"""Unit tests for ffmpeg_compositor module."""

import unittest
import tempfile
import subprocess
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.media.ffmpeg_compositor import (
    get_ffmpeg_executable,
    escape_ffmpeg_path,
    sanitize_text,
    VideoCompositor
)

class TestVideoCompositor(unittest.TestCase):
    def setUp(self):
        self.compositor = VideoCompositor()

    def test_ffmpeg_available(self):
        exe = get_ffmpeg_executable()
        self.assertTrue(Path(exe).exists())

    def test_escape_ffmpeg_path(self):
        p = Path("C:/Users/Test/file.srt")
        escaped = escape_ffmpeg_path(p)
        self.assertIn("C\\:", escaped)

    def test_sanitize_text(self):
        raw = "Qiymət: 150'000 AZN / 100% kupçalı"
        clean = sanitize_text(raw)
        self.assertNotIn("'", clean)
        self.assertNotIn(":", clean)

    def test_build_video_end_to_end(self):
        temp_dir = Path(tempfile.mkdtemp())
        try:
            # Create two test images
            img1 = temp_dir / "img1.png"
            img2 = temp_dir / "img2.png"
            for p, color in [(img1, "blue"), (img2, "maroon")]:
                subprocess.run([
                    self.compositor.ffmpeg_exe, "-y",
                    "-f", "lavfi", "-i", f"color=c={color}:s=800x600:d=1",
                    "-vframes", "1", str(p)
                ], check=True, capture_output=True)

            # Create test audio (2 seconds tone)
            audio_p = temp_dir / "test_audio.mp3"
            subprocess.run([
                self.compositor.ffmpeg_exe, "-y",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                "-c:a", "libmp3lame", str(audio_p)
            ], check=True, capture_output=True)

            # Create test srt
            srt_p = temp_dir / "test_sub.srt"
            srt_p.write_text("1\n00:00:00,000 --> 00:00:02,500\nKUPÇALI MƏNZİL!\n", encoding="utf-8")

            out_video = temp_dir / "output.mp4"
            sample_listing = {
                "price": 195000,
                "currency": "AZN",
                "location": "Elmlər m.",
                "rooms": 2,
                "area": 75,
                "has_bill_of_sale": True
            }

            rendered = self.compositor.build_video(
                listing=sample_listing,
                image_paths=[str(img1), str(img2)],
                audio_path=str(audio_p),
                srt_path=str(srt_p),
                output_video_path=out_video,
                duration=3.0
            )

            self.assertTrue(rendered.exists())
            self.assertGreater(rendered.stat().st_size, 10000)

            # Probe resolution using ffmpeg
            res = subprocess.run([
                self.compositor.ffmpeg_exe, "-i", str(rendered)
            ], capture_output=True, text=True, encoding="utf-8", errors="replace")
            self.assertIn("1080x1920", res.stderr)

            # Test video composition WITH background music & ducking
            bg_music_p = temp_dir / "bg_music.mp3"
            subprocess.run([
                self.compositor.ffmpeg_exe, "-y",
                "-f", "lavfi", "-i", "sine=frequency=220:duration=4",
                "-c:a", "libmp3lame", str(bg_music_p)
            ], check=True, capture_output=True)

            out_ducked = temp_dir / "output_ducked.mp4"
            rendered_ducked = self.compositor.build_video(
                listing=sample_listing,
                image_paths=[str(img1), str(img2)],
                audio_path=str(audio_p),
                srt_path=str(srt_p),
                output_video_path=out_ducked,
                bg_music_path=str(bg_music_p),
                duration=3.0
            )
            self.assertTrue(rendered_ducked.exists())
            self.assertGreater(rendered_ducked.stat().st_size, 10000)

        finally:
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
