# -*- coding: utf-8 -*-
"""
Unit tests for TELEGRAM_DISPATCH worker handling.
Path: tests/test_telegram_dispatch_worker.py
"""

import os
import unittest
from unittest.mock import MagicMock, patch
from pathlib import Path
import tempfile

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.worker.local_worker import BakuLocalWorker, ALL_JOB_TYPES
from src.dispatcher.telegram_crm import TelegramCRMDispatcher


class TestTelegramDispatchWorker(unittest.TestCase):
    def setUp(self):
        self.mock_repo = MagicMock()
        self.mock_repo.is_configured.return_value = True
        self.mock_pipeline = MagicMock()
        self.worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            worker_id="test-telegram-worker",
        )

    def test_job_types_includes_telegram_dispatch(self):
        """Verifies TELEGRAM_DISPATCH is part of ALL_JOB_TYPES"""
        self.assertIn("TELEGRAM_DISPATCH", ALL_JOB_TYPES)

    @patch("src.worker.local_worker.TelegramCRMDispatcher")
    def test_handle_telegram_dispatch_invokes_send_video_lead(self, MockDispatcher):
        """Verifies _handle_telegram_dispatch calls send_video_lead with force_multipart=True"""
        mock_instance = MockDispatcher.return_value
        mock_instance.send_video_lead.return_value = {
            "status": "DISPATCHED",
            "message_id": "tg_msg_999",
            "public_message_id": "tg_pub_1000",
        }

        sample_listing = {
            "id": "list-uuid-123",
            "bina_id": "777888",
            "price": 350000,
            "currency": "AZN",
            "owner_phone": "+994501234567",
        }
        self.mock_repo.get_listing_by_id.return_value = sample_listing

        job = {
            "id": "job-tg-1",
            "job_type": "TELEGRAM_DISPATCH",
            "listing_id": "list-uuid-123",
            "params_json": {
                "listing_id": "list-uuid-123",
                "target_account": "@bakuestate.premium",
                "custom_caption": "Exclusive Penthouse",
            },
        }

        res = self.worker._handle_telegram_dispatch(job)

        self.assertEqual(res["job_type"], "TELEGRAM_DISPATCH")
        self.assertEqual(res["listing_id"], "list-uuid-123")
        self.assertEqual(res["message_id"], "tg_msg_999")
        self.assertEqual(res["status"], "DISPATCHED")

        mock_instance.send_video_lead.assert_called_once()
        _, kwargs = mock_instance.send_video_lead.call_args
        self.assertTrue(kwargs.get("force_multipart"))
        self.assertEqual(kwargs.get("custom_caption"), "Exclusive Penthouse")
        self.assertEqual(kwargs.get("target_account_handle"), "@bakuestate.premium")

        # Verify listing audit event was logged
        self.mock_repo.insert_listing_event.assert_called_once()
        call_kwargs = self.mock_repo.insert_listing_event.call_args[1]
        self.assertEqual(call_kwargs["listing_id"], "list-uuid-123")
        self.assertEqual(call_kwargs["event_type"], "STATUS_CHANGED")
        self.assertEqual(call_kwargs["actor"], "local_worker")

    @patch("src.worker.local_worker.TelegramCRMDispatcher")
    def test_execute_job_completes_telegram_dispatch(self, MockDispatcher):
        """Verifies execute_job runs _handle_telegram_dispatch and marks SUCCEEDED"""
        mock_instance = MockDispatcher.return_value
        mock_instance.send_video_lead.return_value = {
            "status": "DISPATCHED",
            "message_id": "tg_msg_101",
        }

        sample_listing = {
            "id": "list-uuid-456",
            "bina_id": "999000",
            "price": 200000,
            "currency": "AZN",
        }
        self.mock_repo.get_listing_by_id.return_value = sample_listing

        job = {
            "id": "job-tg-2",
            "job_type": "TELEGRAM_DISPATCH",
            "listing_id": "list-uuid-456",
            "params_json": {"listing_id": "list-uuid-456"},
        }

        result = self.worker.execute_job(job)

        self.assertEqual(result["status"], "SUCCEEDED")
        self.mock_repo.complete_pipeline_job.assert_called_with(
            "job-tg-2",
            status="SUCCEEDED",
            worker_id="test-telegram-worker",
        )


if __name__ == "__main__":
    unittest.main()
