"""
Listing deduplication, currency normalization, change detection,
and Rejim 3 automatic price-drop re-render guardrail evaluation.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from config.settings import (
    AUTO_RENDER_COOLDOWN_HOURS,
    BAKU_DISTRICT_MEDIAN_M2,
    BAKU_LANDMARK_DISTRICT_MAP,
    DAILY_AUTO_RENDER_LIMIT,
    EUR_TO_AZN_RATE,
    PRICE_DROP_TRIGGER_PCT,
    USD_TO_AZN_RATE,
    safe_parse_numeric,
)
from src.scraper.bina_scraper import clean_phone_number

# Rejim 3 blocking status sets
BLOCKED_EDITORIAL_STATUSES = frozenset({"ARCHIVED", "REJECTED"})
BLOCKED_OUTREACH_STATUSES = frozenset({"OWNER_SOLD", "REFUSED_AGENT"})

# Repost scoring weights (total = 1.00)
WEIGHT_PHONE = 0.45
WEIGHT_DISTRICT = 0.15
WEIGHT_ROOMS = 0.15
WEIGHT_AREA = 0.15
WEIGHT_FLOOR = 0.10
DEFAULT_REPOST_THRESHOLD = 0.85
AREA_TOLERANCE_RATIO = 0.03

_CANONICAL_DISTRICTS: Dict[str, str] = {
    "nərimanov": "Nərimanov",
    "nerimanov": "Nərimanov",
    "nəsimi": "Nəsimi",
    "nasimi": "Nəsimi",
    "səbail": "Səbail",
    "sebail": "Səbail",
    "yasamal": "Yasamal",
    "xəzər": "Xəzər",
    "xezer": "Xəzər",
    "nizami": "Nizami",
    "xətai": "Xətai",
    "xetai": "Xətai",
    "binəqədi": "Binəqədi",
    "bineqedi": "Binəqədi",
    "sabunçu": "Sabunçu",
    "sabuncu": "Sabunçu",
    "suraxanı": "Suraxanı",
    "suraxani": "Suraxanı",
    "pirallahı": "Pirallahı",
    "pirallahi": "Pirallahı",
    "abşeron": "Abşeron",
    "absheron": "Abşeron",
    "qaradağ": "Qaradağ",
    "qaradag": "Qaradağ",
}


def _canonical_currency(currency: Optional[str]) -> str:
    """Normalizes currency strings and symbols into canonical ISO codes (AZN, USD, EUR)."""
    cur = (currency or "AZN").strip().upper()
    if cur in ("AZN", "₼", "MANAT", "AZM", ""):
        return "AZN"
    if cur in ("USD", "$", "US$", "DOLLAR"):
        return "USD"
    if cur in ("EUR", "€", "EURO"):
        return "EUR"
    return cur


def normalize_price_to_azn(
    price: Any,
    currency: Optional[str] = "AZN",
    usd_rate: float = USD_TO_AZN_RATE,
    eur_rate: float = EUR_TO_AZN_RATE,
) -> float:
    """
    Converts a listing price in AZN, USD, or EUR into a canonical AZN float.
    Prevents currency flips (e.g., 100,000 USD <-> 170,000 AZN) from creating false price drops.
    """
    raw_val = safe_parse_numeric(price, default=0.0, is_price=True)
    if raw_val <= 0:
        return 0.0

    cur = _canonical_currency(currency)
    if cur == "AZN":
        rate = 1.0
    elif cur == "USD":
        rate = float(usd_rate)
    elif cur == "EUR":
        rate = float(eur_rate)
    else:
        rate = 1.0

    return round(raw_val * rate, 2)


def normalize_district(location: Optional[str], address: Optional[str] = "") -> str:
    """
    Maps a Baku location / metro / settlement / address string to its canonical
    administrative district name when recognizable, or returns a cleaned lowercase fallback.
    """
    combined = f"{location or ''} {address or ''}".strip().lower()
    if not combined:
        return ""

    # 1. Exact/substring match against known Baku administrative districts
    for key, canonical in _CANONICAL_DISTRICTS.items():
        if key in combined:
            return canonical

    # 2. Match against Baku metro stations, landmarks, and settlements
    for landmark, canonical in BAKU_LANDMARK_DISTRICT_MAP.items():
        if landmark in combined:
            return canonical

    # 3. Fallback: match keys from BAKU_DISTRICT_MEDIAN_M2
    for key in BAKU_DISTRICT_MEDIAN_M2:
        if key != "baku_median" and key in combined:
            return _CANONICAL_DISTRICTS.get(key, key.capitalize())

    # 4. Clean fallback text (stripped of common suffixes like 'm.', 'q.', 'r-nu')
    cleaned = re.sub(r"\b(m\.|q\.|r-nu|rayonu|qəsəbəsi|metrosu)\b", "", (location or "").strip().lower())
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,.-")
    return cleaned.title() if cleaned else ""


def compute_photo_urls_hash(photo_urls: Optional[Sequence[str]]) -> str:
    """
    Computes a deterministic SHA-256 hex digest over normalized, deduplicated photo URLs.
    Returns empty string when photo_urls is empty.
    """
    if not photo_urls:
        return ""

    cleaned = sorted({str(u).strip() for u in photo_urls if u and str(u).strip()})
    if not cleaned:
        return ""

    payload = "\n".join(cleaned).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _extract_normalized_phone(listing: Dict[str, Any]) -> str:
    raw = (
        listing.get("owner_phone_normalized")
        or listing.get("owner_phone")
        or listing.get("owner_phone_raw")
        or ""
    )
    return clean_phone_number(str(raw))


def _extract_district(listing: Dict[str, Any]) -> str:
    explicit = str(listing.get("district_normalized") or "").strip()
    if explicit:
        return normalize_district(explicit) or explicit
    return normalize_district(listing.get("location"), listing.get("address"))


def _extract_positive_int(val: Any) -> Optional[int]:
    if val is None or val == "":
        return None
    try:
        parsed = int(safe_parse_numeric(val, default=-1.0, is_price=False))
        return parsed if parsed > 0 else None
    except Exception:
        return None


def _extract_positive_float(val: Any) -> Optional[float]:
    if val is None or val == "":
        return None
    try:
        parsed = safe_parse_numeric(val, default=-1.0, is_price=False)
        return parsed if parsed > 0 else None
    except Exception:
        return None


def score_repost_candidate(
    candidate: Dict[str, Any],
    existing: Dict[str, Any],
    threshold: float = DEFAULT_REPOST_THRESHOLD,
) -> Dict[str, Any]:
    """
    Null-safe repost similarity scorer comparing a newly scraped listing against an existing one.

    Weights:
      - owner_phone_normalized exact match: +0.45
      - district_normalized exact match:    +0.15
      - rooms exact match:                  +0.15
      - area within <= 3% difference:       +0.15
      - floor exact match:                  +0.10

    Safety guarantees:
      - Never matches empty/null fields against each other.
      - Never auto-flags as PENDING_REVIEW when either listing lacks a phone number.
      - Same bina_id is treated as the same listing (score=0.0, not a repost).
    """
    cand_bina_id = str(candidate.get("bina_id") or "").strip()
    exist_bina_id = str(existing.get("bina_id") or "").strip()

    if cand_bina_id and exist_bina_id and cand_bina_id == exist_bina_id:
        return {
            "score": 0.0,
            "is_potential_duplicate": False,
            "duplicate_resolution": "NONE",
            "matched_fields": [],
            "phone_missing": False,
            "candidate_bina_id": cand_bina_id,
            "existing_bina_id": exist_bina_id,
            "existing_id": existing.get("id"),
        }

    cand_phone = _extract_normalized_phone(candidate)
    exist_phone = _extract_normalized_phone(existing)
    phone_missing = not (cand_phone and exist_phone)

    score = 0.0
    matched_fields: List[str] = []

    if not phone_missing and cand_phone == exist_phone:
        score += WEIGHT_PHONE
        matched_fields.append("phone")

    cand_district = _extract_district(candidate)
    exist_district = _extract_district(existing)
    if cand_district and exist_district and cand_district.lower() == exist_district.lower():
        score += WEIGHT_DISTRICT
        matched_fields.append("district")

    cand_rooms = _extract_positive_int(candidate.get("rooms"))
    exist_rooms = _extract_positive_int(existing.get("rooms"))
    if cand_rooms is not None and exist_rooms is not None and cand_rooms == exist_rooms:
        score += WEIGHT_ROOMS
        matched_fields.append("rooms")

    cand_area = _extract_positive_float(candidate.get("area"))
    exist_area = _extract_positive_float(existing.get("area"))
    if cand_area is not None and exist_area is not None:
        max_area = max(cand_area, exist_area)
        if max_area > 0 and (abs(cand_area - exist_area) / max_area) <= AREA_TOLERANCE_RATIO:
            score += WEIGHT_AREA
            matched_fields.append("area")

    cand_floor = _extract_positive_int(candidate.get("floor"))
    exist_floor = _extract_positive_int(existing.get("floor"))
    if cand_floor is not None and exist_floor is not None and cand_floor == exist_floor:
        score += WEIGHT_FLOOR
        matched_fields.append("floor")

    score = round(score, 4)

    # Critical safety rule: NEVER auto-flag when owner phone is empty
    is_potential_duplicate = (not phone_missing) and (score >= threshold)
    duplicate_resolution = "PENDING_REVIEW" if is_potential_duplicate else "NONE"

    return {
        "score": score,
        "is_potential_duplicate": is_potential_duplicate,
        "duplicate_resolution": duplicate_resolution,
        "matched_fields": matched_fields,
        "phone_missing": phone_missing,
        "candidate_bina_id": cand_bina_id,
        "existing_bina_id": exist_bina_id,
        "existing_id": existing.get("id"),
    }


def find_best_repost_match(
    candidate: Dict[str, Any],
    existing_listings: Sequence[Dict[str, Any]],
    threshold: float = DEFAULT_REPOST_THRESHOLD,
) -> Optional[Dict[str, Any]]:
    """
    Evaluates a candidate listing against existing DB rows and returns the highest-scoring
    match that crosses `threshold` (with non-empty matching phone), or None.
    """
    if not _extract_normalized_phone(candidate):
        return None

    best_match: Optional[Dict[str, Any]] = None
    for existing in existing_listings:
        result = score_repost_candidate(candidate, existing, threshold=threshold)
        if result["is_potential_duplicate"]:
            if best_match is None or result["score"] > best_match["score"]:
                best_match = result
    return best_match


def _parse_utc_datetime(val: Any) -> Optional[datetime]:
    """Parses ISO-8601 strings or datetime instances into timezone-aware UTC datetime."""
    if val is None or val == "":
        return None
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=timezone.utc)
        return val.astimezone(timezone.utc)
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                return dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            return None
    return None


def _get_existing_price_azn(
    existing_listing: Dict[str, Any],
    usd_rate: float = USD_TO_AZN_RATE,
    eur_rate: float = EUR_TO_AZN_RATE,
) -> float:
    norm = existing_listing.get("price_azn_normalized")
    if norm is not None and norm != "":
        val = safe_parse_numeric(norm, default=0.0, is_price=True)
        if val > 0:
            return round(val, 2)
    return normalize_price_to_azn(
        existing_listing.get("price"),
        existing_listing.get("currency", "AZN"),
        usd_rate=usd_rate,
        eur_rate=eur_rate,
    )


def _compute_price_delta(
    existing_listing: Dict[str, Any],
    new_price: Any,
    new_currency: Optional[str] = "AZN",
    *,
    usd_rate: float = USD_TO_AZN_RATE,
    eur_rate: float = EUR_TO_AZN_RATE,
) -> Dict[str, Any]:
    """
    Computes price change metadata safely:
    - When old_currency == new_currency and both raw prices are > 0, computes
      price_delta_pct / price_drop_pct directly from raw prices (preventing FX rate
      updates such as EUR_TO_AZN_RATE changes from creating phantom price drops).
    - On cross-currency flips (e.g. USD <-> AZN) or missing raw prices, compares
      FX-normalized AZN prices.
    - Applies a < 1.0 AZN noise guard in both paths.
    """
    old_currency = _canonical_currency(existing_listing.get("currency"))
    new_currency_canon = _canonical_currency(new_currency)
    old_raw_price = safe_parse_numeric(existing_listing.get("price"), default=0.0, is_price=True)
    new_raw_price = safe_parse_numeric(new_price, default=0.0, is_price=True)

    old_price_azn = _get_existing_price_azn(existing_listing, usd_rate=usd_rate, eur_rate=eur_rate)
    new_price_azn = normalize_price_to_azn(
        new_price,
        new_currency,
        usd_rate=usd_rate,
        eur_rate=eur_rate,
    )

    price_delta_pct = 0.0
    price_drop_pct = 0.0
    price_changed = False

    if old_currency == new_currency_canon and old_raw_price > 0 and new_raw_price > 0:
        raw_diff_azn = normalize_price_to_azn(
            abs(new_raw_price - old_raw_price),
            new_currency_canon,
            usd_rate=usd_rate,
            eur_rate=eur_rate,
        )
        if raw_diff_azn >= 1.0:
            price_changed = True
            price_delta_pct = round(((new_raw_price - old_raw_price) / old_raw_price) * 100.0, 2)
            if new_raw_price < old_raw_price:
                price_drop_pct = round(((old_raw_price - new_raw_price) / old_raw_price) * 100.0, 2)
    elif old_price_azn > 0 and new_price_azn > 0 and abs(new_price_azn - old_price_azn) >= 1.0:
        price_changed = True
        price_delta_pct = round(((new_price_azn - old_price_azn) / old_price_azn) * 100.0, 2)
        if new_price_azn < old_price_azn:
            price_drop_pct = round(((old_price_azn - new_price_azn) / old_price_azn) * 100.0, 2)

    return {
        "old_price_azn": old_price_azn,
        "new_price_azn": new_price_azn,
        "price_changed": price_changed,
        "price_delta_pct": price_delta_pct,
        "price_drop_pct": price_drop_pct,
    }


def detect_listing_changes(
    existing_listing: Dict[str, Any],
    incoming_listing: Dict[str, Any],
    *,
    usd_rate: float = USD_TO_AZN_RATE,
    eur_rate: float = EUR_TO_AZN_RATE,
    actor: str = "scraper",
) -> Dict[str, Any]:
    """
    Compares an existing DB listing against freshly scraped data and builds
    structured diff metadata and immutable listing_events records.
    """
    price_calc = _compute_price_delta(
        existing_listing,
        incoming_listing.get("price"),
        incoming_listing.get("currency", "AZN"),
        usd_rate=usd_rate,
        eur_rate=eur_rate,
    )
    old_price_azn = price_calc["old_price_azn"]
    new_price_azn = price_calc["new_price_azn"]
    price_delta_pct = price_calc["price_delta_pct"]
    price_drop_pct = price_calc["price_drop_pct"]
    price_changed = price_calc["price_changed"]

    old_kupca = existing_listing.get("has_bill_of_sale")
    new_kupca = incoming_listing.get("has_bill_of_sale")
    kupca_changed = (
        old_kupca is not None
        and new_kupca is not None
        and bool(old_kupca) != bool(new_kupca)
    )

    old_hash = str(existing_listing.get("photo_urls_hash") or "").strip()
    if not old_hash and existing_listing.get("photo_urls"):
        old_hash = compute_photo_urls_hash(existing_listing.get("photo_urls"))
    new_hash = str(incoming_listing.get("photo_urls_hash") or "").strip()
    if not new_hash and incoming_listing.get("photo_urls"):
        new_hash = compute_photo_urls_hash(incoming_listing.get("photo_urls"))
    photos_changed = bool(old_hash and new_hash and old_hash != new_hash)

    events: List[Dict[str, Any]] = []
    if price_changed:
        events.append({
            "event_type": "PRICE_CHANGED",
            "old_value_json": {
                "price": existing_listing.get("price"),
                "currency": existing_listing.get("currency", "AZN"),
                "price_azn_normalized": old_price_azn,
            },
            "new_value_json": {
                "price": incoming_listing.get("price"),
                "currency": incoming_listing.get("currency", "AZN"),
                "price_azn_normalized": new_price_azn,
            },
            "price_delta_pct": price_delta_pct,
            "actor": actor,
        })

    if kupca_changed:
        events.append({
            "event_type": "KUPCA_CHANGED",
            "old_value_json": {"has_bill_of_sale": bool(old_kupca)},
            "new_value_json": {"has_bill_of_sale": bool(new_kupca)},
            "price_delta_pct": None,
            "actor": actor,
        })

    if photos_changed:
        events.append({
            "event_type": "PHOTOS_CHANGED",
            "old_value_json": {"photo_urls_hash": old_hash},
            "new_value_json": {"photo_urls_hash": new_hash},
            "price_delta_pct": None,
            "actor": actor,
        })

    return {
        "has_changes": bool(events),
        "price_changed": price_changed,
        "old_price_azn": old_price_azn,
        "new_price_azn": new_price_azn,
        "price_delta_pct": price_delta_pct,
        "price_drop_pct": price_drop_pct,
        "kupca_changed": kupca_changed,
        "photos_changed": photos_changed,
        "old_photo_urls_hash": old_hash,
        "new_photo_urls_hash": new_hash,
        "events": events,
    }


def evaluate_price_drop_retrigger(
    existing_listing: Dict[str, Any],
    new_price: Any,
    new_currency: str = "AZN",
    *,
    today_auto_render_count: int = 0,
    now: Optional[datetime] = None,
    min_drop_pct: float = PRICE_DROP_TRIGGER_PCT,
    daily_limit: int = DAILY_AUTO_RENDER_LIMIT,
    cooldown_hours: int = AUTO_RENDER_COOLDOWN_HOURS,
    usd_rate: float = USD_TO_AZN_RATE,
    eur_rate: float = EUR_TO_AZN_RATE,
) -> Dict[str, Any]:
    """
    Evaluates whether an observed price drop on an existing listing should enqueue an
    automatic RENDER_PRICE_DROP job under Rejim 3's 4 strict guardrails:

      1. editorial_status NOT IN ('ARCHIVED', 'REJECTED')
      2. source_availability == 'ACTIVE'
      3. owner_outreach_status NOT IN ('OWNER_SOLD', 'REFUSED_AGENT')
      4. last_auto_rendered_at is outside cooldown_hours (default 24h)
         AND today_auto_render_count < daily_limit (default 5)
    """
    price_calc = _compute_price_delta(
        existing_listing,
        new_price,
        new_currency,
        usd_rate=usd_rate,
        eur_rate=eur_rate,
    )
    old_price_azn = price_calc["old_price_azn"]
    new_price_azn = price_calc["new_price_azn"]
    price_delta_pct = price_calc["price_delta_pct"]
    price_drop_pct = price_calc["price_drop_pct"]

    blocked_reasons: List[str] = []

    if old_price_azn <= 0 or new_price_azn <= 0:
        blocked_reasons.append("INVALID_PRICE")
    elif price_drop_pct < float(min_drop_pct):
        blocked_reasons.append(f"DROP_BELOW_THRESHOLD:{price_drop_pct:.2f}%<{min_drop_pct:.2f}%")

    # Guardrail 1: editorial_status
    editorial_status = str(existing_listing.get("editorial_status") or "PENDING_REVIEW").strip().upper()
    if editorial_status in BLOCKED_EDITORIAL_STATUSES:
        blocked_reasons.append(f"EDITORIAL_BLOCKED:{editorial_status}")

    # Guardrail 2: source_availability
    source_availability = str(existing_listing.get("source_availability") or "ACTIVE").strip().upper()
    if source_availability != "ACTIVE":
        blocked_reasons.append(f"SOURCE_UNAVAILABLE:{source_availability}")

    # Guardrail 3: owner_outreach_status
    owner_outreach_status = str(existing_listing.get("owner_outreach_status") or "NOT_CONTACTED").strip().upper()
    if owner_outreach_status in BLOCKED_OUTREACH_STATUSES:
        blocked_reasons.append(f"OUTREACH_BLOCKED:{owner_outreach_status}")

    # Guardrail 4a: 24h per-listing cooldown
    now_utc = _parse_utc_datetime(now) or datetime.now(timezone.utc)
    last_rendered_dt = _parse_utc_datetime(existing_listing.get("last_auto_rendered_at"))
    if last_rendered_dt is not None and cooldown_hours > 0:
        elapsed = now_utc - last_rendered_dt
        if elapsed < timedelta(hours=cooldown_hours):
            blocked_reasons.append("COOLDOWN_ACTIVE")

    # Guardrail 4b: daily Baku auto-render budget limit
    if daily_limit >= 0 and int(today_auto_render_count) >= int(daily_limit):
        blocked_reasons.append("DAILY_LIMIT_REACHED")

    should_trigger = len(blocked_reasons) == 0
    bina_id = str(existing_listing.get("bina_id") or "").strip()

    price_drop_info: Optional[Dict[str, Any]] = None
    if old_price_azn > 0 and new_price_azn > 0 and price_drop_pct >= float(min_drop_pct):
        price_drop_info = {
            "old_price_azn": old_price_azn,
            "new_price_azn": new_price_azn,
            "drop_pct": price_drop_pct,
            "drop_amount_azn": round(old_price_azn - new_price_azn, 2),
        }

    idempotency_key = (
        f"price_drop:{bina_id}:{int(round(new_price_azn))}"
        if should_trigger and bina_id
        else None
    )

    return {
        "should_trigger": should_trigger,
        "old_price_azn": old_price_azn,
        "new_price_azn": new_price_azn,
        "price_delta_pct": price_delta_pct,
        "price_drop_pct": price_drop_pct,
        "blocked_reasons": blocked_reasons,
        "idempotency_key": idempotency_key,
        "price_drop_info": price_drop_info,
    }
