"""
Unit tests for Sentry Telemetry and Crash Reporting.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest
from unittest.mock import patch, MagicMock

import config.settings as settings


class TestSentryTelemetry(unittest.TestCase):

    def test_sentry_init_with_dsn(self):
        with patch("sentry_sdk.init") as mock_init:
            settings._sentry_initialized = False
            result = settings.init_sentry()
            self.assertTrue(result)
            mock_init.assert_called_once()
            args, kwargs = mock_init.call_args
            self.assertIn("dsn", kwargs)
            self.assertEqual(kwargs["dsn"], settings.SENTRY_DSN)

    def test_sentry_init_when_already_initialized(self):
        settings._sentry_initialized = True
        result = settings.init_sentry()
        self.assertTrue(result)

    def test_sentry_init_empty_dsn(self):
        settings._sentry_initialized = False
        original_dsn = settings.SENTRY_DSN
        try:
            settings.SENTRY_DSN = ""
            result = settings.init_sentry()
            self.assertFalse(result)
        finally:
            settings.SENTRY_DSN = original_dsn

    @patch("sentry_sdk.capture_message")
    def test_pipeline_sentry_capture_message(self, mock_capture):
        from run_pipeline import BakuEstatePipeline
        pipeline = BakuEstatePipeline(mock_dispatch=True, enable_supabase=False, enable_notion=False)
        self.assertIsNotNone(pipeline)

    @patch("sentry_sdk.capture_exception")
    def test_pipeline_sentry_capture_exception_on_error(self, mock_capture_exc):
        from run_pipeline import BakuEstatePipeline
        pipeline = BakuEstatePipeline(mock_dispatch=True, enable_supabase=False, enable_notion=False)
        # Process listing that causes an error
        listing = {
            "bina_id": "err_123",
            "downloaded_photos": ["/tmp/fake.jpg"]
        }
        with patch("run_pipeline.generate_tts_for_listing", side_effect=RuntimeError("FFmpeg error")):
            res = pipeline.process_listing_video_and_dispatch(listing)
            self.assertEqual(res["status"], "FAILED")
            self.assertIn("FFmpeg error", res["error"])
            mock_capture_exc.assert_called_once()


if __name__ == "__main__":
    unittest.main()
