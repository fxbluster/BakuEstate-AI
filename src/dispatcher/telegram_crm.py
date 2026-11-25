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
from typing import Dict, Any, Optional, Union
from datetime import datetime, timezone
import urllib.parse
import requests

from config.settings import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_MOCK_DISPATCH, OUTPUT_DIR
try:
    from config.settings import AGENCY_WHATSAPP_PHONE
except ImportError:
    AGENCY_WHATSAPP_PHONE = os.getenv("AGENCY_WHATSAPP_PHONE", "994501234567")

from src.scraper.bina_scraper import clean_phone_number

logger = logging.getLogger("telegram_crm")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

NICHE_LABELS: Dict[str, str] = {
    "LUXURY": "LÜKS & MƏRKƏZ",
    "AFFORDABLE": "SƏRFƏLİ EVLƏR",
    "TIKTOK": "VİRAL & TƏCİLİ",
    "GENERAL": "ÜMUMİ BAZAR",
}

NICHE_SLUGS: Dict[str, str] = {
    "LUXURY": "luxury",
    "AFFORDABLE": "affordable",
    "TIKTOK": "tiktok",
    "GENERAL": "general",
}

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
    title = str(listing.get("title", "")).lower()
    desc = str(listing.get("description", "")).lower()
    combined = f"{title} {desc}"
    is_apartment_title = "mənzil" in title or "menzil" in title

    if any(k in title for k in ["həyət evi", "heyet evi", "bağ evi", "bag evi"]) or (
        not is_apartment_title and any(k in combined for k in ["həyət evi", "heyet evi", "bağ evi", "bag evi"])
    ):
        return "HƏYƏT EVİ"
    elif "villa" in title or (not is_apartment_title and "villa" in combined):
        return "VİLLA"
    elif any(k in title for k in ["obyekt", "ofis", "kommersiya"]) or (
        not is_apartment_title and any(k in combined for k in ["obyekt satılır", "qeyri-yaşayış"])
    ):
        return "OBYEKT"
    return "MƏNZİL"


def get_targeted_hashtags(prop_type: str, has_bill_of_sale: bool = False) -> list[str]:
    """Returns at most 5 high-converting, clean viral hashtags without competitor tags."""
    doc_tag = "#kupcali" if has_bill_of_sale else "#dasinmazemlak"
    if prop_type == "HƏYƏT EVİ":
        return ["#emlak", "#evler", "#heyetevleri", doc_tag, "#baku"]
    elif prop_type == "VİLLA":
        return ["#villa", "#luxuryrealestate", "#baku", "#emlak", doc_tag]
    else:
        return ["#emlak", "#menzil", "#baku", doc_tag, "#baki" if not has_bill_of_sale else "#ipoteka"]


def generate_crm_caption(
    listing: Dict[str, Any],
    target_account_handle: Optional[str] = None,
    channel_niche: Optional[str] = None,
    fallback_triggered: bool = False,
) -> str:
    """Generates the private CRM lead card for the agency/investor."""
    handle = target_account_handle or listing.get("target_account_handle")
    niche = channel_niche or listing.get("channel_niche")
    if not handle or not niche:
        try:
            from src.worker.account_router import route_listing_to_channel
            route_info = route_listing_to_channel(listing)
            handle = handle or route_info.get("target_account_handle")
            niche = niche or route_info.get("channel_niche")
        except Exception:
            pass

    handle = handle or "@bakuestate.official"
    niche = (niche or "GENERAL").upper()
    niche_name = NICHE_LABELS.get(niche, niche)
    clean_handle = re.sub(r'[^a-zA-Z0-9_.-]', '', str(handle).lstrip('@'))

    if niche == "TIKTOK" or "tiktok" in clean_handle.lower():
        platform_name = "TikTok"
        platform_deep_link = f"https://www.tiktok.com/@{clean_handle}"
    else:
        platform_name = "Instagram"
        platform_deep_link = f"https://instagram.com/{clean_handle}"

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
        f"🎯 <b>PAYLAŞILACAQ HESAB: @{clean_handle} ({niche_name})</b>",
        f"📲 <a href=\"{platform_deep_link}\">{platform_name} Profilini Aç</a>",
        "",
        "💼 <b>DAXİLİ CRM — MÜLKİYYƏTÇİ İLƏ ƏLAQƏ</b>",
        f"👤 <b>Elan Sahibi:</b> {listing.get('contact_name') or 'Mülkiyyətçi'} ({seller_title})",
        f"📞 <b>Telefon:</b> <code>{raw_phone or 'Qeyd olunmayıb'}</code>",
        f"💬 <b>WhatsApp:</b> <a href=\"{wa_link}\">Mülkiyyətçiyə WhatsApp-da Yaz</a>",
        f"🔗 <b>bina.az Linki:</b> https://bina.az/items/{bina_id}",
        f"💰 <b>Qiymət:</b> {formatted_price} {curr} | 📍 <b>Ərazi:</b> {loc}"
    ]

    is_fallback = fallback_triggered or bool(listing.get("tts_fallback") or listing.get("fallback_triggered"))
    if is_fallback:
        lines.append("")
        lines.append("⚠️ <b>DİQQƏT:</b> ElevenLabs balansı/kvotası bitdiyi üçün bu video müvəqqəti Edge-TTS ilə hazırlandı.")

    return "\n".join(lines)


