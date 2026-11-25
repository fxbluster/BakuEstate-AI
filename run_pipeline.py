"""
End-to-End Orchestrator Pipeline for Baku Estate AI.
Coordinates:
1. Ingestion: bina.az scraping (pre-scrape known_bina_ids skip, phone extraction, photo hash refresh).
2. State & Deduplication:
   - Cloud mode (USE_CLOUD_BACKEND=true): SupabaseRepo (8 Postgres tables) + ChangeDetector
     (AZN currency normalization, null-safe repost scoring, Rejim 3 price-drop guardrails).
   - Local fallback (USE_CLOUD_BACKEND=false): SQLite database (listings, accounts, videos).
3. Script & TTS: Azerbaijani narration with explicit tts_engine/voice_id/script_angle/version_num
   (zero global os.environ mutation) and price-drop openings.
4. Video Composition: 1080x1920 (9:16) versioned output (`video_{bina_id}_v{n}.mp4`).
5. Storage & Telegram Dispatch: Versioned Supabase Storage (`videos/{bina_id}/v{n}.mp4`),
   immediate telegram_message_id persistence for idempotency, in-place editMessageMedia for
   re-renders, and marking prior render_versions SUPERSEDED. Active Notion CRM sync is disabled
   by default unless NOTION_LEGACY_SYNC=true.
"""

import sys
from pathlib import Path

# Add project root to sys.path
BASE_PROJECT_DIR = Path(__file__).resolve().parent
if str(BASE_PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_PROJECT_DIR))

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import argparse
import ipaddress
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

import requests

from config.settings import (
    AUTO_JOB_TTL_HOURS,
    AUTO_RENDER_COOLDOWN_HOURS,
    DAILY_AUTO_RENDER_LIMIT,
    DB_PATH,
    DEFAULT_BG_MUSIC,
    DOWNLOADS_DIR,
    EDGE_TTS_RATE,
    EDGE_TTS_VOICE,
    EUR_TO_AZN_RATE,
    FILTER_DIRECT_OWNER_ONLY,
    OUTPUT_DIR,
    PRICE_DROP_TRIGGER_PCT,
    PROFILES_DIR,
    R2_MEDIA_BASE_URL,
    SUPABASE_ENABLED,
    TELEGRAM_MOCK_DISPATCH,
    USD_TO_AZN_RATE,
    USE_CLOUD_BACKEND,
    init_sentry,
    safe_parse_numeric,
)
from src.cloud.supabase_repo import SupabaseRepo
from src.database import (
    get_listing_by_bina_id,
    get_unprocessed_listings,
    init_db,
    mark_video_dispatched,
    record_generated_video,
    save_listing,
    update_listing_status,
)
from src.dedup.change_detector import (
    compute_photo_urls_hash,
    detect_listing_changes,
    evaluate_price_drop_retrigger,
    find_best_repost_match,
)
from src.dispatcher.notion_crm import NotionCRMDispatcher, is_notion_legacy_sync_enabled
from src.dispatcher.supabase_sync import SupabaseSync
from src.dispatcher.telegram_crm import (
    TelegramCRMDispatcher,
    build_inline_keyboard,
    generate_crm_caption,
    generate_public_caption,
)
from src.google_pool.brave_gemini_client import BraveGeminiClient
from src.google_pool.pool_manager import GooglePoolManager
from src.google_pool.setup_accounts import setup_all_profiles
from src.media.ffmpeg_compositor import VideoCompositor
from src.media.tts_service import generate_tts_for_listing
from src.scraper.bina_scraper import BinaScraper, clean_phone_number

logger = logging.getLogger("estate_pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

AUTO_TRIGGER_REASONS = frozenset({"AUTO_INITIAL", "AUTO_PRICE_DROP"})
MAX_CUSTOM_SCRIPT_LENGTH = 1000
MIN_STUDIO_PHOTOS = 4
MAX_STUDIO_PHOTOS = 10
MAX_TELEGRAM_VIDEO_BYTES = 18 * 1024 * 1024
DEFAULT_R2_MEDIA_BASE_URL = "https://media.bakuestate.az"


class PipelineCancelledError(Exception):
    """Raised when cooperative job cancellation is requested mid-pipeline."""


class WorkerShutdownError(Exception):
    """Raised when an active FFmpeg render is interrupted by graceful SIGTERM."""


_ACTIVE_FFMPEG_LOCK = threading.Lock()
_ACTIVE_FFMPEG_PROCS: set[Any] = set()


def register_active_ffmpeg_process(proc: Any) -> None:
    """Registers an active FFmpeg subprocess so SIGTERM can interrupt it promptly."""
    with _ACTIVE_FFMPEG_LOCK:
        _ACTIVE_FFMPEG_PROCS.add(proc)


def unregister_active_ffmpeg_process(proc: Any) -> None:
    """Unregisters a finished FFmpeg subprocess."""
    with _ACTIVE_FFMPEG_LOCK:
        _ACTIVE_FFMPEG_PROCS.discard(proc)


def terminate_active_ffmpeg_processes() -> int:
    """Terminates all currently running FFmpeg subprocesses (for graceful SIGTERM)."""
    with _ACTIVE_FFMPEG_LOCK:
        procs = list(_ACTIVE_FFMPEG_PROCS)
    terminated = 0
    for proc in procs:
        try:
            if proc.poll() is None:
                proc.terminate()
                terminated += 1
        except Exception:
            pass
    return terminated


def _assert_safe_public_https_url(raw_url: str) -> str:
    """SSRF guard: enforces public https:// URL with no internal/metadata IPs or traversal."""
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise ValueError("Photo URL must be a non-empty string.")
    cleaned = raw_url.strip()
    parsed = urllib.parse.urlparse(cleaned)
    if parsed.scheme.lower() != "https":
        raise ValueError(f"Blocked non-HTTPS photo URL (SSRF guard): {cleaned}")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"Blocked photo URL with embedded credentials: {cleaned}")
    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise ValueError(f"Photo URL missing hostname: {cleaned}")
    if (
        host in ("localhost", "localhost.localdomain", "metadata.google.internal")
        or host.endswith(".local")
        or host.endswith(".internal")
    ):
        raise ValueError(f"Blocked internal hostname in photo URL (SSRF guard): {host}")
    try:
        ip_obj = ipaddress.ip_address(host)
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
        ):
            raise ValueError(f"Blocked internal/private IP in photo URL (SSRF guard): {host}")
    except ValueError as ip_exc:
        # Distinguish "not an IP address" (valid domain) from our explicit SSRF ValueError
        if "Blocked internal/private IP" in str(ip_exc):
            raise
    if ".." in urllib.parse.unquote(parsed.path or "").split("/"):
        raise ValueError(f"Blocked path traversal in photo URL: {cleaned}")
    return cleaned


