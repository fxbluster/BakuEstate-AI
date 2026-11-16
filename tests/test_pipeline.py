"""Integration tests for end-to-end Baku Estate AI pipeline."""

import unittest
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from run_pipeline import BakuEstatePipeline
from src.database import get_listing_by_bina_id, get_connection
from src.media.ffmpeg_compositor import get_ffmpeg_executable

class TestPipelineEndToEnd(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.db_path = self.base_dir / "pipeline_test.sqlite"
        self.output_dir = self.base_dir / "output"
        self.downloads_dir = self.base_dir / "downloads"
        self.ffmpeg_exe = get_ffmpeg_executable()

        self.pipeline = BakuEstatePipeline(
            owner_only=False,
            mock_dispatch=True,
            db_path=self.db_path,
            enable_supabase=False,
            enable_notion=False
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_pipeline_execution_with_mock_listing(self):
        # 1. Create 2 test photos
        photo_dir = self.downloads_dir / "998877"
        photo_dir.mkdir(parents=True, exist_ok=True)
        img1 = photo_dir / "photo_01.jpg"
        img2 = photo_dir / "photo_02.jpg"

        for p, color in [(img1, "darkblue"), (img2, "darkgreen")]:
            subprocess.run([
                self.ffmpeg_exe, "-y",
                "-f", "lavfi", "-i", f"color=c={color}:s=800x600:d=1",
                "-vframes", "1", str(p)
            ], check=True, capture_output=True)

        sample_listing = {
            "bina_id": "998877",
            "url": "https://bina.az/items/998877",
            "title": "2 otaqlı kupçalı mənzil",
            "price": 145000,
            "currency": "AZN",
            "location": "Xətai m.",
            "rooms": 2,
            "area": 68,
            "has_bill_of_sale": True,
            "is_owner": True,
            "owner_phone": "+994509998877",
            "photo_urls": [],
            "downloaded_photos": [str(img1.resolve()), str(img2.resolve())],
            "status": "PHOTOS_READY"
        }

        # Mock the TTS synthesizer with a short fast audio synthesis to keep test rapid
        short_audio = self.base_dir / "voice_998877.mp3"
        short_srt = self.base_dir / "subs_998877.srt"

        subprocess.run([
            self.ffmpeg_exe, "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-c:a", "libmp3lame", str(short_audio)
        ], check=True, capture_output=True)

        short_srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nKUPÇALI MƏNZİL SATILIR!\n", encoding="utf-8")

        from src.database import save_listing
        save_listing(sample_listing, self.db_path)

        with patch("run_pipeline.generate_tts_for_listing") as mock_tts:
            mock_tts.return_value = (
                "Xətai rayonunda 2 otaqlı mənzil satılır",
                str(short_audio.resolve()),
                str(short_srt.resolve()),
                2.0
            )

            result = self.pipeline.process_listing_video_and_dispatch(sample_listing)

            self.assertEqual(result["bina_id"], "998877")
            self.assertTrue(Path(result["video_path"]).exists())
            self.assertGreater(Path(result["video_path"]).stat().st_size, 5000)

            # Check DB status
            final_record = get_listing_by_bina_id("998877", self.db_path)
            self.assertEqual(final_record["status"], "DISPATCHED")

            # Check generated_videos table
            conn = get_connection(self.db_path)
            vid_row = conn.execute("SELECT * FROM generated_videos WHERE listing_id = ?", (final_record["id"],)).fetchone()
            self.assertIsNotNone(vid_row)
            self.assertIn("mock_msg_", vid_row["telegram_message_id"])
            conn.close()

    def test_specific_id_prioritization_over_unprocessed_in_db(self):
        # Insert an unrelated older listing with status 'NEW'
        from src.database import save_listing
        save_listing({"bina_id": "older_listing", "price": 100000, "status": "NEW"}, self.db_path)

        # Mock run_ingestion to return specific listing
        with patch.object(self.pipeline, "run_ingestion") as mock_ingest:
            with patch.object(self.pipeline, "process_listing_video_and_dispatch") as mock_process:
                mock_ingest.return_value = [{"bina_id": "targeted_123"}]
                save_listing({"bina_id": "targeted_123", "price": 200000, "status": "PHOTOS_READY"}, self.db_path)
                mock_process.return_value = {"bina_id": "targeted_123", "status": "OK"}

                results = self.pipeline.run_full_pipeline(limit=1, specific_id="targeted_123")
                self.assertEqual(len(results), 1)
                self.assertEqual(results[0]["bina_id"], "targeted_123")
                mock_process.assert_called_once()
                # Verify targeted_123 was passed, NOT older_listing
                call_arg = mock_process.call_args[0][0]
                self.assertEqual(call_arg["bina_id"], "targeted_123")

if __name__ == "__main__":
    unittest.main()
