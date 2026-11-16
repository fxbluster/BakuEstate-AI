"""
Unit tests for Notion CRM Dispatcher and Database Sync.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest
from unittest.mock import patch, MagicMock

from src.dispatcher.notion_crm import NotionCRMDispatcher, normalize_location_for_notion


class TestNotionCRM(unittest.TestCase):

    def test_normalize_location_for_notion(self):
        self.assertEqual(normalize_location_for_notion("Nərimanov rayonu"), "Nərimanov")
        self.assertEqual(normalize_location_for_notion("Gənclik metrosu yanı"), "Nərimanov")
        self.assertEqual(normalize_location_for_notion("Yasamal m."), "Yasamal")
        self.assertEqual(normalize_location_for_notion("Nəsimi r., 28 May"), "Nəsimi")
        self.assertEqual(normalize_location_for_notion("28 May m."), "Nəsimi")
        self.assertEqual(normalize_location_for_notion("Xətai, Əhmədli"), "Xətai")
        self.assertEqual(normalize_location_for_notion("Əhmədli metrosu"), "Xətai")
        self.assertEqual(normalize_location_for_notion("Səbail, Badamdar"), "Səbail")
        self.assertEqual(normalize_location_for_notion("Badamdar qəsəbəsi"), "Səbail")
        self.assertEqual(normalize_location_for_notion("Binəqədi r."), "Binəqədi")
        self.assertEqual(normalize_location_for_notion("Nizami, Neftçilər"), "Nizami")
        self.assertEqual(normalize_location_for_notion("Mərdəkan qəs."), "Xəzər")
        self.assertEqual(normalize_location_for_notion("Qobustan"), "Digər")
        self.assertEqual(normalize_location_for_notion(""), "Digər")

    def test_build_deal_page_payload(self):
        dispatcher = NotionCRMDispatcher(
            data_source_id="41a7b510-0e72-8179-99a5-000bff2d8a14",
            enabled=True
        )

        listing = {
            "bina_id": "776655",
            "title": "2 otaqlı əla təmirli mənzil",
            "price": "135.000 AZN",
            "currency": "AZN",
            "location": "Gənclik m.",
            "rooms": "2 otaq",
            "area": "60.5 m²",
            "has_bill_of_sale": True,
            "is_owner": True,
            "owner_phone": "+994701112233"
        }

        payload = dispatcher.build_deal_page_payload(
            listing=listing,
            video_cdn_url="https://supabase.co/media/test.mp4",
            script_text="Test Ssenari",
            status="Video Ready"
        )

        props = payload["properties"]
        self.assertEqual(props["Property Title"], "2 otaqlı əla təmirli mənzil")
        self.assertEqual(props["Price (AZN)"], 135000.0)
        self.assertEqual(props["Area (m²)"], 60.5)
        self.assertEqual(props["Rooms"], 2)
        self.assertEqual(props["Location"], "Nərimanov")
        self.assertEqual(props["Direct Owner"], "__YES__")
        self.assertEqual(props["Has Kupça"], "__YES__")
        self.assertEqual(props["Status"], "Video Ready")
        self.assertEqual(props["Video CDN Link"], "https://supabase.co/media/test.mp4")
        self.assertIn("wa.me/994701112233", props["WhatsApp Link"])
        self.assertEqual(payload["parent"]["data_source_id"], "41a7b510-0e72-8179-99a5-000bff2d8a14")

    @patch("src.dispatcher.notion_crm.requests.post")
    def test_sync_deal_with_api_key(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"id": "page_uuid_123"}
        mock_post.return_value = mock_resp

        dispatcher = NotionCRMDispatcher(api_key="secret_test_notion_key", enabled=True)
        res = dispatcher.sync_deal({"bina_id": "123", "price": 100000})

        self.assertTrue(res["success"])
        self.assertEqual(res["notion_id"], "page_uuid_123")
        mock_post.assert_called_once()

    def test_sync_deal_mcp_ready_mode(self):
        dispatcher = NotionCRMDispatcher(api_key="", enabled=True)
        res = dispatcher.sync_deal({"bina_id": "123", "price": 100000})

        self.assertTrue(res["success"])
        self.assertEqual(res["mode"], "mcp_ready")
        self.assertIn("properties", res["payload"])


if __name__ == "__main__":
    unittest.main()
