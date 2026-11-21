import os
import sys
import tempfile
import unittest
from pathlib import Path

# Add project root to sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from PIL import Image

from src.media.glass_badge import (
    create_hero_badge,
    create_cta_badge,
    create_bottom_scrim_png,
    get_hero_overlay_filter,
    ARCHETYPE_STYLES
)
from src.media.kinetic_subtitles import (
    convert_srt_to_kinetic_ass,
    build_kinetic_ass_from_words,
    highlight_keywords_in_text,
    split_srt_block_into_chunks,
    get_bottom_scrim_overlay_filter,
    escape_ffmpeg_path
)

class TestTypographyUI(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_typo_"))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_create_hero_badge_archetypes(self):
        listing = {
            "price": "285000",
            "currency": "AZN",
            "location": "Ağ Şəhər",
            "rooms": "3",
            "area": "145",
            "has_bill_of_sale": True,
            "is_urgent": True,
            "is_owner": True
        }
        for arch in ["budget", "luxury", "villa", "commercial"]:
            out_badge = self.temp_dir / f"hero_{arch}.png"
            res = create_hero_badge(listing, output_path=out_badge, width=960, height=240, archetype=arch)
            self.assertTrue(res.exists())
            self.assertGreater(res.stat().st_size, 1000)

            with Image.open(res) as img:
                self.assertEqual(img.size, (960, 240))
                self.assertEqual(img.mode, "RGBA")

    def test_create_cta_badge(self):
        listing = {
            "owner_phone": "+994 50 123 45 67"
        }
        out_cta = self.temp_dir / "cta.png"
        res = create_cta_badge(listing, output_path=out_cta, width=920, height=150)
        self.assertTrue(res.exists())
        self.assertGreater(res.stat().st_size, 1000)

        with Image.open(res) as img:
            self.assertEqual(img.size, (920, 150))
            self.assertEqual(img.mode, "RGBA")

    def test_create_bottom_scrim_png(self):
        out_scrim = self.temp_dir / "scrim.png"
        res = create_bottom_scrim_png(output_path=out_scrim, width=1080, height=1920)
        self.assertTrue(res.exists())
        self.assertGreater(res.stat().st_size, 1000)

        with Image.open(res) as img:
            self.assertEqual(img.size, (1080, 1920))
            self.assertEqual(img.mode, "RGBA")

    def test_get_hero_overlay_filter_25s_timing(self):
        badge_path = self.temp_dir / "badge.png"
        badge_path.write_text("dummy")
        filter_str, esc_path = get_hero_overlay_filter(badge_path, start_time=0.2, end_time=2.5)
        self.assertIn("overlay=x=(W-w)/2", filter_str)
        self.assertIn("186", filter_str)
        self.assertIn("between(t,0.20,2.50)", filter_str)
        self.assertIn("format=auto", filter_str)
        self.assertTrue(len(esc_path) > 0)

    def test_standardized_cta_badge_no_phone_leakage(self):
        from unittest.mock import patch
        listing = {
            "owner_phone": "+994 50 999 88 77",
            "phone": "+994 12 444 33 22"
        }
        drawn_texts = []

        def mock_text(xy, text, **kwargs):
            drawn_texts.append(text)

        with patch("PIL.ImageDraw.ImageDraw.text", side_effect=mock_text):
            out_cta = self.temp_dir / "cta_clean.png"
            create_cta_badge(listing, output_path=out_cta)

        self.assertIn("DƏQİQ ÜNVAN VƏ BAXIŞ ÜÇÜN", drawn_texts)
        self.assertIn("ŞƏRHƏ 'EV' YAZIN VƏ YA DM GÖNDƏRİN", drawn_texts)
        for t in drawn_texts:
            self.assertNotIn("999", t)
            self.assertNotIn("BİRBAŞA SAHİBİNDƏN", t)
            self.assertNotIn("KOMİSSİYASIZ", t)

    def test_kinetic_subtitles_safe_zone_baseline(self):
        # Video height is 1920. Baseline y = 1920 - MarginV.
        # Safe zone baseline must stay within [1250, 1420] px.
        srt_content = "1\n00:00:01,000 --> 00:00:03,000\nTest mənzil\n"
        srt_file = self.temp_dir / "safe.srt"
        srt_file.write_text(srt_content, encoding="utf-8")
        ass_file = self.temp_dir / "safe.ass"

        convert_srt_to_kinetic_ass(srt_file, ass_file)
        content = ass_file.read_text(encoding="utf-8")

        import re
        # Find MarginV for KineticSub and KineticSubCTA
        m_sub = re.search(r"Style: KineticSub,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,(\d+)", content)
        m_cta = re.search(r"Style: KineticSubCTA,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,(\d+)", content)
        self.assertIsNotNone(m_sub)
        self.assertIsNotNone(m_cta)

        margin_v_normal = int(m_sub.group(1))
        margin_v_cta = int(m_cta.group(1))

        baseline_normal = 1920 - margin_v_normal
        baseline_cta = 1920 - margin_v_cta

        self.assertGreaterEqual(baseline_normal, 1250)
        self.assertLessEqual(baseline_normal, 1420)
        self.assertGreaterEqual(baseline_cta, 1250)
        self.assertLessEqual(baseline_cta, 1420)

    def test_phonetic_floor_fraction_verbalization(self):
        from src.media.tts_service import normalize_azerbaijani_phonetics
        res_49 = normalize_azerbaijani_phonetics("4/9")
        self.assertEqual(res_49, "doqquz mərtəbəli binanın dördüncü mərtəbəsində")

        res_sentence = normalize_azerbaijani_phonetics("Mənzil 2/5 yerləşir")
        self.assertIn("beş mərtəbəli binanın ikinci mərtəbəsində", res_sentence)

    def test_elevenlabs_voice_mapping_and_edge_fallback(self):
        from unittest.mock import patch, MagicMock
        from src.media.elevenlabs_tts import (
            resolve_elevenlabs_voice_id,
            synthesize_elevenlabs_speech,
            ElevenLabsSynthesisError,
        )

        # 1. Alias mapping check
        self.assertEqual(resolve_elevenlabs_voice_id("Arif"), "ZQJv3hwvRAIC7fvWZ1Qr")
        self.assertEqual(resolve_elevenlabs_voice_id("banu"), "EXAVITQu4vr4xnSDxMaL")

        # 2. Quota exhaustion 401/429 raises ElevenLabsSynthesisError (fallback handled in tts_service)
        out_audio = self.temp_dir / "fallback.mp3"
        out_srt = self.temp_dir / "fallback.srt"

        mock_resp_429 = MagicMock()
        mock_resp_429.status_code = 429
        mock_resp_429.text = '{"detail": "Quota exceeded"}'

        with patch("requests.post", return_value=mock_resp_429):
            with self.assertRaises(ElevenLabsSynthesisError):
                synthesize_elevenlabs_speech(
                    text="Bakıda mənzil",
                    output_audio_path=out_audio,
                    output_srt_path=out_srt,
                    api_key="test-key",
                    voice_id="Arif"
                )

        # Test female/banu fallback raises ElevenLabsSynthesisError on 401
        mock_resp_401 = MagicMock()
        mock_resp_401.status_code = 401
        mock_resp_401.text = '{"detail": "Unauthorized"}'

        with patch("requests.post", return_value=mock_resp_401):
            with self.assertRaises(ElevenLabsSynthesisError):
                synthesize_elevenlabs_speech(
                    text="Bakıda mənzil",
                    output_audio_path=out_audio,
                    output_srt_path=out_srt,
                    api_key="test-key",
                    voice_id="banu"
                )

    def test_highlight_keywords_in_text(self):
        sample = "NƏRİMANOVDA KUPÇALI 3 OTAQLI MƏNZİL"
        res = highlight_keywords_in_text(sample)
        self.assertIn("&H003BD4FF&", res)
        self.assertIn("&H0099D334&", res)

    def test_split_srt_block_into_chunks(self):
        text = "Bu gün sizə Nərimanovda yerləşən möhtəşəm kupçalı mənzili təqdim edirik"
        chunks = split_srt_block_into_chunks(text, start_s=0.0, end_s=6.0, max_words=3)
        self.assertGreaterEqual(len(chunks), 3)
        for c in chunks:
            words = c["text"].split()
            self.assertLessEqual(len(words), 4)

    def test_convert_srt_to_kinetic_ass_with_cta_shift(self):
        srt_content = """1
00:00:01,000 --> 00:00:04,000
Təcili satılır! Nərimanov metrosu yaxınlığında 3 otaqlı kupçalı mənzil.

2
00:00:26,000 --> 00:00:30,000
Ətraflı məlumat üçün dərhal bizimlə əlaqə saxlayın.
"""
        srt_file = self.temp_dir / "test.srt"
        srt_file.write_text(srt_content, encoding="utf-8")

        ass_file = self.temp_dir / "test_kinetic.ass"
        res = convert_srt_to_kinetic_ass(srt_file, ass_file, margin_v=580, margin_v_cta=700, cta_start_time=26.5)
        self.assertTrue(res.exists())

        content = ass_file.read_text(encoding="utf-8")
        self.assertIn("[Script Info]", content)
        self.assertIn("Style: KineticSub", content)
        self.assertIn("Style: KineticSubCTA", content)
        self.assertIn(r"\fscx108\fscy108", content)
        self.assertIn("KineticSubCTA", content)

    def test_build_kinetic_ass_from_words(self):
        words = [
            {"word": "Bakı", "start": 0.5, "end": 0.9},
            {"word": "şəhərində", "start": 0.9, "end": 1.4},
            {"word": "möhtəşəm", "start": 1.4, "end": 2.0},
            {"word": "mənzil", "start": 2.0, "end": 2.5},
        ]
        ass_file = self.temp_dir / "words_kinetic.ass"
        res = build_kinetic_ass_from_words(words, ass_file)
        self.assertTrue(res.exists())
        content = ass_file.read_text(encoding="utf-8")
        self.assertIn(r"\fscx108\fscy108", content)
        self.assertIn("BAKI ŞƏHƏRİNDƏ", content)

if __name__ == "__main__":
    unittest.main()
