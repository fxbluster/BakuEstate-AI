"""Unit tests for telegram_crm dispatcher module."""

import unittest
from unittest.mock import patch, MagicMock
import tempfile
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.dispatcher.telegram_crm import (
    generate_social_caption,
    TelegramCRMDispatcher
)

class TestTelegramCRM(unittest.TestCase):
    def setUp(self):
        self.sample_listing = {
            "bina_id": "888999",
            "price": 275000,
            "currency": "AZN",
            "location": "Gənclik m.",
            "rooms": 3,
            "area": 110,
            "has_bill_of_sale": True,
            "is_owner": True,
            "owner_phone": "+994501234567"
        }

    def test_generate_social_caption(self):
        caption = generate_social_caption(self.sample_listing)
        self.assertIn("275 000 AZN", caption)
        self.assertIn("Gənclik m.", caption)
        self.assertIn("3 otaq", caption)
        self.assertIn("wa.me/994501234567", caption)
        self.assertIn("#baku", caption)
        self.assertIn("Trending Track", caption)

    def test_generate_social_caption_with_local_phone(self):
        listing = dict(self.sample_listing)
        listing["owner_phone"] = "(070) 288-62-22"
        caption = generate_social_caption(listing)
        self.assertIn("wa.me/994702886222", caption)
        self.assertNotIn("wa.me/070", caption)

    def test_mock_dispatch(self):
        temp_dir = Path(tempfile.mkdtemp())
        dummy_video = temp_dir / "lead.mp4"
        dummy_video.write_bytes(b"dummy video data")

        dispatcher = TelegramCRMDispatcher(mock_mode=True)
        res = dispatcher.send_video_lead(self.sample_listing, str(dummy_video))
        self.assertEqual(res["status"], "MOCK_SUCCESS")
        self.assertIn("mock_msg_", res["message_id"])
        self.assertTrue(Path(res["lead_dump"]).exists())

    @patch("requests.post")
    def test_live_api_dispatch_mocked_http(self, mock_post):
        temp_dir = Path(tempfile.mkdtemp())
        dummy_video = temp_dir / "lead.mp4"
        dummy_video.write_bytes(b"dummy video data")

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"ok": True, "result": {"message_id": 123456}}
        mock_post.return_value = mock_resp

        dispatcher = TelegramCRMDispatcher(bot_token="fake_token", chat_id="12345", mock_mode=False)
        res = dispatcher.send_video_lead(self.sample_listing, str(dummy_video))
        self.assertEqual(res["status"], "DISPATCHED")
        self.assertEqual(res["message_id"], "123456")

if __name__ == "__main__":
    unittest.main()
