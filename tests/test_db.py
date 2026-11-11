"""Unit tests for SQLite database layer."""

import unittest
import tempfile
import os
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.database import (
    init_db,
    save_listing,
    get_listing_by_bina_id,
    update_listing_status,
    get_unprocessed_listings,
    record_generated_video,
    mark_video_dispatched,
    get_connection
)

class TestDatabase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_estate.sqlite"
        init_db(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_schema_init_and_accounts_seeded(self):
        conn = get_connection(self.db_path)
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        self.assertIn("listings", tables)
        self.assertIn("google_accounts", tables)
        self.assertIn("generated_videos", tables)

        accounts = conn.execute("SELECT profile_name FROM google_accounts").fetchall()
        self.assertEqual(len(accounts), 6)
        conn.close()

    def test_save_and_retrieve_listing(self):
        sample = {
            "bina_id": "777888",
            "url": "https://bina.az/items/777888",
            "title": "3 otaqlı yeni tikili",
            "price": 250000,
            "currency": "AZN",
            "location": "Nərimanov m.",
            "address": "Təbriz küçəsi",
            "rooms": 3,
            "area": 115.5,
            "floor": 8,
            "floors": 16,
            "has_bill_of_sale": True,
            "is_owner": True,
            "contact_type_name": "Mülkiyyətçi",
            "contact_name": "Rəşad",
            "owner_phone": "+994501234567",
            "photo_urls": ["https://bina.azstatic.com/uploads/full/photo1.jpg"],
            "downloaded_photos": [],
            "description": "Əla təmirli mənzil",
            "status": "NEW"
        }
        row_id = save_listing(sample, self.db_path)
        self.assertGreater(row_id, 0)

        retrieved = get_listing_by_bina_id("777888", self.db_path)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved["price"], 250000)
        self.assertEqual(retrieved["is_owner"], 1)
        self.assertEqual(retrieved["photo_urls"], ["https://bina.azstatic.com/uploads/full/photo1.jpg"])
        self.assertEqual(retrieved["owner_phone"], "+994501234567")

    def test_save_listing_with_none_and_invalid_values(self):
        sample = {
            "bina_id": "none_values_test",
            "price": {"total": None, "value": None},
            "rooms": {"value": None},
            "area": "not_a_number",
            "floor": None,
            "floors": "N/A",
            "has_bill_of_sale": False,
            "location": None
        }
        row_id = save_listing(sample, self.db_path)
        self.assertGreater(row_id, 0)
        retrieved = get_listing_by_bina_id("none_values_test", self.db_path)
        self.assertEqual(retrieved["price"], 0.0)
        self.assertIsNone(retrieved["rooms"])
        self.assertIsNone(retrieved["area"])
        self.assertIsNone(retrieved["floor"])
        self.assertIsNone(retrieved["floors"])
        self.assertEqual(retrieved["has_bill_of_sale"], 0)

    def test_update_status_and_video_recording(self):
        sample = {
            "bina_id": "12345",
            "price": 100000,
            "status": "NEW"
        }
        row_id = save_listing(sample, self.db_path)

        unprocessed = get_unprocessed_listings(limit=10, db_path=self.db_path)
        self.assertEqual(len(unprocessed), 1)

        update_listing_status("12345", "PHOTOS_READY", ["path/to/p1.jpg"], self.db_path)
        updated = get_listing_by_bina_id("12345", self.db_path)
        self.assertEqual(updated["status"], "PHOTOS_READY")
        self.assertEqual(updated["downloaded_photos"], ["path/to/p1.jpg"])

        vid_id = record_generated_video(
            listing_id=row_id,
            video_path="output/v_12345.mp4",
            audio_path="output/a_12345.mp3",
            srt_path="output/s_12345.srt",
            script_text="Gözəl mənzil",
            duration_seconds=15.4,
            db_path=self.db_path
        )
        self.assertGreater(vid_id, 0)
        
        post_vid = get_listing_by_bina_id("12345", self.db_path)
        self.assertEqual(post_vid["status"], "VIDEO_READY")

        mark_video_dispatched(row_id, telegram_message_id="msg_999", db_path=self.db_path)
        final_listing = get_listing_by_bina_id("12345", self.db_path)
        self.assertEqual(final_listing["status"], "DISPATCHED")

if __name__ == "__main__":
    unittest.main()
