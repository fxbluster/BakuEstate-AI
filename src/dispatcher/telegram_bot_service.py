"""
[LOCAL DEV / FALLBACK] Interactive Telegram Bot Long-Polling Service for BakuEstate-AI.
In 24/7 production, Telegram callbacks and commands (/lead, /today) are handled by the
Supabase Edge Function (`supabase/functions/telegram-webhook`).

This local polling service is retained for local development/fallback with:
- Strict fail-closed `chat_id == TELEGRAM_CHAT_ID` authorization on all updates/callbacks
- Thread-safe explicit `voice_engine`, `voice_id`, `script_angle` parameters (no `os.environ` mutation)
- In-place `editMessageMedia` via `update_telegram_message_id`
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
import json
import time
import logging
import urllib.parse
from pathlib import Path
from typing import Dict, Any, Optional, List, Union
from concurrent.futures import ThreadPoolExecutor

_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import requests

from config.settings import (
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    DB_PATH,
    OUTPUT_DIR
)
from src.database import get_listing_by_bina_id, update_listing_status
from src.google_pool.brave_gemini_client import get_keenable_market_comparison
from src.dispatcher.telegram_crm import (
    build_inline_keyboard,
    get_property_type,
    generate_public_caption,
    generate_crm_caption,
    format_cockpit_card_telegram,
)

logger = logging.getLogger("telegram_bot_service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def get_main_keyboard(bina_id: str, wa_url: str, bina_url: str) -> Dict[str, Any]:
    """Generates the primary 4-row executive inline keyboard."""
    return {
        "inline_keyboard": [
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
    }


def get_script_menu_keyboard(bina_id: str) -> Dict[str, Any]:
    """Submenu for selecting real estate script marketing angles."""
    return {
        "inline_keyboard": [
            [
                {"text": "👨‍👩‍👧‍👦 Ailəvi Yaşayış Bucaqı", "callback_data": f"scriptset_{bina_id}_family"},
                {"text": "📈 İnvestisiya / İcarə ROI", "callback_data": f"scriptset_{bina_id}_investor"}
            ],
            [
                {"text": "⚡ Təcili Qiymət Fürsəti", "callback_data": f"scriptset_{bina_id}_urgent"},
                {"text": "👑 Lüks & Prestij", "callback_data": f"scriptset_{bina_id}_luxury"}
            ],
            [
                {"text": "⬅️ Əsas Menyuya Qayıt", "callback_data": f"mainmenu_{bina_id}"}
            ]
        ]
    }


def get_voice_menu_keyboard(bina_id: str) -> Dict[str, Any]:
    """Submenu for selecting voice engines."""
    return {
        "inline_keyboard": [
            [
                {"text": "💎 ElevenLabs — Arif (Studio)", "callback_data": f"voiceset_{bina_id}_eleven_male"},
                {"text": "🌸 ElevenLabs (Xanım Dinamik)", "callback_data": f"voiceset_{bina_id}_eleven_female"}
            ],
            [
                {"text": "🎙️ OpenAI Nova HD", "callback_data": f"voiceset_{bina_id}_nova"},
                {"text": "📻 Edge-TTS Babek (0 AZN)", "callback_data": f"voiceset_{bina_id}_edge"}
            ],
            [
                {"text": "⬅️ Əsas Menyuya Qayıt", "callback_data": f"mainmenu_{bina_id}"}
            ]
        ]
    }


def get_published_keyboard(bina_id: str) -> Dict[str, Any]:
    """Keyboard state once deal is approved and published."""
    return {
        "inline_keyboard": [
            [
                {"text": "✅ Paylaşıldı və Arxivləndi", "callback_data": f"noop_{bina_id}"}
            ],
            [
                {"text": "🌐 Bina.az Elanı", "url": f"https://bina.az/items/{bina_id}"}
            ]
        ]
    }


def get_archived_keyboard(bina_id: str) -> Dict[str, Any]:
    """Keyboard state once deal is archived."""
    return {
        "inline_keyboard": [
            [
                {"text": "❌ Bu Elan Arxivləşdirilib", "callback_data": f"noop_{bina_id}"}
            ]
        ]
    }


VOICE_CHOICE_MAP: Dict[str, tuple[str, Optional[str]]] = {
    "eleven_male": ("elevenlabs", "ZQJv3hwvRAIC7fvWZ1Qr"),
    "eleven_female": ("elevenlabs", "DZaip8UahF0Qri1FxU8M"),
    "eleven_arif": ("elevenlabs", "ZQJv3hwvRAIC7fvWZ1Qr"),
    "eleven_ayan": ("elevenlabs", "DZaip8UahF0Qri1FxU8M"),
    "nova": ("openai", None),
    "edge": ("edge", None),
}


def resolve_voice_choice(voice_choice: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Maps Telegram callback voice selector key to explicit (voice_engine, voice_id)."""
    if not voice_choice:
        return None, None
    return VOICE_CHOICE_MAP.get(voice_choice, (None, None))


