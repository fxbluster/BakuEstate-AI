"""Unit tests for multimodal vision analyzer module."""

import base64
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests
from PIL import Image

# Ensure project root is in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.ai.vision_analyzer import (
    PropertyVisualProfile,
    _clean_and_parse_json,
    analyze_listing_photos,
    encode_image_to_base64_jpeg,
    select_key_photos,
)


class TestVisionAnalyzer(unittest.TestCase):
    """Test suite for PropertyVisualProfile, photo selection, and GPT-4o Vision API client."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.test_dir = Path(self.temp_dir.name)

        # Create a small valid test JPEG image
        self.sample_image_path = self.test_dir / "sample_test.jpg"
        img = Image.new("RGB", (200, 200), color=(100, 150, 200))
        img.save(self.sample_image_path, format="JPEG")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_photo_selection_heuristic_caps_at_5(self):
        """Validates that photo selection caps at 5 and follows [0, 1, len//3, len//2, -1]."""
        # Case 1: Empty list
        self.assertEqual(select_key_photos([]), [])

        # Case 2: Under 5 photos -> returns all
        paths_3 = [Path(f"photo_{i}.jpg") for i in range(3)]
        self.assertEqual(select_key_photos(paths_3), paths_3)

        # Case 3: Exactly 5 photos -> returns all 5
        paths_5 = [Path(f"photo_{i}.jpg") for i in range(5)]
        self.assertEqual(select_key_photos(paths_5), paths_5)

        # Case 4: 6 photos -> returns exactly 5 photos [0, 1, 2, 3, 5]
        paths_6 = [Path(f"photo_{i}.jpg") for i in range(6)]
        selected_6 = select_key_photos(paths_6)
        self.assertEqual(len(selected_6), 5)
        self.assertEqual(selected_6, [paths_6[0], paths_6[1], paths_6[2], paths_6[3], paths_6[5]])

        # Case 5: 10 photos -> [0, 1, 10//3=3, 10//2=5, -1=9]
        paths_10 = [Path(f"photo_{i}.jpg") for i in range(10)]
        selected_10 = select_key_photos(paths_10)
        self.assertEqual(len(selected_10), 5)
        self.assertEqual(
            selected_10,
            [paths_10[0], paths_10[1], paths_10[3], paths_10[5], paths_10[9]],
        )

        # Case 6: 25 photos -> caps at 5 deterministically
        paths_25 = [Path(f"photo_{i}.jpg") for i in range(25)]
        selected_25 = select_key_photos(paths_25)
        self.assertEqual(len(selected_25), 5)
        # Verify deduplication and determinism
        self.assertEqual(len(set(selected_25)), 5)
        self.assertEqual(select_key_photos(paths_25), selected_25)

    @patch("requests.post")
    def test_analyze_listing_photos_success(self, mock_post):
        """Validates successful visual profile generation from mocked Gemini vision response."""
        mock_response_data = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": json.dumps({
                                    "renovation_quality": "modern_luxury",
                                    "floor_and_ceiling": "Təbii palıd parketi, LED xətti işıqlı dartma tavan",
                                    "kitchen_appliances": "Quraşdırılmış Bosch soba və daş tezgah",
                                    "view_and_lighting": "Xəzər dənizinə panoramik mənzərə və vitraj pəncərələr",
                                    "hook_sentence_az": "Dəniz panoramalı və lüks təmirli bu premium mənzil şəhərin ən prestijli nöqtəsindədir!",
                                    "standout_features": [
                                        "panoramik dəniz mənzərəsi",
                                        "təbii parket",
                                        "quraşdırılmış mətbəx texnikası",
                                    ],
                                })
                            }
                        ]
                    }
                }
            ]
        }

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = mock_response_data
        mock_post.return_value = mock_resp

        profile = analyze_listing_photos(
            [self.sample_image_path],
            api_key="AIza-test-mock-key-12345",
            timeout=15.0,
        )

        self.assertFalse(profile.is_fallback)
        self.assertEqual(profile.renovation_quality, "modern_luxury")
        self.assertEqual(profile.floor_and_ceiling, "Təbii palıd parketi, LED xətti işıqlı dartma tavan")
        self.assertEqual(profile.kitchen_appliances, "Quraşdırılmış Bosch soba və daş tezgah")
        self.assertEqual(profile.view_and_lighting, "Xəzər dənizinə panoramik mənzərə və vitraj pəncərələr")
        self.assertIn("Dəniz panoramalı", profile.hook_sentence_az)
        self.assertEqual(len(profile.standout_features), 3)

        # Verify API request details
        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        self.assertEqual(
            args[0],
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        )
        self.assertEqual(kwargs["headers"]["x-goog-api-key"], "AIza-test-mock-key-12345")
        self.assertEqual(kwargs["timeout"], 15.0)

        payload = kwargs["json"]
        self.assertEqual(payload["generationConfig"]["responseMimeType"], "application/json")
        parts = payload["contents"][0]["parts"]
        image_part = next(part for part in parts if "inline_data" in part)
        self.assertEqual(image_part["inline_data"]["mime_type"], "image/jpeg")
        self.assertTrue(len(image_part["inline_data"]["data"]) > 0)

    @patch("requests.post")
    def test_analyze_listing_photos_circuit_breaker_on_500(self, mock_post):
        """Validates circuit breaker returns fallback on HTTP 500 error without raising."""
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Server Error"
        mock_post.return_value = mock_resp

        profile = analyze_listing_photos(
            [self.sample_image_path],
            api_key="sk-test-key",
        )

        self.assertTrue(profile.is_fallback)
        self.assertEqual(profile.renovation_quality, "standard")
        self.assertEqual(profile.hook_sentence_az, "")

    @patch("requests.post")
    def test_analyze_listing_photos_timeout(self, mock_post):
        """Validates circuit breaker returns fallback on requests.exceptions.Timeout."""
        mock_post.side_effect = requests.exceptions.Timeout("Connection timed out after 15s")

        profile = analyze_listing_photos(
            [self.sample_image_path],
            api_key="sk-test-key",
        )

        self.assertTrue(profile.is_fallback)
        self.assertEqual(profile.renovation_quality, "standard")
        self.assertEqual(profile.standout_features, [])

    def test_to_dict_and_from_dict(self):
        """Validates serialization and deserialization of PropertyVisualProfile."""
        original = PropertyVisualProfile(
            renovation_quality="scandinavian",
            floor_and_ceiling="Ağ palıd laminat, mat tavan",
            kitchen_appliances="İnteqrasiya olunmuş soyuducu",
            view_and_lighting="Geniş pəncərələr, günəşli tərəf",
            hook_sentence_az="İşıqlı və minimal üslubda təmir olunmuş mənzil!",
            standout_features=["skandinaviya üslubu", "geniş eyvan"],
            is_fallback=False,
        )

        d = original.to_dict()
        self.assertEqual(d["renovation_quality"], "scandinavian")
        self.assertEqual(d["floor_and_ceiling"], "Ağ palıd laminat, mat tavan")
        self.assertEqual(d["standout_features"], ["skandinaviya üslubu", "geniş eyvan"])
        self.assertFalse(d["is_fallback"])

        restored = PropertyVisualProfile.from_dict(d)
        self.assertEqual(restored.renovation_quality, original.renovation_quality)
        self.assertEqual(restored.floor_and_ceiling, original.floor_and_ceiling)
        self.assertEqual(restored.kitchen_appliances, original.kitchen_appliances)
        self.assertEqual(restored.view_and_lighting, original.view_and_lighting)
        self.assertEqual(restored.hook_sentence_az, original.hook_sentence_az)
        self.assertEqual(restored.standout_features, original.standout_features)
        self.assertFalse(restored.is_fallback)

        # Edge cases: None or non-dict input
        fallback_from_none = PropertyVisualProfile.from_dict(None)
        self.assertTrue(fallback_from_none.is_fallback)

        fallback_from_empty = PropertyVisualProfile.from_dict({})
        self.assertTrue(fallback_from_empty.is_fallback)

        # Invalid renovation quality defaults to "standard"
        custom_dict = {"renovation_quality": "unknown_future_style"}
        profile_unknown = PropertyVisualProfile.from_dict(custom_dict)
        self.assertEqual(profile_unknown.renovation_quality, "standard")

    def test_circuit_breaker_on_empty_photos_or_no_api_key(self):
        """Validates immediate fallback when no photos or no API key are provided."""
        # Empty photos
        profile_empty = analyze_listing_photos([], api_key="sk-test-key")
        self.assertTrue(profile_empty.is_fallback)

        # Missing API key
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}, clear=True):
            profile_no_key = analyze_listing_photos([self.sample_image_path], api_key=None)
            self.assertTrue(profile_no_key.is_fallback)

    def test_clean_and_parse_json_markdown_fence(self):
        """Validates that markdown code fences are stripped cleanly when parsing JSON."""
        raw_markdown = "```json\n{\"renovation_quality\": \"euro\", \"view_and_lighting\": \"park mənzərəsi\"}\n```"
        parsed = _clean_and_parse_json(raw_markdown)
        self.assertEqual(parsed["renovation_quality"], "euro")
        self.assertEqual(parsed["view_and_lighting"], "park mənzərəsi")

    def test_large_image_resizing_in_encoder(self):
        """Validates that images exceeding 1080px are resized down to max 1080px."""
        large_image_path = self.test_dir / "large_photo.jpg"
        large_img = Image.new("RGB", (2400, 1600), color=(50, 80, 120))
        large_img.save(large_image_path, format="JPEG")

        b64 = encode_image_to_base64_jpeg(large_image_path, max_dimension=1080)
        self.assertIsNotNone(b64)

        # Decode base64 and verify dimensions
        img_bytes = base64.b64decode(b64)
        with Image.open(io.BytesIO(img_bytes)) as decoded_img:
            self.assertLessEqual(max(decoded_img.size), 1080)
            self.assertEqual(decoded_img.size[0], 1080)  # Width was 2400, scaled to 1080


if __name__ == "__main__":
    unittest.main()
