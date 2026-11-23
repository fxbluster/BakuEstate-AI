"""Unit tests for BakuLocalWorker (claim/heartbeat/TTL expiry/liveness),
idempotent cloud Telegram dispatch, and TelegramBotService chat_id security."""

import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from run_pipeline import BakuEstatePipeline
from src.dispatcher.telegram_bot_service import TelegramBotService
from src.scraper.bina_scraper import (
    LIVENESS_ACTIVE,
    LIVENESS_REMOVED,
    LIVENESS_TRANSIENT_ERROR,
)
from src.worker.account_router import route_listing_to_channel
from src.worker.local_worker import (
    BakuLocalWorker,
    JobHeartbeatThread,
    is_job_expired,
)


class TestLocalWorkerTTLAndHeartbeat(unittest.TestCase):
    def setUp(self):
        self.mock_repo = MagicMock()
        self.mock_repo.is_configured.return_value = True
        self.mock_repo.count_today_auto_renders_baku.return_value = 0
        self.mock_repo.complete_pipeline_job.return_value = True
        self.mock_repo.create_sold_listing_lead_alerts.return_value = []
        self.mock_pipeline = MagicMock()
        self.worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            worker_id="win-test-worker",
            poll_interval_seconds=0.05,
            heartbeat_interval_seconds=0.05,
            lease_minutes=5,
            liveness_jitter_range=(0.0, 0.0),
            enable_periodic_scheduler=False,
        )

    def test_is_job_expired_auto_vs_manual(self):
        now = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
        past = (now - timedelta(hours=2)).isoformat()
        future = (now + timedelta(hours=2)).isoformat()

        # AUTO_SCHEDULER past TTL -> expired
        self.assertTrue(
            is_job_expired(
                {"trigger_source": "AUTO_SCHEDULER", "expires_at": past},
                now=now,
            )
        )
        # AUTO_SCHEDULER before TTL -> not expired
        self.assertFalse(
            is_job_expired(
                {"trigger_source": "AUTO_SCHEDULER", "expires_at": future},
                now=now,
            )
        )
        # Manual WEB_UI / TELEGRAM_WEBHOOK jobs NEVER expire on PC sleep
        self.assertFalse(
            is_job_expired(
                {"trigger_source": "WEB_UI", "expires_at": past},
                now=now,
            )
        )
        self.assertFalse(
            is_job_expired(
                {"trigger_source": "TELEGRAM_WEBHOOK", "expires_at": past},
                now=now,
            )
        )

    def test_execute_job_marks_expired_auto_job_without_running_pipeline(self):
        past = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
        job = {
            "id": "job-expired-1",
            "job_type": "RENDER_PRICE_DROP",
            "trigger_source": "AUTO_SCHEDULER",
            "expires_at": past,
            "listing_id": "uuid-listing-1",
        }
        outcome = self.worker.execute_job(job)
        self.assertEqual(outcome["status"], "EXPIRED")
        self.mock_repo.complete_pipeline_job.assert_called_once()
        _, kwargs = self.mock_repo.complete_pipeline_job.call_args
        self.assertEqual(kwargs["status"], "EXPIRED")
        self.mock_pipeline.process_listing_video_and_dispatch.assert_not_called()

    def test_run_once_claims_job_sends_heartbeats_and_completes(self):
        job = {
            "id": "job-hb-1",
            "job_type": "RENDER_INITIAL",
            "trigger_source": "WEB_UI",
            "listing_id": "uuid-listing-1",
            "params_json": {"script_angle": "investor"},
        }
        self.mock_repo.claim_next_pipeline_job.return_value = job
        self.mock_repo.get_listing_by_id.return_value = {
            "id": "uuid-listing-1",
            "bina_id": "5616503",
        }
        self.mock_repo.heartbeat_pipeline_job.return_value = True

        def slow_render(*args, **kwargs):
            time.sleep(0.16)
            return {"bina_id": "5616503", "status": "OK"}

        self.mock_pipeline.process_listing_video_and_dispatch.side_effect = slow_render

        outcome = self.worker.run_once()
        self.assertIsNotNone(outcome)
        self.assertEqual(outcome["status"], "SUCCEEDED")
        self.assertGreaterEqual(outcome["heartbeats_sent"], 1)
        self.mock_repo.claim_next_pipeline_job.assert_called_once_with(
            worker_id="win-test-worker",
            lease_minutes=5,
        )
        self.assertGreaterEqual(self.mock_repo.heartbeat_pipeline_job.call_count, 1)
        self.mock_repo.complete_pipeline_job.assert_called_once_with(
            "job-hb-1",
            status="SUCCEEDED",
            worker_id="win-test-worker",
        )

    def test_price_drop_job_rechecks_owner_sold_guardrail_before_render(self):
        job = {
            "id": "job-drop-sold",
            "job_type": "RENDER_PRICE_DROP",
            "trigger_source": "AUTO_SCHEDULER",
            "listing_id": "uuid-sold",
            "params_json": {"price_drop_info": {"drop_pct": 8.0}},
        }
        self.mock_repo.get_listing_by_id.return_value = {
            "id": "uuid-sold",
            "bina_id": "5616503",
            "editorial_status": "PUBLISHED",
            "source_availability": "ACTIVE",
            "owner_outreach_status": "OWNER_SOLD",
        }

        outcome = self.worker.execute_job(job)
        self.assertEqual(outcome["status"], "SUCCEEDED")
        self.assertEqual(outcome["result"]["status"], "SKIPPED_BLOCKED")
        self.mock_pipeline.process_listing_video_and_dispatch.assert_not_called()

    def test_rerender_job_maps_voice_choice_and_update_message_id(self):
        job = {
            "id": "job-rerender-1",
            "job_type": "RERENDER",
            "trigger_source": "TELEGRAM_WEBHOOK",
            "listing_id": "uuid-1",
            "params_json": {
                "voice_choice": "eleven_male",
                "script_angle": "luxury",
                "telegram_message_id": 777,
                "telegram_chat_id": "12345",
            },
        }
        self.mock_repo.get_listing_by_id.return_value = {"id": "uuid-1", "bina_id": "5616503"}
        self.mock_pipeline.process_listing_video_and_dispatch.return_value = {"bina_id": "5616503", "status": "OK"}

        outcome = self.worker.execute_job(job)
        self.assertEqual(outcome["status"], "SUCCEEDED")
        _, kwargs = self.mock_pipeline.process_listing_video_and_dispatch.call_args
        self.assertEqual(kwargs["voice_engine"], "elevenlabs")
        self.assertEqual(kwargs["voice_id"], "ZQJv3hwvRAIC7fvWZ1Qr")
        self.assertEqual(kwargs["script_angle"], "luxury")
        self.assertEqual(kwargs["update_telegram_message_id"], 777)
        self.assertEqual(kwargs["telegram_chat_id"], "12345")

    def test_liveness_check_job_handles_active_removed_and_transient_429(self):
        self.mock_repo.get_active_listings_for_liveness.return_value = [
            {"id": "u-active", "bina_id": "101", "source_availability": "ACTIVE"},
            {"id": "u-removed", "bina_id": "102", "source_availability": "ACTIVE"},
            {"id": "u-429", "bina_id": "103", "source_availability": "ACTIVE"},
        ]
        self.mock_pipeline.scraper.check_listing_liveness.side_effect = [
            LIVENESS_ACTIVE,
            LIVENESS_REMOVED,
            LIVENESS_TRANSIENT_ERROR,
        ]

        job = {"id": "job-live-1", "job_type": "LIVENESS_CHECK", "params_json": {"limit": 10}}
        outcome = self.worker.execute_job(job)
        self.assertEqual(outcome["status"], "SUCCEEDED")
        self.assertEqual(outcome["result"]["active"], 1)
        self.assertEqual(outcome["result"]["removed"], 1)
        self.assertEqual(outcome["result"]["transient_errors"], 1)

        # Only u-removed gets source_availability=REMOVED_ON_BINA and REMOVED_ON_BINA event
        self.mock_repo.insert_listing_event.assert_called_once()
        ev_args, ev_kwargs = self.mock_repo.insert_listing_event.call_args
        self.assertEqual(ev_args[0], "u-removed")
        self.assertEqual(ev_args[1], "REMOVED_ON_BINA")
        self.assertEqual(ev_kwargs["actor"], "liveness_poller")

        # u-429 must NEVER be updated to REMOVED_ON_BINA
        for call_args, _ in self.mock_repo.update_listing.call_args_list:
            self.assertNotEqual(call_args[0], "u-429")

    def test_periodic_scheduler_enqueues_idempotently(self):
        worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            scrape_times=["10:00"],
            enable_periodic_scheduler=True,
        )
        self.mock_repo.enqueue_pipeline_job.side_effect = [
            {"id": "j-scrape"},
            {"id": "j-live"},
        ]
        baku_11am_utc = datetime(2026, 11, 18, 7, 0, 0, tzinfo=timezone.utc)  # 11:00 Asia/Baku
        first = worker.maybe_enqueue_scheduled_jobs(now=baku_11am_utc)
        second = worker.maybe_enqueue_scheduled_jobs(now=baku_11am_utc)
        self.assertEqual(len(first), 2)
        self.assertEqual(len(second), 0)
        self.assertEqual(self.mock_repo.enqueue_pipeline_job.call_count, 2)

    def test_heartbeat_thread_default_max_runtime_by_job_type(self):
        for rtype in ("RENDER_INITIAL", "RENDER_PRICE_DROP", "RERENDER"):
            hb = JobHeartbeatThread(self.mock_repo, "j1", "w1", job_type=rtype)
            self.assertEqual(hb.max_runtime_seconds, 600.0)
        for stype in ("SCRAPE_NEW", "LIVENESS_CHECK"):
            hb = JobHeartbeatThread(self.mock_repo, "j2", "w1", job_type=stype)
            self.assertEqual(hb.max_runtime_seconds, 300.0)

    def test_heartbeat_thread_stops_renewing_after_max_runtime_cap(self):
        self.mock_repo.heartbeat_pipeline_job.return_value = True
        hb = JobHeartbeatThread(
            self.mock_repo,
            "job-cap-1",
            "win-test-worker",
            job_type="SCRAPE_NEW",
            interval_seconds=0.05,
            max_runtime_seconds=0.12,
        )
        hb.start()
        hb.join(timeout=1.5)
        self.assertFalse(hb.is_alive())
        self.assertTrue(hb.runtime_cap_exceeded.is_set())
        self.assertLessEqual(hb.heartbeat_count, 2)

    def test_execute_job_does_not_mark_succeeded_when_lease_lost(self):
        job = {
            "id": "job-lease-lost-1",
            "job_type": "RENDER_INITIAL",
            "trigger_source": "WEB_UI",
            "listing_id": "uuid-listing-1",
            "params_json": {},
        }
        self.mock_repo.get_listing_by_id.return_value = {
            "id": "uuid-listing-1",
            "bina_id": "5616503",
        }
        self.mock_repo.heartbeat_pipeline_job.return_value = False

        def slow_render(*args, **kwargs):
            time.sleep(0.18)
            return {"bina_id": "5616503", "status": "OK"}

        self.mock_pipeline.process_listing_video_and_dispatch.side_effect = slow_render

        outcome = self.worker.execute_job(job)
        self.assertEqual(outcome["status"], "LEASE_LOST")
        self.mock_repo.complete_pipeline_job.assert_not_called()
        # Heartbeat stopped immediately after first False response
        self.assertEqual(self.mock_repo.heartbeat_pipeline_job.call_count, 1)

    def test_periodic_scheduler_coalesces_missed_slots_within_3h_and_skips_older(self):
        worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            scrape_times=["08:00", "10:30", "11:30", "12:30"],
            liveness_jitter_range=(0.0, 0.0),
            enable_periodic_scheduler=True,
        )
        self.mock_repo.enqueue_pipeline_job.side_effect = (
            lambda **kwargs: {"id": f"job-{kwargs['idempotency_key']}", **kwargs}
        )

        # Wake up at 13:00 Asia/Baku (09:00 UTC): 08:00 (>3h) skipped;
        # 10:30, 11:30, 12:30 coalesced -> ONLY 1 catch-up SCRAPE_NEW for 12:30
        baku_1300_utc = datetime(2026, 11, 18, 9, 0, 0, tzinfo=timezone.utc)
        enqueued = worker.maybe_enqueue_scheduled_jobs(now=baku_1300_utc)
        scrape_jobs = [j for j in enqueued if j["job_type"] == "SCRAPE_NEW"]
        self.assertEqual(len(scrape_jobs), 1)
        self.assertEqual(scrape_jobs[0]["idempotency_key"], "sched_scrape:2026-11-18:12:30")

        # Subsequent tick at 13:05 Baku does not backfill 10:30 or 11:30
        baku_1305_utc = datetime(2026, 11, 18, 9, 5, 0, tzinfo=timezone.utc)
        enqueued_again = worker.maybe_enqueue_scheduled_jobs(now=baku_1305_utc)
        self.assertEqual([j for j in enqueued_again if j["job_type"] == "SCRAPE_NEW"], [])

        # Separate worker waking up when all slots are >3h old -> 0 SCRAPE_NEW jobs
        worker_old = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            scrape_times=["08:00", "09:30"],
            liveness_jitter_range=(0.0, 0.0),
            enable_periodic_scheduler=True,
        )
        baku_1400_utc = datetime(2026, 11, 18, 10, 0, 0, tzinfo=timezone.utc)
        enqueued_old = worker_old.maybe_enqueue_scheduled_jobs(now=baku_1400_utc)
        self.assertEqual([j for j in enqueued_old if j["job_type"] == "SCRAPE_NEW"], [])

    def test_render_initial_and_price_drop_recheck_daily_limit_and_24h_cooldown(self):
        recent_iso = (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat()

        # 1. RENDER_INITIAL blocked by DAILY_AUTO_RENDER_LIMIT
        self.mock_repo.count_today_auto_renders_baku.return_value = 5
        self.mock_repo.get_listing_by_id.return_value = {
            "id": "uuid-1",
            "bina_id": "5616503",
            "editorial_status": "PENDING_REVIEW",
            "source_availability": "ACTIVE",
            "owner_outreach_status": "NOT_CONTACTED",
            "last_auto_rendered_at": None,
        }
        res_init_limit = self.worker.execute_job({
            "id": "j-init-limit",
            "job_type": "RENDER_INITIAL",
            "trigger_source": "AUTO_SCHEDULER",
            "listing_id": "uuid-1",
        })
        self.assertEqual(res_init_limit["status"], "SUCCEEDED")
        self.assertEqual(res_init_limit["result"]["status"], "SKIPPED_DAILY_LIMIT")
        self.mock_pipeline.process_listing_video_and_dispatch.assert_not_called()

        # 2. RENDER_INITIAL blocked by 24h last_auto_rendered_at cooldown
        self.mock_repo.count_today_auto_renders_baku.return_value = 0
        self.mock_repo.get_listing_by_id.return_value = {
            "id": "uuid-1",
            "bina_id": "5616503",
            "editorial_status": "PENDING_REVIEW",
            "source_availability": "ACTIVE",
            "owner_outreach_status": "NOT_CONTACTED",
            "last_auto_rendered_at": recent_iso,
        }
        res_init_cd = self.worker.execute_job({
            "id": "j-init-cd",
            "job_type": "RENDER_INITIAL",
            "trigger_source": "AUTO_SCHEDULER",
            "listing_id": "uuid-1",
        })
        self.assertEqual(res_init_cd["result"]["status"], "SKIPPED_COOLDOWN")
        self.mock_pipeline.process_listing_video_and_dispatch.assert_not_called()

        # 3. RENDER_PRICE_DROP blocked by DAILY_AUTO_RENDER_LIMIT
        self.mock_repo.count_today_auto_renders_baku.return_value = 5
        self.mock_repo.get_listing_by_id.return_value = {
            "id": "uuid-2",
            "bina_id": "5616504",
            "editorial_status": "PUBLISHED",
            "source_availability": "ACTIVE",
            "owner_outreach_status": "NOT_CONTACTED",
            "last_auto_rendered_at": None,
        }
        res_drop_limit = self.worker.execute_job({
            "id": "j-drop-limit",
            "job_type": "RENDER_PRICE_DROP",
            "trigger_source": "AUTO_SCHEDULER",
            "listing_id": "uuid-2",
        })
        self.assertEqual(res_drop_limit["result"]["status"], "SKIPPED_DAILY_LIMIT")
        self.mock_pipeline.process_listing_video_and_dispatch.assert_not_called()

        # 4. RENDER_PRICE_DROP blocked by 24h last_auto_rendered_at cooldown
        self.mock_repo.count_today_auto_renders_baku.return_value = 1
        self.mock_repo.get_listing_by_id.return_value = {
            "id": "uuid-2",
            "bina_id": "5616504",
            "editorial_status": "PUBLISHED",
            "source_availability": "ACTIVE",
            "owner_outreach_status": "NOT_CONTACTED",
            "last_auto_rendered_at": recent_iso,
        }
        res_drop_cd = self.worker.execute_job({
            "id": "j-drop-cd",
            "job_type": "RENDER_PRICE_DROP",
            "trigger_source": "AUTO_SCHEDULER",
            "listing_id": "uuid-2",
        })
        self.assertEqual(res_drop_cd["result"]["status"], "SKIPPED_COOLDOWN")
        self.mock_pipeline.process_listing_video_and_dispatch.assert_not_called()

    def test_liveness_check_jitter_circuit_breaker_and_sold_lead_alerts(self):
        # Part A: Jitter (1.5-3.0s) and sold-listing lead alert creation
        jitter_worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            worker_id="win-test-worker",
            liveness_jitter_range=(1.5, 3.0),
            enable_periodic_scheduler=False,
        )
        self.mock_repo.get_active_listings_for_liveness.return_value = [
            {"id": "u-1", "bina_id": "101", "source_availability": "ACTIVE"},
            {"id": "u-2", "bina_id": "102", "source_availability": "ACTIVE"},
            {"id": "u-3", "bina_id": "103", "source_availability": "ACTIVE"},
        ]
        self.mock_repo.create_sold_listing_lead_alerts.return_value = [{"id": "task-1"}]
        self.mock_pipeline.scraper.check_listing_liveness.side_effect = [
            LIVENESS_ACTIVE,
            LIVENESS_REMOVED,
            LIVENESS_ACTIVE,
        ]

        with patch("src.worker.local_worker.time.sleep") as mock_sleep:
            outcome = jitter_worker.execute_job({
                "id": "job-live-jitter",
                "job_type": "LIVENESS_CHECK",
                "params_json": {"limit": 10},
            })

        self.assertEqual(outcome["status"], "SUCCEEDED")
        self.assertEqual(outcome["result"]["removed"], 1)
        self.assertEqual(outcome["result"]["lead_alerts_created"], 1)
        self.assertFalse(outcome["result"]["circuit_breaker_tripped"])
        self.mock_repo.create_sold_listing_lead_alerts.assert_called_once_with("u-2", "102")
        # 3 requests -> 2 jitter sleeps between requests, each in [1.5, 3.0]
        self.assertEqual(mock_sleep.call_count, 2)
        for call in mock_sleep.call_args_list:
            delay = call.args[0]
            self.assertGreaterEqual(delay, 1.5)
            self.assertLessEqual(delay, 3.0)

        # Part B: Circuit breaker aborts after 3 consecutive TRANSIENT_ERROR responses
        self.mock_repo.reset_mock()
        self.mock_repo.is_configured.return_value = True
        self.mock_repo.complete_pipeline_job.return_value = True
        self.mock_repo.get_active_listings_for_liveness.return_value = [
            {"id": f"u-{i}", "bina_id": f"20{i}", "source_availability": "ACTIVE"}
            for i in range(5)
        ]
        self.mock_pipeline.scraper.check_listing_liveness.reset_mock()
        self.mock_pipeline.scraper.check_listing_liveness.side_effect = [
            LIVENESS_TRANSIENT_ERROR,
            LIVENESS_TRANSIENT_ERROR,
            LIVENESS_TRANSIENT_ERROR,
            LIVENESS_ACTIVE,
            LIVENESS_ACTIVE,
        ]

        cb_outcome = self.worker.execute_job({
            "id": "job-live-cb",
            "job_type": "LIVENESS_CHECK",
            "params_json": {"limit": 10},
        })
        self.assertEqual(cb_outcome["status"], "SUCCEEDED")
        self.assertEqual(cb_outcome["result"]["checked"], 3)
        self.assertEqual(cb_outcome["result"]["transient_errors"], 3)
        self.assertTrue(cb_outcome["result"]["circuit_breaker_tripped"])
        self.assertEqual(self.mock_pipeline.scraper.check_listing_liveness.call_count, 3)

    def test_execute_job_requeues_transient_error_when_attempts_below_max_attempts(self):
        self.mock_repo.get_listing_by_id.return_value = {"id": "uuid-1", "bina_id": "5616503"}
        self.mock_pipeline.process_listing_video_and_dispatch.side_effect = RuntimeError("ElevenLabs 503")

        # Attempt 1 of 2 -> requeue as QUEUED instead of permanent FAILED
        outcome_retry = self.worker.execute_job({
            "id": "job-retry-1",
            "job_type": "RENDER_INITIAL",
            "trigger_source": "WEB_UI",
            "listing_id": "uuid-1",
            "attempts": 1,
            "max_attempts": 2,
        })
        self.assertEqual(outcome_retry["status"], "QUEUED")
        self.mock_repo.complete_pipeline_job.assert_called_once_with(
            "job-retry-1",
            status="QUEUED",
            error_message="ElevenLabs 503",
            worker_id="win-test-worker",
        )

        # Attempt 2 of 2 -> permanently FAILED
        self.mock_repo.complete_pipeline_job.reset_mock()
        outcome_fail = self.worker.execute_job({
            "id": "job-retry-2",
            "job_type": "RENDER_INITIAL",
            "trigger_source": "WEB_UI",
            "listing_id": "uuid-1",
            "attempts": 2,
            "max_attempts": 2,
        })
        self.assertEqual(outcome_fail["status"], "FAILED")
        self.mock_repo.complete_pipeline_job.assert_called_once_with(
            "job-retry-2",
            status="FAILED",
            error_message="ElevenLabs 503",
            worker_id="win-test-worker",
        )


