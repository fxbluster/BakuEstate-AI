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


def generate_social_caption(listing: Dict[str, Any]) -> str:
    """
    Generates a high-converting, ready-to-copy caption for Instagram Reels and TikTok.
    Includes listing highlights, price, owner phone, direct WhatsApp click link,
    trending audio recommendations, and viral hashtags.
    """
    price = listing.get("price")
    curr = listing.get("currency", "AZN")
    formatted_price = f"{int(price):,}".replace(",", " ") if price else "Münasib Qiymət"

    loc = listing.get("location") or listing.get("address") or "Bakı"
    rooms = listing.get("rooms", "")
    area = listing.get("area", "")
    floor = listing.get("floor", "")
    floors = listing.get("floors", "")

    bina_id = listing.get("bina_id", "")
    raw_phone = listing.get("owner_phone", "")
    normalized_phone = clean_phone_number(raw_phone)
    wa_digits = normalized_phone.lstrip("+")

    # WhatsApp link with international phone number format
    if wa_digits:
        wa_text = f"Salam, bina.az-dakı {bina_id} nömrəli elanınızla bağlı yazıram."
        wa_link = f"https://wa.me/{wa_digits}?text={urllib.parse.quote(wa_text)}"
    else:
        wa_link = f"https://bina.az/items/{bina_id}"

    seller_title = "BİRBAŞA MÜLKİYYƏTÇİ (Sahibindən)" if listing.get("is_owner") else "Təcili Satış"
    kupca_badge = "✅ ÇIXARIŞ (Kupça) VAR - İpotekaya tam yararlıdır!" if listing.get("has_bill_of_sale", True) else "Müqaviləli"

    caption_lines = [
        "🔥 <b>BAKIDA TƏCİLİ KUPÇALI MƏNZİL SATILIR!</b> 🔥",
        "",
        f"💰 <b>Qiymət:</b> {formatted_price} {curr}",
        f"📍 <b>Ərazi:</b> {loc}",
        f"📐 <b>Parametrlər:</b> {rooms} otaq | {area} m²" + (f" | {floor}/{floors} mərtəbə" if floor else ""),
        f"📜 <b>Sənəd:</b> {kupca_badge}",
        f"👤 <b>Satıcı:</b> {seller_title}",
        "",
        f"📞 <b>Əlaqə telefonu:</b> {raw_phone or 'Qeyd olunmayıb'}",
        f"💬 <b>Birbaşa WhatsApp:</b> <a href=\"{wa_link}\">WhatsApp-da Yaz</a>",
        f"🔗 <b>Elan linki:</b> https://bina.az/items/{bina_id}",
        "",
        "🎵 <b>Tövsiyə olunan Trending Audio:</b>",
        f"👉 {TRENDING_AUDIOS[0]}",
        "",
        " ".join(VIRAL_HASHTAGS)
    ]

    return "\n".join(caption_lines)


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
        Sends the MP4 video to Telegram channel/group or records mock dispatch.
        Returns dispatch response metadata.
        """
        caption = custom_caption or generate_social_caption(listing)
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
                "caption": caption,
                "dispatched_at": json.dumps(str(Path(video_path).stat().st_mtime))
            }
            with open(lead_dump_path, "w", encoding="utf-8") as f:
                json.dump(lead_data, f, ensure_ascii=False, indent=2)

            return {
                "status": "MOCK_SUCCESS",
                "message_id": f"mock_msg_{listing.get('bina_id')}",
                "lead_dump": str(lead_dump_path.resolve()),
                "caption": caption
            }

        # Real Telegram Bot API call
        logger.info(f"Uploading video {video_path} to Telegram chat {self.chat_id}...")
        api_url = f"https://api.telegram.org/bot{self.bot_token}/sendVideo"

        # Guard against Telegram Bot API 1024-character caption limit for media
        telegram_caption = caption
        if len(telegram_caption) > 1024:
            telegram_caption = telegram_caption[:1020] + "..."

        with open(video_file, "rb") as vf:
            payload = {
                "chat_id": self.chat_id,
                "caption": telegram_caption,
                "parse_mode": "HTML",
                "supports_streaming": True
            }
            files = {"video": (video_file.name, vf, "video/mp4")}
            resp = requests.post(api_url, data=payload, files=files, timeout=120)

        if resp.status_code == 200:
            result = resp.json().get("result", {})
            msg_id = str(result.get("message_id", ""))
            logger.info(f"Video lead successfully dispatched! Telegram Message ID: {msg_id}")
            return {
                "status": "DISPATCHED",
                "message_id": msg_id,
                "caption": caption
            }
        else:
            logger.error(f"Telegram dispatch failed (status {resp.status_code}): {resp.text}")
            raise RuntimeError(f"Telegram dispatch failed: {resp.text}")
