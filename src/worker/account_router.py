"""
Multi-Account Niche Routing Engine for BakuEstate-AI.

Provides deterministic waterfall precedence for routing real-estate listings
to specialized audience channels and accounts:
- Priority 1 (Viral Trigger):
    Urgent listing or significant price drop (>= 10%) -> TikTok / Fast-paced
- Priority 2 (Dominant Archetypes / Geographic Districts & Price):
    Elite central districts or >= 250,000 AZN -> Luxury channel (@bakuestate.premium)
    Suburban districts or <= 120,000 AZN      -> Affordable channel (@baku.serfeli.evler)
    Else                                      -> General channel (@bakuestate.official)
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict, Optional, Tuple

try:
    from config.settings import (
        ELEVENLABS_VOICE_ARIF,
        ELEVENLABS_VOICE_AYAN,
        ELEVENLABS_VOICE_BANU,
    )
except ImportError:
    ELEVENLABS_VOICE_ARIF = os.getenv("ELEVENLABS_VOICE_ARIF", "ZQJv3hwvRAIC7fvWZ1Qr")
    ELEVENLABS_VOICE_AYAN = os.getenv("ELEVENLABS_VOICE_AYAN", "DZaip8UahF0Qri1FxU8M")
    ELEVENLABS_VOICE_BANU = ELEVENLABS_VOICE_AYAN

CHANNEL_TIKTOK = "TIKTOK"
CHANNEL_LUXURY = "LUXURY"
CHANNEL_AFFORDABLE = "AFFORDABLE"
CHANNEL_GENERAL = "GENERAL"

ACCOUNT_TIKTOK = "@baku_emlak_ai"
ACCOUNT_LUXURY = "@bakuestate.premium"
ACCOUNT_AFFORDABLE = "@baku.serfeli.evler"
ACCOUNT_GENERAL = "@bakuestate.official"

DEFAULT_NICHE_RULES: Dict[str, Any] = {
    "luxury_min_azn": 250_000.0,
    "affordable_max_azn": 120_000.0,
    "viral_drop_pct": 10.0,
}

ELITE_CENTRAL_DISTRICTS = (
    "səbail", "sebail",
    "nəsimi", "nasimi",
    "nərimanov", "nerimanov",
    "gənclik", "genclik",
    "ağ şəhər", "ag seher", "ag sheher", "white city",
    "badamdar",
    "bilgəh", "bilgeh",
    "mərdəkan", "merdekan",
)

SUBURBAN_DISTRICTS = (
    "xırdalan", "xirdalan",
    "masazır", "masazir",
    "hövsan", "hovsan",
    "zabrat",
    "suraxanı", "suraxani",
    "binəqədi", "bineqedi",
    "sabunçu", "sabuncu",
)


def _parse_float(raw: Any) -> float:
    if raw is None:
        return 0.0
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    if isinstance(raw, str):
        cleaned = re.sub(r"[^\d.]", "", raw)
        try:
            return float(cleaned)
        except (ValueError, TypeError):
            return 0.0
    return 0.0


def _extract_numeric_price(listing: Dict[str, Any]) -> float:
    norm = _parse_float(listing.get("price_azn_normalized"))
    if norm > 0.0:
        return norm
    for key in ("price", "price_azn"):
        val = _parse_float(listing.get(key))
        if val > 0.0:
            return val
    return 0.0


def _extract_price_drop_pct(listing: Dict[str, Any]) -> float:
    raw = listing.get("price_drop_pct")
    if raw is None and isinstance(listing.get("price_drop_info"), dict):
        raw = (
            listing["price_drop_info"].get("drop_pct")
            or listing["price_drop_info"].get("price_drop_pct")
        )
    if raw is None:
        return 0.0
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        cleaned = re.sub(r"[^\d.]", "", raw)
        try:
            return float(cleaned)
        except (ValueError, TypeError):
            return 0.0
    return 0.0


def _is_urgent(listing: Dict[str, Any]) -> bool:
    val = listing.get("is_urgent")
    if isinstance(val, str):
        return val.strip().lower() in ("true", "1", "yes", "t")
    return bool(val)


def _extract_district_text(listing: Dict[str, Any]) -> str:
    """Extracts raw or normalized district / location text from listing."""
    candidates = [
        listing.get("district_normalized"),
        listing.get("location"),
        listing.get("district"),
        listing.get("settlement"),
    ]
    parts = [str(c).strip().lower() for c in candidates if c and isinstance(c, str)]
    return " ".join(parts)


def _normalize_niche_rules(niche_rules: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    rules = dict(DEFAULT_NICHE_RULES)
    if not isinstance(niche_rules, dict):
        return rules
    source = niche_rules.get("niche_rules_json") if isinstance(niche_rules.get("niche_rules_json"), dict) else niche_rules

    lux = _parse_float(source.get("luxury_min_azn"))
    if lux > 0.0:
        rules["luxury_min_azn"] = lux
    aff = _parse_float(source.get("affordable_max_azn"))
    if aff > 0.0:
        rules["affordable_max_azn"] = aff
    drop = _parse_float(source.get("viral_drop_pct"))
    if drop > 0.0:
        rules["viral_drop_pct"] = drop

    if isinstance(source.get("elite_districts"), (list, tuple)):
        rules["elite_districts"] = tuple(str(d).strip().lower() for d in source["elite_districts"] if str(d).strip())
    if isinstance(source.get("suburban_districts"), (list, tuple)):
        rules["suburban_districts"] = tuple(str(d).strip().lower() for d in source["suburban_districts"] if str(d).strip())
    if isinstance(source.get("accounts"), dict):
        rules["accounts"] = source["accounts"]
    return rules


def _is_elite_central_district(listing: Dict[str, Any], districts: Tuple[str, ...] = ELITE_CENTRAL_DISTRICTS) -> bool:
    norm = str(listing.get("district_normalized") or "").strip().lower()
    if norm and any(d == norm or d in norm for d in districts):
        return True
    text = _extract_district_text(listing)
    return any(d in text for d in districts)


def _is_suburban_district(listing: Dict[str, Any], districts: Tuple[str, ...] = SUBURBAN_DISTRICTS) -> bool:
    norm = str(listing.get("district_normalized") or "").strip().lower()
    if norm and any(d == norm or d in norm for d in districts):
        return True
    text = _extract_district_text(listing)
    return any(d in text for d in districts)


def route_listing_to_channel(
    listing: Dict[str, Any],
    niche_rules: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Determines channel routing, target account handle, voice configuration,
    and background music track for a given listing using canonical waterfall precedence
    and optional `agency_settings.niche_rules_json` overrides.

    Returns dict with keys:
        'target_account_handle': str
        'channel_niche': str ('TIKTOK' | 'LUXURY' | 'AFFORDABLE' | 'GENERAL')
        'voice_engine': str ('elevenlabs')
        'voice_id': str
        'voice_speed': float
        'music_track': str
    """
    if not isinstance(listing, dict):
        listing = {}

    rules = _normalize_niche_rules(niche_rules or (listing.get("niche_rules_json") if isinstance(listing.get("niche_rules_json"), dict) else None))
    elite_districts = rules.get("elite_districts", ELITE_CENTRAL_DISTRICTS)
    suburban_districts = rules.get("suburban_districts", SUBURBAN_DISTRICTS)
    accounts_map = rules.get("accounts") if isinstance(rules.get("accounts"), dict) else {}

    def _acct(niche: str, default_handle: str) -> str:
        val = str(accounts_map.get(niche) or "").strip()
        return val or default_handle

    # Priority 1 (Viral Trigger)
    is_urgent = _is_urgent(listing)
    drop_pct = _extract_price_drop_pct(listing)
    if is_urgent or drop_pct >= float(rules["viral_drop_pct"]):
        return {
            "target_account_handle": _acct(CHANNEL_TIKTOK, ACCOUNT_TIKTOK),
            "channel_niche": CHANNEL_TIKTOK,
            "voice_engine": "elevenlabs",
            "voice_id": ELEVENLABS_VOICE_AYAN,
            "voice_speed": 1.15,
            "music_track": "viral_bass.mp3",
        }

    # Priority 2 (Dominant Archetypes: Geographic Districts & Canonical Price Thresholds)
    price = _extract_numeric_price(listing)
    is_elite = _is_elite_central_district(listing, elite_districts)
    is_suburban = _is_suburban_district(listing, suburban_districts)
    luxury_min = float(rules["luxury_min_azn"])
    affordable_max = float(rules["affordable_max_azn"])

    # Elite central districts or price >= luxury_min_azn (default 250,000 AZN) -> LUXURY
    if price >= luxury_min or is_elite:
        return {
            "target_account_handle": _acct(CHANNEL_LUXURY, ACCOUNT_LUXURY),
            "channel_niche": CHANNEL_LUXURY,
            "voice_engine": "elevenlabs",
            "voice_id": ELEVENLABS_VOICE_ARIF,
            "voice_speed": 1.0,
            "music_track": "ambient_lounge.mp3",
        }
    # Suburban districts or price <= affordable_max_azn (default 120,000 AZN) -> AFFORDABLE
    elif is_suburban or (0.0 < price <= affordable_max):
        return {
            "target_account_handle": _acct(CHANNEL_AFFORDABLE, ACCOUNT_AFFORDABLE),
            "channel_niche": CHANNEL_AFFORDABLE,
            "voice_engine": "elevenlabs",
            "voice_id": ELEVENLABS_VOICE_AYAN,
            "voice_speed": 1.0,
            "music_track": "upbeat_acoustic.mp3",
        }
    else:
        return {
            "target_account_handle": _acct(CHANNEL_GENERAL, ACCOUNT_GENERAL),
            "channel_niche": CHANNEL_GENERAL,
            "voice_engine": "elevenlabs",
            "voice_id": ELEVENLABS_VOICE_ARIF,
            "voice_speed": 1.0,
            "music_track": "modern_lofi.mp3",
        }


def resolve_canonical_listing_niche(
    listing: Optional[Dict[str, Any]],
    niche_rules: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """
    Canonical Python equivalent of TS `resolveCanonicalListingNiche(listing, rules?)`.
    Returns `{"niche": ChannelNiche, "account": target_account_handle}`.
    """
    routed = route_listing_to_channel(listing or {}, niche_rules=niche_rules)
    return {
        "niche": routed["channel_niche"],
        "account": routed["target_account_handle"],
    }