class TestIdempotentCloudTelegramDispatch(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.db_path = self.base_dir / "cloud_test.sqlite"
        self.photo_path = self.base_dir / "photo_01.jpg"
        self.photo_path.write_bytes(b"fake-jpg" * 300)
        self.audio_path = self.base_dir / "voice_5616503_v2.mp3"
        self.audio_path.write_bytes(b"fake-mp3" * 300)
        self.srt_path = self.base_dir / "subs_5616503_v2.srt"
        self.srt_path.write_text("1\n00:00:00,000 --> 00:00:02,000\nSalam\n", encoding="utf-8")

        self.mock_repo = MagicMock()
        self.mock_repo.is_configured.return_value = True
        self.mock_repo.get_listing_by_bina_id.return_value = {
            "id": "uuid-5616503",
            "bina_id": "5616503",
            "content_revision": 2,
            "owner_phone_normalized": "+994501234567",
        }
        self.mock_repo.get_next_render_version_num.return_value = 2
        self.mock_repo.create_render_version.return_value = {
            "id": "rv-uuid-2",
            "version_num": 2,
            "telegram_message_id": None,
        }
        self.mock_repo.upload_versioned_video.return_value = (
            "videos/5616503/v2.mp4",
            "https://example.supabase.co/storage/v1/object/public/baku-estate-media/videos/5616503/v2.mp4",
        )

        self.pipeline = BakuEstatePipeline(
            owner_only=False,
            mock_dispatch=False,
            db_path=self.db_path,
            use_cloud_backend=True,
            supabase_repo=self.mock_repo,
            enable_notion=False,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def _run_cloud_render(self, **kwargs):
        listing = {
            "bina_id": "5616503",
            "title": "3 otaqlı mənzil",
            "price": 165000,
            "currency": "AZN",
            "location": "Nizami",
            "rooms": 3,
            "area": 85,
            "has_bill_of_sale": True,
            "is_owner": True,
            "downloaded_photos": [str(self.photo_path)],
        }

        def fake_compose(*, output_video_path, **c_kwargs):
            Path(output_video_path).write_bytes(b"fake-mp4" * 1000)
            return str(output_video_path)

        with patch("run_pipeline.OUTPUT_DIR", self.base_dir):
            with patch(
                "run_pipeline.generate_tts_for_listing",
                return_value=("Script", str(self.audio_path), str(self.srt_path), 10.0),
            ):
                with patch.object(self.pipeline.compositor, "build_cinematic_video", side_effect=fake_compose):
                    return self.pipeline.process_listing_video_and_dispatch(listing, **kwargs)

    def test_persists_telegram_message_id_immediately_and_supersedes_prior_versions(self):
        with patch.object(
            self.pipeline.dispatcher,
            "send_video_lead",
            return_value={"status": "SENT", "message_id": 884422},
        ) as mock_send:
            res = self._run_cloud_render(trigger_reason="AUTO_PRICE_DROP")

        self.assertEqual(res["version_num"], 2)
        self.assertIn("video_5616503_v2", res["video_path"])
        self.assertTrue(res["video_path"].endswith(".mp4"))
        self.assertEqual(res["storage_object_path"], "videos/5616503/v2.mp4")
        mock_send.assert_called_once()

        # Verify immediate telegram_message_id update was persisted before final completion
        update_calls = self.mock_repo.update_render_version.call_args_list
        self.assertTrue(
            any(call.args[1] == {"telegram_message_id": "884422"} for call in update_calls),
            f"Expected immediate telegram_message_id persistence, got: {update_calls}",
        )
        self.mock_repo.mark_previous_versions_superseded.assert_called_once_with(
            "uuid-5616503",
            keep_version_num=2,
        )

    def test_idempotency_guard_skips_duplicate_send_video_on_retry(self):
        existing_rv = {
            "id": "rv-uuid-2",
            "version_num": 2,
            "telegram_message_id": "884422",
        }
        with patch.object(self.pipeline.dispatcher, "send_video_lead") as mock_send:
            res = self._run_cloud_render(existing_render_version=existing_rv)

        mock_send.assert_not_called()
        self.assertEqual(res["dispatch"]["status"], "ALREADY_DISPATCHED")
        self.assertEqual(res["dispatch"]["message_id"], "884422")

    def test_update_telegram_message_id_uses_edit_message_media_without_duplicate_send(self):
        with patch.object(self.pipeline, "_edit_telegram_message_media", return_value=True) as mock_edit:
            with patch.object(self.pipeline.dispatcher, "send_video_lead") as mock_send:
                res = self._run_cloud_render(
                    trigger_reason="MANUAL_RERENDER",
                    update_telegram_message_id=555111,
                    telegram_chat_id="12345",
                )

        mock_edit.assert_called_once()
        mock_send.assert_not_called()
        self.assertEqual(res["dispatch"]["status"], "UPDATED")
        self.assertEqual(res["dispatch"]["message_id"], "555111")


class TestTelegramBotServiceAuthorization(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "auth_test.sqlite"
        self.service = TelegramBotService(bot_token="tok", chat_id="12345", db_path=self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_unauthorized_callback_and_message_are_blocked(self):
        with patch.object(self.service, "answer_callback_query") as mock_ans:
            res_cb = self.service.handle_callback_query({
                "id": "cb-evil",
                "data": "publish_5616503",
                "message": {"message_id": 1, "chat": {"id": 99999}},
            })
        self.assertEqual(res_cb["action"], "unauthorized")
        self.assertFalse(res_cb["authorized"])
        mock_ans.assert_not_called()

        with patch.object(self.service, "send_message") as mock_send:
            res_msg = self.service.process_update({
                "update_id": 1,
                "message": {"message_id": 2, "text": "/start", "chat": {"id": 99999}},
            })
        self.assertEqual(res_msg["type"], "unauthorized")
        self.assertFalse(res_msg["authorized"])
        mock_send.assert_not_called()

    def test_empty_configured_chat_id_fails_closed(self):
        svc = TelegramBotService(bot_token="tok", chat_id="", db_path=self.db_path)
        self.assertFalse(svc.is_authorized_chat("12345"))
        self.assertFalse(svc.is_authorized_chat(None))


class TestMultiAccountNicheRouting(unittest.TestCase):
    def setUp(self):
        self.mock_repo = MagicMock()
        self.mock_repo.is_configured.return_value = True
        self.mock_repo.count_today_auto_renders_baku.return_value = 0
        self.mock_pipeline = MagicMock()
        self.worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            worker_id="test-router-worker",
            enable_periodic_scheduler=False,
        )

    def test_waterfall_priority_1_viral_urgent_overrides_luxury_price(self):
        listing = {
            "id": "uuid-urgent-lux",
            "bina_id": "99001",
            "price": 500_000,
            "is_urgent": True,
        }
        res = route_listing_to_channel(listing)
        self.assertEqual(res["channel_niche"], "TIKTOK")
        self.assertEqual(res["target_account_handle"], "@baku_emlak_ai")
        self.assertEqual(res["voice_engine"], "elevenlabs")
        self.assertEqual(res["voice_id"], "DZaip8UahF0Qri1FxU8M")
        self.assertEqual(res["voice_speed"], 1.15)
        self.assertEqual(res["music_track"], "viral_bass.mp3")

    def test_waterfall_priority_1_viral_price_drop_10_pct_overrides_price(self):
        # 10% drop threshold exact
        listing_10 = {
            "id": "uuid-drop-10",
            "bina_id": "99002",
            "price": 350_000,
            "price_drop_pct": 10.0,
        }
        res = route_listing_to_channel(listing_10)
        self.assertEqual(res["channel_niche"], "TIKTOK")
        self.assertEqual(res["target_account_handle"], "@baku_emlak_ai")
        self.assertEqual(res["voice_speed"], 1.15)

        # Via price_drop_info dict with drop >= 10%
        listing_info = {
            "id": "uuid-drop-info",
            "bina_id": "99003",
            "price": 280_000,
            "price_drop_info": {"drop_pct": 14.5},
        }
        res_info = route_listing_to_channel(listing_info)
        self.assertEqual(res_info["channel_niche"], "TIKTOK")
        self.assertEqual(res_info["target_account_handle"], "@baku_emlak_ai")

    def test_waterfall_priority_2_luxury_price_boundary(self):
        # price == 250_000 exact boundary
        res_250k = route_listing_to_channel({"price": 250_000})
        self.assertEqual(res_250k["channel_niche"], "LUXURY")
        self.assertEqual(res_250k["target_account_handle"], "@bakuestate.premium")
        self.assertEqual(res_250k["voice_engine"], "elevenlabs")
        self.assertEqual(res_250k["voice_id"], "ZQJv3hwvRAIC7fvWZ1Qr")
        self.assertEqual(res_250k["voice_speed"], 1.0)
        self.assertEqual(res_250k["music_track"], "ambient_lounge.mp3")

        # price > 250_000
        res_high = route_listing_to_channel({"price": 1_200_000})
        self.assertEqual(res_high["channel_niche"], "LUXURY")
        self.assertEqual(res_high["target_account_handle"], "@bakuestate.premium")

    def test_waterfall_priority_2_affordable_price_boundary(self):
        # price <= 120_000 or suburban location boundary
        res_149k = route_listing_to_channel({"price": 149_999, "location": "Xırdalan"})
        self.assertEqual(res_149k["channel_niche"], "AFFORDABLE")
        self.assertEqual(res_149k["target_account_handle"], "@baku.serfeli.evler")
        self.assertEqual(res_149k["voice_engine"], "elevenlabs")
        self.assertEqual(res_149k["voice_id"], "DZaip8UahF0Qri1FxU8M")
        self.assertEqual(res_149k["voice_speed"], 1.0)
        self.assertEqual(res_149k["music_track"], "upbeat_acoustic.mp3")

        res_low = route_listing_to_channel({"price": 75_000})
        self.assertEqual(res_low["channel_niche"], "AFFORDABLE")
        self.assertEqual(res_low["target_account_handle"], "@baku.serfeli.evler")

    def test_waterfall_priority_2_general_middle_band(self):
        # price == 150_000 lower boundary of general
        res_150k = route_listing_to_channel({"price": 150_000})
        self.assertEqual(res_150k["channel_niche"], "GENERAL")
        self.assertEqual(res_150k["target_account_handle"], "@bakuestate.official")
        self.assertEqual(res_150k["voice_engine"], "elevenlabs")
        self.assertEqual(res_150k["voice_id"], "ZQJv3hwvRAIC7fvWZ1Qr")
        self.assertEqual(res_150k["voice_speed"], 1.0)
        self.assertEqual(res_150k["music_track"], "modern_lofi.mp3")

        # price in between 150k and 250k
        res_mid = route_listing_to_channel({"price": 210_000})
        self.assertEqual(res_mid["channel_niche"], "GENERAL")
        self.assertEqual(res_mid["target_account_handle"], "@bakuestate.official")

    def test_tag_render_ab_attaches_routing_metadata_and_passes_to_publication(self):
        listing = {
            "id": "uuid-lux-1",
            "bina_id": "77001",
            "price": 320_000,
        }
        render_result = {
            "render_version_id": "rv-lux-1",
            "version_num": 1,
            "duration": 28.5,
        }
        params = {}

        self.worker._tag_render_ab_and_create_draft_publication(
            listing,
            render_result,
            params,
        )

        # Assert ab_metadata attached to render_version
        self.mock_repo.update_render_version.assert_called_once()
        rv_id, patch_data = self.mock_repo.update_render_version.call_args[0]
        self.assertEqual(rv_id, "rv-lux-1")
        ab_meta = patch_data["ab_metadata"]
        self.assertEqual(ab_meta["target_account_handle"], "@bakuestate.premium")
        self.assertEqual(ab_meta["channel_niche"], "LUXURY")
        self.assertEqual(ab_meta["voice_engine"], "elevenlabs")
        self.assertEqual(ab_meta["voice_id"], "ZQJv3hwvRAIC7fvWZ1Qr")
        self.assertEqual(ab_meta["music_track"], "ambient_lounge.mp3")

        # Assert target_account_handle and channel_niche passed to create_or_update_publication
        self.mock_repo.create_or_update_publication.assert_called_once()
        _, pub_kwargs = self.mock_repo.create_or_update_publication.call_args
        self.assertEqual(pub_kwargs["listing_id"], "uuid-lux-1")
        self.assertEqual(pub_kwargs["status"], "DRAFT_READY")
        self.assertEqual(pub_kwargs["target_account_handle"], "@bakuestate.premium")
        self.assertEqual(pub_kwargs["channel_niche"], "LUXURY")

    def test_render_initial_uses_routed_voice_engine_and_id(self):
        listing = {
            "id": "uuid-afford-1",
            "bina_id": "55001",
            "price": 95_000,
            "editorial_status": "PENDING_REVIEW",
            "source_availability": "ACTIVE",
            "owner_outreach_status": "NOT_CONTACTED",
        }
        self.mock_repo.get_listing_by_id.return_value = listing
        self.mock_repo.get_next_render_version_num.return_value = 1
        self.mock_repo.create_render_version.return_value = {"id": "rv-1", "version_num": 1}
        self.mock_pipeline.process_listing_video_and_dispatch.return_value = {
            "bina_id": "55001",
            "status": "OK",
            "render_version_id": "rv-1",
            "version_num": 1,
            "duration": 26.0,
        }

        job = {
            "id": "job-init-routed",
            "job_type": "RENDER_INITIAL",
            "trigger_source": "AUTO_SCHEDULER",
            "listing_id": "uuid-afford-1",
            "params_json": {},
        }

        outcome = self.worker.execute_job(job)
        self.assertEqual(outcome["status"], "SUCCEEDED")

        # Assert create_render_version received routed voice settings
        self.mock_repo.create_render_version.assert_called_once()
        _, rv_kwargs = self.mock_repo.create_render_version.call_args
        self.assertEqual(rv_kwargs["voice_engine"], "elevenlabs")
        self.assertEqual(rv_kwargs["voice_id"], "DZaip8UahF0Qri1FxU8M")

        # Assert process_listing_video_and_dispatch received routed voice settings
        _, p_kwargs = self.mock_pipeline.process_listing_video_and_dispatch.call_args
        self.assertEqual(p_kwargs["voice_engine"], "elevenlabs")
        self.assertEqual(p_kwargs["voice_id"], "DZaip8UahF0Qri1FxU8M")


if __name__ == "__main__":
    unittest.main()
