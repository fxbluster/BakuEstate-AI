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
from typing import Any, Dict

try:
    from config.settings import (
        ELEVENLABS_VOICE_ARIF,
        ELEVENLABS_VOICE_BANU,
    )
except ImportError:
    ELEVENLABS_VOICE_ARIF = os.getenv("ELEVENLABS_VOICE_ARIF", "ZQJv3hwvRAIC7fvWZ1Qr")
    ELEVENLABS_VOICE_BANU = os.getenv("ELEVENLABS_VOICE_BANU", "EXAVITQu4vr4xnSDxMaL")

CHANNEL_TIKTOK = "TIKTOK"
CHANNEL_LUXURY = "LUXURY"
CHANNEL_AFFORDABLE = "AFFORDABLE"
CHANNEL_GENERAL = "GENERAL"

ACCOUNT_TIKTOK = "@baku_emlak_ai"
ACCOUNT_LUXURY = "@bakuestate.premium"
ACCOUNT_AFFORDABLE = "@baku.serfeli.evler"
ACCOUNT_GENERAL = "@bakuestate.official"

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


def _extract_numeric_price(listing: Dict[str, Any]) -> float:
    raw = listing.get("price")
    if raw is None:
        raw = listing.get("price_azn_normalized")
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


def _is_elite_central_district(listing: Dict[str, Any]) -> bool:
    norm = str(listing.get("district_normalized") or "").strip().lower()
    if norm and any(d == norm or d in norm for d in ELITE_CENTRAL_DISTRICTS):
        return True
    text = _extract_district_text(listing)
    return any(d in text for d in ELITE_CENTRAL_DISTRICTS)


def _is_suburban_district(listing: Dict[str, Any]) -> bool:
    norm = str(listing.get("district_normalized") or "").strip().lower()
    if norm and any(d == norm or d in norm for d in SUBURBAN_DISTRICTS):
        return True
    text = _extract_district_text(listing)
    return any(d in text for d in SUBURBAN_DISTRICTS)


def route_listing_to_channel(listing: Dict[str, Any]) -> Dict[str, Any]:
    """
    Determines channel routing, target account handle, voice configuration,
    and background music track for a given listing using waterfall precedence.

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

    # Priority 1 (Viral Trigger)
    is_urgent = _is_urgent(listing)
    drop_pct = _extract_price_drop_pct(listing)
    if is_urgent or drop_pct >= 10.0:
        return {
            "target_account_handle": ACCOUNT_TIKTOK,
            "channel_niche": CHANNEL_TIKTOK,
            "voice_engine": "elevenlabs",
            "voice_id": ELEVENLABS_VOICE_BANU,
            "voice_speed": 1.15,
            "music_track": "viral_bass.mp3",
        }

    # Priority 2 (Dominant Archetypes: Geographic Districts & Price)
    price = _extract_numeric_price(listing)
    is_elite = _is_elite_central_district(listing)
    is_suburban = _is_suburban_district(listing)

    # Elite central districts (Səbail, Nəsimi, Nərimanov, Gənclik, Ağ Şəhər, Badamdar, Bilgəh, Mərdəkan) or price >= 250k AZN -> LUXURY
    if price >= 250_000.0 or is_elite:
        return {
            "target_account_handle": ACCOUNT_LUXURY,
            "channel_niche": CHANNEL_LUXURY,
            "voice_engine": "elevenlabs",
            "voice_id": ELEVENLABS_VOICE_ARIF,
            "voice_speed": 1.0,
            "music_track": "ambient_lounge.mp3",
        }
    # Suburban districts (Xırdalan, Masazır, Hövsan, Zabrat, Suraxanı, Binəqədi, Sabunçu) or price <= 120k AZN -> AFFORDABLE
    elif is_suburban or (0.0 < price <= 120_000.0):
        return {
            "target_account_handle": ACCOUNT_AFFORDABLE,
            "channel_niche": CHANNEL_AFFORDABLE,
            "voice_engine": "elevenlabs",
            "voice_id": ELEVENLABS_VOICE_BANU,
            "voice_speed": 1.0,
            "music_track": "upbeat_acoustic.mp3",
        }
    else:
        return {
            "target_account_handle": ACCOUNT_GENERAL,
            "channel_niche": CHANNEL_GENERAL,
            "voice_engine": "elevenlabs",
            "voice_id": ELEVENLABS_VOICE_ARIF,
            "voice_speed": 1.0,
            "music_track": "modern_lofi.mp3",
        }
