"""
Unified Windows Local Worker Daemon for BakuEstate-AI.
Polls Supabase Postgres `claim_next_pipeline_job()` every 10 seconds (FOR UPDATE SKIP LOCKED),
maintains a 60-second background heartbeat thread extending `lease_expires_at` + updating
`worker_heartbeats`, executes all supported job types (`SCRAPE_NEW`, `RENDER_INITIAL`,
`RENDER_PRICE_DROP`, `RERENDER`, `LIVENESS_CHECK`, `PREFLIGHT_CHECK`, `SYNC_SOCIAL_METRICS`,
`TELEGRAM_DISPATCH`), and cleanly schedules periodic
`SCRAPE_NEW` and `LIVENESS_CHECK` jobs using idempotent keys.
"""

from __future__ import annotations

import sys
from pathlib import Path

BASE_PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
if str(BASE_PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_PROJECT_DIR))

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import os
import re
import json
import argparse
import logging
import random
import signal
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple, Union

from config.settings import (
    AUTO_JOB_TTL_HOURS,
    AUTO_RENDER_COOLDOWN_HOURS,
    DAILY_AUTO_RENDER_LIMIT,
    DB_PATH,
    OUTPUT_DIR,
    SCHEDULE_LIMIT,
    SCHEDULE_PAGES,
    SCHEDULE_TIMES,
    SOCIAL_API_MODE,
    SOCIAL_CIRCUIT_BREAKER_HOURS,
    SOCIAL_POLL_BUDGET_MAX,
    SOCIAL_SCRAPER_TIMEOUT_SECONDS,
    SOCIAL_TELEMETRY_ENABLED,
    TELEGRAM_MOCK_DISPATCH,
    WORKER_ID,
    init_sentry,
)

if TYPE_CHECKING:
    from run_pipeline import BakuEstatePipeline
from src.cloud.supabase_repo import SupabaseRepo
from src.dedup.change_detector import (
    BLOCKED_EDITORIAL_STATUSES,
    BLOCKED_OUTREACH_STATUSES,
)
from src.dispatcher.telegram_bot_service import TelegramBotService, resolve_voice_choice
from src.dispatcher.telegram_crm import TelegramCRMDispatcher
from src.scheduler import parse_schedule_times
from src.scraper.bina_scraper import (
    BinaScraper,
    LIVENESS_ACTIVE,
    LIVENESS_REMOVED,
    LIVENESS_TRANSIENT_ERROR,
    REMOVED_DOM_PHRASES,
)
from src.worker.account_router import route_listing_to_channel

logger = logging.getLogger("local_worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

BAKU_TZ = timezone(timedelta(hours=4))

DEFAULT_POLL_INTERVAL_SECONDS = 2.0
DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 15.0
DEFAULT_LEASE_MINUTES = 5
DEFAULT_LIVENESS_INTERVAL_HOURS = 12
DEFAULT_LIVENESS_LIMIT = 50
DEFAULT_RENDER_MAX_RUNTIME_SECONDS = 600.0
DEFAULT_SCRAPE_LIVENESS_MAX_RUNTIME_SECONDS = 300.0
DEFAULT_SOCIAL_MAX_RUNTIME_SECONDS = 60.0
DEFAULT_TELEGRAM_MAX_RUNTIME_SECONDS = 180.0
DEFAULT_MISSED_SLOT_WINDOW_HOURS = 3.0
DEFAULT_LIVENESS_JITTER_RANGE: Tuple[float, float] = (1.5, 3.0)
DEFAULT_LIVENESS_CIRCUIT_BREAKER_THRESHOLD = 3
RENDER_JOB_TYPES = frozenset({"RENDER_INITIAL", "RENDER_PRICE_DROP", "RERENDER"})
ALL_JOB_TYPES = frozenset({
    "SCRAPE_NEW",
    "RENDER_INITIAL",
    "RENDER_PRICE_DROP",
    "RERENDER",
    "LIVENESS_CHECK",
    "PREFLIGHT_CHECK",
    "SYNC_SOCIAL_METRICS",
    "TELEGRAM_DISPATCH",
    "PUBLISH_SOCIAL",
})

SCHEDULE_OFFSETS_HOURS: List[int] = [4, 12, 24, 36, 48, 60, 72, 96, 120, 144, 168]
TOTAL_POLL_BUDGET: int = 11


def calculate_decay_schedule(
    published_at: datetime,
    completed_polls: int,
    now: Optional[datetime] = None,
) -> Tuple[Optional[datetime], str, Optional[str]]:
    """
    Calculates 4-phase decay schedule:
    Phase 1 (0-24h): 3 polls (T+4h, T+12h, T+24h)
    Phase 2 (24-72h): every 12h (T+36h, T+48h - snapshot A/B NER score, T+60h, T+72h)
    Phase 3 (72-168h): daily (T+96h, T+120h, T+144h, T+168h)
    Phase 4 (>168h): set telemetry_status='FROZEN' (stops automated polling; max 11 total polls).

    Returns: (next_poll_at, telemetry_status, snapshot_phase)
    """
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=timezone.utc)
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)

    # Determine snapshot phase for the poll that just completed (completed_polls: 1..11)
    snapshot_phase: Optional[str] = None
    phase_map = {
        1: "T+4h",
        2: "T+12h",
        3: "T+24h",
        5: "T+48h",
        11: "T+7d",
    }
    if completed_polls in phase_map:
        snapshot_phase = phase_map[completed_polls]
    elif 1 <= completed_polls <= len(SCHEDULE_OFFSETS_HOURS):
        offset = SCHEDULE_OFFSETS_HOURS[completed_polls - 1]
        snapshot_phase = f"T+{offset}h"

    # Check Phase 4 freeze conditions:
    # 1. Total lifetime poll budget completed (>= 11)
    # 2. Time elapsed > 168 hours (7 days)
    elapsed = current_time - published_at
    if completed_polls >= TOTAL_POLL_BUDGET or elapsed >= timedelta(hours=168):
        return None, "FROZEN", snapshot_phase

    # Next poll calculation: index in SCHEDULE_OFFSETS_HOURS is completed_polls
    next_offset_hours = SCHEDULE_OFFSETS_HOURS[completed_polls]
    next_poll_dt = published_at + timedelta(hours=next_offset_hours)

    return next_poll_dt, "ACTIVE", snapshot_phase


def calculate_ner_score(
    views: int,
    leads: int,
    comments: int,
    median_views: float = 1000.0,
) -> float:
    """
    Normalized Engagement Ratio (NER):
    (Views_48h / max(1.0, Median_Views)) * 0.6 + (Leads_48h / max(1, Comments_48h)) * 0.4
    """
    m_views = float(median_views) if median_views and median_views > 0 else 1.0
    v_ratio = float(views) / m_views
    c_denom = max(1, int(comments))
    l_ratio = float(leads) / float(c_denom)
    return round((v_ratio * 0.6) + (l_ratio * 0.4), 4)


def _default_max_runtime_for_job_type(job_type: str) -> float:
    clean_type = str(job_type or "").strip().upper()
    if clean_type in RENDER_JOB_TYPES:
        return DEFAULT_RENDER_MAX_RUNTIME_SECONDS
    if clean_type in ("SYNC_SOCIAL_METRICS", "PUBLISH_SOCIAL"):
        return DEFAULT_SOCIAL_MAX_RUNTIME_SECONDS
    if clean_type == "TELEGRAM_DISPATCH":
        return DEFAULT_TELEGRAM_MAX_RUNTIME_SECONDS
    return DEFAULT_SCRAPE_LIVENESS_MAX_RUNTIME_SECONDS


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _baku_now(now: Optional[datetime] = None) -> datetime:
    base = now or _utc_now()
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    return base.astimezone(BAKU_TZ)


