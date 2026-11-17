"""Unit tests for tts_service module."""

import unittest
import tempfile
import os
from pathlib import Path
from datetime import timedelta

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.media.tts_service import (
    generate_azerbaijani_script,
    format_srt_time,
    convert_cues_to_word_level_srt,
    generate_tts_for_listing,
    azerbaijani_ordinal_suffix,
    verbalize_baku_price,
    canonicalize_location_phrase,
    detect_listing_archetype
)

class MockCue:
    def __init__(self, content, start_sec, end_sec):
        self.content = content
        self.start = timedelta(seconds=start_sec)
        self.end = timedelta(seconds=end_sec)

class TestTTSService(unittest.TestCase):
    def test_verbalize_baku_price(self):
        self.assertEqual(verbalize_baku_price(175000), "175 min manat")
        self.assertEqual(verbalize_baku_price(240500), "240 min 500 manat")
        self.assertEqual(verbalize_baku_price(1500000), "1 milyon 500 min manat")
        self.assertEqual(verbalize_baku_price(850), "850 manat")

    def test_canonicalize_location_phrase(self):
        loc1 = "Xalqlar Dostluğu m."
        clean1 = canonicalize_location_phrase(loc1)
        self.assertEqual(clean1, "Xalqlar Dostluğu metrosu yaxınlığında")
        self.assertNotIn("yaxınlığında ərazisində", clean1)

        loc2 = "Nizami r-nu, Qara Qarayev pr."
        clean2 = canonicalize_location_phrase(loc2)
        self.assertIn("rayonunda", clean2)
        self.assertIn("prospektində", clean2)

    def test_detect_listing_archetype(self):
        self.assertEqual(detect_listing_archetype({"price": 450000, "location": "Ağ Şəhər"}), "luxury")
        self.assertEqual(detect_listing_archetype({"title": "Mərdəkanda 6 sotda hovuzlu villa"}), "villa")
        self.assertEqual(detect_listing_archetype({"title": "28 Mayda hazır icarədə obyekt"}), "commercial")
        self.assertEqual(detect_listing_archetype({"price": 140000, "location": "Xalqlar Dostluğu"}), "budget")

    def test_azerbaijani_ordinal_suffix(self):
        self.assertEqual(azerbaijani_ordinal_suffix(1), "-ci")
        self.assertEqual(azerbaijani_ordinal_suffix(2), "-ci")
        self.assertEqual(azerbaijani_ordinal_suffix(3), "-cü")
        self.assertEqual(azerbaijani_ordinal_suffix(4), "-cü")
        self.assertEqual(azerbaijani_ordinal_suffix(5), "-ci")
        self.assertEqual(azerbaijani_ordinal_suffix(6), "-cı")
        self.assertEqual(azerbaijani_ordinal_suffix(7), "-ci")
        self.assertEqual(azerbaijani_ordinal_suffix(8), "-ci")
        self.assertEqual(azerbaijani_ordinal_suffix(9), "-cu")
        self.assertEqual(azerbaijani_ordinal_suffix(10), "-cu")
        self.assertEqual(azerbaijani_ordinal_suffix(16), "-cı")
        self.assertEqual(azerbaijani_ordinal_suffix(20), "-ci")

    def test_generate_azerbaijani_script(self):
        sample = {
            "bina_id": "112233",
            "price": 185000,
            "currency": "AZN",
            "location": "Nərimanov m.",
            "rooms": 2,
            "area": 85,
            "floor": 5,
            "floors": 5,
            "title": "Daş binada mənzil",
            "description": "Eksperimental daş bina, minsk layihə",
            "has_bill_of_sale": True,
            "is_owner": True
        }
        script = generate_azerbaijani_script(sample)
        self.assertIn("Nərimanov metrosu", script)
        self.assertIn("2 otaqlı", script)
        self.assertIn("85 kvadrat metr", script)
        self.assertIn("5-ci mərtəbəsində", script)
        self.assertIn("Dam örtüyü tamamilə yenilənib", script)
        self.assertIn("Bina tam daşdır", script)
        self.assertIn("kupçası var", script.lower())
        self.assertIn("185 min manat", script)
        self.assertNotIn("yaxınlığında ərazisində", script)

    def test_archetype_scripts(self):
        lux = generate_azerbaijani_script({"price": 500000, "location": "Ağ Şəhər", "rooms": 4, "area": 200}, archetype="luxury")
        self.assertIn("premium", lux.lower())
        self.assertIn("500 min manat", lux)

        vil = generate_azerbaijani_script({"price": 380000, "location": "Mərdəkan", "rooms": 5, "area": 280}, archetype="villa")
        self.assertIn("villa", vil.lower())
        self.assertIn("hovuz", vil.lower())

        com = generate_azerbaijani_script({"price": 250000, "location": "Nizami", "area": 60}, archetype="commercial")
        self.assertIn("obyekt", com.lower())
        self.assertIn("250 min manat", com)

    def test_format_srt_time(self):
        td = timedelta(seconds=65, milliseconds=250)
        formatted = format_srt_time(td)
        self.assertEqual(formatted, "00:01:05,250")

    def test_convert_cues_to_word_level_srt(self):
        cues = [MockCue("Bakıda təcili və sərfəli mənzil satılır", 0.0, 3.0)]
        srt = convert_cues_to_word_level_srt(cues, words_per_chunk=3)
        self.assertIn("-->", srt)
        self.assertIn("Bakıda təcili və", srt)
        self.assertIn("sərfəli mənzil satılır", srt)

    def test_convert_cues_to_word_level_srt_no_zero_duration(self):
        # Edge case: rapid cue with 9 words in 0.6 seconds
        cues = [MockCue("one two three four five six seven eight nine", 0.0, 0.6)]
        srt = convert_cues_to_word_level_srt(cues, words_per_chunk=3)
        lines = srt.strip().split("\n")
        for line in lines:
            if "-->" in line:
                start_str, end_str = line.split("-->")
                self.assertNotEqual(start_str.strip(), end_str.strip(), f"Zero duration cue found: {line}")

    def test_live_tts_synthesis(self):
        temp_dir = tempfile.TemporaryDirectory()
        out_dir = Path(temp_dir.name)
        sample = {
            "bina_id": "test_audio",
            "price": 120000,
            "currency": "AZN",
            "location": "Yasamal",
            "rooms": 1,
            "area": 50,
            "has_bill_of_sale": True,
            "is_owner": True
        }
        script, audio_p, srt_p, duration = generate_tts_for_listing(sample, output_dir=out_dir)
        self.assertTrue(Path(audio_p).exists())
        self.assertGreater(Path(audio_p).stat().st_size, 5000)
        self.assertTrue(Path(srt_p).exists())
        self.assertGreater(Path(srt_p).stat().st_size, 20)
        self.assertGreater(duration, 1.0)
        temp_dir.cleanup()

    def test_openai_tts_mocked_synthesis(self):
        from unittest.mock import patch, MagicMock
        from src.media.openai_tts import synthesize_openai_speech

        temp_dir = tempfile.TemporaryDirectory()
        out_dir = Path(temp_dir.name)
        audio_p = out_dir / "test_openai.mp3"
        srt_p = out_dir / "test_openai.srt"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = b"ID3FakeMP3AudioBytesForTesting"

        with patch("requests.post", return_value=mock_resp), \
             patch("src.media.openai_tts.probe_audio_duration_ffmpeg", return_value=24.5):
            duration = synthesize_openai_speech(
                text="Bakıda möhtəşəm 3 otaqlı mənzil satışa çıxarıldı",
                output_audio_path=audio_p,
                output_srt_path=srt_p,
                api_key="sk-testkey123"
            )
            self.assertEqual(duration, 24.5)
            self.assertTrue(audio_p.exists())
            self.assertTrue(srt_p.exists())
            content = srt_p.read_text(encoding="utf-8")
            self.assertIn("Bakıda möhtəşəm 3", content)

        temp_dir.cleanup()

    def test_elevenlabs_alignment_and_mocked_synthesis(self):
        from unittest.mock import patch, MagicMock
        from src.media.elevenlabs_tts import parse_alignment_to_words, build_word_level_srt, synthesize_elevenlabs_speech
        import base64

        # Test alignment parser
        fake_alignment = {
            "characters": ["B", "a", "k", "ı", " ", "e", "v"],
            "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
            "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
        }
        words = parse_alignment_to_words(fake_alignment)
        self.assertEqual(len(words), 2)
        self.assertEqual(words[0]["word"], "Bakı")
        self.assertEqual(words[1]["word"], "ev")
        self.assertAlmostEqual(words[0]["start"], 0.0)
        self.assertAlmostEqual(words[1]["end"], 0.7)

        srt = build_word_level_srt(words, words_per_chunk=2)
        self.assertIn("Bakı ev", srt)

        # Test mocked synthesis
        temp_dir = tempfile.TemporaryDirectory()
        out_dir = Path(temp_dir.name)
        audio_p = out_dir / "test_eleven.mp3"
        srt_p = out_dir / "test_eleven.srt"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "audio_base64": base64.b64encode(b"ID3FakeElevenLabsAudio").decode("utf-8"),
            "alignment": fake_alignment
        }

        with patch("requests.post", return_value=mock_resp):
            duration = synthesize_elevenlabs_speech(
                text="Bakı ev",
                output_audio_path=audio_p,
                output_srt_path=srt_p,
                api_key="xi-testkey123"
            )
            self.assertAlmostEqual(duration, 0.7)
            self.assertTrue(audio_p.exists())
            self.assertTrue(srt_p.exists())

        temp_dir.cleanup()

if __name__ == "__main__":
    unittest.main()
