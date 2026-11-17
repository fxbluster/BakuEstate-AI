"""
Unit tests for BakuEstate-AI Cinematic Motion Engine (src/media/motion_engine.py).
Tests motion profiles, smart-matte framing, cinematic_fill, 4 archetypes, xfade chaining, and transition metadata.
"""

import unittest
import tempfile
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image

from src.media.motion_engine import (
    MotionEngine,
    MotionProfile,
    PropertyArchetype,
    detect_property_archetype,
    resolve_motion_profile,
    render_cinematic_walkthrough,
    DEFAULT_MOTION_SEQUENCE,
    DEFAULT_WALKTHROUGH_TRANSITIONS,
    ARCHETYPE_CONFIGS
)


class TestMotionEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(tempfile.mkdtemp(prefix="estate_test_motion_"))
        cls.test_images = []
        # Create 3 solid-colored test images
        colors = [(200, 50, 50), (50, 200, 50), (50, 50, 200)]
        for i, col in enumerate(colors):
            img_p = cls.temp_dir / f"test_img_{i}.jpg"
            img = Image.new("RGB", (640, 480), color=col)
            img.save(img_p, "JPEG")
            cls.test_images.append(img_p)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def test_detect_property_archetype(self):
        """Tests automatic classification of listings into 4 archetypes."""
        # Budget
        listing_budget = {
            "title": "3 otaqlı daş bina",
            "description": "Eksperimental minsk proyekt, 3 metr tavan",
            "location": "Xalqlar Dostluğu m.",
            "price": "175000"
        }
        self.assertEqual(detect_property_archetype(listing_budget), PropertyArchetype.BUDGET)

        # Luxury
        listing_luxury = {
            "title": "Ağ Şəhərdə 4 otaqlı penthouse",
            "description": "Panoramik dəniz mənzərəsi, dizayn avro təmir",
            "location": "Ağ Şəhər",
            "price": "490000"
        }
        self.assertEqual(detect_property_archetype(listing_luxury), PropertyArchetype.LUXURY)

        # Villa
        listing_villa = {
            "title": "Mərdəkanda möhtəşəm bağ evi",
            "description": "6 sot həyətyanı sahə, filterli hovuz və manqal",
            "location": "Mərdəkan qəsəbəsi",
            "price": "380000"
        }
        self.assertEqual(detect_property_archetype(listing_villa), PropertyArchetype.VILLA)

        # Commercial
        listing_comm = {
            "title": "Hazır icarədə olan ticarət obyekti",
            "description": "Gediş-gəlişli küçədə vitraj mağaza, aylıq icarə 2500 AZN",
            "location": "Nərimanov",
            "price": "350000"
        }
        self.assertEqual(detect_property_archetype(listing_comm), PropertyArchetype.COMMERCIAL)

    def test_resolve_motion_profile(self):
        """Tests that auto profile cycles predictably through default sequence."""
        for i in range(len(DEFAULT_MOTION_SEQUENCE) * 2):
            expected = DEFAULT_MOTION_SEQUENCE[i % len(DEFAULT_MOTION_SEQUENCE)]
            self.assertEqual(resolve_motion_profile(MotionProfile.AUTO, i), expected)
        self.assertEqual(resolve_motion_profile(MotionProfile.PUSH_IN, 3), MotionProfile.PUSH_IN)

    def test_single_slide_walkthrough(self):
        """Tests walkthrough with a single photo (no xfade required)."""
        engine = MotionEngine()
        out_vid = self.temp_dir / "single_slide.mp4"
        res = engine.render_walkthrough(
            image_paths=[self.test_images[0]],
            output_path=out_vid,
            total_duration=2.0,
            fps=24,
            width=540,
            height=960,
            framing_mode="cinematic_fill"
        )
        self.assertTrue(out_vid.exists())
        self.assertGreater(out_vid.stat().st_size, 1000)
        self.assertEqual(res["clip_count"], 1)
        self.assertEqual(len(res["transitions"]), 0)
        self.assertEqual(res["framing_mode"], "cinematic_fill")

    def test_cinematic_fill_mode_rendering(self):
        """Tests that cinematic_fill mode renders full-bleed camera pans without letterboxing."""
        engine = MotionEngine()
        out_clip = self.temp_dir / "test_fill_pan.mp4"
        res = engine.create_motion_clip(
            image_path=self.test_images[0],
            output_clip_path=out_clip,
            duration=1.5,
            profile=MotionProfile.PAN_LEFT_TO_RIGHT,
            framing_mode="cinematic_fill",
            fps=24,
            width=540,
            height=960
        )
        self.assertTrue(out_clip.exists())
        self.assertGreater(out_clip.stat().st_size, 2000)

    def test_multi_slide_xfade_walkthrough_with_archetype(self):
        """Tests walkthrough with 3 photos chained with luxury archetype xfade and cinematic_fill."""
        out_vid = self.temp_dir / "luxury_walkthrough.mp4"
        res = render_cinematic_walkthrough(
            image_paths=self.test_images,
            output_path=out_vid,
            total_duration=4.5,
            archetype=PropertyArchetype.LUXURY,
            framing_mode="cinematic_fill",
            fps=24,
            width=540,
            height=960
        )
        self.assertTrue(out_vid.exists())
        self.assertGreater(out_vid.stat().st_size, 5000)
        self.assertEqual(res["clip_count"], 3)
        self.assertEqual(res["archetype"], PropertyArchetype.LUXURY)
        self.assertEqual(res["framing_mode"], "cinematic_fill")
        self.assertEqual(len(res["transitions"]), 2)
        self.assertGreater(len(res["transitions"]), 0)


if __name__ == "__main__":
    unittest.main()
