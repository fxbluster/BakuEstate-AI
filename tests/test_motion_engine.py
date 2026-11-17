"""
Unit tests for BakuEstate-AI Cinematic Motion Engine (src/media/motion_engine.py).
Tests motion profiles, smart-matte framing, xfade chaining, and transition metadata.
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
    resolve_motion_profile,
    render_cinematic_walkthrough,
    DEFAULT_MOTION_SEQUENCE,
    DEFAULT_WALKTHROUGH_TRANSITIONS
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
            height=960
        )
        self.assertTrue(out_vid.exists())
        self.assertGreater(out_vid.stat().st_size, 1000)
        self.assertEqual(res["clip_count"], 1)
        self.assertEqual(len(res["transitions"]), 0)

    def test_multi_slide_xfade_walkthrough(self):
        """Tests walkthrough with 3 photos chained with xfade smoothleft & smoothright."""
        out_vid = self.temp_dir / "multi_walkthrough.mp4"
        res = render_cinematic_walkthrough(
            image_paths=self.test_images,
            output_path=out_vid,
            total_duration=4.5,
            transition_duration=0.5,
            transitions=["smoothleft", "smoothright"],
            fps=24,
            width=540,
            height=960
        )
        self.assertTrue(out_vid.exists())
        self.assertGreater(out_vid.stat().st_size, 5000)
        self.assertEqual(res["clip_count"], 3)
        self.assertEqual(len(res["transitions"]), 2)
        
        # Verify transition timestamps
        # 3 slides, total_dur=4.5, trans_dur=0.5 -> slide_dur = (4.5 + 2*0.5)/3 = 5.5/3 = 1.833s
        # Transition 0: 1.833 - 0.5 = 1.333s
        # Transition 1: 1.333 + 1.833 - 0.5 = 2.667s
        trans = res["transitions"]
        self.assertEqual(trans[0]["type"], "smoothleft")
        self.assertEqual(trans[1]["type"], "smoothright")
        self.assertAlmostEqual(trans[0]["timestamp"], 1.333, places=2)
        self.assertAlmostEqual(trans[1]["timestamp"], 2.667, places=2)


if __name__ == "__main__":
    unittest.main()
