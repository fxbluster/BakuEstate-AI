"""
Telegram CRM Dispatcher module.
Sends rendered real estate MP4 videos along with ready-to-copy social media captions,
viral hashtags, trending audio suggestions, owner contact details, and direct WhatsApp click links.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
import re
import json
import logging
from pathlib import Path
from typing import Dict, Any, Optional
import urllib.parse
import requests

from config.settings import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_MOCK_DISPATCH, OUTPUT_DIR
from src.scraper.bina_scraper import clean_phone_number

logger = logging.getLogger("telegram_crm")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

VIRAL_HASHTAGS = [
    "#baku", "#azerbaijan", "#emlak", "#binaaz", "#menzil",
    "#evler", "#dasinmazemlak", "#kupcali", "#baki", "#ipoteka",
    "#reelsazerbaijan", "#tiktokazerbaycan", "#alqi_satqi", "#luxuryrealestate"
]

TRENDING_AUDIOS = [
    "Trending Track: 'Baku Sunset Chill'",
    "Viral Sound: 'Luxury Living Beats 2026'",
    "Trending Aesthetic: 'Real Estate Ambient Piano'"
]


def get_property_type(listing: Dict[str, Any]) -> str:
    """Detects whether listing is a courtyard house, villa, commercial, or apartment."""
    combined = f"{listing.get('title', '')} {listing.get('description', '')}".lower()
    if any(k in combined for k in ["həyət evi", "heyet evi", "həyət", "heyet", "bağ evi", "bag evi"]):
        return "HƏYƏT EVİ"
    elif "villa" in combined:
        return "VİLLA"
    elif any(k in combined for k in ["obyekt", "ofis"]):
        return "OBYEKT"
    return "MƏNZİL"


def get_targeted_hashtags(prop_type: str) -> list[str]:
    """Returns at most 5 high-converting, clean viral hashtags without competitor tags."""
    if prop_type == "HƏYƏT EVİ":
        return ["#emlak", "#evler", "#heyetevleri", "#kupcali", "#baku"]
    elif prop_type == "VİLLA":
        return ["#villa", "#luxuryrealestate", "#baku", "#emlak", "#kupcali"]
    else:
        return ["#emlak", "#menzil", "#baku", "#kupcali", "#ipoteka"]


def generate_crm_caption(listing: Dict[str, Any]) -> str:
    """Generates the private CRM lead card for the agency/investor."""
    price = listing.get("price")
    curr = listing.get("currency", "AZN")
    try:
        num_price = float(price) if price is not None else 0.0
        formatted_price = f"{int(num_price):,}".replace(",", " ") if num_price > 0 else "Münasib Qiymət"
    except (ValueError, TypeError):
        formatted_price = "Münasib Qiymət"

    raw_loc = listing.get("location") or listing.get("address") or "Bakı"
    loc = re.sub(r'\bq\.(?=\s|$|[,\.!])', 'qəsəbəsi', raw_loc, flags=re.IGNORECASE).strip()
    loc = re.sub(r'\bm\.(?=\s|$|[,\.!])', 'metrosu', loc, flags=re.IGNORECASE).strip()

    bina_id = listing.get("bina_id", "")
    raw_phone = listing.get("owner_phone", "")
    normalized_phone = clean_phone_number(raw_phone)
    wa_digits = normalized_phone.lstrip("+")

    prop_type = get_property_type(listing)

    if wa_digits:
        wa_text = f"Salam, bina.az-dakı {bina_id} nömrəli {prop_type.lower()} elanınızla bağlı yazıram."
        wa_link = f"https://wa.me/{wa_digits}?text={urllib.parse.quote(wa_text)}"
    else:
        wa_link = f"https://bina.az/items/{bina_id}"

    seller_title = "Birbaşa Mülkiyyətçi (Sahibindən)" if listing.get("is_owner") else "Vasitəçi / Agent"

    lines = [
        "💼 <b>DAXİLİ CRM — MÜLKİYYƏTÇİ İLƏ ƏLAQƏ</b>",
        f"👤 <b>Elan Sahibi:</b> {listing.get('contact_name') or 'Mülkiyyətçi'} ({seller_title})",
        f"📞 <b>Telefon:</b> <code>{raw_phone or 'Qeyd olunmayıb'}</code>",
        f"💬 <b>WhatsApp:</b> <a href=\"{wa_link}\">Mülkiyyətçiyə WhatsApp-da Yaz</a>",
        f"🔗 <b>bina.az Linki:</b> https://bina.az/items/{bina_id}",
        f"💰 <b>Qiymət:</b> {formatted_price} {curr} | 📍 <b>Ərazi:</b> {loc}"
    ]
    return "\n".join(lines)


def generate_public_caption(listing: Dict[str, Any]) -> str:
    """
    Generates a clean, 1-tap copy-paste Instagram/TikTok caption.
    Strictly NO owner numbers, NO competitor links, max 5 hashtags.
    """
    price = listing.get("price")
    curr = listing.get("currency", "AZN")
    try:
        num_price = float(price) if price is not None else 0.0
        formatted_price = f"{int(num_price):,}".replace(",", " ") if num_price > 0 else "Münasib Qiymət"
    except (ValueError, TypeError):
        formatted_price = "Münasib Qiymət"

    raw_loc = listing.get("location") or listing.get("address") or "Bakı"
    loc = re.sub(r'\bq\.(?=\s|$|[,\.!])', 'qəsəbəsi', raw_loc, flags=re.IGNORECASE).strip()
    loc = re.sub(r'\bm\.(?=\s|$|[,\.!])', 'metrosu', loc, flags=re.IGNORECASE).strip()
    loc = re.sub(r'\bküç\.(?=\s|$|[,\.!])', 'küçəsi', loc, flags=re.IGNORECASE).strip()
    loc = re.sub(r'\bpr\.(?=\s|$|[,\.!])', 'prospekti', loc, flags=re.IGNORECASE).strip()

    rooms = listing.get("rooms", "")
    area = listing.get("area", "")
    try:
        area_num = float(area) if area else 0.0
        area_str = f"{int(area_num)} m²" if area_num.is_integer() else f"{area_num:.1f} m²"
    except Exception:
        area_str = f"{area} m²" if area else ""

    floor = listing.get("floor", "")
    floors = listing.get("floors", "")
    floor_str = f" | {floor}/{floors} mərtəbə" if floor else ""

    prop_type = get_property_type(listing)
    hashtags = get_targeted_hashtags(prop_type)[:5]
    kupca_badge = "✅ Dövlət Çıxarışı (Kupça) var - İpotekaya yararlıdır!" if listing.get("has_bill_of_sale", True) else "Müqaviləli"

    caption_lines = [
        f"🔥 <b>TƏCİLİ KUPÇALI {prop_type} SATILIR!</b> 🔥",
        "",
        f"💰 <b>Qiymət:</b> {formatted_price} {curr}",
        f"📍 <b>Ünvan:</b> {loc}",
        f"📐 <b>Parametrlər:</b> {rooms} otaq | {area_str}{floor_str}",
        f"📜 <b>Sənəd:</b> {kupca_badge}",
        "",
        "📩 <b>Ətraflı məlumat və baxış üçün Direktə (DM) yazın və ya bizimlə əlaqə saxlayın!</b>",
        "",
        " ".join(hashtags)
    ]
    return "\n".join(caption_lines)


def generate_social_caption(listing: Dict[str, Any]) -> str:
    """Returns the combined caption for backward-compatibility or full display."""
    crm = generate_crm_caption(listing)
    public = generate_public_caption(listing)
    return f"{crm}\n\n━━━━━━━━━━━━━━━━━━━━━\n📲 <b>İNSTAGRAM / TİKTOK ÜÇÜN (KOPYALA-PAYLAŞ)</b>\n\n{public}"


class TelegramCRMDispatcher:
    def __init__(
        self,
        bot_token: Optional[str] = None,
        chat_id: Optional[str] = None,
        mock_mode: Optional[bool] = None
    ):
        self.bot_token = bot_token or TELEGRAM_BOT_TOKEN
        self.chat_id = chat_id or TELEGRAM_CHAT_ID
        self.mock_mode = (
            mock_mode if mock_mode is not None 
            else (TELEGRAM_MOCK_DISPATCH or not self.bot_token or not self.chat_id)
        )
        logger.info(f"Initialized TelegramCRMDispatcher (Mock Mode: {self.mock_mode})")

    def send_video_lead(
        self,
        listing: Dict[str, Any],
        video_path: str,
        custom_caption: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Sends the MP4 video with internal CRM details, followed immediately
        by a standalone 1-tap copy-paste Instagram/TikTok caption.
        """
        crm_caption = generate_crm_caption(listing)
        public_caption = custom_caption or generate_public_caption(listing)
        video_file = Path(video_path)

        if not video_file.exists():
            raise FileNotFoundError(f"Video file not found: {video_path}")

        if self.mock_mode:
            logger.info(f"[MOCK DISPATCH] Simulating Telegram dispatch for listing {listing.get('bina_id')}")
            lead_dump_path = OUTPUT_DIR / f"lead_{listing.get('bina_id')}.json"
            lead_data = {
                "bina_id": listing.get("bina_id"),
                "video_path": str(video_file.resolve()),
                "owner_phone": listing.get("owner_phone"),
                "crm_caption": crm_caption,
                "public_caption": public_caption,
                "dispatched_at": json.dumps(str(Path(video_path).stat().st_mtime))
            }
            with open(lead_dump_path, "w", encoding="utf-8") as f:
                json.dump(lead_data, f, ensure_ascii=False, indent=2)

            return {
                "status": "MOCK_SUCCESS",
                "message_id": f"mock_msg_{listing.get('bina_id')}",
                "lead_dump": str(lead_dump_path.resolve()),
                "crm_caption": crm_caption,
                "public_caption": public_caption
            }

        # 1. Real Telegram API: Send Video with CRM Lead Card
        logger.info(f"Uploading video {video_path} to Telegram chat {self.chat_id}...")
        api_video_url = f"https://api.telegram.org/bot{self.bot_token}/sendVideo"

        with open(video_file, "rb") as vf:
            payload = {
                "chat_id": self.chat_id,
                "caption": crm_caption,
                "parse_mode": "HTML",
                "supports_streaming": True
            }
            files = {"video": (video_file.name, vf, "video/mp4")}
            resp = requests.post(api_video_url, data=payload, files=files, timeout=120)

        if resp.status_code != 200:
            logger.error(f"Telegram dispatch failed (status {resp.status_code}): {resp.text}")
            raise RuntimeError(f"Telegram dispatch failed: {resp.text}")

        result = resp.json().get("result", {})
        msg_id = str(result.get("message_id", ""))
        logger.info(f"Video lead successfully dispatched! Telegram Message ID: {msg_id}")

        # 2. Real Telegram API: Send Standalone 1-Tap Copy-Paste Caption
        api_msg_url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        msg_payload = {
            "chat_id": self.chat_id,
            "text": public_caption,
            "parse_mode": "HTML"
        }
        try:
            resp_msg = requests.post(api_msg_url, json=msg_payload, timeout=30)
            if resp_msg.status_code == 200:
                public_msg_id = str(resp_msg.json().get("result", {}).get("message_id", ""))
                logger.info(f"Standalone copy-paste caption dispatched! Message ID: {public_msg_id}")
            else:
                logger.warning(f"Failed to send standalone copy-paste caption: {resp_msg.text}")
                public_msg_id = ""
        except Exception as e:
            logger.warning(f"Failed to send standalone copy-paste caption: {e}")
            public_msg_id = ""

        return {
            "status": "DISPATCHED",
            "message_id": msg_id,
            "public_message_id": public_msg_id,
            "crm_caption": crm_caption,
            "public_caption": public_caption
        }
