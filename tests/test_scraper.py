"""Unit tests for bina_scraper module."""

import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path
import json

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.scraper.bina_scraper import (
    clean_phone_number,
    is_direct_owner,
    BinaScraper
)

class TestBinaScraper(unittest.TestCase):
    def test_clean_phone_number(self):
        self.assertEqual(clean_phone_number("(050) 123-45-67"), "+994501234567")
        self.assertEqual(clean_phone_number("070 288 62 22"), "+994702886222")
        self.assertEqual(clean_phone_number("+994 55 999 88 77"), "+994559998877")
        self.assertEqual(clean_phone_number("511234567"), "+994511234567")
        self.assertEqual(clean_phone_number(None), "")
        self.assertEqual(clean_phone_number(""), "")

    def test_is_direct_owner(self):
        self.assertTrue(is_direct_owner("Mülkiyyətçi"))
        self.assertTrue(is_direct_owner("Ev sahibi"))
        self.assertTrue(is_direct_owner("sahibindən"))
        self.assertFalse(is_direct_owner("vasitəçi (agent)"))
        self.assertFalse(is_direct_owner("Daşınmaz əmlak şirkəti"))
        # Test description fallback
        self.assertTrue(is_direct_owner("", "Təcili satılır, sahibindən satılır, kupça var."))
        self.assertFalse(is_direct_owner("vasitəçi (agent)", "sahibindən satılır")) # Explicit agent overrides

    def test_build_listings_url(self):
        scraper = BinaScraper(city_id=1, category_id=1, has_bill_of_sale=True, min_price=100000, max_price=300000)
        url = scraper.build_listings_url(page=2)
        self.assertIn("city_id=1", url)
        self.assertIn("category_id=1", url)
        self.assertIn("has_bill_of_sale=true", url)
        self.assertIn("price_from=100000", url)
        self.assertIn("price_to=300000", url)
        self.assertIn("page=2", url)

    def test_parse_next_data(self):
        scraper = BinaScraper()
        mock_item_data = {
            "id": 999111,
            "rooms": 3,
            "area": 120.0,
            "floor": 5,
            "floors": 12,
            "hasBillOfSale": True,
            "contactTypeName": "mülkiyyətçi",
            "contactName": "Əli Həsənov",
            "description": "Əla təmirli kupçalı mənzil",
            "price": {"currency": "AZN", "total": 220000},
            "location": {"fullName": "Gənclik m."},
            "address": "Atatürk prospekti",
            "photos": [
                {"full": "https://bina.azstatic.com/uploads/full/img1.jpg", "thumbnail": "https://bina.azstatic.com/uploads/thumb/img1.jpg"},
                {"full": "https://bina.azstatic.com/uploads/full/img2.jpg"}
            ]
        }
        res = scraper._parse_next_data("999111", "https://bina.az/items/999111", mock_item_data)
        self.assertEqual(res["bina_id"], "999111")
        self.assertEqual(res["price"], 220000.0)
        self.assertEqual(res["currency"], "AZN")
        self.assertEqual(res["rooms"], 3)
        self.assertEqual(res["location"], "Gənclik m.")
        self.assertTrue(res["is_owner"])
        self.assertEqual(len(res["photo_urls"]), 2)
        self.assertEqual(res["photo_urls"][0], "https://bina.azstatic.com/uploads/full/img1.jpg")

    def test_parse_next_data_with_none_values(self):
        scraper = BinaScraper()
        mock_item_data = {
            "id": 123456,
            "rooms": {"value": None},
            "area": {"value": None},
            "floor": {"value": None},
            "floors": {"value": None},
            "price": {"currency": "AZN", "total": None, "value": None},
            "hasBillOfSale": False,
            "location": None,
            "photos": []
        }
        res = scraper._parse_next_data("123456", "https://bina.az/items/123456", mock_item_data)
        self.assertEqual(res["bina_id"], "123456")
        self.assertEqual(res["price"], 0.0)
        self.assertIsNone(res["rooms"])
        self.assertIsNone(res["area"])
        self.assertIsNone(res["floor"])
        self.assertIsNone(res["floors"])
        self.assertFalse(res["has_bill_of_sale"])

    @patch("requests.Session.get")
    def test_fetch_contact_phone(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"phones": ["(070) 288-62-22"]}
        mock_get.return_value = mock_resp

        scraper = BinaScraper()
        phone = scraper.fetch_contact_phone("6585624")
        self.assertEqual(phone, "+994702886222")

if __name__ == "__main__":
    unittest.main()