def generate_public_caption(listing: Dict[str, Any]) -> str:
    """
    Generates a clean, 1-tap copy-paste Instagram/TikTok caption.
    Strictly NO owner numbers, NO competitor links, max 5 hashtags.
    Formats public WhatsApp inquiry link with AGENCY_WHATSAPP_PHONE and niche-slug attribution.
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
    has_kupca = bool(listing.get("has_bill_of_sale", False))
    hashtags = get_targeted_hashtags(prop_type, has_bill_of_sale=has_kupca)[:5]
    kupca_badge = (
        "✅ Dövlət Çıxarışı (Kupça) var - İpotekaya yararlıdır!"
        if has_kupca
        else "Müqaviləli / Sənəd dəqiqləşdirilir"
    )

    bina_id = str(listing.get("bina_id", "")).strip()
    niche = listing.get("channel_niche")
    if not niche:
        try:
            from src.worker.account_router import route_listing_to_channel
            niche = route_listing_to_channel(listing).get("channel_niche")
        except Exception:
            pass
    niche_slug = NICHE_SLUGS.get((niche or "GENERAL").upper(), "general")

    agency_phone = re.sub(r"[^\d]", "", str(AGENCY_WHATSAPP_PHONE or "994501234567"))
    wa_text = f"Salam, kod:{bina_id}-{niche_slug}"
    public_wa_link = f"https://wa.me/{agency_phone}?text={urllib.parse.quote(wa_text)}"

    headline = (
        f"🔥 <b>TƏCİLİ KUPÇALI {prop_type} SATILIR!</b> 🔥"
        if has_kupca
        else f"🔥 <b>{prop_type} SATILIR!</b> 🔥"
    )

    caption_lines = [
        headline,
        "",
        f"💰 <b>Qiymət:</b> {formatted_price} {curr}",
        f"📍 <b>Ünvan:</b> {loc}",
        f"📐 <b>Parametrlər:</b> {rooms} otaq | {area_str}{floor_str}",
        f"📜 <b>Sənəd:</b> {kupca_badge}",
        "",
        f"📲 <b>WhatsApp:</b> <a href=\"{public_wa_link}\">Ətraflı məlumat üçün keçid edin</a> (kod: {bina_id}-{niche_slug})",
        "📩 <b>Ətraflı məlumat və baxış üçün Direktə (DM) yazın və ya profildəki WhatsApp linkinə keçin!</b>",
        "",
        " ".join(hashtags)
    ]
    return "\n".join(caption_lines)


def build_inline_keyboard(listing: Dict[str, Any], fallback_triggered: bool = False) -> Dict[str, Any]:
    """
    Builds the interactive inline keyboard for Telegram:
    If fallback_triggered is True, prepends [ 🔄 ElevenLabs ilə Təkrar Render ].
    Row 1: [ 🔄 Yenidən Render Et ], [ ✍️ Ssenarini Dəyiş ]
    Row 2: [ 🎙️ Səsi Dəyiş ], [ 📊 Keenable Hesabatı ]
    Row 3: [ 💬 WhatsApp Sahibinə ], [ 🌐 Bina.az Elanı ]
    Row 4: [ 🚀 Təsdiqlə və Paylaş ], [ ❌ Arxivlə ]
    """
    bina_id = str(listing.get("bina_id", ""))
    raw_phone = listing.get("owner_phone", "")
    normalized_phone = clean_phone_number(raw_phone)
    wa_digits = normalized_phone.lstrip("+")
    prop_type = get_property_type(listing)

    if wa_digits:
        wa_text = f"Salam, bina.az-dakı {bina_id} nömrəli {prop_type.lower()} elanınızla bağlı yazıram."
        wa_url = f"https://wa.me/{wa_digits}?text={urllib.parse.quote(wa_text)}"
    else:
        wa_url = f"https://bina.az/items/{bina_id}"

    bina_url = f"https://bina.az/items/{bina_id}"

    keyboard = [
        [
            {"text": "🔄 Yenidən Render Et", "callback_data": f"rerender_{bina_id}"},
            {"text": "✍️ Ssenarini Dəyiş", "callback_data": f"scriptmenu_{bina_id}"}
        ],
        [
            {"text": "🎙️ Səsi Dəyiş", "callback_data": f"voicemenu_{bina_id}"},
            {"text": "📊 Keenable Hesabatı", "callback_data": f"keenable_{bina_id}"}
        ],
        [
            {"text": "💬 WhatsApp Sahibinə", "url": wa_url},
            {"text": "🌐 Bina.az Elanı", "url": bina_url}
        ],
        [
            {"text": "🚀 Təsdiqlə və Paylaş", "callback_data": f"publish_{bina_id}"},
            {"text": "❌ Arxivlə", "callback_data": f"archive_{bina_id}"}
        ]
    ]

    is_fallback = fallback_triggered or bool(listing.get("tts_fallback") or listing.get("fallback_triggered"))
    if is_fallback:
        keyboard.insert(0, [
            {"text": "🔄 ElevenLabs ilə Təkrar Render", "callback_data": f"rerender_eleven_{bina_id}"}
        ])

    return {"inline_keyboard": keyboard}


class TelegramFormattedCard(dict):
    """
    Container for formatted Telegram messages supporting both dict access,
    attribute access (.text, .reply_markup), and tuple unpacking (text, markup).
    """
    def __init__(self, text: str, reply_markup: Dict[str, Any]):
        super().__init__(text=text, reply_markup=reply_markup)
        self.text = text
        self.reply_markup = reply_markup

    def __iter__(self):
        return iter((self.text, self.reply_markup))

    def __getitem__(self, item):
        if item == 0:
            return self.text
        if item == 1:
            return self.reply_markup
        return super().__getitem__(item)


def format_cockpit_card_telegram(card: Dict[str, Any]) -> TelegramFormattedCard:
    """
    Formats an AI Advisory Cockpit Card into an executive Telegram HTML message
    with interactive inline buttons:
    - [ 💬 WhatsApp Sahibinə ]
    - [ 🚀 Təsdiqlə ] (callback: cockpit_act_{id})
    - [ ❌ Ləğv Et ] (callback: cockpit_dismiss_{id})
    """
    card_id = str(card.get("id") or card.get("card_id") or "")
    headline = str(card.get("headline") or "AI Məsləhət Kartı").strip()
    channel = str(card.get("channel") or "WHATSAPP").upper().strip()
    priority = str(card.get("priority") or "NORMAL").upper().strip()
    reason = str(card.get("reason") or card.get("strategic_rationale") or "").strip()
    draft_text = str(card.get("draft_text") or "").strip()
    sentinel_warning = card.get("sentinel_warning")
    raw_phone = card.get("owner_phone") or card.get("phone") or ""
    target_uri = card.get("target_uri")

    # Priority icon
    priority_icons = {
        "URGENT": "🔴 TƏCİLİ",
        "HIGH": "🟠 YÜKSƏK",
        "NORMAL": "🟡 STANDART",
        "LOW": "⚪ AŞAĞI"
    }
    p_badge = priority_icons.get(priority, "🟡 STANDART")

    # Channel icon
    channel_icons = {
        "WHATSAPP": "📱 WhatsApp",
        "TELEGRAM": "✈️ Telegram",
        "CALL": "📞 Zəng",
        "INSTAGRAM": "📸 Instagram DM",
        "TIKTOK": "🎵 TikTok DM",
        "SMS": "✉️ SMS"
    }
    c_badge = channel_icons.get(channel, f"📡 {channel}")

    # Build WhatsApp URL
    normalized_phone = clean_phone_number(raw_phone) if raw_phone else ""
    wa_digits = normalized_phone.lstrip("+")
    if wa_digits:
        wa_url = f"https://wa.me/{wa_digits}?text={urllib.parse.quote(draft_text)}"
    elif target_uri and str(target_uri).startswith("http"):
        wa_url = str(target_uri)
    else:
        wa_url = f"https://wa.me/?text={urllib.parse.quote(draft_text)}" if draft_text else "https://wa.me/"

    lines = [
        "🎯 <b>AI SATIŞ MƏŞVƏRƏT KARTI (COCKPIT HUD)</b>",
        f"⚡ <b>Prioritet:</b> {p_badge} | <b>Kanal:</b> {c_badge}",
        f"📌 <b>Başlıq:</b> <b>{headline}</b>",
    ]

    if reason:
        lines.append(f"💡 <b>Strategiya:</b> <i>{reason}</i>")

    if sentinel_warning:
        lines.append(f"\n⚠️ <b>Sentinel Qoruyucu:</b> <i>{sentinel_warning}</i>")

    if draft_text:
        lines.append(
            "\n💬 <b>Hazır Mesaj (kopyalamaq üçün toxunun):</b>\n"
            f"<code>{draft_text}</code>"
        )

    lines.append("\n<i>Aşağıdakı düymələrlə dərhal icra edin və ya ləğv edin:</i>")
    text = "\n".join(lines)

    reply_markup = {
        "inline_keyboard": [
            [
                {"text": "💬 WhatsApp Sahibinə", "url": wa_url}
            ],
            [
                {"text": "🚀 Təsdiqlə", "callback_data": f"cockpit_act_{card_id}"},
                {"text": "❌ Ləğv Et", "callback_data": f"cockpit_dismiss_{card_id}"}
            ]
        ]
    }

    return TelegramFormattedCard(text=text, reply_markup=reply_markup)


def generate_social_caption(
    listing: Dict[str, Any],
    target_account_handle: Optional[str] = None,
    channel_niche: Optional[str] = None,
    fallback_triggered: bool = False,
) -> str:
    """Returns the combined caption for backward-compatibility or full display."""
    crm = generate_crm_caption(
        listing,
        target_account_handle=target_account_handle,
        channel_niche=channel_niche,
        fallback_triggered=fallback_triggered,
    )
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
        listing: Union[Dict[str, Any], str],
        video_path: Optional[str] = None,
        custom_caption: Optional[str] = None,
        target_account_handle: Optional[str] = None,
        channel_niche: Optional[str] = None,
        fallback_triggered: bool = False,
        force_multipart: bool = True,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """
        Sends the MP4 video with internal CRM details via multipart upload,
        followed immediately by a standalone 1-tap copy-paste Instagram/TikTok caption.
        Accepts either a listing dict or listing_id string, and optional video_path.
        """
        if isinstance(listing, str):
            listing_str = listing.strip()
            resolved = None
            try:
                from src.cloud.supabase_repo import SupabaseRepo
                repo = SupabaseRepo()
                if repo.is_configured():
                    resolved = repo.get_listing_by_id(listing_str) or repo.get_listing_by_bina_id(listing_str)
            except Exception:
                pass
            if not resolved:
                resolved = {"id": listing_str, "bina_id": listing_str}
            listing = resolved

        if not video_path:
            bina_id = str(listing.get("bina_id") or listing.get("id") or "").strip()
            candidate = OUTPUT_DIR / f"{bina_id}.mp4"
            if candidate.exists():
                video_path = str(candidate)
            else:
                cdn_url = listing.get("video_cdn_url")
                if not cdn_url:
                    try:
                        from src.cloud.supabase_repo import SupabaseRepo
                        repo = SupabaseRepo()
                        if repo.is_configured() and listing.get("id"):
                            rv = repo.get_latest_render_version(str(listing["id"]))
                            if rv and rv.get("video_cdn_url"):
                                cdn_url = rv["video_cdn_url"]
                    except Exception:
                        pass
                if cdn_url:
                    candidate.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        resp = requests.get(cdn_url, stream=True, timeout=60)
                        if resp.status_code == 200:
                            with open(candidate, "wb") as f:
                                for chunk in resp.iter_content(chunk_size=65536):
                                    f.write(chunk)
                            video_path = str(candidate)
                    except Exception as err:
                        logger.warning(f"Could not download video from {cdn_url}: {err}")
                if not video_path:
                    if self.mock_mode:
                        candidate.parent.mkdir(parents=True, exist_ok=True)
                        candidate.write_bytes(b"mock video data")
                        video_path = str(candidate)
                    else:
                        raise FileNotFoundError(f"Video file not found for listing {bina_id}")

        crm_caption = generate_crm_caption(
            listing,
            target_account_handle=target_account_handle,
            channel_niche=channel_niche,
            fallback_triggered=fallback_triggered,
        )
        public_caption = custom_caption or generate_public_caption(listing)
        video_file = Path(video_path)
        reply_markup = build_inline_keyboard(listing, fallback_triggered=fallback_triggered)

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
                "reply_markup": reply_markup,
                "dispatched_at": json.dumps(str(Path(video_path).stat().st_mtime))
            }
            with open(lead_dump_path, "w", encoding="utf-8") as f:
                json.dump(lead_data, f, ensure_ascii=False, indent=2)

            return {
                "status": "MOCK_SUCCESS",
                "message_id": f"mock_msg_{listing.get('bina_id')}",
                "lead_dump": str(lead_dump_path.resolve()),
                "crm_caption": crm_caption,
                "public_caption": public_caption,
                "reply_markup": reply_markup
            }

        # 1. Real Telegram API: Send Video with CRM Lead Card & Interactive Inline Keyboard
        logger.info(f"Uploading video {video_path} to Telegram chat {self.chat_id} with interactive buttons...")
        api_video_url = f"https://api.telegram.org/bot{self.bot_token}/sendVideo"

        with open(video_file, "rb") as vf:
            payload = {
                "chat_id": self.chat_id,
                "caption": crm_caption,
                "parse_mode": "HTML",
                "supports_streaming": True,
                "reply_markup": json.dumps(reply_markup)
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
            "public_caption": public_caption,
            "reply_markup": reply_markup
        }

    def send_cockpit_card(self, card: Dict[str, Any]) -> Dict[str, Any]:
        """
        Sends an advisory Cockpit Card to Telegram with 1-click action buttons:
        [ 💬 WhatsApp Sahibinə ], [ 🚀 Təsdiqlə ], [ ❌ Ləğv Et ].
        """
        formatted = format_cockpit_card_telegram(card)
        card_id = str(card.get("id") or card.get("card_id") or "")

        if self.mock_mode:
            logger.info(f"[MOCK DISPATCH] Cockpit Card {card_id} simulation.")
            dump_path = OUTPUT_DIR / f"cockpit_card_{card_id}.json"
            data = {
                "card_id": card_id,
                "text": formatted.text,
                "reply_markup": formatted.reply_markup,
                "dispatched_at": json.dumps(str(datetime.now(timezone.utc).isoformat()))
            }
            try:
                with open(dump_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            except Exception:
                pass
            return {
                "status": "MOCK_SUCCESS",
                "message_id": f"mock_card_{card_id}",
                "card_id": card_id,
                "text": formatted.text,
                "reply_markup": formatted.reply_markup
            }

        url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        payload = {
            "chat_id": self.chat_id,
            "text": formatted.text,
            "parse_mode": "HTML",
            "reply_markup": formatted.reply_markup
        }

        try:
            resp = requests.post(url, json=payload, timeout=20)
            if resp.status_code == 200:
                msg_id = str(resp.json().get("result", {}).get("message_id", ""))
                logger.info(f"Cockpit Card {card_id} successfully sent! Telegram msg_id: {msg_id}")
                return {
                    "status": "DISPATCHED",
                    "message_id": msg_id,
                    "card_id": card_id,
                    "text": formatted.text,
                    "reply_markup": formatted.reply_markup
                }
            else:
                logger.error(f"Failed to send Cockpit Card to Telegram: {resp.text}")
                return {"status": "ERROR", "error": resp.text, "card_id": card_id}
        except Exception as e:
            logger.error(f"Exception sending Cockpit Card to Telegram: {e}")
            return {"status": "ERROR", "error": str(e), "card_id": card_id}