def validate_selected_photo_urls(
    selected_photo_urls: Optional[Sequence[str]],
    listing: Dict[str, Any],
    *,
    agency_id: Optional[str] = None,
    r2_media_base_url: Optional[str] = None,
) -> Optional[List[str]]:
    """
    Validates Pre-Render Studio `selected_photo_urls`:
    - Must contain between 4 and 10 URLs (inclusive).
    - Every URL must pass HTTPS + non-private-IP SSRF checks.
    - Every URL must be allowlisted against either the listing's own `photo_urls`
      OR the caller's agency R2 media prefix (`https://media.bakuestate.az/staging/{agency_id}/`
      or `.../photos/{agency_id}/`).
    Raises ValueError on any violation.
    """
    if selected_photo_urls is None:
        return None
    if isinstance(selected_photo_urls, (str, bytes)) or not isinstance(selected_photo_urls, Sequence):
        raise ValueError("selected_photo_urls must be a list of 4 to 10 photo URLs.")

    urls = list(selected_photo_urls)
    if len(urls) < MIN_STUDIO_PHOTOS or len(urls) > MAX_STUDIO_PHOTOS:
        raise ValueError(
            f"selected_photo_urls must contain between {MIN_STUDIO_PHOTOS} and "
            f"{MAX_STUDIO_PHOTOS} photos (got {len(urls)})."
        )

    listing_allowed = {
        str(u).strip()
        for u in (listing.get("photo_urls") or [])
        if isinstance(u, str) and str(u).strip()
    }
    resolved_agency = str(agency_id or listing.get("agency_id") or "").strip()
    base_url = (
        r2_media_base_url
        or os.getenv("R2_MEDIA_BASE_URL")
        or os.getenv("NEXT_PUBLIC_R2_MEDIA_BASE_URL")
        or R2_MEDIA_BASE_URL
        or DEFAULT_R2_MEDIA_BASE_URL
    ).strip().rstrip("/")
    allowed_r2_prefixes: Tuple[str, ...] = ()
    if resolved_agency:
        allowed_r2_prefixes = (
            f"{base_url}/staging/{resolved_agency}/",
            f"{base_url}/v/staging/{resolved_agency}/",
            f"{base_url}/photos/{resolved_agency}/",
            f"{base_url}/v/photos/{resolved_agency}/",
        )

    validated: List[str] = []
    for raw_url in urls:
        safe_url = _assert_safe_public_https_url(raw_url)
        in_listing = safe_url in listing_allowed
        in_agency_r2 = bool(allowed_r2_prefixes) and any(
            safe_url.startswith(prefix) for prefix in allowed_r2_prefixes
        )
        if not in_listing and not in_agency_r2:
            raise ValueError(
                f"Photo URL is not allowlisted for this listing or agency R2 prefix (SSRF guard): {safe_url}"
            )
        validated.append(safe_url)
    return validated


def validate_custom_script_text(
    custom_script_text: Optional[str],
    *,
    max_length: int = MAX_CUSTOM_SCRIPT_LENGTH,
) -> Optional[str]:
    """Validates Pre-Render Studio `custom_script_text` (<= 1,000 characters)."""
    if custom_script_text is None:
        return None
    if not isinstance(custom_script_text, str):
        raise ValueError("custom_script_text must be a string.")
    cleaned = custom_script_text.strip()
    if len(cleaned) > max_length:
        raise ValueError(
            f"custom_script_text exceeds maximum length of {max_length} characters ({len(cleaned)})."
        )
    return cleaned or None


def calculate_two_pass_video_bitrate_kbps(
    duration_seconds: float,
    *,
    max_bytes: int = MAX_TELEGRAM_VIDEO_BYTES,
    audio_bitrate_kbps: int = 128,
) -> int:
    """
    Calculates target libx264 video bitrate (kbps) for 2-pass encoding so the final MP4
    stays strictly under `max_bytes` (default 18 MB for Telegram's 20 MB URL fetch cap).
    """
    safe_duration = max(1.0, float(duration_seconds or 1.0))
    # 96% budget leaves 4% headroom for MP4 container/muxing overhead
    total_bits = int(max_bytes * 8 * 0.96)
    total_kbps = total_bits / (safe_duration * 1000.0)
    video_kbps = int(total_kbps - max(64, int(audio_bitrate_kbps)))
    return max(350, min(video_kbps, 4500))


