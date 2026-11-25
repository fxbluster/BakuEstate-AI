"""Phase 2 TDD tests for Private Cloudflare R2 Storage, Dual-Path SupabaseRepo,
run_pipeline.py Pre-Render Studio guards / <= 18 MB 2-pass cap / cooperative cancel,
local_worker.py --no-scheduler / cancel / SIGTERM handling, BinaScraper proxy & max_photos=10,
and Railway worker container manifests.
"""

from __future__ import annotations

import inspect
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

REPO_ROOT = Path(__file__).resolve().parent.parent


class TestRequirementsAndContainerManifests(unittest.TestCase):
    def test_requirements_includes_boto3(self):
        req_text = (REPO_ROOT / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("boto3>=1.35.0", req_text)

    def test_dockerfile_worker_has_python_313_ffmpeg_fonts_and_no_scheduler(self):
        dockerfile = REPO_ROOT / "Dockerfile.worker"
        self.assertTrue(dockerfile.is_file(), "Dockerfile.worker must exist")
        content = dockerfile.read_text(encoding="utf-8")
        self.assertIn("python:3.13-slim", content)
        self.assertIn("ffmpeg", content)
        self.assertIn("fonts-dejavu-core", content)
        self.assertIn("fonts-noto-core", content)
        self.assertIn("--no-scheduler", content)
        self.assertIn("SIGTERM", content)

    def test_railway_toml_configures_replicas_restart_and_graceful_sigterm(self):
        railway_toml = REPO_ROOT / "railway.toml"
        self.assertTrue(railway_toml.is_file(), "railway.toml must exist")
        content = railway_toml.read_text(encoding="utf-8")
        self.assertIn("Dockerfile.worker", content)
        self.assertRegex(content, r"numReplicas\s*=\s*[2-9]")
        self.assertIn("restartPolicyType", content)
        self.assertIn("drainingSeconds", content)


class TestR2StorageClient(unittest.TestCase):
    def test_upload_video_delete_and_signed_url(self):
        from src.cloud.r2_storage import R2StorageClient, R2UploadResult

        mock_s3 = MagicMock()
        client = R2StorageClient(
            account_id="acc123",
            access_key_id="key123",
            secret_access_key="secret456",
            bucket="baku-estate-media",
            media_base_url="https://media.bakuestate.az",
            signing_secret="hmac-signing-secret-xyz",
            s3_client=mock_s3,
        )
        self.assertTrue(client.is_configured())

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            payload = b"mp4-binary-content-test" * 10
            tmp.write(payload)
            tmp_path = tmp.name

        try:
            res = client.upload_video(tmp_path, "videos/agency-1/listing-1/v1.mp4")
            self.assertIsInstance(res, R2UploadResult)
            self.assertEqual(res.object_path, "videos/agency-1/listing-1/v1.mp4")
            self.assertEqual(res.size_bytes, len(payload))
            self.assertEqual(
                res.cdn_url,
                "https://media.bakuestate.az/v/videos/agency-1/listing-1/v1.mp4",
            )
            # Never store 7-day S3 SigV4 pre-signed URLs in cdn_url
            self.assertNotIn("X-Amz-Signature", res.cdn_url)
            self.assertNotIn("r2.cloudflarestorage.com", res.cdn_url)

            mock_s3.put_object.assert_called_once()
            put_kwargs = mock_s3.put_object.call_args.kwargs
            self.assertEqual(put_kwargs["Bucket"], "baku-estate-media")
            self.assertEqual(put_kwargs["Key"], "videos/agency-1/listing-1/v1.mp4")
            self.assertEqual(put_kwargs["ContentType"], "video/mp4")

            # Signed short-lived Worker CDN URL
            signed_url = client.mint_signed_media_url(
                "videos/agency-1/listing-1/v1.mp4",
                ttl_seconds=900,
                now_ts=1_760_000_000,
            )
            self.assertTrue(
                signed_url.startswith(
                    "https://media.bakuestate.az/v/videos/agency-1/listing-1/v1.mp4?"
                )
            )
            self.assertIn("exp=1760000900", signed_url)
            self.assertIn("sig=", signed_url)
            self.assertTrue(
                client.verify_signed_media_url(
                    "videos/agency-1/listing-1/v1.mp4",
                    signed_url,
                    now_ts=1_760_000_100,
                )
            )
            self.assertFalse(
                client.verify_signed_media_url(
                    "videos/agency-1/listing-1/v1.mp4",
                    signed_url,
                    now_ts=1_760_001_000,
                )
            )

            # Delete object
            deleted = client.delete_object("videos/agency-1/listing-1/v1.mp4")
            self.assertTrue(deleted)
            mock_s3.delete_object.assert_called_once_with(
                Bucket="baku-estate-media",
                Key="videos/agency-1/listing-1/v1.mp4",
            )
        finally:
            Path(tmp_path).unlink(missing_ok=True)


class TestSupabaseRepoDualPathR2(unittest.TestCase):
    def test_upload_routes_to_r2_when_worker_mode_railway_or_r2_injected(self):
        from src.cloud.r2_storage import R2StorageClient
        from src.cloud.supabase_repo import SupabaseRepo

        mock_session = MagicMock()
        mock_s3 = MagicMock()
        r2_client = R2StorageClient(
            account_id="acc1",
            access_key_id="ak",
            secret_access_key="sk",
            bucket="baku-estate-media",
            media_base_url="https://media.bakuestate.az",
            s3_client=mock_s3,
        )
        repo = SupabaseRepo(
            supabase_url="https://v2.supabase.co",
            supabase_key="service-role-secret",
            enabled=True,
            session=mock_session,
            r2_storage=r2_client,
            worker_mode="railway",
        )

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp.write(b"fake-r2-mp4-data")
            tmp_path = tmp.name

        try:
            obj_path, cdn_url = repo.upload_versioned_video(
                tmp_path,
                "6588858",
                2,
                agency_id="11111111-1111-1111-1111-111111111111",
                listing_id="22222222-2222-2222-2222-222222222222",
            )
            self.assertEqual(
                obj_path,
                "videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v2.mp4",
            )
            self.assertEqual(
                cdn_url,
                "https://media.bakuestate.az/v/videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v2.mp4",
            )
            self.assertEqual(repo.last_upload_storage_provider, "r2")
            mock_s3.put_object.assert_called_once()
            # Must NOT POST to legacy Supabase Storage
            mock_session.post.assert_not_called()

            # Delete routes to R2 when provider='r2'
            self.assertTrue(repo.delete_storage_object(obj_path, storage_provider="r2"))
            mock_s3.delete_object.assert_called_once_with(
                Bucket="baku-estate-media",
                Key=obj_path,
            )
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def test_create_render_version_persists_storage_provider_and_get_agency_settings(self):
        from src.cloud.supabase_repo import SupabaseRepo

        mock_session = MagicMock()
        resp_post = MagicMock()
        resp_post.status_code = 201
        resp_post.json.return_value = [{"id": "rv-1", "storage_provider": "r2"}]
        mock_session.post.return_value = resp_post

        resp_get = MagicMock()
        resp_get.status_code = 200
        resp_get.json.return_value = [
            {
                "agency_id": "11111111-1111-1111-1111-111111111111",
                "public_phone": "+994501112233",
                "watermark_preset_json": {"label": "BakuEstate"},
            }
        ]
        mock_session.get.return_value = resp_get

        repo = SupabaseRepo(
            supabase_url="https://v2.supabase.co",
            supabase_key="service-role-secret",
            enabled=True,
            session=mock_session,
        )
        rv = repo.create_render_version(
            listing_id="22222222-2222-2222-2222-222222222222",
            version_num=1,
            storage_provider="r2",
        )
        self.assertIsNotNone(rv)
        sent = mock_session.post.call_args.kwargs["json"]
        self.assertEqual(sent["storage_provider"], "r2")

        settings_row = repo.get_agency_settings("11111111-1111-1111-1111-111111111111")
        self.assertIsNotNone(settings_row)
        self.assertEqual(settings_row["public_phone"], "+994501112233")


class TestPipelineStudioGuardsSizeCapAndCancel(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.db_path = self.base_dir / "test.sqlite"
        self.mock_repo = MagicMock()
        self.mock_repo.is_configured.return_value = True
        self.mock_repo.get_listing_by_bina_id.return_value = {
            "id": "22222222-2222-2222-2222-222222222222",
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "bina_id": "6588858",
            "content_revision": 1,
            "photo_urls": [
                "https://bina.azstatic.com/uploads/full/p1.jpg",
                "https://bina.azstatic.com/uploads/full/p2.jpg",
                "https://bina.azstatic.com/uploads/full/p3.jpg",
                "https://bina.azstatic.com/uploads/full/p4.jpg",
            ],
        }
        self.mock_repo.get_listing_by_id.return_value = self.mock_repo.get_listing_by_bina_id.return_value
        self.mock_repo.get_next_render_version_num.return_value = 1
        self.mock_repo.create_render_version.return_value = {"id": "rv-uuid-1", "version_num": 1}
        self.mock_repo.upload_versioned_video.return_value = (
            "videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v1.mp4",
            "https://media.bakuestate.az/v/videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v1.mp4",
        )
        self.mock_repo.last_upload_storage_provider = "r2"
        self.mock_repo.delete_storage_object.return_value = True

        from run_pipeline import BakuEstatePipeline

        self.pipeline = BakuEstatePipeline(
            owner_only=False,
            mock_dispatch=True,
            db_path=self.db_path,
            enable_supabase=True,
            enable_notion=False,
            use_cloud_backend=True,
            supabase_repo=self.mock_repo,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_ssrf_photo_urls_and_custom_script_over_1000_rejected(self):
        from run_pipeline import validate_custom_script_text, validate_selected_photo_urls

        listing = {
            "id": "22222222-2222-2222-2222-222222222222",
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "bina_id": "6588858",
            "photo_urls": [
                "https://bina.azstatic.com/uploads/full/p1.jpg",
                "https://bina.azstatic.com/uploads/full/p2.jpg",
                "https://bina.azstatic.com/uploads/full/p3.jpg",
                "https://bina.azstatic.com/uploads/full/p4.jpg",
            ],
        }

        # Internal metadata IP SSRF must raise ValueError
        with self.assertRaises(ValueError):
            validate_selected_photo_urls(
                [
                    "http://169.254.169.254/latest/meta-data/",
                    "https://bina.azstatic.com/uploads/full/p2.jpg",
                    "https://bina.azstatic.com/uploads/full/p3.jpg",
                    "https://bina.azstatic.com/uploads/full/p4.jpg",
                ],
                listing,
            )

        # Unlisted external domain must raise ValueError
        with self.assertRaises(ValueError):
            validate_selected_photo_urls(
                [
                    "https://evil.example.com/p1.jpg",
                    "https://bina.azstatic.com/uploads/full/p2.jpg",
                    "https://bina.azstatic.com/uploads/full/p3.jpg",
                    "https://bina.azstatic.com/uploads/full/p4.jpg",
                ],
                listing,
            )

        # Fewer than 4 photos must raise ValueError
        with self.assertRaises(ValueError):
            validate_selected_photo_urls(listing["photo_urls"][:3], listing)

        # More than 10 photos must raise ValueError
        with self.assertRaises(ValueError):
            validate_selected_photo_urls(
                [f"https://media.bakuestate.az/staging/{listing['agency_id']}/p{i}.jpg" for i in range(11)],
                listing,
            )

        # Valid 4 photos including agency R2 staging URL passes
        valid_urls = [
            "https://bina.azstatic.com/uploads/full/p1.jpg",
            "https://bina.azstatic.com/uploads/full/p2.jpg",
            "https://bina.azstatic.com/uploads/full/p3.jpg",
            f"https://media.bakuestate.az/staging/{listing['agency_id']}/custom.jpg",
        ]
        self.assertEqual(validate_selected_photo_urls(valid_urls, listing), valid_urls)

        # Script > 1000 chars rejected
        with self.assertRaises(ValueError):
            validate_custom_script_text("A" * 1001)
        self.assertEqual(validate_custom_script_text("  Salam Bakı  "), "Salam Bakı")

        # Pipeline entrypoint rejects SSRF directly with ValueError
        with self.assertRaises(ValueError):
            self.pipeline.process_listing_video_and_dispatch(
                listing,
                selected_photo_urls=[
                    "http://169.254.169.254/latest/meta-data/",
                    "https://bina.azstatic.com/uploads/full/p2.jpg",
                    "https://bina.azstatic.com/uploads/full/p3.jpg",
                    "https://bina.azstatic.com/uploads/full/p4.jpg",
                ],
            )

        # Pipeline entrypoint rejects >1000 char custom script with ValueError
        with self.assertRaises(ValueError):
            self.pipeline.process_listing_video_and_dispatch(
                listing,
                custom_script_text="X" * 1001,
            )

    def test_two_pass_18mb_cap_calculation_and_invocation(self):
        from run_pipeline import (
            MAX_TELEGRAM_VIDEO_BYTES,
            calculate_two_pass_video_bitrate_kbps,
            enforce_video_size_cap,
        )

        self.assertEqual(MAX_TELEGRAM_VIDEO_BYTES, 18 * 1024 * 1024)
        kbps = calculate_two_pass_video_bitrate_kbps(duration_seconds=45.0, max_bytes=MAX_TELEGRAM_VIDEO_BYTES)
        self.assertGreaterEqual(kbps, 350)
        self.assertLessEqual(kbps, 3300)

        oversized = self.base_dir / "oversized.mp4"
        oversized.write_bytes(b"\x00" * 2048)

        commands_run = []

        def fake_run_ffmpeg(cmd, **_kwargs):
            commands_run.append(cmd)
            if "-pass" in cmd and cmd[cmd.index("-pass") + 1] == "2":
                Path(cmd[-1]).write_bytes(b"compressed-mp4")
            return 0

        with patch("run_pipeline._run_tracked_ffmpeg", side_effect=fake_run_ffmpeg):
            result_path = enforce_video_size_cap(
                oversized,
                duration_seconds=45.0,
                max_bytes=1024,  # force 2-pass transcode on 2048-byte test file
                temp_dir=self.base_dir / "cap_tmp",
                ffmpeg_exe="ffmpeg",
            )

        self.assertEqual(result_path, oversized)
        self.assertEqual(len(commands_run), 2)
        self.assertIn("-pass", commands_run[0])
        self.assertEqual(commands_run[0][commands_run[0].index("-pass") + 1], "1")
        self.assertIn("-pass", commands_run[1])
        self.assertEqual(commands_run[1][commands_run[1].index("-pass") + 1], "2")
        self.assertLessEqual(oversized.stat().st_size, 1024)

    def test_cooperative_cancel_mid_tts_skips_ffmpeg_and_cleans_temp_dir(self):
        created_temp_dirs = []
        orig_mkdtemp = tempfile.mkdtemp

        def tracking_mkdtemp(*args, **kwargs):
            d = orig_mkdtemp(*args, **kwargs)
            created_temp_dirs.append(Path(d))
            return d

        photo = self.base_dir / "photo_01.jpg"
        photo.write_bytes(b"jpgdata" * 300)
        audio = self.base_dir / "voice.mp3"
        audio.write_bytes(b"mp3data")
        srt = self.base_dir / "subs.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nSalam\n", encoding="utf-8")

        listing = {
            "id": "22222222-2222-2222-2222-222222222222",
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "bina_id": "6588858",
            "price": 175000,
            "currency": "AZN",
            "downloaded_photos": [str(photo)],
        }

        cancel_calls = {"n": 0}

        def cancel_after_tts():
            cancel_calls["n"] += 1
            # Allow phases up to TTS (calls 1..3), then cancel right before FFmpeg (call 4+)
            return cancel_calls["n"] >= 4

        with patch("run_pipeline.tempfile.mkdtemp", side_effect=tracking_mkdtemp), patch(
            "run_pipeline.OUTPUT_DIR", self.base_dir
        ), patch(
            "run_pipeline.generate_tts_for_listing",
            return_value=("Custom studio script", str(audio), str(srt), 10.0),
        ) as mock_tts, patch.object(
            self.pipeline.compositor, "build_cinematic_video"
        ) as mock_compose:
            res = self.pipeline.process_listing_video_and_dispatch(
                listing,
                custom_script_text="Custom studio script",
                agency_settings={"public_phone": "+994501112233", "watermark_preset_json": {"brand": "Test"}},
                cancel_check_cb=cancel_after_tts,
                skip_telegram_dispatch=True,
            )

        self.assertEqual(res["status"], "CANCELLED")
        self.assertTrue(res.get("cancelled"))
        mock_tts.assert_called_once()
        self.assertEqual(mock_tts.call_args.kwargs["custom_script"], "Custom studio script")
        mock_compose.assert_not_called()
        self.mock_repo.upload_versioned_video.assert_not_called()
        self.assertTrue(created_temp_dirs, "Expected a per-job temp dir to be created")
        for d in created_temp_dirs:
            self.assertFalse(d.exists(), f"Temp directory was not cleaned up: {d}")

    def test_cooperative_cancel_after_r2_upload_deletes_partial_r2_object(self):
        photo = self.base_dir / "photo_01.jpg"
        photo.write_bytes(b"jpgdata" * 300)
        audio = self.base_dir / "voice.mp3"
        audio.write_bytes(b"mp3data")
        srt = self.base_dir / "subs.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nSalam\n", encoding="utf-8")

        listing = {
            "id": "22222222-2222-2222-2222-222222222222",
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "bina_id": "6588858",
            "price": 175000,
            "currency": "AZN",
            "downloaded_photos": [str(photo)],
        }

        uploaded = {"done": False}

        def fake_upload(*args, **kwargs):
            uploaded["done"] = True
            return (
                "videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v1.mp4",
                "https://media.bakuestate.az/v/videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v1.mp4",
            )

        self.mock_repo.upload_versioned_video.side_effect = fake_upload

        def fake_compose(*, output_video_path, **_kw):
            Path(output_video_path).write_bytes(b"fake-mp4" * 200)
            return output_video_path

        with patch("run_pipeline.OUTPUT_DIR", self.base_dir), patch(
            "run_pipeline.generate_tts_for_listing",
            return_value=("Script", str(audio), str(srt), 10.0),
        ), patch.object(
            self.pipeline.compositor, "build_cinematic_video", side_effect=fake_compose
        ), patch.object(
            self.pipeline.dispatcher, "send_video_lead"
        ) as mock_tg:
            res = self.pipeline.process_listing_video_and_dispatch(
                listing,
                cancel_check_cb=lambda: uploaded["done"],
            )

        self.assertEqual(res["status"], "CANCELLED")
        self.assertTrue(res.get("cleaned_storage_object"))
        self.mock_repo.delete_storage_object.assert_called_once_with(
            "videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v1.mp4",
            storage_provider="r2",
        )
        mock_tg.assert_not_called()


class TestLocalWorkerCancelAndSigterm(unittest.TestCase):
    def test_no_scheduler_cli_disables_periodic_scheduler(self):
        from src.worker.local_worker import BakuLocalWorker

        mock_repo = MagicMock()
        mock_repo.is_configured.return_value = True
        worker = BakuLocalWorker(
            repo=mock_repo,
            pipeline=MagicMock(),
            enable_periodic_scheduler=False,
        )
        self.assertEqual(worker.maybe_enqueue_scheduled_jobs(), [])
        mock_repo.enqueue_pipeline_job.assert_not_called()

    def test_worker_passes_studio_params_and_cleans_r2_on_cancel(self):
        from src.worker.local_worker import BakuLocalWorker

        mock_repo = MagicMock()
        mock_repo.is_configured.return_value = True
        mock_repo.count_today_auto_renders_baku.return_value = 0
        mock_repo.complete_pipeline_job.return_value = True
        mock_repo.get_next_render_version_num.return_value = 1
        mock_repo.create_render_version.return_value = {"id": "rv-1", "version_num": 1}
        mock_repo.get_agency_settings.return_value = {
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "public_phone": "+994501112233",
        }
        mock_repo.get_listing_by_id.return_value = {
            "id": "22222222-2222-2222-2222-222222222222",
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "bina_id": "6588858",
            "price": 180000,
        }
        # First check (before execution) False, then True during/after execution
        mock_repo.is_job_cancel_requested.side_effect = [False, True, True]
        mock_repo.delete_storage_object.return_value = True

        mock_pipeline = MagicMock()
        mock_pipeline.process_listing_video_and_dispatch.return_value = {
            "bina_id": "6588858",
            "status": "CANCELLED",
            "cancelled": True,
            "storage_object_path": "videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v1.mp4",
            "storage_provider": "r2",
            "cleaned_storage_object": False,
        }

        worker = BakuLocalWorker(
            repo=mock_repo,
            pipeline=mock_pipeline,
            worker_id="railway-worker-1",
            enable_periodic_scheduler=False,
        )
        job = {
            "id": "job-cancel-render",
            "job_type": "RENDER_INITIAL",
            "trigger_source": "WEB_UI",
            "listing_id": "22222222-2222-2222-2222-222222222222",
            "params_json": {
                "selected_photo_urls": [
                    "https://bina.azstatic.com/uploads/full/1.jpg",
                    "https://bina.azstatic.com/uploads/full/2.jpg",
                    "https://bina.azstatic.com/uploads/full/3.jpg",
                    "https://bina.azstatic.com/uploads/full/4.jpg",
                ],
                "custom_script_text": "Salam əziz izləyicilər",
            },
        }
        outcome = worker.execute_job(job)

        self.assertEqual(outcome["status"], "CANCELLED")
        _, p_kwargs = mock_pipeline.process_listing_video_and_dispatch.call_args
        self.assertEqual(len(p_kwargs["selected_photo_urls"]), 4)
        self.assertEqual(p_kwargs["custom_script_text"], "Salam əziz izləyicilər")
        self.assertEqual(p_kwargs["agency_settings"]["public_phone"], "+994501112233")
        self.assertTrue(callable(p_kwargs["cancel_check_cb"]))
        mock_repo.delete_storage_object.assert_called_once_with(
            "videos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/v1.mp4",
            storage_provider="r2",
        )
        mock_repo.complete_pipeline_job.assert_called_once()
        self.assertEqual(mock_repo.complete_pipeline_job.call_args.kwargs["status"], "CANCELLED")

    def test_sigterm_handler_interrupts_ffmpeg_and_requeues_job(self):
        from run_pipeline import WorkerShutdownError, register_active_ffmpeg_process, unregister_active_ffmpeg_process
        from src.worker.local_worker import BakuLocalWorker

        mock_repo = MagicMock()
        mock_repo.is_configured.return_value = True
        mock_repo.is_job_cancel_requested.return_value = False
        mock_repo.complete_pipeline_job.return_value = True
        mock_repo.get_listing_by_id.return_value = {"id": "lst-1", "bina_id": "6588858", "price": 150000}

        fake_proc = MagicMock()
        fake_proc.poll.return_value = None

        mock_pipeline = MagicMock()

        def interrupted_render(*_a, **_kw):
            register_active_ffmpeg_process(fake_proc)
            try:
                worker.handle_sigterm()
                raise WorkerShutdownError("FFmpeg interrupted by SIGTERM")
            finally:
                unregister_active_ffmpeg_process(fake_proc)

        mock_pipeline.process_listing_video_and_dispatch.side_effect = interrupted_render

        worker = BakuLocalWorker(
            repo=mock_repo,
            pipeline=mock_pipeline,
            worker_id="railway-worker-2",
            enable_periodic_scheduler=False,
        )
        outcome = worker.execute_job(
            {
                "id": "job-sigterm-1",
                "job_type": "RERENDER",
                "trigger_source": "WEB_UI",
                "listing_id": "lst-1",
                "params_json": {},
            }
        )

        fake_proc.terminate.assert_called_once()
        self.assertEqual(outcome["status"], "QUEUED")
        mock_repo.complete_pipeline_job.assert_called_once()
        self.assertEqual(mock_repo.complete_pipeline_job.call_args.kwargs["status"], "QUEUED")


class TestBinaScraperProxyAndMaxPhotos(unittest.TestCase):
    def test_bina_proxy_url_configures_session_proxies(self):
        from src.scraper.bina_scraper import BinaScraper

        proxy = "http://user:pass@isp.webshare.io:8080"
        with patch.dict(os.environ, {"BINA_PROXY_URL": proxy}):
            scraper = BinaScraper()
        self.assertEqual(scraper.session.proxies.get("http"), proxy)
        self.assertEqual(scraper.session.proxies.get("https"), proxy)

    def test_download_full_hd_photos_defaults_to_max_photos_10(self):
        from src.scraper.bina_scraper import BinaScraper

        sig = inspect.signature(BinaScraper.download_full_hd_photos)
        self.assertEqual(sig.parameters["max_photos"].default, 10)

        mock_session = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = b"x" * 2048
        mock_session.get.return_value = mock_resp

        scraper = BinaScraper(session=mock_session)
        urls = [f"https://bina.azstatic.com/uploads/full/p{i}.jpg" for i in range(12)]
        with tempfile.TemporaryDirectory() as tmpdir, patch(
            "src.scraper.bina_scraper.DOWNLOADS_DIR", Path(tmpdir)
        ), patch("src.scraper.bina_scraper.time.sleep"):
            paths = scraper.download_full_hd_photos("6588858", urls)

        self.assertEqual(len(paths), 10)
        self.assertEqual(mock_session.get.call_count, 10)


if __name__ == "__main__":
    unittest.main()