def _parse_utc_iso(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            return None
    return None


def is_job_expired(job: Dict[str, Any], now: Optional[datetime] = None) -> bool:
    """
    Defense-in-depth TTL check: returns True when an AUTO_SCHEDULER job has passed its
    `expires_at` deadline. Manual jobs (`WEB_UI`, `TELEGRAM_WEBHOOK`) never expire on PC sleep.
    """
    trigger_source = str(job.get("trigger_source") or "").strip().upper()
    if trigger_source != "AUTO_SCHEDULER":
        return False
    expires_at = _parse_utc_iso(job.get("expires_at"))
    if expires_at is None:
        return False
    current = now or _utc_now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return expires_at < current


def get_next_baku_schedule_slot(
    scrape_times: List[str],
    now: Optional[datetime] = None,
) -> Optional[str]:
    """Returns the next scheduled Baku (UTC+4) auto-scrape slot label."""
    if not scrape_times:
        return None
    baku_now = _baku_now(now)
    parsed: List[Tuple[int, int, str]] = []
    for raw in scrape_times:
        try:
            hh, mm = map(int, str(raw).strip().split(":"))
            parsed.append((hh, mm, f"{hh:02d}:{mm:02d}"))
        except (ValueError, TypeError):
            continue
    if not parsed:
        return None
    parsed.sort(key=lambda t: (t[0], t[1]))
    current_hm = (baku_now.hour, baku_now.minute)
    for hh, mm, label in parsed:
        if (hh, mm) > current_hm:
            return label
    return f"Sabah {parsed[0][2]}"


JOB_PHASE_LABELS: Dict[str, str] = {
    "SCRAPE_NEW": "bina.az-dan yeni elanlar yığılır",
    "RENDER_INITIAL": "Video montaj və TTS səs sintezi aparılır",
    "RENDER_PRICE_DROP": "Qiymət endirimi videosu hazırlanır",
    "RERENDER": "Video yenidən montaj edilir",
    "LIVENESS_CHECK": "bina.az elan aktivliyi yoxlanılır",
    "PREFLIGHT_CHECK": "Yayınöncəsi qiymət yoxlaması aparılır",
    "SYNC_SOCIAL_METRICS": "Sosial media statistikası yığılır",
    "TELEGRAM_DISPATCH": "Video Telegram-a göndərilir",
    "PUBLISH_SOCIAL": "Rəsmi sosial şəbəkə paylaşımı icra olunur",
}


class WorkerTelemetryBuffer(logging.Handler):
    """Thread-safe bounded log buffer capturing recent worker pipeline events."""

    def __init__(self, maxlen: int = 20):
        super().__init__(level=logging.INFO)
        self._records: deque[Dict[str, str]] = deque(maxlen=max(1, int(maxlen)))
        self._lock = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = record.getMessage()
            if len(msg) > 220:
                msg = msg[:217] + "..."
            ts = datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat()
            entry = {
                "ts": ts,
                "level": record.levelname,
                "msg": msg,
            }
            with self._lock:
                self._records.append(entry)
        except Exception:  # noqa: BLE001, S110
            pass

    def snapshot(self) -> List[Dict[str, str]]:
        with self._lock:
            return list(self._records)


class JobHeartbeatThread(threading.Thread):
    """
    Background thread that periodically extends `pipeline_jobs.lease_expires_at`
    and updates `worker_heartbeats` while a long-running scrape/render job executes.
    Stops renewing once `max_runtime_seconds` is exceeded OR when
    `heartbeat_pipeline_job()` returns False (setting `self.lease_lost`).
    """

    def __init__(
        self,
        repo: SupabaseRepo,
        job_id: str,
        worker_id: str,
        *,
        job_type: str = "",
        lease_minutes: int = DEFAULT_LEASE_MINUTES,
        interval_seconds: float = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        max_runtime_seconds: Optional[float] = None,
        telemetry_fn: Optional[Callable[[], Dict[str, Any]]] = None,
    ):
        super().__init__(name=f"heartbeat-{str(job_id)[:8]}", daemon=True)
        self.repo = repo
        self.job_id = str(job_id)
        self.worker_id = worker_id
        self.job_type = job_type
        self.lease_minutes = max(1, int(lease_minutes))
        self.interval_seconds = max(0.05, float(interval_seconds))
        resolved_cap = (
            float(max_runtime_seconds)
            if max_runtime_seconds is not None
            else _default_max_runtime_for_job_type(job_type)
        )
        self.max_runtime_seconds = max(0.05, resolved_cap)
        self.telemetry_fn = telemetry_fn
        self._stop_event = threading.Event()
        self.lease_lost = threading.Event()
        self.runtime_cap_exceeded = threading.Event()
        self.heartbeat_count = 0
        self._started_mono = 0.0

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        self._started_mono = time.monotonic()
        while not self._stop_event.wait(timeout=self.interval_seconds):
            elapsed = time.monotonic() - self._started_mono
            if elapsed >= self.max_runtime_seconds:
                self.runtime_cap_exceeded.set()
                logger.warning(
                    "Job %s (%s) exceeded max_runtime_seconds=%.1fs (elapsed=%.1fs); "
                    "stopping lease renewals.",
                    self.job_id,
                    self.job_type,
                    self.max_runtime_seconds,
                    elapsed,
                )
                break

            try:
                ok = self.repo.heartbeat_pipeline_job(
                    self.job_id,
                    worker_id=self.worker_id,
                    lease_minutes=self.lease_minutes,
                )
                meta: Dict[str, Any] = {"job_type": self.job_type, "lease_extended": bool(ok)}
                if self.telemetry_fn is not None:
                    try:
                        extra = self.telemetry_fn()
                        if isinstance(extra, dict):
                            meta.update(extra)
                    except Exception:  # noqa: BLE001, S110
                        pass
                self.repo.record_worker_heartbeat(
                    worker_id=self.worker_id,
                    current_job_id=self.job_id,
                    metadata=meta,
                )
                self.heartbeat_count += 1
                if not ok:
                    self.lease_lost.set()
                    logger.warning(
                        "Lease lost for job %s (%s) on worker '%s'; stopping lease renewals.",
                        self.job_id,
                        self.job_type,
                        self.worker_id,
                    )
                    break
                logger.debug(
                    "Heartbeat #%d sent for job %s (lease_extended=%s)",
                    self.heartbeat_count,
                    self.job_id,
                    ok,
                )
            except Exception as exc:
                logger.warning("Heartbeat error for job %s: %s", self.job_id, exc)


class BakuLocalWorker:
    """
    Single-process Windows local worker daemon polling Supabase `pipeline_jobs`.
    """

    def __init__(
        self,
        repo: Optional[SupabaseRepo] = None,
        pipeline: Optional[BakuEstatePipeline] = None,
        *,
        worker_id: str = WORKER_ID,
        poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
        heartbeat_interval_seconds: float = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        lease_minutes: int = DEFAULT_LEASE_MINUTES,
        scrape_times: Optional[List[str]] = None,
        scrape_pages: int = SCHEDULE_PAGES,
        scrape_limit: int = SCHEDULE_LIMIT,
        liveness_interval_hours: int = DEFAULT_LIVENESS_INTERVAL_HOURS,
        liveness_limit: int = DEFAULT_LIVENESS_LIMIT,
        liveness_jitter_range: Tuple[float, float] = DEFAULT_LIVENESS_JITTER_RANGE,
        liveness_circuit_breaker_threshold: int = DEFAULT_LIVENESS_CIRCUIT_BREAKER_THRESHOLD,
        render_max_runtime_seconds: float = DEFAULT_RENDER_MAX_RUNTIME_SECONDS,
        scrape_max_runtime_seconds: float = DEFAULT_SCRAPE_LIVENESS_MAX_RUNTIME_SECONDS,
        missed_slot_window_hours: float = DEFAULT_MISSED_SLOT_WINDOW_HOURS,
        enable_periodic_scheduler: bool = True,
        mock_dispatch: Optional[bool] = None,
        owner_only: bool = True,
        db_path: Path = DB_PATH,
    ):
        init_sentry()

        self.worker_id = (worker_id or WORKER_ID or "windows-local-worker").strip()
        self.poll_interval_seconds = max(0.05, float(poll_interval_seconds))
        self.heartbeat_interval_seconds = max(0.05, float(heartbeat_interval_seconds))
        self.lease_minutes = max(1, int(lease_minutes))
        self.scrape_times = (
            list(scrape_times)
            if scrape_times is not None
            else parse_schedule_times(SCHEDULE_TIMES)
        )
        self.scrape_pages = max(1, int(scrape_pages))
        self.scrape_limit = max(1, int(scrape_limit))
        self.liveness_interval_hours = max(1, int(liveness_interval_hours))
        self.liveness_limit = max(1, int(liveness_limit))
        low_jitter = max(0.0, float(liveness_jitter_range[0]))
        high_jitter = max(low_jitter, float(liveness_jitter_range[1]))
        self.liveness_jitter_range = (low_jitter, high_jitter)
        self.liveness_circuit_breaker_threshold = max(1, int(liveness_circuit_breaker_threshold))
        self.render_max_runtime_seconds = max(0.05, float(render_max_runtime_seconds))
        self.scrape_max_runtime_seconds = max(0.05, float(scrape_max_runtime_seconds))
        self.missed_slot_window_hours = max(0.0, float(missed_slot_window_hours))
        self.enable_periodic_scheduler = bool(enable_periodic_scheduler)

        self.repo = repo if repo is not None else SupabaseRepo(enabled=True)
        if pipeline is not None:
            self.pipeline = pipeline
        else:
            from run_pipeline import BakuEstatePipeline
            dispatch_mock = TELEGRAM_MOCK_DISPATCH if mock_dispatch is None else mock_dispatch
            self.pipeline = BakuEstatePipeline(
                owner_only=owner_only,
                mock_dispatch=dispatch_mock,
                db_path=db_path,
                use_cloud_backend=True,
                supabase_repo=self.repo,
            )

        bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
        chat_id = os.getenv("TELEGRAM_CHAT_ID")
        self.telegram = TelegramBotService(
            bot_token=bot_token,
            chat_id=chat_id,
            db_path=db_path,
        )

        self._stop_event = threading.Event()
        self._sigterm_received = threading.Event()
        self._last_idle_heartbeat_mono = 0.0
        self._enqueued_schedule_keys: set[str] = set()
        self._consecutive_social_rate_limits: int = 0
        self.jobs_processed = 0
        self._started_at_iso = _utc_now().isoformat()
        self._current_phase: str = "Tapşırıq gözlənilir"
        self._current_bina_id: Optional[str] = None
        self._telemetry_buffer = WorkerTelemetryBuffer(maxlen=20)

    def get_telemetry_snapshot(self, **overrides: Any) -> Dict[str, Any]:
        """Builds structured worker telemetry dictionary for worker_heartbeats.metadata_json."""
        snapshot: Dict[str, Any] = {
            "state": overrides.pop("state", "IDLE"),
            "pid": os.getpid(),
            "started_at": self._started_at_iso,
            "jobs_processed_session": self.jobs_processed,
            "current_phase": overrides.pop("current_phase", self._current_phase),
            "current_bina_id": overrides.pop("current_bina_id", self._current_bina_id),
            "next_schedule_baku": get_next_baku_schedule_slot(self.scrape_times),
            "recent_logs": self._telemetry_buffer.snapshot(),
        }
        snapshot.update(overrides)
        return snapshot

    def stop(self) -> None:
        logger.info("Local worker '%s' received stop request.", self.worker_id)
        self._stop_event.set()

    def handle_sigterm(self, signum: Optional[int] = None, frame: Any = None) -> None:
        """
        Graceful SIGTERM handler (Railway container draining):
        Sets stop/sigterm flags and immediately interrupts any active FFmpeg subprocess
        so the running job cleans up and releases its lease back to QUEUED (or CANCELLED).
        """
        logger.warning(
            "Worker '%s' received SIGTERM (sig=%s); interrupting active FFmpeg subprocesses...",
            self.worker_id,
            signum,
        )
        self._sigterm_received.set()
        self._stop_event.set()
        try:
            from run_pipeline import terminate_active_ffmpeg_processes

            terminated = terminate_active_ffmpeg_processes()
            if terminated:
                logger.info("Interrupted %d active FFmpeg subprocess(es) on SIGTERM.", terminated)
        except Exception as exc:
            logger.warning("Error interrupting active FFmpeg subprocesses on SIGTERM: %s", exc)

    @property
    def is_running(self) -> bool:
        return not self._stop_event.is_set()

    # ------------------------------------------------------------------
    # Periodic Job Scheduling (Idempotent SCRAPE_NEW & LIVENESS_CHECK)
    # ------------------------------------------------------------------

    def maybe_enqueue_scheduled_jobs(self, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """
        Enqueues periodic `SCRAPE_NEW` (at configured Baku HH:MM times) and
        `LIVENESS_CHECK` (every `liveness_interval_hours`) into `pipeline_jobs`
        using deterministic idempotency keys so restarts never duplicate jobs.
        """
        if not self.enable_periodic_scheduler or not self.repo.is_configured():
            return []

        baku_now = _baku_now(now)
        utc_now = baku_now.astimezone(timezone.utc)
        expires_at = (utc_now + timedelta(hours=max(1, int(AUTO_JOB_TTL_HOURS)))).isoformat()
        date_str = baku_now.strftime("%Y-%m-%d")
        enqueued: List[Dict[str, Any]] = []

        # 1. Daily fixed-time SCRAPE_NEW slots (Baku UTC+4)
        # Coalesce missed schedule slots: on wake-up, enqueue AT MOST 1 catch-up
        # SCRAPE_NEW job for the most recent slot within the last 3 hours and skip
        # older/earlier missed slots instead of backfilling them back-to-back.
        catchup_window = timedelta(hours=self.missed_slot_window_hours)
        eligible_slots: List[Tuple[datetime, str]] = []
        for slot in self.scrape_times:
            try:
                hour, minute = map(int, slot.split(":"))
            except ValueError:
                continue
            slot_dt = baku_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if slot_dt <= baku_now and (baku_now - slot_dt) <= catchup_window:
                eligible_slots.append((slot_dt, slot))

        if eligible_slots:
            eligible_slots.sort(key=lambda item: item[0], reverse=True)
            _, latest_slot = eligible_slots[0]
            idem_key = f"sched_scrape:{date_str}:{latest_slot}"
            if idem_key not in self._enqueued_schedule_keys:
                job = self.repo.enqueue_pipeline_job(
                    idempotency_key=idem_key,
                    job_type="SCRAPE_NEW",
                    trigger_source="AUTO_SCHEDULER",
                    params_json={
                        "pages": self.scrape_pages,
                        "limit": self.scrape_limit,
                        "check_existing_for_changes": True,
                        "scheduled_slot_baku": latest_slot,
                    },
                    expires_at=expires_at,
                )
                self._enqueued_schedule_keys.add(idem_key)
                if job:
                    logger.info("Scheduled SCRAPE_NEW job %s (slot=%s Baku)", job.get("id"), latest_slot)
                    enqueued.append(job)
            # Mark any earlier coalesced slots within the window as skipped
            for _, skipped_slot in eligible_slots[1:]:
                self._enqueued_schedule_keys.add(f"sched_scrape:{date_str}:{skipped_slot}")

        # 2. Periodic LIVENESS_CHECK buckets (every N hours in Baku day)
        bucket = baku_now.hour // self.liveness_interval_hours
        liveness_key = f"sched_liveness:{date_str}:b{bucket}"
        if liveness_key not in self._enqueued_schedule_keys:
            job = self.repo.enqueue_pipeline_job(
                idempotency_key=liveness_key,
                job_type="LIVENESS_CHECK",
                trigger_source="AUTO_SCHEDULER",
                params_json={
                    "limit": self.liveness_limit,
                    "bucket": bucket,
                },
                expires_at=expires_at,
            )
            self._enqueued_schedule_keys.add(liveness_key)
            if job:
                logger.info("Scheduled LIVENESS_CHECK job %s (bucket=%d)", job.get("id"), bucket)
                enqueued.append(job)

        # 3. Scheduled SYNC_SOCIAL_METRICS for due publications
        if SOCIAL_TELEMETRY_ENABLED:
            try:
                due_publications = self.repo.get_active_telemetry_publications(now=utc_now)
                for pub in due_publications:
                    pub_id = str(pub.get("id") or "").strip()
                    post_url = pub.get("post_url")
                    if not pub_id or not post_url:
                        continue
                    poll_count = int(pub.get("poll_count") or 0)
                    idem_key = f"sync_social:{pub_id}:{poll_count}"
                    if idem_key not in self._enqueued_schedule_keys:
                        job = self.repo.enqueue_pipeline_job(
                            idempotency_key=idem_key,
                            job_type="SYNC_SOCIAL_METRICS",
                            listing_id=str(pub.get("listing_id") or "") or None,
                            trigger_source="AUTO_SCHEDULER",
                            params_json={
                                "publication_id": pub_id,
                                "post_url": post_url,
                                "channel": pub.get("channel", "INSTAGRAM_REELS"),
                                "poll_count": poll_count,
                            },
                            expires_at=expires_at,
                        )
                        self._enqueued_schedule_keys.add(idem_key)
                        if job:
                            logger.info(
                                "Scheduled SYNC_SOCIAL_METRICS job %s for publication %s (poll #%d)",
                                job.get("id"),
                                pub_id,
                                poll_count + 1,
                            )
                            enqueued.append(job)
            except Exception as exc:
                logger.error("Exception enqueuing SYNC_SOCIAL_METRICS jobs: %s", exc)

        # Trim old in-memory keys from prior days so set never grows unbounded
        if len(self._enqueued_schedule_keys) > 200:
            self._enqueued_schedule_keys = {
                k for k in self._enqueued_schedule_keys if date_str in k
            }

        return enqueued

    # ------------------------------------------------------------------
    # Listing Resolution Helper
    # ------------------------------------------------------------------

    def _resolve_listing_for_job(self, job: Dict[str, Any]) -> Dict[str, Any]:
        params = job.get("params_json") or {}
        listing_id = job.get("listing_id")
        bina_id = str(params.get("bina_id") or "").strip()

        listing = None
        if listing_id:
            listing = self.repo.get_listing_by_id(str(listing_id))
        if listing is None and bina_id:
            listing = self.repo.get_listing_by_bina_id(bina_id)
        if listing is None:
            raise ValueError(
                f"Listing not found for job {job.get('id')} (listing_id={listing_id}, bina_id={bina_id})"
            )
        return listing

    # ------------------------------------------------------------------
    # Job Handlers (All 5 Canonical Job Types)
    # ------------------------------------------------------------------

    def _handle_scrape_new(self, job: Dict[str, Any]) -> Dict[str, Any]:
        params = job.get("params_json") or {}
        pages = int(params.get("pages") or self.scrape_pages)
        limit = int(params.get("limit") or self.scrape_limit)
        specific_id = params.get("specific_id") or None
        check_existing = bool(params.get("check_existing_for_changes", True))
        enqueue_renders = bool(params.get("enqueue_render_jobs", True))
        special_opportunities_only = bool(params.get("special_opportunities_only", False))
        backlog_renders_enqueued = 0

        if not specific_id:
            backlog_fn = getattr(self.repo, "get_unrendered_backlog_listings", None)
            backlog = backlog_fn(limit=max(1, limit)) if callable(backlog_fn) else []
            if isinstance(backlog, list) and len(backlog) > 0:
                is_auto = str(job.get("trigger_source") or "").upper() == "AUTO_SCHEDULER"
                today_count = self.repo.count_today_auto_renders_baku() if is_auto else 0
                utc_now = datetime.now(timezone.utc)
                expires_at = (utc_now + timedelta(hours=max(1, int(AUTO_JOB_TTL_HOURS)))).isoformat()

                for row in backlog:
                    if is_auto and today_count >= DAILY_AUTO_RENDER_LIMIT:
                        logger.info(
                            "Daily auto-render cap (%d/%d) reached while queueing backlog.",
                            today_count,
                            DAILY_AUTO_RENDER_LIMIT,
                        )
                        break
                    lid = str(row.get("id") or "").strip()
                    bid = str(row.get("bina_id") or "").strip()
                    if not lid or not bid:
                        continue
                    queued_job = self.repo.enqueue_pipeline_job(
                        idempotency_key=f"initial:{bid}",
                        job_type="RENDER_INITIAL",
                        listing_id=lid,
                        agency_id=str(job.get("agency_id") or row.get("agency_id") or "").strip() or None,
                        trigger_source=str(job.get("trigger_source") or "AUTO_SCHEDULER"),
                        params_json={"bina_id": bid, "backlog_priority": True},
                        expires_at=expires_at,
                    )
                    if queued_job:
                        self.repo.update_listing(lid, {"pipeline_status": "QUEUED"})
                        backlog_renders_enqueued += 1
                        if is_auto:
                            today_count += 1

                special_opportunities_only = True
                enqueue_renders = False

        ingested = self.pipeline.run_ingestion(
            pages=pages,
            limit_per_page=limit,
            specific_id=specific_id,
            enqueue_render_jobs=enqueue_renders,
            check_existing_for_changes=check_existing,
            special_opportunities_only=special_opportunities_only,
        )

        matched_leads_count = 0
        for row in ingested or []:
            if not isinstance(row, dict):
                continue
            listing_uuid = str(row.get("id") or "").strip()
            availability = str(row.get("source_availability") or "ACTIVE").strip().upper()
            if listing_uuid and availability == "ACTIVE":
                matched_leads_count += self._match_listing_to_leads(listing_uuid)

        return {
            "job_type": "SCRAPE_NEW",
            "ingested_count": len(ingested),
            "matched_leads_count": matched_leads_count,
            "backlog_renders_enqueued": backlog_renders_enqueued,
            "special_opportunities_only": special_opportunities_only,
        }

    def _check_auto_render_guardrails(
        self,
        job: Dict[str, Any],
        listing: Dict[str, Any],
        *,
        job_label: str,
        always_check_status: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """
        Re-checks Rejim 3 status, 24h per-listing cooldown, and DAILY_AUTO_RENDER_LIMIT
        guardrails right before spending TTS/FFmpeg credits on an auto-render job.
        Manual triggers (`WEB_UI`, `TELEGRAM_WEBHOOK`) bypass daily auto-render caps
        and auto cooldowns.
        """
        trigger_source = str(job.get("trigger_source") or "AUTO_SCHEDULER").strip().upper()
        is_auto = trigger_source == "AUTO_SCHEDULER"

        if always_check_status or is_auto:
            editorial = str(listing.get("editorial_status") or "PENDING_REVIEW").upper()
            availability = str(listing.get("source_availability") or "ACTIVE").upper()
            outreach = str(listing.get("owner_outreach_status") or "NOT_CONTACTED").upper()
            if (
                editorial in BLOCKED_EDITORIAL_STATUSES
                or availability != "ACTIVE"
                or outreach in BLOCKED_OUTREACH_STATUSES
            ):
                logger.info(
                    "Skipping %s for %s: status changed while queued "
                    "(editorial=%s, availability=%s, outreach=%s)",
                    job_label,
                    listing.get("bina_id"),
                    editorial,
                    availability,
                    outreach,
                )
                return {
                    "bina_id": listing.get("bina_id"),
                    "status": "SKIPPED_BLOCKED",
                    "reason": f"editorial={editorial},availability={availability},outreach={outreach}",
                }

        if not is_auto:
            return None

        # Re-check 24h per-listing auto-render cooldown
        cooldown_hours = int(AUTO_RENDER_COOLDOWN_HOURS)
        last_rendered_dt = _parse_utc_iso(listing.get("last_auto_rendered_at"))
        if last_rendered_dt is not None and cooldown_hours > 0:
            elapsed = _utc_now() - last_rendered_dt
            if elapsed < timedelta(hours=cooldown_hours):
                logger.info(
                    "Skipping %s for %s: 24h auto-render cooldown active (last_auto_rendered_at=%s).",
                    job_label,
                    listing.get("bina_id"),
                    listing.get("last_auto_rendered_at"),
                )
                return {
                    "bina_id": listing.get("bina_id"),
                    "status": "SKIPPED_COOLDOWN",
                    "reason": "COOLDOWN_ACTIVE",
                }

        # Re-check Baku daily auto-render budget limit
        daily_limit = int(DAILY_AUTO_RENDER_LIMIT)
        if daily_limit >= 0:
            raw_count = self.repo.count_today_auto_renders_baku()
            if isinstance(raw_count, (int, float, str)) and not isinstance(raw_count, bool):
                try:
                    today_count = int(raw_count)
                except (TypeError, ValueError):
                    today_count = 0
            else:
                today_count = 0

            if today_count >= daily_limit:
                logger.info(
                    "Skipping %s for %s: DAILY_AUTO_RENDER_LIMIT reached (%d >= %d).",
                    job_label,
                    listing.get("bina_id"),
                    today_count,
                    daily_limit,
                )
                return {
                    "bina_id": listing.get("bina_id"),
                    "status": "SKIPPED_DAILY_LIMIT",
                    "reason": f"DAILY_LIMIT_REACHED:{today_count}>={daily_limit}",
                }

        return None

    def _tag_render_ab_and_create_draft_publication(
        self,
        listing: Dict[str, Any],
        render_result: Dict[str, Any],
        params: Dict[str, Any],
        route_info: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Tags render_versions with alternating hook_type and duration_bucket,
        attaches niche routing metadata, and automatically inserts/upserts a
        DRAFT_READY publication record with target_account_handle & channel_niche.
        """
        listing_uuid = str(listing.get("id") or render_result.get("listing_id") or "")
        render_version_id = render_result.get("render_version_id")
        version_num = int(render_result.get("version_num") or 1)
        duration = render_result.get("duration")

        # Alternating hook_type: odd versions PRICE_FIRST, even versions LOCATION_FIRST
        # (or override via params['hook_type'])
        hook_type = params.get("hook_type")
        if not hook_type:
            hook_type = "PRICE_FIRST" if (version_num % 2 == 1) else "LOCATION_FIRST"

        # Alternating duration_bucket: based on actual duration if available, else alternating
        duration_bucket = params.get("duration_bucket")
        if not duration_bucket:
            if duration and isinstance(duration, (int, float)):
                duration_bucket = "SHORT_25_30" if duration <= 35.0 else "LONG_40_50"
            else:
                duration_bucket = "SHORT_25_30" if (version_num % 2 == 1) else "LONG_40_50"

        if not route_info:
            routing_listing = dict(listing)
            if "price_drop_info" in params and "price_drop_info" not in routing_listing:
                routing_listing["price_drop_info"] = params["price_drop_info"]
            if "price_drop_pct" not in routing_listing and isinstance(params.get("price_drop_info"), dict):
                routing_listing["price_drop_pct"] = (
                    params["price_drop_info"].get("drop_pct")
                    or params["price_drop_info"].get("price_drop_pct")
                )
            route_info = route_listing_to_channel(routing_listing)

        target_handle = route_info.get("target_account_handle") or "@bakuestate.official"
        channel_niche = route_info.get("channel_niche") or "GENERAL"

        res = render_result or {}
        tts_engine_used = res.get("tts_engine_used") or route_info.get("voice_engine")
        tts_fallback = bool(res.get("tts_fallback", False))

        ab_metadata = {
            "version_num": version_num,
            "hook_type": hook_type,
            "duration_bucket": duration_bucket,
            "target_account_handle": target_handle,
            "channel_niche": channel_niche,
            "voice_engine": route_info.get("voice_engine"),
            "voice_id": route_info.get("voice_id"),
            "voice_speed": route_info.get("voice_speed"),
            "music_track": route_info.get("music_track"),
            "tts_engine_used": tts_engine_used,
            "tts_fallback": tts_fallback,
        }
        if route_info.get("routing_rule"):
            ab_metadata["routing_rule"] = route_info.get("routing_rule")
        if res.get("fallback_engine"):
            ab_metadata["fallback_engine"] = res.get("fallback_engine")
        if res.get("visual_profile"):
            ab_metadata["visual_profile"] = res.get("visual_profile")

        if render_version_id and self.repo.is_configured():
            try:
                self.repo.update_render_version(
                    str(render_version_id),
                    {
                        "hook_type": hook_type,
                        "duration_bucket": duration_bucket,
                        "rendered_price": listing.get("price"),
                        "rendered_currency": "AZN",
                        "ab_metadata": ab_metadata,
                    },
                )
            except Exception as exc:
                logger.warning("Failed to tag render_version with A/B metadata: %s", exc)

        # Automatically insert/upsert DRAFT_READY publication record with preflight_status='UNCHECKED'
        if listing_uuid and self.repo.is_configured():
            try:
                self.repo.create_or_update_publication(
                    listing_id=listing_uuid,
                    status="DRAFT_READY",
                    preflight_status="UNCHECKED",
                    channel="INSTAGRAM_REELS",
                    render_version_id=str(render_version_id) if render_version_id else None,
                    notes="Generated upon video completion",
                    target_account_handle=target_handle,
                    channel_niche=channel_niche,
                )
            except TypeError:
                try:
                    self.repo.create_or_update_publication(
                        listing_id=listing_uuid,
                        status="DRAFT_READY",
                        preflight_status="UNCHECKED",
                        channel="INSTAGRAM_REELS",
                        render_version_id=str(render_version_id) if render_version_id else None,
                        notes="Generated upon video completion",
                    )
                except Exception as inner_exc:
                    logger.warning("Failed to insert/upsert DRAFT_READY publication: %s", inner_exc)
            except Exception as exc:
                logger.warning("Failed to insert/upsert DRAFT_READY publication: %s", exc)

    def _resolve_agency_settings_for_render(
        self,
        listing: Dict[str, Any],
        params: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if isinstance(params.get("agency_settings"), dict):
            return params["agency_settings"]
        agency_id = str(listing.get("agency_id") or "").strip()
        if agency_id and self.repo.is_configured() and hasattr(self.repo, "get_agency_settings"):
            try:
                settings_row = self.repo.get_agency_settings(agency_id)
                if isinstance(settings_row, dict):
                    return settings_row
            except Exception as exc:
                logger.warning("Could not load agency_settings for %s: %s", agency_id, exc)
        return None

    def _build_cancel_check_cb(self, job: Dict[str, Any]) -> Callable[[], bool]:
        job_id = str(job.get("id") or "").strip()

        def _is_cancelled() -> bool:
            return bool(
                job_id
                and hasattr(self.repo, "is_job_cancel_requested")
                and self.repo.is_job_cancel_requested(job_id) is True
            )

        return _is_cancelled

    def _handle_render_initial(self, job: Dict[str, Any]) -> Dict[str, Any]:
        listing = self._resolve_listing_for_job(job)
        params = job.get("params_json") or {}

        guardrail_skip = self._check_auto_render_guardrails(
            job,
            listing,
            job_label="RENDER_INITIAL",
            always_check_status=False,
        )
        if guardrail_skip is not None:
            return guardrail_skip

        # Multi-Account Niche Routing
        agency_settings = self._resolve_agency_settings_for_render(listing, params)
        niche_rules = (agency_settings or {}).get("niche_rules_json") if isinstance(agency_settings, dict) else None
        route_info = route_listing_to_channel(listing, niche_rules=niche_rules)
        voice_engine = params.get("voice_engine") or route_info.get("voice_engine")
        voice_id = params.get("voice_id") or route_info.get("voice_id")
        cancel_check_cb = self._build_cancel_check_cb(job)

        listing_id = str(listing.get("id") or "").strip()
        render_version = None
        if listing_id and self.repo.is_configured():
            next_ver = self.repo.get_next_render_version_num(listing_id)
            render_version = self.repo.create_render_version(
                listing_id=listing_id,
                version_num=next_ver,
                rendered_price=listing.get("price"),
                rendered_currency="AZN",
                trigger_reason="AUTO_INITIAL",
                voice_engine=voice_engine,
                voice_id=voice_id,
                script_angle=params.get("script_angle"),
                model_id=params.get("model_id"),
            )

        # Silent video staging: no automatic Telegram dispatch (do not call self.telegram.dispatch_video_lead)
        res = self.pipeline.process_listing_video_and_dispatch(
            listing,
            voice_engine=voice_engine,
            voice_id=voice_id,
            script_angle=params.get("script_angle"),
            model_id=params.get("model_id"),
            trigger_reason="AUTO_INITIAL",
            skip_telegram_dispatch=True,
            existing_render_version=render_version,
            selected_photo_urls=params.get("selected_photo_urls"),
            custom_script_text=params.get("custom_script_text"),
            agency_settings=agency_settings,
            cancel_check_cb=cancel_check_cb,
        )
        if res.get("status") == "CANCELLED":
            return res
        if res.get("status") == "FAILED":
            raise RuntimeError(res.get("error") or res.get("reason") or "RENDER_INITIAL failed")

        if render_version and not res.get("render_version_id"):
            res["render_version_id"] = render_version.get("id")
        if render_version and not res.get("version_num"):
            res["version_num"] = render_version.get("version_num")

        self._tag_render_ab_and_create_draft_publication(listing, res, params, route_info=route_info)
        return res

    def _handle_render_price_drop(self, job: Dict[str, Any]) -> Dict[str, Any]:
        listing = self._resolve_listing_for_job(job)
        params = job.get("params_json") or {}

        # Final guardrail re-check right before spending TTS/FFmpeg credits
        guardrail_skip = self._check_auto_render_guardrails(
            job,
            listing,
            job_label="RENDER_PRICE_DROP",
            always_check_status=True,
        )
        if guardrail_skip is not None:
            return guardrail_skip

        # Multi-Account Niche Routing (incorporating price drop info)
        agency_settings = self._resolve_agency_settings_for_render(listing, params)
        niche_rules = (agency_settings or {}).get("niche_rules_json") if isinstance(agency_settings, dict) else None
        routing_listing = dict(listing)
        if "price_drop_info" in params and "price_drop_info" not in routing_listing:
            routing_listing["price_drop_info"] = params["price_drop_info"]
        if "price_drop_pct" not in routing_listing and isinstance(params.get("price_drop_info"), dict):
            routing_listing["price_drop_pct"] = (
                params["price_drop_info"].get("drop_pct")
                or params["price_drop_info"].get("price_drop_pct")
            )
        route_info = route_listing_to_channel(routing_listing, niche_rules=niche_rules)
        voice_engine = params.get("voice_engine") or route_info.get("voice_engine")
        voice_id = params.get("voice_id") or route_info.get("voice_id")
        cancel_check_cb = self._build_cancel_check_cb(job)

        listing_id = str(listing.get("id") or "").strip()
        render_version = None
        if listing_id and self.repo.is_configured():
            next_ver = self.repo.get_next_render_version_num(listing_id)
            render_version = self.repo.create_render_version(
                listing_id=listing_id,
                version_num=next_ver,
                rendered_price=listing.get("price"),
                rendered_currency="AZN",
                trigger_reason="AUTO_PRICE_DROP",
                voice_engine=voice_engine,
                voice_id=voice_id,
                script_angle=params.get("script_angle"),
                model_id=params.get("model_id"),
            )

        # Silent video staging: no automatic Telegram dispatch (do not call self.telegram.dispatch_video_lead)
        res = self.pipeline.process_listing_video_and_dispatch(
            listing,
            voice_engine=voice_engine,
            voice_id=voice_id,
            script_angle=params.get("script_angle"),
            model_id=params.get("model_id"),
            trigger_reason="AUTO_PRICE_DROP",
            price_drop_info=params.get("price_drop_info"),
            skip_telegram_dispatch=True,
            existing_render_version=render_version,
            selected_photo_urls=params.get("selected_photo_urls"),
            custom_script_text=params.get("custom_script_text"),
            agency_settings=agency_settings,
            cancel_check_cb=cancel_check_cb,
        )
        if res.get("status") == "CANCELLED":
            return res
        if res.get("status") == "FAILED":
            raise RuntimeError(res.get("error") or res.get("reason") or "RENDER_PRICE_DROP failed")

        if render_version and not res.get("render_version_id"):
            res["render_version_id"] = render_version.get("id")
        if render_version and not res.get("version_num"):
            res["version_num"] = render_version.get("version_num")

        self._tag_render_ab_and_create_draft_publication(listing, res, params, route_info=route_info)
        return res

    def _handle_rerender(self, job: Dict[str, Any]) -> Dict[str, Any]:
        listing = self._resolve_listing_for_job(job)
        params = job.get("params_json") or {}

        agency_settings = self._resolve_agency_settings_for_render(listing, params)
        niche_rules = (agency_settings or {}).get("niche_rules_json") if isinstance(agency_settings, dict) else None
        routing_listing = dict(listing)
        if "price_drop_info" in params and "price_drop_info" not in routing_listing:
            routing_listing["price_drop_info"] = params["price_drop_info"]
        if "price_drop_pct" not in routing_listing and isinstance(params.get("price_drop_info"), dict):
            routing_listing["price_drop_pct"] = (
                params["price_drop_info"].get("drop_pct")
                or params["price_drop_info"].get("price_drop_pct")
            )
        route_info = route_listing_to_channel(routing_listing, niche_rules=niche_rules)

        voice_engine = params.get("voice_engine")
        voice_id = params.get("voice_id")
        if not voice_engine and params.get("voice_choice"):
            voice_engine, mapped_voice_id = resolve_voice_choice(str(params["voice_choice"]))
            if not voice_id:
                voice_id = mapped_voice_id

        if not voice_engine:
            voice_engine = route_info.get("voice_engine")
        if not voice_id:
            voice_id = route_info.get("voice_id")

        script_angle = params.get("script_angle")
        model_id = params.get("model_id")
        trigger_reason = str(
            params.get("trigger_reason")
            or (
                "VOICE_SWITCH"
                if (voice_engine or voice_id)
                else ("SCRIPT_ANGLE" if script_angle else "MANUAL_RERENDER")
            )
        )

        # Support both telegram-webhook (`telegram_message_id`) and direct (`update_telegram_message_id`)
        update_msg_id = params.get("update_telegram_message_id") or params.get("telegram_message_id")
        tg_chat_id = params.get("telegram_chat_id") or params.get("chat_id")
        cancel_check_cb = self._build_cancel_check_cb(job)

        res = self.pipeline.process_listing_video_and_dispatch(
            listing,
            voice_engine=voice_engine,
            voice_id=voice_id,
            script_angle=script_angle,
            model_id=model_id,
            trigger_reason=trigger_reason,
            price_drop_info=params.get("price_drop_info"),
            update_telegram_message_id=update_msg_id,
            telegram_chat_id=tg_chat_id,
            selected_photo_urls=params.get("selected_photo_urls"),
            custom_script_text=params.get("custom_script_text"),
            agency_settings=agency_settings,
            cancel_check_cb=cancel_check_cb,
        )
        if res.get("status") == "CANCELLED":
            return res
        if res.get("status") == "FAILED":
            raise RuntimeError(res.get("error") or res.get("reason") or "RERENDER failed")
        return res

    def _handle_preflight_check(self, job: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes an on-demand residential preflight check for a listing.
        Bypasses Cloudflare datacenter IP blocks, extracts live portal price,
        checks deletion, and logs to public.preflight_checks.
        """
        params = job.get("params_json") or {}
        bina_id = str(params.get("bina_id") or "").strip()
        listing_id = params.get("listing_id")
        expected_price = params.get("expected_price")

        if not bina_id:
            raise ValueError("bina_id parametr tələb olunur.")

        logger.info("Executing residential preflight check for bina_id: %s", bina_id)
        url = f"https://bina.az/items/{bina_id}"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "az,ru;q=0.9,en;q=0.8",
        }

        start_t = time.time()
        try:
            resp = self.pipeline.scraper.session.get(url, headers=headers, timeout=12)
            elapsed_ms = int((time.time() - start_t) * 1000)
            status_code = resp.status_code
            html = resp.text or ""
        except Exception as exc:
            elapsed_ms = int((time.time() - start_t) * 1000)
            logger.error("Preflight live fetch failed for %s: %s", bina_id, exc)
            raise RuntimeError(f"Preflight şəbəkə xətası: {exc}")

        # 1. Check Deletion / Delisting
        is_removed = False
        if status_code in (404, 410):
            is_removed = True
        elif status_code == 200:
            lower_html = html.lower()
            if any(p in lower_html for p in REMOVED_DOM_PHRASES):
                is_removed = True
            elif "item_status_deleted" in lower_html:
                is_removed = True
            else:
                try:
                    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">([\s\S]*?)</script>', html)
                    if m:
                        nd = json.loads(m.group(1))
                        props = nd.get("props", {}).get("pageProps", {})
                        cid = props.get("currentItemData") or {}
                        item_status = str(cid.get("status") or "").lower()
                        if item_status in ("deleted", "removed", "expired", "archived", "sold", "inactive"):
                            is_removed = True
                        elif cid.get("isDeleted") or cid.get("isExpired"):
                            is_removed = True
                except Exception:
                    pass

        if is_removed:
            if listing_id:
                self.repo.update_listing(str(listing_id), {
                    "source_availability": "REMOVED_ON_BINA",
                    "editorial_status": "ARCHIVED",
                })
            self.repo.log_preflight_check(
                listing_id=str(listing_id) if listing_id else "",
                bina_id=bina_id,
                result="REMOVED_ON_BINA",
                response_time_ms=elapsed_ms,
            )
            return {
                "ok": False,
                "reason": "REMOVED_ON_BINA",
                "is_removed": True,
                "portal_price": None,
                "response_time_ms": elapsed_ms,
            }

        # 2. Multi-Layer Price Extraction
        portal_price = None

        # Layer 1: __NEXT_DATA__ JSON parsing
        try:
            m = re.search(r'<script id="__NEXT_DATA__" type="application/json">([\s\S]*?)</script>', html)
            if m:
                nd = json.loads(m.group(1))
                page_props = nd.get("props", {}).get("pageProps", {})
                cid = page_props.get("currentItemData") or {}
                p_obj = cid.get("price")
                if isinstance(p_obj, dict):
                    v = p_obj.get("total") or p_obj.get("value")
                    if v:
                        portal_price = float(v)
                elif isinstance(p_obj, (int, float)) and p_obj > 0:
                    portal_price = float(p_obj)

                if portal_price is None:
                    apollo = page_props.get("apolloState") or {}
                    item_data = apollo.get(f"Item:{bina_id}") or {}
                    ap_price = item_data.get("price")
                    if isinstance(ap_price, dict):
                        v = ap_price.get("total") or ap_price.get("value")
                        if v:
                            portal_price = float(v)
                    elif isinstance(ap_price, (int, float)) and ap_price > 0:
                        portal_price = float(ap_price)
        except Exception:
            pass

        # Layer 2: Regex for Apollo cached price object
        if portal_price is None:
            m = re.search(r'"price":\{"__typename":"Price"[^}]*"total":\s*(\d+)', html)
            if m:
                portal_price = float(m.group(1))

        # Layer 3: Schema.org Offer Price
        if portal_price is None:
            m = re.search(r'"@type":"Offer"[^}]*"price":"(\d+)"', html)
            if m:
                portal_price = float(m.group(1))

        # Layer 4: Styled-components price text preceding AZN
        if portal_price is None:
            m = re.search(r'>([\d\s]{3,15})</[a-z0-9]+>[^<]{0,20}(?:AZN|₼)', html, re.I) or re.search(r'>([\d\s]{3,15})\s*(?:<!--.*?-->\s*)*(?:AZN|₼)', html, re.I)
            if m:
                raw_d = re.sub(r'\D', '', m.group(1))
                if raw_d:
                    portal_price = float(raw_d)

        # Layer 5: Legacy price-val span
        if portal_price is None:
            m = re.search(r'class=["\'][^"\']*price-val[^"\']*["\'][^>]*>([\s\S]*?)<\/', html, re.I)
            if m:
                raw_d = re.sub(r'<[^>]*>', '', m.group(1))
                raw_d = re.sub(r'\s+', '', raw_d)
                try:
                    p = float(raw_d)
                    if p > 0:
                        portal_price = p
                except ValueError:
                    pass

        if portal_price is None or portal_price <= 0:
            raise RuntimeError("bina.az portalından qiymət oxuna bilmədi.")

        # 3. Calculate delta against expected_price
        old_p = float(expected_price) if expected_price is not None else None
        price_delta = abs(portal_price - old_p) if old_p is not None else 0.0
        delta_pct = round(((portal_price - old_p) / old_p) * 100, 2) if (old_p and old_p > 0) else 0.0

        if price_delta >= 1.0:
            res_status = "PRICE_CHANGED"
        else:
            res_status = "PASSED"

        # 4. Update listings table & log preflight check
        if listing_id:
            self.repo.update_listing(str(listing_id), {
                "price": portal_price,
                "price_azn_normalized": portal_price,
                "last_checked_at": _utc_now().isoformat(),
            })

        self.repo.log_preflight_check(
            listing_id=str(listing_id) if listing_id else "",
            bina_id=bina_id,
            result=res_status,
            portal_price=portal_price,
            video_price=old_p,
            price_delta_pct=delta_pct,
            response_time_ms=elapsed_ms,
        )

        logger.info(
            "Preflight check for %s succeeded: status=%s, portal_price=%s (delta=%.2f%%)",
            bina_id,
            res_status,
            portal_price,
            delta_pct,
        )

        return {
            "ok": res_status == "PASSED",
            "reason": res_status,
            "portal_price": portal_price,
            "old_price": old_p,
            "new_price": portal_price,
            "delta_pct": delta_pct,
            "response_time_ms": elapsed_ms,
        }

    def _handle_liveness_check(self, job: Dict[str, Any]) -> Dict[str, Any]:
        params = job.get("params_json") or {}
        limit = int(params.get("limit") or self.liveness_limit)
        bina_ids = params.get("bina_ids")

        if bina_ids and isinstance(bina_ids, list):
            listings_map = self.repo.get_listings_by_bina_ids([str(b) for b in bina_ids])
            listings = list(listings_map.values())
        else:
            listings = self.repo.get_active_listings_for_liveness(limit=limit)

        checked = 0
        active_count = 0
        removed_count = 0
        transient_count = 0
        consecutive_transient = 0
        circuit_breaker_tripped = False
        lead_alerts_created = 0

        for item in listings:
            bina_id = str(item.get("bina_id") or "").strip()
            listing_uuid = item.get("id")
            if not bina_id or not listing_uuid:
                continue

            # Random pacing jitter between bina.az requests (default 1.5-3.0s)
            if checked > 0 and self.liveness_jitter_range[1] > 0:
                if self._stop_event.is_set():
                    break
                delay = random.uniform(
                    self.liveness_jitter_range[0],
                    self.liveness_jitter_range[1],
                )
                if delay > 0:
                    time.sleep(delay)

            status = self.pipeline.scraper.check_listing_liveness(bina_id)
            checked += 1
            now_iso = _utc_now().isoformat()

            if status == LIVENESS_ACTIVE:
                active_count += 1
                consecutive_transient = 0
                self.repo.update_listing(str(listing_uuid), {"last_checked_at": now_iso})
            elif status == LIVENESS_REMOVED:
                removed_count += 1
                consecutive_transient = 0
                self.repo.update_listing(
                    str(listing_uuid),
                    {
                        "source_availability": LIVENESS_REMOVED,
                        "last_checked_at": now_iso,
                    },
                )
                self.repo.insert_listing_event(
                    str(listing_uuid),
                    "REMOVED_ON_BINA",
                    old_value={"source_availability": item.get("source_availability", "ACTIVE")},
                    new_value={"source_availability": LIVENESS_REMOVED},
                    actor="liveness_poller",
                )
                alerts = self.repo.create_sold_listing_lead_alerts(str(listing_uuid), bina_id)
                if isinstance(alerts, list):
                    lead_alerts_created += len(alerts)
            else:
                # LIVENESS_TRANSIENT_ERROR (429/403/5xx/network): NEVER mark removed!
                transient_count += 1
                consecutive_transient += 1
                logger.warning(
                    "Liveness check transient error for %s (%s); leaving source_availability unchanged "
                    "(consecutive=%d/%d).",
                    bina_id,
                    status,
                    consecutive_transient,
                    self.liveness_circuit_breaker_threshold,
                )
                if consecutive_transient >= self.liveness_circuit_breaker_threshold:
                    circuit_breaker_tripped = True
                    logger.warning(
                        "Liveness check circuit breaker tripped after %d consecutive transient errors; "
                        "aborting remaining batch.",
                        consecutive_transient,
                    )
                    break

        return {
            "job_type": "LIVENESS_CHECK",
            "checked": checked,
            "active": active_count,
            "removed": removed_count,
            "transient_errors": transient_count,
            "circuit_breaker_tripped": circuit_breaker_tripped,
            "lead_alerts_created": lead_alerts_created,
        }

    def _notify_social_inbound_lead(
        self,
        listing: Optional[Dict[str, Any]],
        author_handle: str,
        comment_text: str,
        intent_category: str,
        suggested_reply: Optional[str],
        platform: str = "INSTAGRAM",
    ) -> None:
        """
        Dispatches an inbound social lead alert card to Telegram with direct 1-tap
        https://ig.me/m/{handle} universal DM link and pre-composed reply.
        """
        clean_handle = author_handle.lstrip("@").strip()
        bina_id = listing.get("bina_id") if listing else None
        if not bina_id and listing and listing.get("id"):
            bina_id = str(listing.get("id"))[:8]
        bina_id = bina_id or "Baku"
        location = listing.get("district") or listing.get("location") or "" if listing else ""
        location_str = f"({location})" if location else ""
        price = listing.get("price") if listing else None
        currency = listing.get("currency") or "AZN" if listing else "AZN"
        price_str = f"{price} {currency}" if price else "Məlum deyil"
        reply_text = suggested_reply or "Salam, əlaqə nömrənizi qeyd edin, rəsmi məlumatları göndərək."

        text = (
            f"🎯 <b>Yeni Sosial Şəbəkə Müştəri Sorğusu!</b>\n\n"
            f"🏢 <b>Elan:</b> #{bina_id} {location_str}\n"
            f"💰 <b>Qiymət:</b> {price_str}\n"
            f"👤 <b>Müştəri:</b> @{clean_handle}\n"
            f"💬 <b>Şərh:</b> {comment_text}\n"
            f"🏷️ <b>Kateqoriya:</b> {intent_category}\n\n"
            f"💡 <b>Təklif olunan cavab:</b>\n"
            f"<code>{reply_text}</code>"
        )
        reply_markup = {
            "inline_keyboard": [
                [
                    {
                        "text": "📱 Instagram DM-də Cavab Ver",
                        "url": f"https://ig.me/m/{clean_handle}",
                    }
                ]
            ]
        }
        try:
            bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
            chat_id = os.getenv("TELEGRAM_CHAT_ID")
            if bot_token and chat_id:
                bot_service = TelegramBotService(bot_token=bot_token, chat_id=chat_id)
                bot_service.send_message(chat_id=chat_id, text=text, parse_mode="HTML", reply_markup=reply_markup)
            else:
                logger.info("[MOCK] Social lead notification for @%s: %s", clean_handle, text)
        except Exception as exc:
            logger.warning("Failed to dispatch social lead card to Telegram: %s", exc)

    def _send_sre_alert(self, message: str) -> None:
        """Sends an urgent SRE alert to Telegram."""
        logger.error("SRE Alert: %s", message)
        try:
            bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
            chat_id = os.getenv("TELEGRAM_CHAT_ID")
            if bot_token and chat_id:
                bot_service = TelegramBotService(bot_token=bot_token, chat_id=chat_id)
                bot_service.send_message(chat_id=chat_id, text=f"🚨 <b>SRE ALERT</b>\n\n{message}", parse_mode="HTML")
        except Exception as exc:
            logger.warning("Failed to dispatch SRE alert to Telegram: %s", exc)

    def _send_operator_alert(self, message: str) -> None:
        """Sends an operator alert to Telegram."""
        logger.info("Operator Alert: %s", message)
        try:
            bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
            chat_id = os.getenv("TELEGRAM_CHAT_ID")
            if bot_token and chat_id:
                bot_service = TelegramBotService(bot_token=bot_token, chat_id=chat_id)
                bot_service.send_message(chat_id=chat_id, text=message)
            elif hasattr(self, "telegram") and self.telegram and hasattr(self.telegram, "send_message"):
                self.telegram.send_message(text=message)
        except Exception as exc:
            logger.warning("Failed to dispatch operator alert to Telegram: %s", exc)

    def _check_listing_liveness_and_price(
        self,
        bina_id: Union[int, str],
        current_price: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Performs concurrent portal liveness and price check for listing['bina_id'] using bina_scraper.
        Returns dict with keys: 'status', 'price', 'price_dropped'.
        """
        clean_id = str(bina_id).strip()
        scraper = getattr(self.pipeline, "scraper", None)
        if not scraper:
            scraper = getattr(self, "bina_scraper", None)
        if not scraper:
            scraper = BinaScraper()

        status = "ACTIVE"
        portal_price = current_price
        price_dropped = False

        try:
            liveness_res = None
            if hasattr(scraper, "check_listing_liveness"):
                liveness_res = scraper.check_listing_liveness(clean_id)
            elif hasattr(scraper, "check_liveness"):
                liveness_res = scraper.check_liveness(clean_id)
            elif callable(scraper):
                liveness_res = scraper(clean_id)

            if isinstance(liveness_res, dict):
                status = liveness_res.get("status") or liveness_res.get("result") or "ACTIVE"
                portal_price = liveness_res.get("price") or current_price
                price_dropped = bool(liveness_res.get("price_dropped"))
                return {
                    "status": status,
                    "price": portal_price,
                    "price_dropped": price_dropped,
                }

            status = str(liveness_res or "ACTIVE").upper()
            if status in ("REMOVED_ON_BINA", LIVENESS_REMOVED):
                return {
                    "status": "REMOVED_ON_BINA",
                    "price": current_price,
                    "price_dropped": False,
                }

            if hasattr(scraper, "fetch_item_details"):
                details = scraper.fetch_item_details(clean_id)
                if details and isinstance(details, dict):
                    raw_p = details.get("price") or details.get("portal_price") or details.get("new_price")
                    if raw_p is not None:
                        try:
                            portal_price = float(raw_p)
                            if current_price is not None and portal_price < float(current_price):
                                price_dropped = True
                        except (ValueError, TypeError):
                            pass
        except Exception as exc:
            logger.warning("Error checking liveness and price for bina_id %s: %s", clean_id, exc)

        return {
            "status": status,
            "price": portal_price,
            "price_dropped": price_dropped,
        }

    def _is_real_repo_http(self) -> bool:
        return (
            self.repo is not None
            and isinstance(getattr(self.repo, "supabase_url", None), str)
            and bool(self.repo.supabase_url)
            and isinstance(getattr(self.repo, "supabase_key", None), str)
            and bool(self.repo.supabase_key)
            and getattr(self.repo, "session", None) is not None
        )

    def _resolve_social_api_mode(
        self,
        agency_id: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Resolves `OFFICIAL` vs `TELEGRAM_FALLBACK` from `agency_settings.social_api_mode`,
        job `params_json`, or `SOCIAL_API_MODE` env setting (defaults to `TELEGRAM_FALLBACK`).
        """
        if isinstance(params, dict) and params.get("social_api_mode"):
            mode = str(params["social_api_mode"]).strip().upper()
            if mode in ("OFFICIAL", "TELEGRAM_FALLBACK"):
                return mode
        clean_agency = str(agency_id or "").strip()
        if clean_agency and hasattr(self.repo, "get_agency_settings"):
            try:
                settings_row = self.repo.get_agency_settings(clean_agency)
                if isinstance(settings_row, dict) and settings_row.get("social_api_mode"):
                    mode = str(settings_row["social_api_mode"]).strip().upper()
                    if mode in ("OFFICIAL", "TELEGRAM_FALLBACK"):
                        return mode
            except Exception as exc:
                logger.warning("Could not resolve agency social_api_mode for %s: %s", clean_agency, exc)
        env_mode = (os.getenv("SOCIAL_API_MODE") or SOCIAL_API_MODE or "TELEGRAM_FALLBACK").strip().upper()
        return env_mode if env_mode in ("OFFICIAL", "TELEGRAM_FALLBACK") else "TELEGRAM_FALLBACK"

    def _call_repo_rpc(self, fn_name: str, payload: Dict[str, Any]) -> Any:
        if not self._is_real_repo_http():
            return None
        resp = self.repo.session.post(
            self.repo._rpc_url(fn_name),
            headers=self.repo._headers(),
            json=payload,
            timeout=getattr(self.repo, "timeout", 20),
        )
        if resp.status_code == 200:
            return resp.json()
        logger.warning("%s RPC failed (%s): %s", fn_name, resp.status_code, str(getattr(resp, "text", ""))[:240])
        return None

    def _match_listing_to_leads(self, listing_id: str) -> int:
        """Invokes `public.match_listing_to_leads(p_listing_id)` SQL RPC safely."""
        clean_id = str(listing_id or "").strip()
        if not clean_id:
            return 0
        try:
            if self._is_real_repo_http():
                res = self._call_repo_rpc("match_listing_to_leads", {"p_listing_id": clean_id})
                return int(res) if isinstance(res, (int, float)) and not isinstance(res, bool) else 0
            if hasattr(self.repo, "match_listing_to_leads"):
                raw = self.repo.match_listing_to_leads(clean_id)
                return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0
        except Exception as exc:
            logger.warning("match_listing_to_leads failed for listing %s: %s", clean_id, exc)
        return 0

    def _upsert_social_comment_dedup(
        self,
        *,
        agency_id: Optional[str],
        publication_id: str,
        platform_comment_id: str,
        author_handle: str,
        comment_text: str,
        like_count: int,
        is_intent_lead: bool,
        intent_category: Optional[str],
        intent_confidence: Optional[float],
        suggested_reply: Optional[str],
        buyer_lead_id: Optional[str] = None,
    ) -> Tuple[Optional[str], bool]:
        """
        Persists a social comment via `upsert_social_comment_returning_is_new` RPC
        and returns `(comment_id, is_new)` so repeat comment polls never trigger
        duplicate buyer leads or Telegram alerts.
        """
        rpc_payload: Dict[str, Any] = {
            "p_agency_id": str(agency_id).strip() if agency_id else None,
            "p_publication_id": str(publication_id).strip(),
            "p_platform_comment_id": str(platform_comment_id).strip(),
            "p_author_handle": str(author_handle).strip(),
            "p_comment_text": str(comment_text or ""),
            "p_like_count": max(0, int(like_count)),
            "p_is_intent_lead": bool(is_intent_lead),
            "p_intent_category": intent_category,
            "p_intent_confidence": float(intent_confidence) if intent_confidence is not None else None,
            "p_suggested_reply": suggested_reply,
            "p_buyer_lead_id": str(buyer_lead_id).strip() if buyer_lead_id else None,
        }
        if self._is_real_repo_http():
            data = self._call_repo_rpc("upsert_social_comment_returning_is_new", rpc_payload)
            row = data[0] if isinstance(data, list) and data else (data if isinstance(data, dict) else None)
            if isinstance(row, dict) and "is_new" in row:
                return (str(row.get("comment_id") or "") or None, bool(row.get("is_new")))
        elif hasattr(self.repo, "upsert_social_comment_returning_is_new"):
            raw = self.repo.upsert_social_comment_returning_is_new(**rpc_payload)
            row = raw[0] if isinstance(raw, list) and raw else raw
            if isinstance(row, dict) and "is_new" in row:
                return (str(row.get("comment_id") or "") or None, bool(row.get("is_new")))
            if isinstance(row, tuple) and len(row) == 2 and isinstance(row[1], bool):
                return (row[0], row[1])
            if isinstance(row, bool):
                return (None, row)

        # Fallback for unmocked legacy tests
        self.repo.upsert_social_comment(
            publication_id=publication_id,
            platform_comment_id=platform_comment_id,
            author_handle=author_handle,
            comment_text=comment_text,
            is_intent_lead=is_intent_lead,
            intent_category=intent_category,
            suggested_reply=suggested_reply,
            buyer_lead_id=buyer_lead_id,
            like_count=like_count,
            intent_confidence=intent_confidence,
        )
        return (None, True)

    def _link_buyer_lead_to_comment(self, comment_id: Optional[str], buyer_lead_id: Optional[str]) -> None:
        if not comment_id or not buyer_lead_id or not self._is_real_repo_http():
            return
        try:
            self.repo.session.patch(
                self.repo._rest_url("social_comments"),
                headers=self.repo._headers(prefer="return=minimal"),
                params={"id": f"eq.{comment_id}"},
                json={"buyer_lead_id": buyer_lead_id},
                timeout=getattr(self.repo, "timeout", 20),
            )
        except Exception as exc:
            logger.warning("Failed linking buyer_lead_id %s to social_comment %s: %s", buyer_lead_id, comment_id, exc)

    def _handle_sync_social_metrics(self, job: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes SYNC_SOCIAL_METRICS pipeline job:
        - Concurrent portal liveness and price check for listing['bina_id'].
        - Branches on `SOCIAL_API_MODE` (`OFFICIAL` Meta/TikTok API vs `TELEGRAM_FALLBACK` observer).
        - Deduplicates comments via `upsert_social_comment_returning_is_new` before creating leads/alerts.
        - Triggers `match_listing_to_leads` when an ACTIVE listing has a price drop.
        - 4-phase decay calculation and circuit breaker management.
        """
        params = job.get("params_json") or {}
        pub_id = str(params.get("publication_id") or job.get("publication_id") or "").strip()
        post_url = str(params.get("post_url") or "").strip()

        if not pub_id:
            raise ValueError(f"SYNC_SOCIAL_METRICS job {job.get('id')} missing publication_id")

        pub = self.repo.get_publication_by_id(pub_id)
        if not pub:
            logger.warning("Publication %s not found in database; aborting sync.", pub_id)
            return {"status": "SKIPPED", "reason": "PUBLICATION_NOT_FOUND"}

        if not post_url:
            post_url = str(pub.get("post_url") or "").strip()

        current_poll_count = int(pub.get("poll_count") or 0)
        published_at_dt = _parse_utc_iso(pub.get("published_at")) or _utc_now()

        # Step 1.5: Concurrent portal liveness and price check for listing['bina_id']
        listing_id = pub.get("listing_id")
        listing = self.repo.get_listing_by_id(str(listing_id)) if listing_id else None
        agency_id = str(pub.get("agency_id") or (listing.get("agency_id") if isinstance(listing, dict) else "") or "").strip() or None
        social_api_mode = self._resolve_social_api_mode(agency_id, params=params)

        if social_api_mode != "OFFICIAL" and not post_url:
            logger.warning("Publication %s has no post_url; aborting sync.", pub_id)
            return {"status": "SKIPPED", "reason": "MISSING_POST_URL"}

        if listing and listing.get("bina_id"):
            bina_id = str(listing.get("bina_id")).strip()
            old_p_raw = listing.get("price")
            old_p = float(old_p_raw) if old_p_raw is not None else None

            check_res = self._check_listing_liveness_and_price(bina_id, current_price=old_p)
            status_str = str(check_res.get("status") or "").upper()
            new_p = check_res.get("price")

            if status_str in ("REMOVED_ON_BINA", LIVENESS_REMOVED):
                self.repo.update_listing(str(listing["id"]), {"source_availability": "REMOVED_ON_BINA"})
                listing["source_availability"] = "REMOVED_ON_BINA"
                alert_msg = f"⚠️ Diqqət: #{bina_id} nömrəli mənzil bina.az-dan silinib (satılıb). Instagram/TikTok-dan gələn müştərilərə alternativ təklif edin."
                self._send_operator_alert(alert_msg)
            elif (
                (new_p is not None and old_p is not None and float(new_p) < old_p)
                or check_res.get("price_dropped")
            ):
                new_price_val = float(new_p) if new_p is not None else old_p
                self.repo.update_listing(
                    str(listing["id"]),
                    {"price": new_price_val, "price_azn_normalized": new_price_val},
                )
                listing["price"] = new_price_val
                listing["price_azn_normalized"] = new_price_val
                self._match_listing_to_leads(str(listing["id"]))
                old_fmt = int(old_p) if (old_p is not None and old_p.is_integer()) else old_p
                new_fmt = int(new_price_val) if new_price_val.is_integer() else new_price_val
                alert_msg = f"📉 Diqqət: #{bina_id} nömrəli elanın qiyməti endi ({old_fmt} -> {new_fmt} AZN). Paylaşılmış videonun rəylərində endirimi qeyd edin və ya yeni video hazırlayaq."
                self._send_operator_alert(alert_msg)

        # Step 2: Fetch metrics via Official API or TELEGRAM_FALLBACK observer
        from src.social.observer import SocialTelemetryObserver, RateLimitException

        try:
            if social_api_mode == "OFFICIAL":
                from src.social.official_clients import OfficialSocialPublisher
                official_client = OfficialSocialPublisher(repo=self.repo)
                telemetry = official_client.fetch_telemetry(pub)
            else:
                observer = SocialTelemetryObserver(social_api_mode=social_api_mode)
                telemetry = observer.fetch_telemetry(post_url)
            self._consecutive_social_rate_limits = 0
        except RateLimitException as rle:
            self._consecutive_social_rate_limits += 1
            logger.warning(
                "Social telemetry rate limit encountered for %s (consecutive=%d): %s",
                post_url,
                self._consecutive_social_rate_limits,
                rle,
            )
            self.repo.update_publication_telemetry(
                publication_id=pub_id,
                views=pub.get("views_count", 0),
                likes=pub.get("likes_count", 0),
                comments=pub.get("comments_count", 0),
                poll_count=current_poll_count,
                next_poll_at=pub.get("next_poll_at"),
                telemetry_status="ACTIVE",
                error_info=str(rle),
                scrape_error_count=(int(pub.get("scrape_error_count") or 0) + 1),
            )
            if self._consecutive_social_rate_limits >= 2:
                logger.error("Social circuit breaker TRIPPED after 2 consecutive rate limits.")
                self.repo.trip_social_circuit_breaker(backoff_hours=SOCIAL_CIRCUIT_BREAKER_HOURS)
                self._send_sre_alert(
                    f"🚨 <b>Sosial Telemetriya Circuit Breaker İşə Düşdü!</b>\n\n"
                    f"2 ardıcıl rate-limit/CAPTCHA xətası baş verdi.\n"
                    f"Bütün aktiv paylaşımların yoxlanışı {SOCIAL_CIRCUIT_BREAKER_HOURS} saat sonraya təxirə salındı.\n"
                    f"URL: <code>{post_url}</code>\nXəta: {rle}"
                )
            raise

        views_count = int(telemetry.get("views_count") or 0)
        likes_count = int(telemetry.get("likes_count") or 0)
        comments_count = int(telemetry.get("comments_count") or 0)
        shares_count = int(telemetry.get("shares_count") or 0)
        comments_list = telemetry.get("comments") or []

        # Step 3: Calculate 4-phase decay schedule
        new_poll_count = current_poll_count + 1
        next_poll_at_dt, new_telemetry_status, snapshot_phase = calculate_decay_schedule(
            published_at=published_at_dt,
            completed_polls=new_poll_count,
            now=_utc_now(),
        )
        next_poll_iso = next_poll_at_dt.isoformat() if next_poll_at_dt else None

        # Step 4: Process comments through IntentClassifier + upsert_social_comment_returning_is_new dedup
        from src.social.intent_classifier import IntentClassifier
        classifier = IntentClassifier()

        if not listing:
            listing_id = pub.get("listing_id")
            listing = self.repo.get_listing_by_id(str(listing_id)) if listing_id else None

        leads_captured = 0
        for comm in comments_list:
            p_comm_id = str(comm.get("comment_id") or comm.get("id") or "").strip()
            author_handle = str(comm.get("author_handle") or comm.get("user") or "").strip()
            comment_text = str(comm.get("comment_text") or comm.get("text") or "").strip()
            like_count = int(comm.get("like_count") or 0)

            if not p_comm_id or not author_handle or not comment_text:
                continue

            decision = classifier.classify(comment_text, listing_context=listing)
            comment_uuid, is_new = self._upsert_social_comment_dedup(
                agency_id=agency_id,
                publication_id=pub_id,
                platform_comment_id=p_comm_id,
                author_handle=author_handle,
                comment_text=comment_text,
                like_count=like_count,
                is_intent_lead=decision.is_intent_lead,
                intent_category=decision.intent_category,
                intent_confidence=decision.intent_confidence,
                suggested_reply=decision.suggested_reply,
                buyer_lead_id=None,
            )

            if not is_new:
                logger.debug(
                    "Skipping duplicate comment %s on publication %s (is_new=False).",
                    p_comm_id,
                    pub_id,
                )
                continue

            if decision.is_intent_lead:
                lead_row = self.repo.create_social_buyer_lead(
                    author_handle=author_handle,
                    listing_id=str(listing_id) if listing_id else None,
                    suggested_reply=decision.suggested_reply,
                    platform=telemetry.get("platform", "INSTAGRAM"),
                )
                buyer_lead_id = str(lead_row["id"]) if (lead_row and lead_row.get("id")) else None
                if buyer_lead_id:
                    leads_captured += 1
                    self._link_buyer_lead_to_comment(comment_uuid, buyer_lead_id)

                # Send Telegram notification card only for brand-new comments
                self._notify_social_inbound_lead(
                    listing=listing,
                    author_handle=author_handle,
                    comment_text=comment_text,
                    intent_category=decision.intent_category,
                    suggested_reply=decision.suggested_reply,
                    platform=telemetry.get("platform", "INSTAGRAM"),
                )

        # Step 5: Update publication telemetry
        self.repo.update_publication_telemetry(
            publication_id=pub_id,
            views=views_count,
            likes=likes_count,
            comments=max(comments_count, len(comments_list)),
            poll_count=new_poll_count,
            next_poll_at=next_poll_iso,
            telemetry_status=new_telemetry_status,
            shares=shares_count,
        )

        # Step 6: Telemetry milestone snapshots (e.g., T+4h, T+12h, T+24h, T+48h, T+7d)
        if snapshot_phase:
            ner_score = None
            if snapshot_phase == "T+48h":
                ner_score = calculate_ner_score(
                    views=views_count,
                    leads=leads_captured,
                    comments=max(1, comments_count, len(comments_list)),
                )
            self.repo.record_telemetry_snapshot(
                publication_id=pub_id,
                phase=snapshot_phase,
                views=views_count,
                likes=likes_count,
                comments=max(comments_count, len(comments_list)),
                ner_score=ner_score,
            )

        return {
            "job_type": "SYNC_SOCIAL_METRICS",
            "publication_id": pub_id,
            "poll_count": new_poll_count,
            "telemetry_status": new_telemetry_status,
            "snapshot_phase": snapshot_phase,
            "views_count": views_count,
            "likes_count": likes_count,
            "comments_count": max(comments_count, len(comments_list)),
            "leads_captured": leads_captured,
            "next_poll_at": next_poll_iso,
        }

    def _handle_telegram_dispatch(self, job: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes TELEGRAM_DISPATCH pipeline job:
        Dispatches vertical MP4 video with internal CRM card & copy-paste caption to Telegram
        using multipart upload stream via TelegramCRMDispatcher.send_video_lead.
        """
        listing = self._resolve_listing_for_job(job)
        params = job.get("params_json") or {}
        listing_id = str(job.get("listing_id") or params.get("listing_id") or listing.get("id") or "").strip()

        custom_caption = params.get("custom_caption")
        target_account = params.get("target_account") or params.get("target_account_handle")
        video_path = params.get("video_path")

        # Resolve video file if not explicitly supplied
        if not video_path:
            bina_id = str(listing.get("bina_id") or "").strip()
            candidate = OUTPUT_DIR / f"{bina_id}.mp4"
            if candidate.exists():
                video_path = str(candidate)
            else:
                # Check render_version_id or latest render version
                render_version_id = params.get("render_version_id")
                video_cdn_url = params.get("video_cdn_url")
                if not video_cdn_url and self.repo.is_configured() and listing_id:
                    try:
                        rv = None
                        if render_version_id:
                            rv = self.repo.get_render_version_by_id(render_version_id)
                        if not rv:
                            rv = self.repo.get_latest_render_version(listing_id)
                        if rv and rv.get("video_cdn_url"):
                            video_cdn_url = rv["video_cdn_url"]
                    except Exception as err:
                        logger.warning("Could not fetch render version for job %s: %s", job.get("id"), err)

                if video_cdn_url and isinstance(video_cdn_url, str) and video_cdn_url.startswith("http"):
                    candidate.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        import requests
                        logger.info("Downloading video for dispatch from CDN: %s", video_cdn_url)
                        resp = requests.get(video_cdn_url, stream=True, timeout=60)
                        if resp.status_code == 200:
                            with open(candidate, "wb") as f:
                                for chunk in resp.iter_content(chunk_size=65536):
                                    f.write(chunk)
                            video_path = str(candidate)
                    except Exception as err:
                        logger.warning("Failed downloading video from %s: %s", video_cdn_url, err)

        dispatcher = TelegramCRMDispatcher()
        res = dispatcher.send_video_lead(
            listing=listing,
            video_path=video_path,
            custom_caption=custom_caption,
            target_account_handle=target_account,
            force_multipart=True,
        )

        if self.repo.is_configured() and listing_id:
            try:
                self.repo.insert_listing_event(
                    listing_id=listing_id,
                    event_type="STATUS_CHANGED",
                    new_value={"telegram_result": res, "job_id": job.get("id")},
                    triggered_job_id=str(job.get("id")) if job.get("id") else None,
                    actor="local_worker",
                )
            except Exception as err:
                logger.warning("Could not record listing event for telegram dispatch: %s", err)

        return {
            "job_type": "TELEGRAM_DISPATCH",
            "listing_id": listing_id,
            "status": res.get("status", "DISPATCHED"),
            "message_id": res.get("message_id"),
            "public_message_id": res.get("public_message_id"),
        }

    def _handle_publish_social(self, job: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes PUBLISH_SOCIAL pipeline job, branching on `SOCIAL_API_MODE`:
        - OFFICIAL: publishes via Meta Graph Reels Container API or TikTok PULL_FROM_URL
          using Vault-stored OAuth tokens (`OfficialSocialPublisher`).
        - TELEGRAM_FALLBACK: routes cleanly to `_handle_telegram_dispatch` during the
          <= 45-day transition window.
        """
        params = job.get("params_json") or {}
        pub_id = str(params.get("publication_id") or job.get("publication_id") or "").strip()
        pub = self.repo.get_publication_by_id(pub_id) if pub_id and hasattr(self.repo, "get_publication_by_id") else None
        if not isinstance(pub, dict):
            pub = None

        listing_id = str(
            job.get("listing_id")
            or params.get("listing_id")
            or (pub.get("listing_id") if pub else "")
            or ""
        ).strip()
        listing = (
            self.repo.get_listing_by_id(listing_id)
            if listing_id and hasattr(self.repo, "get_listing_by_id")
            else None
        )
        agency_id = str(
            (pub.get("agency_id") if pub else "")
            or (listing.get("agency_id") if isinstance(listing, dict) else "")
            or params.get("agency_id")
            or ""
        ).strip() or None

        mode = self._resolve_social_api_mode(agency_id, params=params)
        if mode != "OFFICIAL":
            tg_res = self._handle_telegram_dispatch(job)
            return {
                **tg_res,
                "job_type": "PUBLISH_SOCIAL",
                "mode": "TELEGRAM_FALLBACK",
            }

        if not pub:
            raise ValueError(f"PUBLISH_SOCIAL job {job.get('id')} missing valid publication")

        rv_id = str(params.get("render_version_id") or pub.get("render_version_id") or "").strip()
        render_version = (
            self.repo.get_render_version_by_id(rv_id)
            if rv_id and hasattr(self.repo, "get_render_version_by_id")
            else None
        )
        if not render_version and listing_id and hasattr(self.repo, "get_latest_render_version"):
            render_version = self.repo.get_latest_render_version(listing_id)

        from src.social.official_clients import OfficialSocialPublisher
        publisher = OfficialSocialPublisher(repo=self.repo)
        res = publisher.publish_publication(
            publication=pub,
            render_version=render_version if isinstance(render_version, dict) else None,
            video_url=params.get("video_url"),
            caption=params.get("custom_caption") or params.get("caption"),
        )
        return {
            "job_type": "PUBLISH_SOCIAL",
            "mode": "OFFICIAL",
            "publication_id": pub_id,
            **res,
        }

    # ------------------------------------------------------------------
    # Single Job Execution with Background Lease Heartbeat
    # ------------------------------------------------------------------

    def execute_job(self, job: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes a claimed `pipeline_jobs` row with a background lease-renewal heartbeat
        thread (with hard wall-clock runtime cap & lease-loss fencing) and updates the
        job status to `SUCCEEDED`, `EXPIRED`, `QUEUED` (transient retry), or `FAILED`.
        """
        job_id = str(job.get("id") or "")
        job_type = str(job.get("job_type") or "").strip().upper()

        # Defense-in-depth TTL check for AUTO_SCHEDULER jobs
        if is_job_expired(job):
            logger.info("Job %s (%s) passed AUTO TTL expires_at; marking EXPIRED.", job_id, job_type)
            self.repo.complete_pipeline_job(
                job_id,
                status="EXPIRED",
                error_message="AUTO_SCHEDULER job expired past TTL before execution",
                worker_id=self.worker_id,
            )
            return {"job_id": job_id, "job_type": job_type, "status": "EXPIRED"}

        logger.info("Executing job %s (%s) on worker '%s'...", job_id, job_type, self.worker_id)
        params = job.get("params_json") or {}
        bina_id_hint = str(params.get("bina_id") or "").strip() or None
        self._current_bina_id = bina_id_hint
        self._current_phase = JOB_PHASE_LABELS.get(job_type, f"{job_type} icra olunur")
        self._write_active_job_marker(job_id, job_type)
        self.repo.record_worker_heartbeat(
            worker_id=self.worker_id,
            current_job_id=job_id,
            metadata=self.get_telemetry_snapshot(
                state="PROCESSING",
                job_type=job_type,
                phase="started",
            ),
        )

        if job_type in RENDER_JOB_TYPES:
            max_runtime = self.render_max_runtime_seconds
        elif job_type == "SYNC_SOCIAL_METRICS":
            max_runtime = DEFAULT_SOCIAL_MAX_RUNTIME_SECONDS
        elif job_type == "TELEGRAM_DISPATCH":
            max_runtime = DEFAULT_TELEGRAM_MAX_RUNTIME_SECONDS
        else:
            max_runtime = self.scrape_max_runtime_seconds

        hb_thread = JobHeartbeatThread(
            repo=self.repo,
            job_id=job_id,
            worker_id=self.worker_id,
            job_type=job_type,
            lease_minutes=self.lease_minutes,
            interval_seconds=self.heartbeat_interval_seconds,
            max_runtime_seconds=max_runtime,
            telemetry_fn=lambda: self.get_telemetry_snapshot(state="PROCESSING"),
        )
        hb_thread.start()
        job_outcome_status = "UNKNOWN"
        job_outcome_error: Optional[str] = None

        try:
            handlers = {
                "SCRAPE_NEW": self._handle_scrape_new,
                "RENDER_INITIAL": self._handle_render_initial,
                "RENDER_PRICE_DROP": self._handle_render_price_drop,
                "RERENDER": self._handle_rerender,
                "LIVENESS_CHECK": self._handle_liveness_check,
                "PREFLIGHT_CHECK": self._handle_preflight_check,
                "SYNC_SOCIAL_METRICS": self._handle_sync_social_metrics,
                "TELEGRAM_DISPATCH": self._handle_telegram_dispatch,
                "PUBLISH_SOCIAL": self._handle_publish_social,
            }
            handler = handlers.get(job_type)
            if handler is None:
                raise ValueError(f"Unsupported pipeline job_type: '{job_type}'")

            if job_id and hasattr(self.repo, "is_job_cancel_requested") and self.repo.is_job_cancel_requested(job_id) is True:
                logger.info("Job %s (%s) cancelled before execution.", job_id, job_type)
                job_outcome_status = "CANCELLED"
                self.repo.complete_pipeline_job(
                    job_id,
                    status="CANCELLED",
                    error_message="Cancelled before execution",
                    worker_id=self.worker_id,
                )
                return {
                    "job_id": job_id,
                    "job_type": job_type,
                    "status": "CANCELLED",
                    "heartbeats_sent": hb_thread.heartbeat_count,
                }

            result = handler(job)
            result_cancelled = (
                isinstance(result, dict)
                and str(result.get("status") or "").strip().upper() == "CANCELLED"
            )
            cancel_requested_after = bool(
                job_id
                and hasattr(self.repo, "is_job_cancel_requested")
                and self.repo.is_job_cancel_requested(job_id) is True
            )
            if result_cancelled or cancel_requested_after:
                logger.info("Job %s (%s) cancel requested during execution; marking CANCELLED.", job_id, job_type)
                if (
                    isinstance(result, dict)
                    and result.get("storage_object_path")
                    and not result.get("cleaned_storage_object")
                    and hasattr(self.repo, "delete_storage_object")
                ):
                    try:
                        self.repo.delete_storage_object(
                            result["storage_object_path"],
                            storage_provider=result.get("storage_provider"),
                        )
                    except Exception as cleanup_exc:
                        logger.warning("Failed partial storage cleanup for cancelled job %s: %s", job_id, cleanup_exc)
                job_outcome_status = "CANCELLED"
                self.repo.complete_pipeline_job(
                    job_id,
                    status="CANCELLED",
                    error_message="Cancelled during execution",
                    worker_id=self.worker_id,
                )
                return {
                    "job_id": job_id,
                    "job_type": job_type,
                    "status": "CANCELLED",
                    "heartbeats_sent": hb_thread.heartbeat_count,
                    "result": result,
                }
            if hb_thread.lease_lost.is_set():
                logger.warning(
                    "Job %s (%s) finished on worker '%s' after lease was lost; "
                    "NOT marking SUCCEEDED to prevent fenced overwrite.",
                    job_id,
                    job_type,
                    self.worker_id,
                )
                return {
                    "job_id": job_id,
                    "job_type": job_type,
                    "status": "LEASE_LOST",
                    "heartbeats_sent": hb_thread.heartbeat_count,
                    "result": result,
                }

            completed = self.repo.complete_pipeline_job(
                job_id,
                status="SUCCEEDED",
                worker_id=self.worker_id,
            )
            if completed is False:
                logger.warning(
                    "Fenced complete_pipeline_job returned False for job %s (%s) on worker '%s' "
                    "(lease no longer held).",
                    job_id,
                    job_type,
                    self.worker_id,
                )
                return {
                    "job_id": job_id,
                    "job_type": job_type,
                    "status": "LEASE_LOST",
                    "heartbeats_sent": hb_thread.heartbeat_count,
                    "result": result,
                }

            self.jobs_processed += 1
            job_outcome_status = "SUCCEEDED"
            logger.info("Job %s (%s) SUCCEEDED.", job_id, job_type)
            return {
                "job_id": job_id,
                "job_type": job_type,
                "status": "SUCCEEDED",
                "heartbeats_sent": hb_thread.heartbeat_count,
                "result": result,
            }
        except Exception as exc:
            job_outcome_error = str(exc)[:240]
            if self._sigterm_received.is_set():
                sigterm_target = (
                    "CANCELLED"
                    if (
                        job_id
                        and hasattr(self.repo, "is_job_cancel_requested")
                        and self.repo.is_job_cancel_requested(job_id) is True
                    )
                    else "QUEUED"
                )
                logger.warning(
                    "Job %s (%s) interrupted by graceful SIGTERM; releasing status=%s.",
                    job_id,
                    job_type,
                    sigterm_target,
                )
                job_outcome_status = sigterm_target
                self.repo.complete_pipeline_job(
                    job_id,
                    status=sigterm_target,
                    error_message=f"Worker interrupted by SIGTERM: {exc}",
                    worker_id=self.worker_id,
                )
                return {
                    "job_id": job_id,
                    "job_type": job_type,
                    "status": sigterm_target,
                    "error": str(exc),
                    "heartbeats_sent": hb_thread.heartbeat_count,
                }
            logger.error("Job %s (%s) error: %s", job_id, job_type, exc, exc_info=True)
            try:
                import sentry_sdk
                sentry_sdk.set_tag("job_id", job_id)
                sentry_sdk.set_tag("job_type", job_type)
                sentry_sdk.capture_exception(exc)
            except Exception:
                pass

            if hb_thread.lease_lost.is_set():
                logger.warning(
                    "Job %s (%s) errored after lease was lost on worker '%s'; "
                    "skipping completion update.",
                    job_id,
                    job_type,
                    self.worker_id,
                )
                return {
                    "job_id": job_id,
                    "job_type": job_type,
                    "status": "LEASE_LOST",
                    "error": str(exc),
                    "heartbeats_sent": hb_thread.heartbeat_count,
                }

            raw_attempts = job.get("attempts")
            raw_max_attempts = job.get("max_attempts")
            attempts = int(raw_attempts) if raw_attempts is not None else 1
            max_attempts = int(raw_max_attempts) if raw_max_attempts is not None else 1
            is_transient = not isinstance(exc, ValueError)
            target_status = "QUEUED" if (is_transient and attempts < max_attempts) else "FAILED"

            if target_status == "QUEUED":
                logger.warning(
                    "Requeueing job %s (%s) after transient error (attempt %d/%d).",
                    job_id,
                    job_type,
                    attempts,
                    max_attempts,
                )

            job_outcome_status = target_status
            self.repo.complete_pipeline_job(
                job_id,
                status=target_status,
                error_message=str(exc),
                worker_id=self.worker_id,
            )
            return {
                "job_id": job_id,
                "job_type": job_type,
                "status": target_status,
                "error": str(exc),
                "heartbeats_sent": hb_thread.heartbeat_count,
            }
        finally:
            self._clear_active_job_marker()
            hb_thread.stop()
            hb_thread.join(timeout=2.0)
            self._current_phase = "Tapşırıq gözlənilir"
            self._current_bina_id = None
            try:
                self.repo.record_worker_heartbeat(
                    worker_id=self.worker_id,
                    current_job_id=None,
                    metadata=self.get_telemetry_snapshot(
                        state="IDLE",
                        last_job_id=job_id,
                        last_job_type=job_type,
                        last_job_status=job_outcome_status,
                        last_job_error=job_outcome_error,
                        last_job_finished_at=_utc_now().isoformat(),
                    ),
                )
            except Exception:
                pass

    def _write_active_job_marker(self, job_id: str, job_type: str) -> None:
        """Writes active job metadata to local JSON marker for watchdog crash inspection."""
        try:
            marker_path = BASE_PROJECT_DIR / "data" / "worker_active_job.json"
            marker_path.parent.mkdir(parents=True, exist_ok=True)
            marker_path.write_text(
                json.dumps({
                    "job_id": job_id,
                    "job_type": job_type,
                    "worker_id": self.worker_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.warning("Failed to write active job marker: %s", exc)

    def _clear_active_job_marker(self) -> None:
        """Removes active job marker once execution completes cleanly or handles exception."""
        try:
            marker_path = BASE_PROJECT_DIR / "data" / "worker_active_job.json"
            if marker_path.exists():
                marker_path.unlink()
        except Exception as exc:
            logger.warning("Failed to clear active job marker: %s", exc)

    # ------------------------------------------------------------------
    # Polling Loop
    # ------------------------------------------------------------------

    def run_once(self) -> Optional[Dict[str, Any]]:
        """Runs periodic schedule enqueueing, claims at most one job, and executes it."""
        if not self.repo.is_configured():
            logger.error(
                "SupabaseRepo is not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY). "
                "Worker cannot poll pipeline_jobs."
            )
            return None

        self.maybe_enqueue_scheduled_jobs()

        job = self.repo.claim_next_pipeline_job(
            worker_id=self.worker_id,
            lease_minutes=self.lease_minutes,
        )
        if not job:
            now_mono = time.monotonic()
            if (now_mono - self._last_idle_heartbeat_mono) >= self.heartbeat_interval_seconds:
                self.repo.record_worker_heartbeat(
                    worker_id=self.worker_id,
                    current_job_id=None,
                    metadata=self.get_telemetry_snapshot(state="IDLE"),
                )
                self._last_idle_heartbeat_mono = now_mono
            return None

        return self.execute_job(job)

    def start(self, max_polls: Optional[int] = None) -> None:
        """Starts the continuous polling loop with graceful Ctrl+C / SIGTERM shutdown."""
        self._stop_event.clear()
        self._sigterm_received.clear()
        self._started_at_iso = _utc_now().isoformat()

        root_logger = logging.getLogger()
        root_logger.addHandler(self._telemetry_buffer)

        try:
            signal.signal(signal.SIGINT, lambda sig, frame: self.stop())
            signal.signal(signal.SIGTERM, self.handle_sigterm)
        except (ValueError, AttributeError):
            pass

        try:
            logger.info(
                ">>> BakuEstate-AI Local Worker '%s' started (poll=%.1fs, heartbeat=%.1fs, lease=%dm) <<<",
                self.worker_id,
                self.poll_interval_seconds,
                self.heartbeat_interval_seconds,
                self.lease_minutes,
            )

            # Initial online heartbeat
            if self.repo.is_configured():
                self.repo.record_worker_heartbeat(
                    worker_id=self.worker_id,
                    current_job_id=None,
                    metadata=self.get_telemetry_snapshot(
                        state="IDLE",
                        current_phase="Hazır — növbə izlənilir",
                    ),
                )
                self._last_idle_heartbeat_mono = time.monotonic()

            polls = 0
            while not self._stop_event.is_set():
                polls += 1
                try:
                    outcome = self.run_once()
                except Exception as exc:
                    logger.error("Unhandled error in worker poll tick: %s", exc, exc_info=True)
                    outcome = None

                if max_polls is not None and polls >= max_polls:
                    break

                # If a job was processed, immediately check for the next queued job;
                # otherwise sleep for poll_interval_seconds.
                if outcome is None:
                    if self._stop_event.wait(timeout=self.poll_interval_seconds):
                        break

            logger.info("Local worker '%s' stopped cleanly (jobs_processed=%d).", self.worker_id, self.jobs_processed)
            if self.repo.is_configured():
                try:
                    self.repo.record_worker_heartbeat(
                        worker_id=self.worker_id,
                        current_job_id=None,
                        metadata=self.get_telemetry_snapshot(
                            state="STOPPED",
                            current_phase="Worker dayandırıldı",
                        ),
                    )
                except Exception:
                    pass
        finally:
            root_logger.removeHandler(self._telemetry_buffer)


def main() -> None:
    parser = argparse.ArgumentParser(description="BakuEstate-AI Windows Local Worker Daemon")
    parser.add_argument("--worker-id", type=str, default=WORKER_ID, help="Unique worker identifier")
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=DEFAULT_POLL_INTERVAL_SECONDS,
        help="Seconds between claim_next_pipeline_job() polls (default: 10)",
    )
    parser.add_argument(
        "--heartbeat-interval",
        type=float,
        default=DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        help="Seconds between background lease heartbeats (default: 60)",
    )
    parser.add_argument(
        "--lease-minutes",
        type=int,
        default=DEFAULT_LEASE_MINUTES,
        help="Lease duration in minutes per claimed job (default: 5)",
    )
    parser.add_argument(
        "--scrape-times",
        type=str,
        default=SCHEDULE_TIMES,
        help="Comma-separated Baku (UTC+4) HH:MM times for periodic SCRAPE_NEW jobs",
    )
    parser.add_argument(
        "--liveness-interval-hours",
        type=int,
        default=DEFAULT_LIVENESS_INTERVAL_HOURS,
        help="Hours between periodic LIVENESS_CHECK jobs (default: 12)",
    )
    parser.add_argument("--pages", type=int, default=SCHEDULE_PAGES, help="Pages per scheduled SCRAPE_NEW")
    parser.add_argument("--limit", type=int, default=SCHEDULE_LIMIT, help="Limit per scheduled SCRAPE_NEW")
    parser.add_argument("--no-scheduler", action="store_true", help="Disable periodic SCRAPE_NEW/LIVENESS_CHECK enqueue")
    parser.add_argument("--live-dispatch", action="store_true", help="Send videos to real Telegram instead of mock")
    parser.add_argument("--allow-agents", action="store_true", help="Allow agent listings (default: direct owner only)")
    parser.add_argument("--once", action="store_true", help="Claim and execute at most one job, then exit")

    args = parser.parse_args()

    dispatch_mock = False if args.live_dispatch else TELEGRAM_MOCK_DISPATCH

    worker = BakuLocalWorker(
        worker_id=args.worker_id,
        poll_interval_seconds=args.poll_interval,
        heartbeat_interval_seconds=args.heartbeat_interval,
        lease_minutes=args.lease_minutes,
        scrape_times=parse_schedule_times(args.scrape_times),
        scrape_pages=args.pages,
        scrape_limit=args.limit,
        liveness_interval_hours=args.liveness_interval_hours,
        enable_periodic_scheduler=not args.no_scheduler,
        mock_dispatch=dispatch_mock,
        owner_only=not args.allow_agents,
    )

    if args.once:
        worker.run_once()
        return

    worker.start()


if __name__ == "__main__":
    main()
