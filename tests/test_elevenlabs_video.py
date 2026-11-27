"""Unit tests for ElevenLabs Flows Image-to-Video (Veo 3.1) generator."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests
from PIL import Image

from src.media.elevenlabs_video import (
    DEFAULT_VIDEO_MODEL,
    ELEVENLABS_FLOWS_VIDEO_URL,
    animate_photo_to_video,
    generate_ai_intro_clips,
)


class TestElevenLabsVideo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.img_path = Path(self.tmp.name) / "hero.jpg"
        Image.new("RGB", (1200, 900), (40, 80, 120)).save(self.img_path, format="JPEG")

    def tearDown(self):
        self.tmp.cleanup()

    @patch("src.media.elevenlabs_video.time.sleep", return_value=None)
    @patch("requests.get")
    @patch("requests.post")
    def test_animate_photo_to_video_success(self, mock_post, mock_get, _mock_sleep):
        post_resp = MagicMock()
        post_resp.status_code = 201
        post_resp.json.return_value = {"id": "gen_veo_123", "status": "pending"}
        mock_post.return_value = post_resp

        poll_pending = MagicMock()
        poll_pending.status_code = 200
        poll_pending.json.return_value = {"id": "gen_veo_123", "status": "generating"}

        poll_done = MagicMock()
        poll_done.status_code = 200
        poll_done.json.return_value = {
            "id": "gen_veo_123",
            "status": "completed",
            "content_url": "https://cdn.elevenlabs.io/mock_veo.mp4",
        }

        dl_resp = MagicMock()
        dl_resp.status_code = 200
        dl_resp.content = b"\x00\x00\x00\x18ftypmp42mockdata"

        mock_get.side_effect = [poll_pending, poll_done, dl_resp]

        out = Path(self.tmp.name) / "clip.mp4"
        res = animate_photo_to_video(
            self.img_path,
            out,
            prompt="Smooth steadycam glide",
            api_key="el_test_key",
            poll_interval=0.01,
        )

        self.assertEqual(res, out)
        self.assertTrue(out.is_file())
        self.assertEqual(out.read_bytes(), b"\x00\x00\x00\x18ftypmp42mockdata")

        args, kwargs = mock_post.call_args
        self.assertEqual(args[0], ELEVENLABS_FLOWS_VIDEO_URL)
        self.assertEqual(kwargs["headers"]["xi-api-key"], "el_test_key")
        self.assertEqual(kwargs["json"]["model_id"], DEFAULT_VIDEO_MODEL)
        self.assertEqual(kwargs["json"]["first_frame"]["type"], "inline_base64")
        self.assertEqual(kwargs["json"]["first_frame"]["mime_type"], "image/jpeg")

    @patch("requests.post")
    def test_animate_photo_fallback_on_403_permission(self, mock_post):
        resp = MagicMock()
        resp.status_code = 403
        resp.text = "Missing Flows permission"
        mock_post.return_value = resp

        out = Path(self.tmp.name) / "clip_403.mp4"
        res = animate_photo_to_video(self.img_path, out, prompt="test", api_key="el_test")
        self.assertIsNone(res)
        self.assertFalse(out.exists())

    @patch("requests.post")
    def test_animate_photo_fallback_on_timeout(self, mock_post):
        mock_post.side_effect = requests.exceptions.Timeout("Timed out")
        out = Path(self.tmp.name) / "clip_to.mp4"
        res = animate_photo_to_video(self.img_path, out, prompt="test", api_key="el_test")
        self.assertIsNone(res)

    @patch.dict("os.environ", {"ELEVENLABS_API_KEY": ""}, clear=False)
    def test_generate_ai_intro_clips_without_key(self):
        clips = generate_ai_intro_clips([self.img_path], Path(self.tmp.name), {"rooms": 3})
        self.assertEqual(clips, {})


if __name__ == "__main__":
    unittest.main()