class TelegramBotService:
    """
    Manages bidirectional Telegram Bot updates and interactive callback queries.
    Operates non-blocking through an internal thread pool executor.
    Enforces strict chat_id authorization against TELEGRAM_CHAT_ID.
    """

    def __init__(
        self,
        bot_token: Optional[str] = None,
        chat_id: Optional[str] = None,
        db_path: Optional[Path] = None,
        executor_workers: int = 4
    ):
        self.bot_token = bot_token if bot_token is not None else TELEGRAM_BOT_TOKEN
        self.chat_id = str(chat_id if chat_id is not None else (TELEGRAM_CHAT_ID or "")).strip()
        self.db_path = db_path or DB_PATH
        self.base_url = f"https://api.telegram.org/bot{self.bot_token}" if self.bot_token else ""
        self.executor = ThreadPoolExecutor(max_workers=executor_workers)
        self.last_update_id = 0
        self.is_running = False

    def dispatch_video_lead(self, *args, **kwargs) -> Dict[str, Any]:
        """Deprecated: Video lead automatic dispatch has been replaced by pre-flight verification gate."""
        return {"status": "DEPRECATED"}

    def is_authorized_chat(self, incoming_chat_id: Optional[Union[int, str]]) -> bool:
        """Fail-closed check ensuring incoming Telegram chat_id strictly matches configured operator chat_id."""
        allowed = str(self.chat_id or "").strip()
        if not allowed or incoming_chat_id is None:
            return False
        return str(incoming_chat_id).strip() == allowed

    def answer_callback_query(
        self,
        callback_query_id: str,
        text: str = "",
        show_alert: bool = False
    ) -> bool:
        """Sends an acknowledgement or smartphone popup alert to Telegram callback."""
        if not self.base_url:
            logger.info(f"[MOCK] answerCallbackQuery: id={callback_query_id}, text='{text}', alert={show_alert}")
            return True

        url = f"{self.base_url}/answerCallbackQuery"
        payload = {
            "callback_query_id": callback_query_id,
            "text": text,
            "show_alert": show_alert
        }
        try:
            r = requests.post(url, json=payload, timeout=10)
            return r.status_code == 200
        except Exception as e:
            logger.warning(f"Error in answer_callback_query: {e}")
            return False

    def edit_message_reply_markup(
        self,
        chat_id: Union[int, str],
        message_id: int,
        reply_markup: Dict[str, Any]
    ) -> bool:
        """Updates the inline keyboard on an existing message in-place."""
        if not self.base_url:
            logger.info(f"[MOCK] editMessageReplyMarkup: msg={message_id}")
            return True

        url = f"{self.base_url}/editMessageReplyMarkup"
        payload = {
            "chat_id": chat_id,
            "message_id": message_id,
            "reply_markup": reply_markup
        }
        try:
            r = requests.post(url, json=payload, timeout=10)
            return r.status_code == 200
        except Exception as e:
            logger.warning(f"Error in edit_message_reply_markup: {e}")
            return False

    def edit_message_media(
        self,
        chat_id: Union[int, str],
        message_id: int,
        video_path: str,
        caption: str = "",
        reply_markup: Optional[Dict[str, Any]] = None
    ) -> bool:
        """Replaces video media in-place without producing duplicate chat clutter."""
        video_file = Path(video_path)
        if not video_file.exists():
            logger.error(f"Media file not found for editing: {video_path}")
            return False

        if not self.base_url:
            logger.info(f"[MOCK] editMessageMedia: msg={message_id}, video={video_path}")
            return True

        url = f"{self.base_url}/editMessageMedia"
        media_obj = {
            "type": "video",
            "media": "attach://video",
            "caption": caption,
            "parse_mode": "HTML",
            "supports_streaming": True
        }
        payload = {
            "chat_id": chat_id,
            "message_id": message_id,
            "media": json.dumps(media_obj)
        }
        if reply_markup:
            payload["reply_markup"] = json.dumps(reply_markup)

        try:
            with open(video_file, "rb") as vf:
                files = {"video": (video_file.name, vf, "video/mp4")}
                r = requests.post(url, data=payload, files=files, timeout=120)
            return r.status_code == 200
        except Exception as e:
            logger.warning(f"Error in edit_message_media: {e}")
            return False

    def send_message(
        self,
        chat_id: Optional[Union[int, str]] = None,
        text: str = "",
        parse_mode: Optional[str] = "HTML",
        reply_markup: Optional[Dict[str, Any]] = None
    ) -> Optional[int]:
        """Sends a standard text message."""
        target_chat_id = str(chat_id if chat_id is not None else (self.chat_id or "")).strip()
        if not target_chat_id:
            logger.warning("send_message: no target chat_id provided and self.chat_id is empty")
            return None

        if not self.base_url:
            logger.info(f"[MOCK] sendMessage: chat_id={target_chat_id}, text='{text[:50]}...'")
            return 999999

        url = f"{self.base_url}/sendMessage"
        payload: Dict[str, Any] = {
            "chat_id": target_chat_id,
            "text": text,
        }
        if parse_mode:
            payload["parse_mode"] = parse_mode
        if reply_markup:
            payload["reply_markup"] = reply_markup

        try:
            r = requests.post(url, json=payload, timeout=20)
            if r.status_code == 200:
                return r.json().get("result", {}).get("message_id")
        except Exception as e:
            logger.warning(f"Error in send_message: {e}")
        return None

    def send_cockpit_card(
        self,
        card: Dict[str, Any],
        chat_id: Optional[Union[int, str]] = None
    ) -> Optional[int]:
        """Sends an advisory Cockpit Card to Telegram with interactive action buttons."""
        formatted = format_cockpit_card_telegram(card)
        return self.send_message(
            chat_id=chat_id,
            text=formatted.text,
            parse_mode="HTML",
            reply_markup=formatted.reply_markup
        )

    def on_callback_query(self, callback_query: Dict[str, Any]) -> Dict[str, Any]:
        """Alias for handle_callback_query for uniform callback dispatcher interface."""
        return self.handle_callback_query(callback_query)

    def handle_callback_query(self, callback_query: Dict[str, Any]) -> Dict[str, Any]:
        """
        Processes an incoming callback query after verifying strict chat_id authorization.
        """
        cb_id = str(callback_query.get("id", ""))
        data = str(callback_query.get("data", ""))
        message = callback_query.get("message") or {}
        message_id = message.get("message_id", 0)
        chat = message.get("chat") or {}
        chat_id = chat.get("id")

        if not self.is_authorized_chat(chat_id):
            logger.warning(
                f"Blocked unauthorized Telegram callback from chat_id={chat_id!r} (data='{data}')"
            )
            return {"action": "unauthorized", "authorized": False, "chat_id": chat_id}

        logger.info(f"Processing Telegram callback: '{data}' (msg_id: {message_id})")

        # 0. Cockpit Advisory Card Actions
        if data.startswith("cockpit_act_"):
            card_id = data[len("cockpit_act_"):]
            try:
                from src.cloud.supabase_repo import SupabaseRepo
                repo = SupabaseRepo()
                repo.update_cockpit_card_status(card_id, "EXECUTED")
                repo.append_lead_timeline_event(
                    actor="OPERATOR",
                    event_type="OFFER",
                    summary=f"Cockpit kartı təsdiqləndi: {card_id}",
                    metadata={"card_id": card_id, "action": "ACT"}
                )
            except Exception as e:
                logger.warning(f"Error updating cockpit card {card_id}: {e}")

            self.answer_callback_query(cb_id, text="🚀 Cockpit kartı təsdiqləndi və icraya göndərildi!")
            executed_kb = {
                "inline_keyboard": [
                    [{"text": "✅ Təsdiqləndi (İcrada)", "callback_data": f"noop_{card_id}"}]
                ]
            }
            self.edit_message_reply_markup(chat_id, message_id, executed_kb)
            return {"action": "cockpit_act", "card_id": card_id, "status": "EXECUTED"}

        elif data.startswith("cockpit_dismiss_"):
            card_id = data[len("cockpit_dismiss_"):]
            try:
                from src.cloud.supabase_repo import SupabaseRepo
                repo = SupabaseRepo()
                repo.update_cockpit_card_status(card_id, "DISMISSED")
                repo.append_lead_timeline_event(
                    actor="OPERATOR",
                    event_type="OBJECTION",
                    summary=f"Cockpit kartı ləğv edildi: {card_id}",
                    metadata={"card_id": card_id, "action": "DISMISS"}
                )
            except Exception as e:
                logger.warning(f"Error dismissing cockpit card {card_id}: {e}")

            self.answer_callback_query(cb_id, text="❌ Cockpit kartı ləğv edildi.")
            dismissed_kb = {
                "inline_keyboard": [
                    [{"text": "❌ Ləğv Edildi", "callback_data": f"noop_{card_id}"}]
                ]
            }
            self.edit_message_reply_markup(chat_id, message_id, dismissed_kb)
            return {"action": "cockpit_dismiss", "card_id": card_id, "status": "DISMISSED"}

        # 0.1 Explicit ElevenLabs re-render callback (prevents split('_', 1) collision on rerender_eleven_{bina_id})
        elif data.startswith("rerender_eleven_"):
            bina_id = data.replace("rerender_eleven_", "")
            self.answer_callback_query(cb_id, text="🔄 ElevenLabs ilə təkrar render başladıldı...")
            loading_kb = {
                "inline_keyboard": [
                    [{"text": "⏳ ElevenLabs ilə Hazırlanır (təxm. 12s)...", "callback_data": f"noop_{bina_id}"}]
                ]
            }
            self.edit_message_reply_markup(chat_id, message_id, loading_kb)
            self.executor.submit(self._execute_rerender_job, bina_id, chat_id, message_id, voice_choice="eleven_male")
            return {"action": "rerender_eleven", "bina_id": bina_id, "voice_choice": "eleven_male"}

        # Parse callback action and bina_id
        parts = data.split("_", 1)
        action = parts[0]
        arg = parts[1] if len(parts) > 1 else ""

        # 1. Keenable Market Analysis Modal Popup
        if action == "keenable":
            bina_id = arg
            listing = get_listing_by_bina_id(bina_id, self.db_path) or {}
            loc = listing.get("location") or "Bakı"
            price = listing.get("price", 0)
            area = listing.get("area", 0)

            stats = get_keenable_market_comparison(loc, price, area)
            if stats and stats.get("m2_price"):
                dist = stats.get("district", "Bakı")
                med = stats.get("district_median", 0)
                m2_p = stats.get("m2_price", 0)
                disc = stats.get("discount_pct", 0)
                diff_azn = int(abs(med - m2_p) * (float(area) if area else 1))

                alert_text = (
                    f"📊 KEENABLE BAZAR ANALİTİKASI (2026)\n\n"
                    f"📍 Ərazi: {dist}\n"
                    f"🏢 Median Qiymət: {med:,} AZN/m²\n"
                    f"💰 Bu Mənzildə: {m2_p:,} AZN/m²\n"
                    f"📉 Bazar Fərqi: {disc}% {'UCUZ!' if disc > 0 else 'BAHA'}\n"
                    f"💵 Ümumi Qənaət: təxm. {diff_azn:,} AZN!"
                ).replace(",", " ")
            else:
                alert_text = f"📊 {loc} üzrə bazar məlumatı hesablandı: {price} AZN / {area} m²."

            self.answer_callback_query(cb_id, text=alert_text, show_alert=True)
            return {"action": "keenable", "bina_id": bina_id, "alert": alert_text}

        # 2. Script Menu Switch
        elif action == "scriptmenu":
            bina_id = arg
            self.answer_callback_query(cb_id, text="Ssenari bucağını seçin 👇")
            self.edit_message_reply_markup(chat_id, message_id, get_script_menu_keyboard(bina_id))
            return {"action": "scriptmenu", "bina_id": bina_id}

        # 3. Voice Menu Switch
        elif action == "voicemenu":
            bina_id = arg
            self.answer_callback_query(cb_id, text="Səs mühərrikini seçin 👇")
            self.edit_message_reply_markup(chat_id, message_id, get_voice_menu_keyboard(bina_id))
            return {"action": "voicemenu", "bina_id": bina_id}

        # 4. Main Menu Restore
        elif action == "mainmenu":
            bina_id = arg
            listing = get_listing_by_bina_id(bina_id, self.db_path) or {"bina_id": bina_id}
            main_kb = build_inline_keyboard(listing)
            self.answer_callback_query(cb_id, text="Əsas menyu")
            self.edit_message_reply_markup(chat_id, message_id, main_kb)
            return {"action": "mainmenu", "bina_id": bina_id}

        # 5. Publish Deal
        elif action == "publish":
            bina_id = arg
            update_listing_status(bina_id, "PUBLISHED", db_path=self.db_path)
            self.answer_callback_query(cb_id, text="🚀 Təsdiqləndi! Notion və Supabase-də yeniləndi.", show_alert=False)
            self.edit_message_reply_markup(chat_id, message_id, get_published_keyboard(bina_id))

            # Send copyable public caption
            listing = get_listing_by_bina_id(bina_id, self.db_path) or {"bina_id": bina_id}
            pub_caption = generate_public_caption(listing)
            self.send_message(chat_id, pub_caption)
            return {"action": "publish", "bina_id": bina_id, "status": "PUBLISHED"}

        # 6. Archive Deal
        elif action == "archive":
            bina_id = arg
            update_listing_status(bina_id, "ARCHIVED", db_path=self.db_path)
            self.answer_callback_query(cb_id, text="❌ Elan arxivləşdirildi.")
            self.edit_message_reply_markup(chat_id, message_id, get_archived_keyboard(bina_id))
            return {"action": "archive", "bina_id": bina_id, "status": "ARCHIVED"}

        # 7. Re-render Trigger
        elif action == "rerender":
            bina_id = arg
            self.answer_callback_query(cb_id, text="🔄 Yenidən render başladıldı...")
            
            # Temporary loading button
            loading_kb = {
                "inline_keyboard": [
                    [{"text": "⏳ Video Hazırlanır (təxm. 12s)...", "callback_data": f"noop_{bina_id}"}]
                ]
            }
            self.edit_message_reply_markup(chat_id, message_id, loading_kb)

            # Enqueue asynchronous re-render job
            self.executor.submit(self._execute_rerender_job, bina_id, chat_id, message_id)
            return {"action": "rerender_queued", "bina_id": bina_id}

        # 8. Script Angle Selection
        elif action == "scriptset":
            # arg format: {bina_id}_{angle}
            parts2 = arg.split("_", 1)
            bina_id = parts2[0]
            angle = parts2[1] if len(parts2) > 1 else "family"

            self.answer_callback_query(cb_id, text=f"✍️ '{angle.capitalize()}' ssenarisi ilə video yenilənir...")
            loading_kb = {
                "inline_keyboard": [
                    [{"text": f"⏳ Yeni Ssenari ({angle.capitalize()}) Hazırlanır...", "callback_data": f"noop_{bina_id}"}]
                ]
            }
            self.edit_message_reply_markup(chat_id, message_id, loading_kb)
            self.executor.submit(self._execute_rerender_job, bina_id, chat_id, message_id, script_angle=angle)
            return {"action": "scriptset", "bina_id": bina_id, "angle": angle}

        # 9. Voice Selection
        elif action == "voiceset":
            # arg format: {bina_id}_{voice}
            parts2 = arg.split("_", 1)
            bina_id = parts2[0]
            voice = parts2[1] if len(parts2) > 1 else "nova"

            self.answer_callback_query(cb_id, text=f"🎙️ '{voice}' səsi ilə video yenilənir...")
            loading_kb = {
                "inline_keyboard": [
                    [{"text": f"⏳ Yeni Səs ({voice}) ilə Render Gedir...", "callback_data": f"noop_{bina_id}"}]
                ]
            }
            self.edit_message_reply_markup(chat_id, message_id, loading_kb)
            self.executor.submit(self._execute_rerender_job, bina_id, chat_id, message_id, voice_choice=voice)
            return {"action": "voiceset", "bina_id": bina_id, "voice": voice}

        # Fallback / Noop
        self.answer_callback_query(cb_id, text="")
        return {"action": "noop", "data": data}

    def _execute_rerender_job(
        self,
        bina_id: str,
        chat_id: Union[int, str],
        message_id: int,
        script_angle: Optional[str] = None,
        voice_choice: Optional[str] = None
    ) -> None:
        """
        Background worker that re-executes pipeline composition with explicit voice/script
        parameters (thread-safe; zero global os.environ mutation) and replaces media in-place.
        """
        logger.info(
            f"Executing background re-render for listing {bina_id} "
            f"(angle={script_angle}, voice={voice_choice})..."
        )
        try:
            listing = get_listing_by_bina_id(bina_id, self.db_path)
            if not listing:
                logger.error(f"Cannot re-render: listing {bina_id} not found in database.")
                return

            voice_engine, voice_id = resolve_voice_choice(voice_choice)
            if not voice_engine:
                try:
                    from src.worker.account_router import route_listing_to_channel
                    route_info = route_listing_to_channel(listing)
                    voice_engine = route_info.get("voice_engine") or "elevenlabs"
                    voice_id = route_info.get("voice_id")
                except Exception:
                    pass

            # Apply requested marketing angle override to listing copy
            listing_copy = dict(listing)
            if script_angle == "urgent":
                listing_copy["is_urgent"] = True
            elif script_angle == "luxury":
                listing_copy["archetype_override"] = "luxury"
            elif script_angle == "investor":
                listing_copy["archetype_override"] = "commercial"
            elif script_angle == "family":
                listing_copy["archetype_override"] = "budget"

            trigger_reason = (
                "VOICE_SWITCH" if voice_choice
                else ("SCRIPT_ANGLE" if script_angle else "MANUAL_RERENDER")
            )

            from run_pipeline import BakuEstatePipeline
            pipeline = BakuEstatePipeline(
                mock_dispatch=not bool(self.base_url),
                db_path=self.db_path
            )
            res = pipeline.process_listing_video_and_dispatch(
                listing_copy,
                voice_engine=voice_engine,
                voice_id=voice_id,
                script_angle=script_angle,
                update_telegram_message_id=message_id,
                telegram_chat_id=chat_id,
                trigger_reason=trigger_reason,
            )

            main_kb = build_inline_keyboard(listing)
            dispatch_status = (res.get("dispatch") or {}).get("status")
            if dispatch_status == "UPDATED":
                logger.info(f"Successfully re-rendered and updated Telegram message {message_id} for {bina_id}!")
                return

            video_p = res.get("video_path")
            if video_p and Path(video_p).exists():
                crm_caption = (res.get("dispatch") or {}).get("crm_caption") or generate_crm_caption(listing)
                ok = self.edit_message_media(chat_id, message_id, video_p, caption=crm_caption, reply_markup=main_kb)
                if ok:
                    logger.info(f"Successfully re-rendered and updated Telegram message {message_id} for {bina_id}!")
                else:
                    logger.warning(f"edit_message_media failed for {bina_id}; restoring keyboard.")
                    self.edit_message_reply_markup(chat_id, message_id, main_kb)
            else:
                self.edit_message_reply_markup(chat_id, message_id, main_kb)
        except Exception as e:
            logger.error(f"Error in background re-render job for {bina_id}: {e}", exc_info=True)
            try:
                listing_fallback = get_listing_by_bina_id(bina_id, self.db_path) or {"bina_id": bina_id}
                self.edit_message_reply_markup(chat_id, message_id, build_inline_keyboard(listing_fallback))
            except Exception:
                pass

    def start_polling(self, poll_timeout: int = 25) -> None:
        """Starts a resilient long-polling loop to handle mobile Telegram button clicks live."""
        if not self.base_url:
            logger.error("TELEGRAM_BOT_TOKEN is not configured; cannot start polling.")
            return

        self.is_running = True
        logger.info("Telegram Interactive Studio Bot polling started! Waiting for button taps...")
        while self.is_running:
            try:
                url = f"{self.base_url}/getUpdates"
                params = {
                    "offset": self.last_update_id + 1,
                    "timeout": poll_timeout,
                    "allowed_updates": json.dumps(["message", "callback_query"])
                }
                r = requests.get(url, params=params, timeout=poll_timeout + 10)
                if r.status_code == 200:
                    for upd in r.json().get("result", []):
                        self.process_update(upd)
                else:
                    logger.warning(f"getUpdates returned {r.status_code}: {r.text[:200]}")
                    time.sleep(3)
            except KeyboardInterrupt:
                self.is_running = False
                logger.info("Telegram Bot polling stopped by user.")
            except Exception as e:
                logger.warning(f"Telegram polling error (retrying in 3s): {e}")
                time.sleep(3)

    def process_update(self, update: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Processes an incoming Telegram Update JSON object."""
        update_id = update.get("update_id", 0)
        if update_id > self.last_update_id:
            self.last_update_id = update_id

        if "callback_query" in update:
            return self.handle_callback_query(update["callback_query"])
        elif "message" in update:
            msg = update["message"]
            text = (msg.get("text") or "").strip()
            chat_id = msg.get("chat", {}).get("id")

            if not self.is_authorized_chat(chat_id):
                logger.warning(
                    f"Blocked unauthorized Telegram message from chat_id={chat_id!r}"
                )
                return {"type": "unauthorized", "authorized": False, "chat_id": chat_id}

            if text in ("/start", "/help"):
                welcome_msg = (
                    "👋 <b>BakuEstate-AI İdarəetmə Botuna Xoş Gəlmisiniz!</b>\n\n"
                    "Bu bot vasitəsilə daşınmaz əmlak videolarını birbaşa mobil telefonunuzdan idarə edə bilərsiniz:\n"
                    "• 🔄 Videoları yenidən render etmək\n"
                    "• ✍️ Ssenari bucağını dəyişmək\n"
                    "• 🎙️ Səsi dəyişmək (ElevenLabs Arif, OpenAI Nova, Edge)\n"
                    "• 📊 Keenable bazar analitikasını oxumaq\n"
                    "• 🚀 1 toxunuşla paylaşmaq və sahibkara WhatsApp yazmaq."
                )
                self.send_message(chat_id, welcome_msg)
                return {"type": "command", "command": text}

        return None


if __name__ == "__main__":
    service = TelegramBotService()
    service.start_polling()