def _run_tracked_ffmpeg(
    cmd: List[str],
    *,
    cancel_check_cb: Optional[Callable[[], bool]] = None,
) -> int:
    """
    Runs an FFmpeg command via Popen with active process registration so SIGTERM
    or cooperative cancellation interrupts FFmpeg promptly.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    register_active_ffmpeg_process(proc)
    try:
        while proc.poll() is None:
            if cancel_check_cb is not None and cancel_check_cb():
                try:
                    proc.terminate()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=3.0)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                raise PipelineCancelledError("Cancelled during FFmpeg 2-pass size cap")
            try:
                proc.wait(timeout=0.15)
            except subprocess.TimeoutExpired:
                continue
        _, stderr_bytes = proc.communicate()
        if proc.returncode != 0:
            err_tail = (stderr_bytes or b"").decode("utf-8", errors="replace")[-400:]
            raise RuntimeError(f"FFmpeg 2-pass size cap failed (rc={proc.returncode}): {err_tail}")
        return int(proc.returncode)
    finally:
        unregister_active_ffmpeg_process(proc)


def enforce_video_size_cap(
    video_path: Path,
    duration_seconds: float,
    *,
    max_bytes: int = MAX_TELEGRAM_VIDEO_BYTES,
    temp_dir: Optional[Path] = None,
    ffmpeg_exe: Optional[str] = None,
    cancel_check_cb: Optional[Callable[[], bool]] = None,
) -> Path:
    """
    Enforces a strict `<= 18 MB` MP4 cap via 2-pass libx264 bitrate targeting
    whenever the rendered file exceeds `max_bytes`.
    """
    target_path = Path(video_path)
    if not target_path.is_file():
        return target_path

    current_size = target_path.stat().st_size
    if current_size <= max_bytes:
        return target_path

    audio_kbps = 128
    video_kbps = calculate_two_pass_video_bitrate_kbps(
        duration_seconds=duration_seconds,
        max_bytes=max_bytes,
        audio_bitrate_kbps=audio_kbps,
    )
    resolved_ffmpeg = ffmpeg_exe
    if not resolved_ffmpeg:
        from src.media.ffmpeg_compositor import get_ffmpeg_executable
        resolved_ffmpeg = get_ffmpeg_executable()

    owned_temp = temp_dir is None
    work_dir = Path(temp_dir) if temp_dir is not None else Path(tempfile.mkdtemp(prefix="estate_cap_"))
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        passlog_prefix = work_dir / "ffmpeg2pass"
        capped_output = work_dir / "capped_output.mp4"

        logger.info(
            "Video %s is %.2f MB (> %.2f MB cap); running 2-pass libx264 re-encode at %dkbps...",
            target_path.name,
            current_size / (1024 * 1024),
            max_bytes / (1024 * 1024),
            video_kbps,
        )

        pass1_cmd = [
            resolved_ffmpeg, "-y",
            "-i", str(target_path),
            "-c:v", "libx264",
            "-preset", "faster",
            "-pix_fmt", "yuv420p",
            "-b:v", f"{video_kbps}k",
            "-pass", "1",
            "-passlogfile", str(passlog_prefix),
            "-an",
            "-f", "mp4",
            os.devnull,
        ]
        _run_tracked_ffmpeg(pass1_cmd, cancel_check_cb=cancel_check_cb)

        if cancel_check_cb is not None and cancel_check_cb():
            raise PipelineCancelledError("Cancelled between FFmpeg pass 1 and pass 2")

        pass2_cmd = [
            resolved_ffmpeg, "-y",
            "-i", str(target_path),
            "-c:v", "libx264",
            "-preset", "faster",
            "-pix_fmt", "yuv420p",
            "-b:v", f"{video_kbps}k",
            "-maxrate", f"{int(video_kbps * 1.15)}k",
            "-bufsize", f"{video_kbps * 2}k",
            "-pass", "2",
            "-passlogfile", str(passlog_prefix),
            "-c:a", "aac",
            "-b:a", f"{audio_kbps}k",
            "-movflags", "+faststart",
            str(capped_output),
        ]
        _run_tracked_ffmpeg(pass2_cmd, cancel_check_cb=cancel_check_cb)

        if capped_output.is_file() and capped_output.stat().st_size > 0:
            shutil.move(str(capped_output), str(target_path))
            logger.info(
                "2-pass size cap succeeded: %s is now %.2f MB.",
                target_path.name,
                target_path.stat().st_size / (1024 * 1024),
            )
        return target_path
    finally:
        if owned_temp:
            shutil.rmtree(work_dir, ignore_errors=True)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return _utc_now().isoformat()


def _auto_job_expires_at_iso(hours: int = AUTO_JOB_TTL_HOURS) -> str:
    return (_utc_now() + timedelta(hours=max(1, int(hours)))).isoformat()


class BakuEstatePipeline:
    def __init__(
        self,
        owner_only: bool = FILTER_DIRECT_OWNER_ONLY,
        mock_dispatch: Optional[bool] = None,
        db_path: Path = DB_PATH,
        use_gemini: bool = False,
        bg_music_path: Optional[str] = None,
        enable_supabase: Optional[bool] = None,
        enable_notion: Optional[bool] = None,
        use_cloud_backend: Optional[bool] = None,
        supabase_repo: Optional[SupabaseRepo] = None,
    ):
        self.db_path = db_path
        self.owner_only = owner_only
        self.mock_dispatch = TELEGRAM_MOCK_DISPATCH if mock_dispatch is None else mock_dispatch
        self.use_gemini = use_gemini
        self.bg_music_path = bg_music_path if bg_music_path is not None else DEFAULT_BG_MUSIC

        # Initialize Sentry telemetry
        init_sentry()

        # Always ensure local SQLite fallback schema is initialized
        init_db(self.db_path)
        self.scraper = BinaScraper(owner_only=self.owner_only)
        self.pool_manager = GooglePoolManager(db_path=self.db_path)
        self.gemini_client = BraveGeminiClient(pool_manager=self.pool_manager)
        self.compositor = VideoCompositor()
        self.dispatcher = TelegramCRMDispatcher(mock_mode=self.mock_dispatch)

        # Cloud Backend (SupabaseRepo + ChangeDetector) gated behind USE_CLOUD_BACKEND
        # Note: explicit enable_supabase=False keeps legacy/test runs strictly local SQLite.
        is_supa_enabled = enable_supabase if enable_supabase is not None else SUPABASE_ENABLED
        if supabase_repo is not None:
            self.supabase_repo = supabase_repo
        else:
            self.supabase_repo = SupabaseRepo(enabled=bool(is_supa_enabled))

        if enable_supabase is False:
            self.use_cloud_backend = False
        elif use_cloud_backend is not None:
            self.use_cloud_backend = bool(use_cloud_backend) and self.supabase_repo.is_configured()
        else:
            self.use_cloud_backend = bool(USE_CLOUD_BACKEND) and self.supabase_repo.is_configured()

        # Legacy SupabaseSync adapter (only used when cloud repo is disabled but legacy sync enabled)
        self.supabase_sync = SupabaseSync(enabled=bool(is_supa_enabled))

        # Notion CRM is deprecated and disabled by default unless NOTION_LEGACY_SYNC=true
        # or explicitly enabled via enable_notion=True
        is_notion_enabled = (
            bool(enable_notion)
            if enable_notion is not None
            else is_notion_legacy_sync_enabled()
        )
        self.notion_crm = NotionCRMDispatcher(enabled=is_notion_enabled)

    # ------------------------------------------------------------------
    # Cloud Ingestion, Deduplication & Rejim 3 Change Detection
    # ------------------------------------------------------------------

    def ingest_scraped_listing(
        self,
        item: Dict[str, Any],
        *,
        enqueue_render_jobs: bool = True,
        actor: str = "scraper",
    ) -> Dict[str, Any]:
        """
        Persists a scraped listing into Supabase Postgres with full change detection,
        null-safe repost scoring, and Rejim 3 price-drop guardrail evaluation.
        Falls back cleanly to local SQLite when USE_CLOUD_BACKEND is False.
        """
        bina_id = str(item.get("bina_id") or "").strip()
        if not bina_id:
            return {"action": "skipped", "reason": "missing_bina_id"}

        # Extract internal hints attached by BinaScraper before persisting
        preloaded_existing = item.get("_existing")
        preloaded_changes = item.get("_changes")
        clean_item = {k: v for k, v in item.items() if not str(k).startswith("_")}

        if not self.use_cloud_backend:
            row_id = save_listing(clean_item, self.db_path)
            return {"action": "saved_local", "bina_id": bina_id, "row_id": row_id, "listing": clean_item}

        existing = preloaded_existing or self.supabase_repo.get_listing_by_bina_id(bina_id)

        # Case 1: Existing bina_id -> detect changes & evaluate Rejim 3 price-drop retrigger
        if existing is not None:
            changes = preloaded_changes or detect_listing_changes(
                existing,
                clean_item,
                usd_rate=USD_TO_AZN_RATE,
                eur_rate=EUR_TO_AZN_RATE,
                actor=actor,
            )
            if not changes["has_changes"]:
                self.supabase_repo.touch_listings_last_seen([bina_id])
                return {"action": "unchanged", "bina_id": bina_id, "listing": existing}

            new_revision = int(existing.get("content_revision") or 1) + 1
            upsert_data = dict(clean_item)
            upsert_data["content_revision"] = new_revision
            saved_row = self.supabase_repo.upsert_listing(upsert_data, existing=existing) or existing
            listing_uuid = saved_row.get("id") or existing.get("id")

            triggered_job: Optional[Dict[str, Any]] = None
            price_drop_decision: Optional[Dict[str, Any]] = None

            if changes["price_changed"] and changes["price_drop_pct"] > 0:
                today_count = self.supabase_repo.count_today_auto_renders_baku()
                price_drop_decision = evaluate_price_drop_retrigger(
                    existing,
                    clean_item.get("price"),
                    clean_item.get("currency", "AZN"),
                    today_auto_render_count=today_count,
                    min_drop_pct=PRICE_DROP_TRIGGER_PCT,
                    daily_limit=DAILY_AUTO_RENDER_LIMIT,
                    cooldown_hours=AUTO_RENDER_COOLDOWN_HOURS,
                    usd_rate=USD_TO_AZN_RATE,
                    eur_rate=EUR_TO_AZN_RATE,
                )
                if price_drop_decision["should_trigger"] and enqueue_render_jobs and listing_uuid:
                    triggered_job = self.supabase_repo.enqueue_pipeline_job(
                        idempotency_key=price_drop_decision["idempotency_key"],
                        job_type="RENDER_PRICE_DROP",
                        listing_id=listing_uuid,
                        trigger_source="AUTO_SCHEDULER",
                        params_json={
                            "bina_id": bina_id,
                            "price_drop_info": price_drop_decision["price_drop_info"],
                        },
                        expires_at=_auto_job_expires_at_iso(),
                    )
                    if triggered_job:
                        self.supabase_repo.update_listing(listing_uuid, {"pipeline_status": "QUEUED"})
                elif not price_drop_decision["should_trigger"]:
                    logger.info(
                        "Rejim 3 price drop for %s blocked by guardrails: %s",
                        bina_id,
                        price_drop_decision["blocked_reasons"],
                    )

            # Attach triggered_job_id onto PRICE_CHANGED event when enqueued
            events_to_insert = []
            for ev in changes["events"]:
                ev_copy = dict(ev)
                if ev_copy.get("event_type") == "PRICE_CHANGED" and triggered_job and triggered_job.get("id"):
                    ev_copy["triggered_job_id"] = triggered_job["id"]
                events_to_insert.append(ev_copy)

            if listing_uuid and events_to_insert:
                self.supabase_repo.insert_listing_events(listing_uuid, events_to_insert)

            return {
                "action": "updated",
                "bina_id": bina_id,
                "listing": saved_row,
                "changes": changes,
                "price_drop_decision": price_drop_decision,
                "job": triggered_job,
            }

        # Case 2: New bina_id -> null-safe repost scoring
        raw_phone = str(
            clean_item.get("owner_phone_normalized")
            or clean_item.get("owner_phone")
            or clean_item.get("owner_phone_raw")
            or ""
        )
        norm_phone = clean_phone_number(raw_phone)
        repost_match = None
        if norm_phone:
            candidates = self.supabase_repo.find_repost_candidates(
                norm_phone,
                exclude_bina_id=bina_id,
            )
            repost_match = find_best_repost_match(clean_item, candidates)

        if repost_match is not None:
            dup_data = dict(clean_item)
            dup_data["pipeline_status"] = "SKIPPED_DUPLICATE"
            dup_data["duplicate_resolution"] = "PENDING_REVIEW"
            dup_data["duplicate_of_listing_id"] = repost_match.get("existing_id")
            dup_data["duplicate_confidence"] = repost_match.get("score")

            saved_row = self.supabase_repo.upsert_listing(dup_data) or dup_data
            listing_uuid = saved_row.get("id")
            if listing_uuid:
                self.supabase_repo.insert_listing_event(
                    listing_uuid,
                    "DUPLICATE_FLAGGED",
                    new_value={
                        "duplicate_of_bina_id": repost_match.get("existing_bina_id"),
                        "duplicate_of_listing_id": repost_match.get("existing_id"),
                        "score": repost_match.get("score"),
                        "matched_fields": repost_match.get("matched_fields"),
                    },
                    actor=actor,
                )
                self.supabase_repo.create_follow_up_task(
                    entity_type="DUPLICATE_REVIEW",
                    title=(
                        f"Şübhəli təkrar elan: #{bina_id} ↔ #{repost_match.get('existing_bina_id')} "
                        f"(uyğunluq {int(round(repost_match['score'] * 100))}%)"
                    ),
                    priority="NORMAL",
                    listing_id=listing_uuid,
                )
            logger.info(
                "Flagged %s as PENDING_REVIEW duplicate of %s (score=%.2f); auto-render skipped.",
                bina_id,
                repost_match.get("existing_bina_id"),
                repost_match["score"],
            )
            return {
                "action": "duplicate_flagged",
                "bina_id": bina_id,
                "listing": saved_row,
                "duplicate_match": repost_match,
            }

        # Case 3: Truly new, unique listing
        new_data = dict(clean_item)
        new_data.setdefault("pipeline_status", "NEW")
        new_data.setdefault("duplicate_resolution", "NONE")
        saved_row = self.supabase_repo.upsert_listing(new_data) or new_data
        listing_uuid = saved_row.get("id")

        triggered_job = None
        if enqueue_render_jobs and listing_uuid:
            today_count = self.supabase_repo.count_today_auto_renders_baku()
            if today_count < DAILY_AUTO_RENDER_LIMIT:
                triggered_job = self.supabase_repo.enqueue_pipeline_job(
                    idempotency_key=f"initial:{bina_id}",
                    job_type="RENDER_INITIAL",
                    listing_id=listing_uuid,
                    trigger_source="AUTO_SCHEDULER",
                    params_json={"bina_id": bina_id},
                    expires_at=_auto_job_expires_at_iso(),
                )
                if triggered_job:
                    self.supabase_repo.update_listing(listing_uuid, {"pipeline_status": "QUEUED"})
            else:
                logger.info(
                    "Daily auto-render cap (%d/%d) reached; listing %s saved without auto-render.",
                    today_count,
                    DAILY_AUTO_RENDER_LIMIT,
                    bina_id,
                )

        if listing_uuid:
            self.supabase_repo.insert_listing_event(
                listing_uuid,
                "SCRAPED_NEW",
                new_value={
                    "price": saved_row.get("price"),
                    "currency": saved_row.get("currency"),
                    "price_azn_normalized": saved_row.get("price_azn_normalized"),
                    "location": saved_row.get("location"),
                },
                triggered_job_id=triggered_job.get("id") if triggered_job else None,
                actor=actor,
            )

        return {
            "action": "created",
            "bina_id": bina_id,
            "listing": saved_row,
            "job": triggered_job,
        }

    def run_ingestion(
        self,
        pages: int = 1,
        limit_per_page: int = 3,
        specific_id: Optional[str] = None,
        enqueue_render_jobs: bool = False,
        check_existing_for_changes: bool = True,
    ) -> List[Dict[str, Any]]:
        """Scrapes listings from bina.az and persists them to Supabase (or local SQLite fallback)."""
        logger.info(
            "--- [Phase 1/5: INGESTION] Starting (owner_only=%s, cloud=%s) ---",
            self.owner_only,
            self.use_cloud_backend,
        )
        saved_listings: List[Dict[str, Any]] = []

        if specific_id:
            logger.info(f"Targeting single bina.az ID: {specific_id}")
            details = self.scraper.fetch_item_details(specific_id)
            if details:
                phone = self.scraper.fetch_contact_phone(specific_id)
                if phone:
                    details["owner_phone"] = phone
                if details.get("photo_urls"):
                    photo_hash = compute_photo_urls_hash(details["photo_urls"])
                    downloaded = self.scraper.download_full_hd_photos(
                        specific_id,
                        details["photo_urls"],
                        photo_urls_hash=photo_hash,
                    )
                    details["downloaded_photos"] = downloaded
                    if downloaded:
                        details["status"] = "PHOTOS_READY"
                if self.use_cloud_backend:
                    ingest_res = self.ingest_scraped_listing(
                        details,
                        enqueue_render_jobs=enqueue_render_jobs,
                    )
                    cloud_row = ingest_res.get("listing") or details
                    cloud_row["downloaded_photos"] = details.get("downloaded_photos", [])
                    saved_listings.append(cloud_row)
                else:
                    save_listing(details, self.db_path)
                    saved_listings.append(details)
            else:
                if self.use_cloud_backend:
                    cloud_item = self.supabase_repo.get_listing_by_bina_id(specific_id)
                    if cloud_item:
                        saved_listings.append(cloud_item)
                else:
                    db_item = get_listing_by_bina_id(specific_id, self.db_path)
                    if db_item:
                        logger.info(f"Listing {specific_id} fetched from local database cache.")
                        saved_listings.append(db_item)
            return saved_listings

        for page in range(1, pages + 1):
            logger.info(f"Processing listings page {page}/{pages}...")
            if self.use_cloud_backend:
                items = self.scraper.scrape_and_process_page(
                    page=page,
                    limit=limit_per_page,
                    repo=self.supabase_repo,
                    check_existing_for_changes=check_existing_for_changes,
                )
            else:
                items = self.scraper.scrape_and_process_page(page=page, limit=limit_per_page)

            for item in items:
                if self.use_cloud_backend:
                    res = self.ingest_scraped_listing(
                        item,
                        enqueue_render_jobs=enqueue_render_jobs,
                    )
                    listing_out = res.get("listing") or item
                    if item.get("downloaded_photos"):
                        listing_out["downloaded_photos"] = item["downloaded_photos"]
                    logger.info(
                        "Cloud ingest for bina_id %s -> %s",
                        item.get("bina_id"),
                        res.get("action"),
                    )
                    if res.get("action") in ("created", "updated"):
                        saved_listings.append(listing_out)
                else:
                    row_id = save_listing(item, self.db_path)
                    logger.info(
                        f"Saved listing ID {item['bina_id']} to DB "
                        f"(row {row_id}, photos: {len(item.get('downloaded_photos', []))})"
                    )
                    saved_listings.append(item)

        logger.info(f"--- [Phase 1/5: INGESTION] Completed: {len(saved_listings)} listings ingested ---")
        return saved_listings

    # ------------------------------------------------------------------
    # Telegram In-Place Edit Helper (for Re-Renders)
    # ------------------------------------------------------------------

    def _edit_telegram_message_media(
        self,
        chat_id: Union[int, str],
        message_id: Union[int, str],
        video_path: str,
        caption: str,
        reply_markup: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Updates an existing Telegram video message in-place via editMessageMedia."""
        bot_token = self.dispatcher.bot_token
        target_chat = chat_id or self.dispatcher.chat_id
        if not bot_token or not target_chat:
            logger.warning("Cannot editMessageMedia: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.")
            return False

        video_file = Path(video_path)
        if not video_file.exists():
            logger.error(f"Media file not found for editMessageMedia: {video_path}")
            return False

        url = f"https://api.telegram.org/bot{bot_token}/editMessageMedia"
        media_obj = {
            "type": "video",
            "media": "attach://video",
            "caption": caption,
            "parse_mode": "HTML",
            "supports_streaming": True,
        }
        payload: Dict[str, Any] = {
            "chat_id": str(target_chat),
            "message_id": int(message_id),
            "media": json.dumps(media_obj),
        }
        if reply_markup:
            payload["reply_markup"] = json.dumps(reply_markup)

        try:
            with open(video_file, "rb") as vf:
                files = {"video": (video_file.name, vf, "video/mp4")}
                resp = requests.post(url, data=payload, files=files, timeout=120)
            if resp.status_code == 200:
                return True
            logger.warning(
                "Telegram editMessageMedia failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
            return False
        except Exception as exc:
            logger.warning("Exception in editMessageMedia: %s", exc)
            return False

    # ------------------------------------------------------------------
    # Versioned Video Render, Storage Upload & Idempotent Dispatch
    # ------------------------------------------------------------------

    def process_listing_video_and_dispatch(
        self,
        listing: Dict[str, Any],
        *,
        voice_engine: Optional[str] = None,
        voice_id: Optional[str] = None,
        script_angle: Optional[str] = None,
        model_id: Optional[str] = None,
        trigger_reason: str = "AUTO_INITIAL",
        price_drop_info: Optional[Dict[str, Any]] = None,
        update_telegram_message_id: Optional[Union[int, str]] = None,
        telegram_chat_id: Optional[Union[int, str]] = None,
        version_num: Optional[int] = None,
        existing_render_version: Optional[Dict[str, Any]] = None,
        skip_telegram_dispatch: bool = False,
        selected_photo_urls: Optional[List[str]] = None,
        custom_script_text: Optional[str] = None,
        agency_settings: Optional[Dict[str, Any]] = None,
        cancel_check_cb: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        """
        Runs the full pipeline for a single listing:
        Pre-Render Studio Validation -> Photos -> Script & Versioned TTS
        -> Versioned Video Composition + Two-Pass <= 18 MB Cap
        -> Versioned Cloud Storage Upload (Private R2 / Legacy Supabase)
        -> Idempotent Telegram Dispatch / editMessageMedia
        -> Mark prior render_versions SUPERSEDED.

        Supports cooperative cancellation via `cancel_check_cb` between every phase,
        `try/finally` temp directory cleanup, and partial R2 object deletion on cancel.
        """
        # Strict Pre-Render Studio input validation BEFORE allocating DB rows or temp dirs.
        # Raises ValueError immediately (non-transient failure / SSRF & length defense-in-depth).
        validated_photo_urls = validate_selected_photo_urls(
            selected_photo_urls,
            listing,
            agency_id=str(
                (agency_settings or {}).get("agency_id")
                or listing.get("agency_id")
                or ""
            ).strip() or None,
        )
        validated_custom_script = validate_custom_script_text(custom_script_text)

        raw_bina_id = str(listing.get("bina_id") or "").strip()
        raw_listing_id = str(listing.get("id") or "").strip()
        bina_id = raw_bina_id or raw_listing_id or "unknown"
        logger.info(
            "=== Processing video pipeline for listing %s (trigger=%s, cloud=%s) ===",
            bina_id,
            trigger_reason,
            self.use_cloud_backend,
        )

        # Normalize owner_phone field & apply agency_settings overrides
        working_listing = dict(listing)
        if not working_listing.get("owner_phone"):
            working_listing["owner_phone"] = (
                working_listing.get("owner_phone_normalized")
                or working_listing.get("owner_phone_raw")
                or ""
            )
        if isinstance(agency_settings, dict) and agency_settings:
            working_listing["agency_settings"] = dict(agency_settings)
            if agency_settings.get("public_phone"):
                working_listing["agency_public_phone"] = str(agency_settings["public_phone"]).strip()
            if agency_settings.get("watermark_preset_json"):
                working_listing["watermark_preset"] = agency_settings["watermark_preset_json"]
            if telegram_chat_id is None and agency_settings.get("telegram_chat_id"):
                telegram_chat_id = agency_settings["telegram_chat_id"]

        cloud_listing: Optional[Dict[str, Any]] = None
        listing_uuid: Optional[str] = raw_listing_id or None
        agency_uuid: Optional[str] = (
            str(
                (agency_settings or {}).get("agency_id")
                or working_listing.get("agency_id")
                or ""
            ).strip()
            or None
        )
        render_version_row: Optional[Dict[str, Any]] = existing_render_version
        render_version_id: Optional[str] = (
            existing_render_version.get("id") if existing_render_version else None
        )
        resolved_version_num = max(1, int(version_num)) if version_num is not None else 1
        content_revision = int(working_listing.get("content_revision") or 1)

        # Resolve target channel and niche routing
        routing_listing = dict(working_listing)
        if price_drop_info and "price_drop_info" not in routing_listing:
            routing_listing["price_drop_info"] = price_drop_info
        if "price_drop_pct" not in routing_listing and isinstance(price_drop_info, dict):
            routing_listing["price_drop_pct"] = (
                price_drop_info.get("drop_pct") or price_drop_info.get("price_drop_pct")
            )

        try:
            from src.worker.account_router import route_listing_to_channel

            route_info = route_listing_to_channel(routing_listing)
        except Exception:
            route_info = {}

        target_handle = (
            working_listing.get("target_account_handle")
            or route_info.get("target_account_handle")
            or "@bakuestate.official"
        )
        channel_niche = (
            working_listing.get("channel_niche")
            or route_info.get("channel_niche")
            or "GENERAL"
        )
        clean_handle = re.sub(r'[^a-zA-Z0-9_.-]', '_', target_handle.lstrip('@'))

        def _check_cancelled(phase: str) -> None:
            if cancel_check_cb is not None and cancel_check_cb() is True:
                raise PipelineCancelledError(f"Pipeline job cancelled at phase '{phase}'")

        job_temp_dir = Path(tempfile.mkdtemp(prefix=f"bakuestate_render_{re.sub(r'[^a-zA-Z0-9_-]', '_', bina_id)}_"))
        storage_object_path: Optional[str] = None
        video_cdn_url: Optional[str] = None
        upload_storage_provider: Optional[str] = None
        output_video_path: Optional[Path] = None

        try:
            # 0. Resolve canonical cloud listing & allocate versioned render_versions row
            if self.use_cloud_backend:
                if raw_listing_id and hasattr(self.supabase_repo, "get_listing_by_id"):
                    cloud_listing = self.supabase_repo.get_listing_by_id(raw_listing_id)
                if cloud_listing is None and raw_bina_id:
                    cloud_listing = self.supabase_repo.get_listing_by_bina_id(raw_bina_id)
                if cloud_listing is None and raw_bina_id:
                    cloud_listing = self.supabase_repo.upsert_listing(working_listing)
                if cloud_listing:
                    listing_uuid = cloud_listing.get("id") or listing_uuid
                    agency_uuid = str(cloud_listing.get("agency_id") or agency_uuid or "").strip() or None
                    content_revision = int(cloud_listing.get("content_revision") or content_revision)
                    # Merge canonical phone if missing on input dict
                    if not working_listing.get("owner_phone") and cloud_listing.get("owner_phone_normalized"):
                        working_listing["owner_phone"] = cloud_listing["owner_phone_normalized"]

                if listing_uuid:
                    if render_version_row is None:
                        if version_num is None:
                            resolved_version_num = self.supabase_repo.get_next_render_version_num(listing_uuid)
                        self.supabase_repo.update_listing(listing_uuid, {"pipeline_status": "RENDERING"})
                        render_version_row = self.supabase_repo.create_render_version(
                            listing_id=listing_uuid,
                            version_num=resolved_version_num,
                            content_revision=content_revision,
                            trigger_reason=trigger_reason,
                            script_angle=script_angle,
                            voice_engine=voice_engine,
                            voice_id=voice_id,
                            model_id=model_id,
                            status="RUNNING",
                            rendered_price=safe_parse_numeric(working_listing.get("price")),
                            rendered_currency=working_listing.get("currency") or "AZN",
                        )
                        render_version_id = render_version_row.get("id") if render_version_row else None
                    else:
                        resolved_version_num = int(render_version_row.get("version_num") or resolved_version_num)

            # Phase boundary 1: Before photo download
            _check_cancelled("before_photo_download")

            # 1. Download photos if not already downloaded (or download exact studio-selected photos)
            if validated_photo_urls is not None:
                logger.info(
                    "Downloading %d Pre-Render Studio selected photos for %s...",
                    len(validated_photo_urls),
                    bina_id,
                )
                studio_photo_dir = job_temp_dir / "studio_photos"
                downloaded_photos = self.scraper.download_full_hd_photos(
                    bina_id,
                    validated_photo_urls,
                    max_photos=MAX_STUDIO_PHOTOS,
                    force_refresh=True,
                    target_dir=studio_photo_dir,
                )
                working_listing["downloaded_photos"] = downloaded_photos
            else:
                downloaded_photos = working_listing.get("downloaded_photos") or []
                photo_urls = working_listing.get("photo_urls") or []
                if not downloaded_photos and photo_urls:
                    logger.info(f"Downloading photos for {bina_id}...")
                    photo_hash = (
                        working_listing.get("photo_urls_hash")
                        or compute_photo_urls_hash(photo_urls)
                    )
                    downloaded_photos = self.scraper.download_full_hd_photos(
                        bina_id,
                        photo_urls,
                        photo_urls_hash=photo_hash,
                    )
                    working_listing["downloaded_photos"] = downloaded_photos
                    if not self.use_cloud_backend:
                        update_listing_status(bina_id, "PHOTOS_READY", downloaded_photos, self.db_path)

            # Phase boundary 2: After photo download / before vision & script generation
            _check_cancelled("before_script_generation")

            # 1b. GPT-4o Vision analysis on locally downloaded photos
            visual_profile = None
            if downloaded_photos:
                try:
                    from src.ai.vision_analyzer import analyze_listing_photos
                    logger.info(
                        "--- [Phase 1b/5: VISION ANALYSIS] Analyzing %d photos with GPT-4o Vision for %s ---",
                        len(downloaded_photos),
                        bina_id,
                    )
                    _photo_paths = [Path(p) if isinstance(p, str) else p for p in downloaded_photos]
                    visual_profile = analyze_listing_photos(_photo_paths)
                    if visual_profile and not visual_profile.is_fallback:
                        logger.info(
                            "GPT-4o Vision: renovation=%s, hook=%s",
                            visual_profile.renovation_quality,
                            visual_profile.hook_sentence_az[:60] if visual_profile.hook_sentence_az else "—",
                        )
                    else:
                        logger.info("GPT-4o Vision returned fallback profile; proceeding with heuristic script.")
                except Exception as _ve:
                    logger.warning("Vision analysis skipped due to error: %s", _ve)

            if not downloaded_photos:
                logger.warning(f"No photos available for listing {bina_id}. Cannot compose video.")
                if self.use_cloud_backend:
                    if render_version_id:
                        self.supabase_repo.update_render_version(
                            render_version_id,
                            {"status": "FAILED", "error_message": "No photos available"},
                        )
                    if listing_uuid:
                        self.supabase_repo.update_listing(listing_uuid, {"pipeline_status": "FAILED"})
                else:
                    update_listing_status(bina_id, "FAILED", db_path=self.db_path)
                return {"bina_id": bina_id, "status": "FAILED", "reason": "No photos"}

            # Phase boundary 3: Before TTS & script synthesis
            _check_cancelled("before_tts")

            # 2. Generate Narration Script & Versioned TTS (no global os.environ mutation)
            logger.info(
                "--- [Phase 2/5: SCRIPT & TTS] Generating Azerbaijani voiceover for %s (v%d) ---",
                bina_id,
                resolved_version_num,
            )
            custom_script = validated_custom_script
            if custom_script is None and self.use_gemini and not price_drop_info:
                if not self.gemini_client.is_connected():
                    logger.info("Google AI Pro hovuzu yoxlanılır...")
                    self.gemini_client.ensure_connected()

                if self.gemini_client.is_connected():
                    logger.info("Requesting multimodal viral AI script from Google AI Pro (Gemini Advanced)...")
                    custom_script = self.gemini_client.generate_script(
                        working_listing,
                        photo_paths=downloaded_photos,
                    )
                else:
                    logger.info("Google AI Pro pool not active. Using built-in high-quality script generator.")

            tts_res = generate_tts_for_listing(
                listing=working_listing,
                output_dir=OUTPUT_DIR,
                voice=EDGE_TTS_VOICE,
                rate=EDGE_TTS_RATE,
                custom_script=custom_script,
                tts_engine=voice_engine or route_info.get("voice_engine"),
                voice_id=voice_id or route_info.get("voice_id"),
                script_angle=script_angle,
                version_num=resolved_version_num,
                price_drop_info=price_drop_info,
                model_id=model_id,
                voice_speed=route_info.get("voice_speed"),
                visual_profile=visual_profile,
            )
            if len(tts_res) == 6:
                script_text, audio_path, srt_path, duration, engine_used, fallback_triggered = tts_res
            else:
                script_text, audio_path, srt_path, duration = tts_res[:4]
                engine_used = voice_engine or route_info.get("voice_engine") or "edge-tts"
                fallback_triggered = False

            if not self.use_cloud_backend:
                update_listing_status(bina_id, "TTS_READY", db_path=self.db_path)

            # Phase boundary 4: After TTS / before FFmpeg render
            _check_cancelled("before_ffmpeg_render")

            # 3. 1080x1920 Versioned Cinematic Video Composition (video_{bina_id}_v{n}__at_{clean_handle}.mp4)
            logger.info(
                "--- [Phase 3/5: VIDEO COMPOSITION] Rendering video_%s_v%d__at_%s.mp4 ---",
                bina_id,
                resolved_version_num,
                clean_handle,
            )
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            output_video_path = OUTPUT_DIR / f"video_{bina_id}_v{resolved_version_num}__at_{clean_handle}.mp4"
            self.compositor.build_cinematic_video(
                listing=working_listing,
                image_paths=downloaded_photos,
                audio_path=audio_path,
                srt_path=srt_path,
                output_video_path=output_video_path,
                bg_music_path=self.bg_music_path,
                duration=duration,
            )

            # Phase boundary 5: After FFmpeg render / before <= 18 MB 2-pass cap
            _check_cancelled("before_size_cap")

            enforce_video_size_cap(
                output_video_path,
                duration_seconds=float(duration or 30.0),
                max_bytes=MAX_TELEGRAM_VIDEO_BYTES,
                temp_dir=job_temp_dir / "size_cap",
                ffmpeg_exe=getattr(self.compositor, "ffmpeg_exe", None),
                cancel_check_cb=cancel_check_cb,
            )
            resolved_video_str = str(output_video_path.resolve())

            # Record video in local SQLite when running local fallback (or if listing exists in SQLite)
            listing_row_id = 0
            if not self.use_cloud_backend:
                db_listing = get_listing_by_bina_id(bina_id, self.db_path)
                listing_row_id = db_listing["id"] if db_listing else 0
                if listing_row_id:
                    record_generated_video(
                        listing_id=listing_row_id,
                        video_path=resolved_video_str,
                        audio_path=audio_path,
                        srt_path=srt_path,
                        script_text=script_text,
                        duration_seconds=duration,
                        status="COMPLETED",
                        db_path=self.db_path,
                    )

            # Phase boundary 6: Before cloud R2/Supabase storage upload
            _check_cancelled("before_storage_upload")

            # 4. Versioned Cloud Storage Upload (Private R2 / Legacy Supabase dual-path)
            supabase_res: Optional[Dict[str, Any]] = None

            if self.use_cloud_backend:
                logger.info(
                    "--- [Phase 4/5: CLOUD STORAGE] Uploading videos/%s/v%d.mp4 ---",
                    bina_id,
                    resolved_version_num,
                )
                try:
                    storage_object_path, video_cdn_url = self.supabase_repo.upload_versioned_video(
                        resolved_video_str,
                        bina_id,
                        resolved_version_num,
                        target_account_handle=target_handle,
                        agency_id=agency_uuid,
                        listing_id=listing_uuid,
                    )
                except TypeError:
                    storage_object_path, video_cdn_url = self.supabase_repo.upload_versioned_video(
                        resolved_video_str,
                        bina_id,
                        resolved_version_num,
                        target_account_handle=target_handle,
                    )
                raw_provider = getattr(self.supabase_repo, "last_upload_storage_provider", None)
                if isinstance(raw_provider, str) and raw_provider.strip().lower() in ("r2", "supabase"):
                    upload_storage_provider = raw_provider.strip().lower()

                # Phase boundary 7: Right after cloud upload (delete partial R2 object if cancelled mid-upload!)
                _check_cancelled("after_storage_upload")

                if render_version_id:
                    _vp_meta: dict = {}
                    if visual_profile is not None and not getattr(visual_profile, "is_fallback", True):
                        try:
                            _vp_meta = visual_profile.to_dict()
                        except Exception:
                            pass
                    rv_patch: Dict[str, Any] = {
                        "script_text": script_text,
                        "local_video_path": resolved_video_str,
                        "storage_object_path": storage_object_path,
                        "video_cdn_url": video_cdn_url,
                        "duration_seconds": duration,
                        **({"ab_metadata": {"visual_profile": _vp_meta}} if _vp_meta else {}),
                    }
                    if upload_storage_provider is not None:
                        rv_patch["storage_provider"] = upload_storage_provider
                    self.supabase_repo.update_render_version(render_version_id, rv_patch)
            elif self.supabase_sync and self.supabase_sync.is_configured():
                logger.info("--- [Phase 4/5: LEGACY SUPABASE SYNC] Uploading video ---")
                video_cdn_url = self.supabase_sync.upload_video(resolved_video_str)
                supabase_res = self.supabase_sync.sync_deal(
                    listing=working_listing,
                    video_cdn_url=video_cdn_url,
                    video_duration=duration,
                    script_text=script_text,
                    status="DISPATCHED",
                )

            # 5. Idempotent Telegram Dispatch OR In-Place editMessageMedia (no fake mock_dispatch hack)
            logger.info("--- [Phase 5/5: TELEGRAM DISPATCH] Delivering version v%d ---", resolved_version_num)
            existing_tg_msg_id = (
                str(render_version_row.get("telegram_message_id") or "").strip()
                if render_version_row
                else ""
            )

            dispatch_result: Dict[str, Any]
            persisted_msg_id: Optional[str] = None

            if skip_telegram_dispatch:
                logger.info(
                    "Selective publishing active: skipping automatic Telegram dispatch for listing %s (staged as draft)",
                    bina_id,
                )
                dispatch_result = {
                    "status": "SKIPPED_DRAFT_READY",
                    "message": "Staged as draft in Web CRM",
                }
                persisted_msg_id = None
            elif update_telegram_message_id is not None and str(update_telegram_message_id).strip():
                target_msg_id = str(update_telegram_message_id).strip()
                crm_caption = generate_crm_caption(
                    working_listing,
                    target_account_handle=target_handle,
                    channel_niche=channel_niche,
                    fallback_triggered=fallback_triggered,
                )
                public_caption = generate_public_caption(working_listing)
                reply_markup = build_inline_keyboard(working_listing, fallback_triggered=fallback_triggered)

                if self.mock_dispatch:
                    dispatch_result = {
                        "status": "MOCK_UPDATED",
                        "message_id": target_msg_id,
                        "crm_caption": crm_caption,
                        "public_caption": public_caption,
                        "reply_markup": reply_markup,
                    }
                    persisted_msg_id = target_msg_id
                else:
                    edited = self._edit_telegram_message_media(
                        chat_id=telegram_chat_id or self.dispatcher.chat_id,
                        message_id=target_msg_id,
                        video_path=resolved_video_str,
                        caption=crm_caption,
                        reply_markup=reply_markup,
                    )
                    if edited:
                        dispatch_result = {
                            "status": "UPDATED",
                            "message_id": target_msg_id,
                            "crm_caption": crm_caption,
                            "public_caption": public_caption,
                            "reply_markup": reply_markup,
                        }
                        persisted_msg_id = target_msg_id
                    else:
                        logger.warning(
                            "editMessageMedia failed for %s (msg=%s); falling back to sendVideo.",
                            bina_id,
                            target_msg_id,
                        )
                        dispatch_result = self.dispatcher.send_video_lead(
                            listing=working_listing,
                            video_path=resolved_video_str,
                            target_account_handle=target_handle,
                            channel_niche=channel_niche,
                            fallback_triggered=fallback_triggered,
                        )
                        persisted_msg_id = str(dispatch_result.get("message_id") or "") or None
            elif existing_tg_msg_id:
                logger.info(
                    "Idempotency guard: render_version v%d for %s already dispatched (msg=%s); skipping duplicate sendVideo.",
                    resolved_version_num,
                    bina_id,
                    existing_tg_msg_id,
                )
                dispatch_result = {
                    "status": "ALREADY_DISPATCHED",
                    "message_id": existing_tg_msg_id,
                }
                persisted_msg_id = existing_tg_msg_id
            else:
                dispatch_result = self.dispatcher.send_video_lead(
                    listing=working_listing,
                    video_path=resolved_video_str,
                    target_account_handle=target_handle,
                    channel_niche=channel_niche,
                    fallback_triggered=fallback_triggered,
                )
                persisted_msg_id = str(dispatch_result.get("message_id") or "") or None

            # IMMEDIATELY persist telegram_message_id right after sendVideo/editMessageMedia
            if persisted_msg_id and self.use_cloud_backend and render_version_id:
                self.supabase_repo.update_render_version(
                    render_version_id,
                    {"telegram_message_id": persisted_msg_id},
                )

            if not self.use_cloud_backend and listing_row_id:
                mark_video_dispatched(
                    listing_id=listing_row_id,
                    telegram_message_id=persisted_msg_id,
                    db_path=self.db_path,
                )

            # Finalize render_version as COMPLETED, mark prior versions SUPERSEDED, update listing
            if self.use_cloud_backend:
                if render_version_id:
                    final_rv_patch: Dict[str, Any] = {
                        "status": "COMPLETED",
                        "script_text": script_text,
                        "local_video_path": resolved_video_str,
                        "storage_object_path": storage_object_path,
                        "video_cdn_url": video_cdn_url,
                        "duration_seconds": duration,
                        "telegram_message_id": persisted_msg_id,
                        "rendered_price": safe_parse_numeric(working_listing.get("price")),
                        "rendered_currency": working_listing.get("currency") or "AZN",
                    }
                    if upload_storage_provider is not None:
                        final_rv_patch["storage_provider"] = upload_storage_provider
                    self.supabase_repo.update_render_version(
                        render_version_id,
                        final_rv_patch,
                    )
                if listing_uuid:
                    self.supabase_repo.mark_previous_versions_superseded(
                        listing_uuid,
                        keep_version_num=resolved_version_num,
                    )
                    listing_patch: Dict[str, Any] = {
                        "pipeline_status": "DRAFT_READY" if skip_telegram_dispatch else "DISPATCHED",
                        "last_rendered_revision": content_revision,
                    }
                    if trigger_reason in AUTO_TRIGGER_REASONS:
                        listing_patch["last_auto_rendered_at"] = _utc_now_iso()
                    self.supabase_repo.update_listing(listing_uuid, listing_patch)

            # Deprecated Notion CRM (disabled by default unless NOTION_LEGACY_SYNC=true)
            notion_res = None
            if self.notion_crm and self.notion_crm.enabled:
                logger.info(f"--- [LEGACY] Syncing deal {bina_id} to Notion CRM database ---")
                notion_res = self.notion_crm.sync_deal(
                    listing=working_listing,
                    video_cdn_url=video_cdn_url,
                    script_text=script_text,
                    status="Dispatched",
                )

            # Sentry Telemetry event
            try:
                import sentry_sdk
                sentry_sdk.set_tag("bina_id", str(bina_id))
                sentry_sdk.capture_message(
                    f"Deal {bina_id} v{resolved_version_num} dispatched "
                    f"(Duration: {duration:.1f}s, Price: {working_listing.get('price')} {working_listing.get('currency', 'AZN')})",
                    level="info",
                )
            except Exception:
                pass

            logger.info(f"=== Successfully completed pipeline for listing {bina_id} (v{resolved_version_num})! ===")
            return {
                "bina_id": bina_id,
                "version_num": resolved_version_num,
                "render_version_id": render_version_id,
                "video_path": resolved_video_str,
                "audio_path": audio_path,
                "srt_path": srt_path,
                "duration": duration,
                "dispatch": dispatch_result,
                "storage_object_path": storage_object_path,
                "storage_provider": upload_storage_provider,
                "video_cdn_url": video_cdn_url,
                "supabase": supabase_res,
                "notion": notion_res,
                "tts_engine_used": engine_used,
                "tts_fallback": fallback_triggered,
                "target_account_handle": target_handle,
                "channel_niche": channel_niche,
                "visual_profile": visual_profile.to_dict() if visual_profile and hasattr(visual_profile, "to_dict") else None,
            }
        except PipelineCancelledError as cancel_exc:
            logger.info("Pipeline cancelled cooperatively for listing %s: %s", bina_id, cancel_exc)
            cleaned_storage = False
            if storage_object_path and self.use_cloud_backend and hasattr(self.supabase_repo, "delete_storage_object"):
                try:
                    cleaned_storage = bool(
                        self.supabase_repo.delete_storage_object(
                            storage_object_path,
                            storage_provider=upload_storage_provider,
                        )
                    )
                except Exception as del_exc:
                    logger.warning("Failed deleting partial storage object %s on cancel: %s", storage_object_path, del_exc)
            if output_video_path is not None and output_video_path.exists():
                try:
                    output_video_path.unlink()
                except Exception:
                    pass
            if self.use_cloud_backend:
                if render_version_id:
                    self.supabase_repo.update_render_version(
                        render_version_id,
                        {
                            "status": "FAILED",
                            "error_message": str(cancel_exc)[:1000],
                            "storage_object_path": None,
                            "video_cdn_url": None,
                        },
                    )
                if listing_uuid:
                    self.supabase_repo.update_listing(listing_uuid, {"pipeline_status": "NEW"})
            return {
                "bina_id": bina_id,
                "status": "CANCELLED",
                "cancelled": True,
                "render_version_id": render_version_id,
                "storage_object_path": storage_object_path,
                "storage_provider": upload_storage_provider,
                "cleaned_storage_object": cleaned_storage,
                "reason": str(cancel_exc),
            }
        except WorkerShutdownError:
            if storage_object_path and self.use_cloud_backend and hasattr(self.supabase_repo, "delete_storage_object"):
                try:
                    self.supabase_repo.delete_storage_object(
                        storage_object_path,
                        storage_provider=upload_storage_provider,
                    )
                except Exception:
                    pass
            if output_video_path is not None and output_video_path.exists():
                try:
                    output_video_path.unlink()
                except Exception:
                    pass
            raise
        except Exception as e:
            logger.error(f"Error processing listing {bina_id}: {e}", exc_info=True)
            try:
                import sentry_sdk
                sentry_sdk.set_tag("bina_id", str(bina_id))
                sentry_sdk.capture_exception(e)
            except Exception:
                pass
            if self.use_cloud_backend:
                if render_version_id:
                    self.supabase_repo.update_render_version(
                        render_version_id,
                        {"status": "FAILED", "error_message": str(e)[:1000]},
                    )
                if listing_uuid:
                    self.supabase_repo.update_listing(listing_uuid, {"pipeline_status": "FAILED"})
            else:
                update_listing_status(bina_id, "FAILED", db_path=self.db_path)
            return {"bina_id": bina_id, "status": "FAILED", "error": str(e)}
        finally:
            try:
                shutil.rmtree(job_temp_dir, ignore_errors=True)
            except Exception:
                pass

    def run_full_pipeline(
        self,
        pages: int = 1,
        limit: int = 1,
        specific_id: Optional[str] = None,
        voice_engine: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """End-to-end execution across ingestion and video production."""
        logger.info("=================================================================")
        logger.info("   BAKU ESTATE AI - AUTOMATED SOCIAL MEDIA VIDEO PIPELINE       ")
        logger.info("=================================================================")

        if specific_id:
            if self.use_cloud_backend:
                specific = self.supabase_repo.get_listing_by_bina_id(specific_id)
                if not specific:
                    ingested = self.run_ingestion(
                        pages=pages,
                        limit_per_page=limit,
                        specific_id=specific_id,
                        enqueue_render_jobs=False,
                    )
                    specific = ingested[0] if ingested else self.supabase_repo.get_listing_by_bina_id(specific_id)
            else:
                specific = get_listing_by_bina_id(specific_id, self.db_path)
                if not specific or not specific.get("downloaded_photos"):
                    self.run_ingestion(pages=pages, limit_per_page=limit, specific_id=specific_id)
                    specific = get_listing_by_bina_id(specific_id, self.db_path)
            pending_listings = [specific] if specific else []
        else:
            if self.use_cloud_backend:
                pending_listings = self.run_ingestion(
                    pages=pages,
                    limit_per_page=limit,
                    enqueue_render_jobs=False,
                )
            else:
                self.run_ingestion(pages=pages, limit_per_page=limit)
                pending_listings = get_unprocessed_listings(limit=limit, db_path=self.db_path)

        results = []
        for item in pending_listings[:limit]:
            try:
                res = self.process_listing_video_and_dispatch(item, voice_engine=voice_engine)
                results.append(res)
            except Exception as e:
                logger.error(f"Unhandled exception in pipeline item {item.get('bina_id')}: {e}", exc_info=True)
                try:
                    import sentry_sdk
                    sentry_sdk.capture_exception(e)
                except Exception:
                    pass
                results.append({"bina_id": item.get("bina_id"), "status": "FAILED", "error": str(e)})

        logger.info(f"--- Pipeline finished. Successfully processed {len(results)} videos ---")
        return results


def main():
    parser = argparse.ArgumentParser(description="Baku Estate AI Video Pipeline Runner")
    parser.add_argument("--pages", type=int, default=1, help="Number of bina.az search pages to crawl")
    parser.add_argument("--limit", type=int, default=1, help="Max number of listings to convert into videos")
    parser.add_argument("--listing-id", "--bina-id", type=str, default=None, dest="listing_id", help="Process a specific bina.az ID directly")
    parser.add_argument("--voice-engine", type=str, default=None, choices=["elevenlabs", "edge-tts"], help="TTS engine override (elevenlabs or edge-tts)")
    parser.add_argument("--allow-agents", action="store_true", help="Allow agent listings (defaults to owner only)")
    parser.add_argument("--setup-accounts", action="store_true", help="Initialize Google account pool profiles")
    parser.add_argument("--init-db-only", action="store_true", help="Initialize SQLite database schema and exit")
    parser.add_argument("--live-dispatch", action="store_true", help="Send to real Telegram bot instead of mock")
    parser.add_argument("--use-gemini", action="store_true", help="Use active Google Pro (Gemini) session in Brave for scripts")
    parser.add_argument("--bg-music", type=str, default=None, help="Path to custom background music audio file")
    parser.add_argument("--supabase", action="store_true", default=None, help="Force enable Supabase backend")
    parser.add_argument("--no-supabase", action="store_false", dest="supabase", help="Disable Supabase (local SQLite fallback)")
    parser.add_argument("--notion", action="store_true", default=None, help="Force enable legacy Notion CRM sync")
    parser.add_argument("--no-notion", action="store_false", dest="notion", help="Disable legacy Notion CRM sync")

    args = parser.parse_args()

    if args.init_db_only:
        init_db(DB_PATH)
        print("Database schema successfully initialized.")
        return

    if args.setup_accounts:
        setup_all_profiles(PROFILES_DIR, DB_PATH)
        print("Google account profiles successfully configured.")
        return

    dispatch_mock = False if args.live_dispatch else TELEGRAM_MOCK_DISPATCH

    pipeline = BakuEstatePipeline(
        owner_only=not args.allow_agents,
        mock_dispatch=dispatch_mock,
        db_path=DB_PATH,
        use_gemini=args.use_gemini,
        bg_music_path=args.bg_music,
        enable_supabase=args.supabase,
        enable_notion=args.notion,
    )

    pipeline.run_full_pipeline(
        pages=args.pages,
        limit=args.limit,
        specific_id=args.listing_id,
        voice_engine=args.voice_engine,
    )


if __name__ == "__main__":
    main()
