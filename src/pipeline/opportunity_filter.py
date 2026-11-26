"""Special opportunity evaluation for backlog-first scraping mode."""

from __future__ import annotations

from typing import Any, Dict, Tuple

DISTRICT_PRICE_FLOORS_AZN_M2: Dict[str, float] = {
    "yasamal": 2200.0,
    "nasimi": 2500.0,
    "sabail": 3200.0,
    "khatai": 2100.0,
    "narimanov": 2400.0,
    "masazir": 1100.0,
    "default": 2000.0,
}

_DISTRICT_ALIASES: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("yasamal", ("yasamal", "inşaatçılar", "insaatcilar", "elmlər", "elmler")),
    ("nasimi", ("nəsimi", "nasimi", "28 may")),
    ("sabail", ("səbail", "sebail", "badamdar", "sahil")),
    ("khatai", ("xətai", "khatai", "əhmədli", "ehmedli", "həzi", "hezi", "ağ şəhər", "ag seher")),
    ("narimanov", ("nərimanov", "narimanov", "gənclik", "genclik")),
    ("masazir", ("masazır", "masazir")),
)

URGENT_DEAL_KEYWORDS: Tuple[str, ...] = (
    "təcili",
    "tecili",
    "dəyərindən ucuz",
    "deyerinden ucuz",
    "bazar qiymətindən aşağı",
    "bazar qiymetinden asagi",
    "şok qiymət",
    "sok qiymet",
    "endirimli",
)


MIN_SALE_PRICE_AZN: float = 20000.0


def _resolve_district_floor(location_text: str) -> float:
    lower = location_text.strip().lower()
    if not lower:
        return DISTRICT_PRICE_FLOORS_AZN_M2["default"]
    for key, patterns in _DISTRICT_ALIASES:
        if any(p in lower for p in patterns):
            return DISTRICT_PRICE_FLOORS_AZN_M2[key]
    return DISTRICT_PRICE_FLOORS_AZN_M2["default"]


def is_special_opportunity(listing: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Determines whether a newly scraped listing qualifies as a special opportunity
    worth saving for deferred rendering while the worker clears its video backlog.
    """
    try:
        price_azn = float(listing.get("price_azn_normalized") or listing.get("price") or 0)
    except (TypeError, ValueError):
        price_azn = 0.0

    try:
        area_m2 = float(listing.get("area") or 0)
    except (TypeError, ValueError):
        area_m2 = 0.0

    location_text = " ".join(
        str(v)
        for v in (listing.get("district_normalized"), listing.get("location"))
        if v
    )

    if 0 < price_azn < MIN_SALE_PRICE_AZN:
        return False, "RENTAL_OR_INVALID_PRICE"

    if price_azn > 0 and area_m2 >= 20.0:
        floor_m2 = _resolve_district_floor(location_text)
        price_per_m2 = price_azn / area_m2
        if price_per_m2 <= floor_m2 * 0.85:
            return True, "BELOW_MARKET_M2"

    is_owner = bool(listing.get("is_owner"))
    has_kupca = bool(listing.get("has_bill_of_sale"))
    if is_owner and has_kupca:
        text_blob = f"{listing.get('title') or ''} {listing.get('description') or ''}".lower()
        if any(kw in text_blob for kw in URGENT_DEAL_KEYWORDS):
            return True, "URGENT_OWNER_KUPCA"

    return False, "STANDARD_MARKET"
