"""
Unit tests for Supabase Cloud Database & Storage Synchronization Service.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest
import tempfile
from unittest.mock import patch, MagicMock

from src.dispatcher.supabase_sync import SupabaseSync


class TestSupabaseSync(unittest.TestCase):

    def setUp(self):
        self.sync = SupabaseSync(
            supabase_url="https://testproject.supabase.co",
            supabase_key="test_dummy_key",
            bucket_name="baku-estate-media",
            enabled=True
        )

    def test_configuration(self):
        self.assertTrue(self.sync.is_configured())

        disabled_sync = SupabaseSync(enabled=False)
        self.assertFalse(disabled_sync.is_configured())

        empty_key_sync = SupabaseSync(supabase_url="https://test.supabase.co", supabase_key="", enabled=True)
        self.assertFalse(empty_key_sync.is_configured())

    @patch("src.dispatcher.supabase_sync.requests.post")
    def test_upload_video_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"Key": "baku-estate-media/video_123.mp4"}
        mock_post.return_value = mock_resp

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(b"mock video data")
            temp_path = f.name

        try:
            cdn_url = self.sync.upload_video(temp_path, "video_123.mp4")
            self.assertEqual(cdn_url, "https://testproject.supabase.co/storage/v1/object/public/baku-estate-media/video_123.mp4")
            mock_post.assert_called_once()
        finally:
            Path(temp_path).unlink(missing_ok=True)

    def test_upload_video_missing_file(self):
        cdn_url = self.sync.upload_video("non_existent_file.mp4")
        self.assertIsNone(cdn_url)

    def test_upload_video_when_disabled(self):
        sync = SupabaseSync(enabled=False)
        cdn_url = sync.upload_video("some_file.mp4")
        self.assertIsNone(cdn_url)

    @patch("src.dispatcher.supabase_sync.requests.post")
    def test_sync_deal_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = [{"id": 1, "bina_id": "887766"}]
        mock_post.return_value = mock_resp

        listing = {
            "bina_id": "887766",
            "title": "3 otaqlı mənzil Nərimanovda",
            "price": "180.000 AZN",
            "currency": "AZN",
            "location": "Nərimanov",
            "rooms": "3",
            "area": "110.5 m²",
            "floor": 5,
            "floors": 16,
            "has_bill_of_sale": True,
            "is_owner": True,
            "owner_phone": "+994 50 123 45 67"
        }

        res = self.sync.sync_deal(
            listing=listing,
            video_cdn_url="https://testproject.supabase.co/storage/v1/object/public/baku-estate-media/video_887766.mp4",
            video_duration=28.5,
            script_text="Gözəl mənzil",
            status="DISPATCHED"
        )

        self.assertTrue(res["success"])
        self.assertEqual(res["bina_id"], "887766")
        mock_post.assert_called_once()

        # Check call arguments
        args, kwargs = mock_post.call_args
        self.assertIn("rest/v1/baku_estate_deals", args[0])
        self.assertIn("Prefer", kwargs["headers"])
        sent_payload = kwargs["json"][0]
        self.assertEqual(sent_payload["price"], 180000.0)
        self.assertEqual(sent_payload["area"], 110.5)
        self.assertEqual(sent_payload["rooms"], 3)
        self.assertIn("wa.me/994501234567", sent_payload["whatsapp_url"])

    def test_sync_deal_missing_bina_id(self):
        res = self.sync.sync_deal({})
        self.assertFalse(res["success"])
        self.assertEqual(res["reason"], "missing_bina_id")

    def test_sync_deal_disabled(self):
        sync = SupabaseSync(enabled=False)
        res = sync.sync_deal({"bina_id": "123"})
        self.assertFalse(res["success"])
        self.assertEqual(res["reason"], "disabled")


if __name__ == "__main__":
    unittest.main()
