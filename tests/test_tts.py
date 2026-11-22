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
        script, audio_p, srt_p, duration, engine_used, fallback_triggered = generate_tts_for_listing(
            sample, output_dir=out_dir, tts_engine="edge"
        )
        self.assertTrue(Path(audio_p).exists())
        self.assertGreater(Path(audio_p).stat().st_size, 5000)
        self.assertTrue(Path(srt_p).exists())
        self.assertGreater(Path(srt_p).stat().st_size, 20)
        self.assertGreater(duration, 1.0)
        self.assertIsInstance(engine_used, str)
        self.assertIsInstance(fallback_triggered, bool)
        temp_dir.cleanup()

    def test_6_tuple_unpack_and_engine_provenance(self):
        """Asserts generate_tts_for_listing returns a 6-tuple with engine and fallback info."""
        temp_dir = tempfile.TemporaryDirectory()
        out_dir = Path(temp_dir.name)
        sample = {
            "bina_id": "test_tuple",
            "price": 120000,
            "currency": "AZN",
            "location": "Yasamal",
            "rooms": 1,
            "area": 50,
            "has_bill_of_sale": True,
            "is_owner": True,
        }
        res = generate_tts_for_listing(sample, output_dir=out_dir, tts_engine="edge")
        self.assertEqual(len(res), 6)
        script, audio_p, srt_p, duration, engine_used, fallback_triggered = res
        self.assertTrue(Path(audio_p).exists())
        self.assertTrue(Path(srt_p).exists())
        self.assertGreater(duration, 0.0)
        self.assertEqual(engine_used, "edge")
        self.assertFalse(fallback_triggered)
        temp_dir.cleanup()

    def test_voice_speed_conversion_to_edge_rate(self):
        """Asserts numeric voice_speed converts to rate percentage on Edge-TTS fallback."""
        from unittest.mock import patch, AsyncMock
        from config.settings import EDGE_TTS_RATE
        temp_dir = tempfile.TemporaryDirectory()
        out_dir = Path(temp_dir.name)
        sample = {
            "bina_id": "test_speed",
            "price": 100000,
            "location": "Xırdalan",
        }
        expected_default_rate = EDGE_TTS_RATE or "+10%"

        # Case 1: voice_speed = 1.15 -> rate = "+15%"
        with patch("src.media.tts_service.synthesize_speech_async", new_callable=AsyncMock) as mock_synth:
            mock_synth.return_value = 15.0
            _script, _audio_p, _srt_p, _dur, _eng, _fb = generate_tts_for_listing(
                sample,
                output_dir=out_dir,
                tts_engine="edge",
                voice_speed=1.15,
            )
            mock_synth.assert_called_once()
            _, kwargs = mock_synth.call_args
            self.assertEqual(kwargs.get("rate"), "+15%")

        # Case 2: voice_speed = 1.0 -> defaults to EDGE_TTS_RATE or "+10%"
        with patch("src.media.tts_service.synthesize_speech_async", new_callable=AsyncMock) as mock_synth:
            mock_synth.return_value = 15.0
            generate_tts_for_listing(
                sample,
                output_dir=out_dir,
                tts_engine="edge",
                voice_speed=1.0,
            )
            mock_synth.assert_called_once()
            _, kwargs = mock_synth.call_args
            self.assertEqual(kwargs.get("rate"), expected_default_rate)

        # Case 3: voice_speed = None -> defaults to EDGE_TTS_RATE or "+10%"
        with patch("src.media.tts_service.synthesize_speech_async", new_callable=AsyncMock) as mock_synth:
            mock_synth.return_value = 15.0
            generate_tts_for_listing(
                sample,
                output_dir=out_dir,
                tts_engine="edge",
                voice_speed=None,
            )
            mock_synth.assert_called_once()
            _, kwargs = mock_synth.call_args
            self.assertEqual(kwargs.get("rate"), expected_default_rate)

        # Case 4: ElevenLabs fallback with voice_speed=1.15 -> rate = "+15%"
        with patch("requests.post", side_effect=Exception("ElevenLabs timeout")), \
             patch("src.media.tts_service.synthesize_speech_async", new_callable=AsyncMock) as mock_synth:
            mock_synth.return_value = 15.0
            _script, _a_p, _s_p, _dur, eng, fb = generate_tts_for_listing(
                sample,
                output_dir=out_dir,
                tts_engine="elevenlabs",
                voice_speed=1.15,
            )
            mock_synth.assert_called_once()
            _, kwargs = mock_synth.call_args
            self.assertEqual(kwargs.get("rate"), "+15%")
            self.assertEqual(eng, "edge_fallback")
            self.assertTrue(fb)

        temp_dir.cleanup()

    def test_elevenlabs_speed_parameter_serialized(self):
        """Asserts synthesize_elevenlabs_speech passes speed parameter into voice_settings."""
        from unittest.mock import patch, MagicMock
        from src.media.elevenlabs_tts import synthesize_elevenlabs_speech
        import base64

        temp_dir = tempfile.TemporaryDirectory()
        out_dir = Path(temp_dir.name)
        audio_p = out_dir / "speed_test.mp3"
        srt_p = out_dir / "speed_test.srt"

        fake_alignment = {
            "characters": ["B", "a", "k", "ı"],
            "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3],
            "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4]
        }
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "audio_base64": base64.b64encode(b"ID3FakeSpeedAudio").decode("utf-8"),
            "alignment": fake_alignment
        }

        with patch("requests.post", return_value=mock_resp) as mock_post:
            duration = synthesize_elevenlabs_speech(
                text="Bakı",
                output_audio_path=audio_p,
                output_srt_path=srt_p,
                api_key="xi-speedkey",
                speed=1.15,
            )
            mock_post.assert_called_once()
            call_kwargs = mock_post.call_args[1]
            payload = call_kwargs["json"]
            self.assertEqual(payload["voice_settings"]["speed"], 1.15)
            self.assertEqual(payload["voice_settings"]["stability"], 0.52)
            self.assertEqual(payload["voice_settings"]["similarity_boost"], 0.82)
            self.assertEqual(payload["voice_settings"]["style"], 0.28)
            self.assertTrue(payload["voice_settings"]["use_speaker_boost"])
            self.assertEqual(call_kwargs["timeout"], 15.0)

        temp_dir.cleanup()

    def test_elevenlabs_typed_synthesis_error_and_fallback(self):
        """Asserts ElevenLabsSynthesisError is raised on 401, 402, 429, 500, timeout, and triggers failover."""
        from unittest.mock import patch, MagicMock
        from src.media.elevenlabs_tts import synthesize_elevenlabs_speech, ElevenLabsSynthesisError
        import requests

        temp_dir = tempfile.TemporaryDirectory()
        out_dir = Path(temp_dir.name)
        audio_p = out_dir / "err_test.mp3"
        srt_p = out_dir / "err_test.srt"

        # 1. Direct call raises ElevenLabsSynthesisError on 401, 402, 429, 500, timeout
        for code in (401, 402, 429, 500, 503):
            mock_err_resp = MagicMock()
            mock_err_resp.status_code = code
            mock_err_resp.text = f"Error {code}"
            with patch("requests.post", return_value=mock_err_resp):
                with self.assertRaises(ElevenLabsSynthesisError):
                    synthesize_elevenlabs_speech(
                        text="Test error",
                        output_audio_path=audio_p,
                        output_srt_path=srt_p,
                        api_key="xi-key",
                    )

        with patch("requests.post", side_effect=requests.exceptions.Timeout("Read timed out")):
            with self.assertRaises(ElevenLabsSynthesisError):
                synthesize_elevenlabs_speech(
                    text="Test timeout",
                    output_audio_path=audio_p,
                    output_srt_path=srt_p,
                    api_key="xi-key",
                )

        # 2. generate_tts_for_listing catches ElevenLabsSynthesisError and falls back to Edge-TTS
        sample = {"bina_id": "fallback_test", "price": 100000}
        with patch("requests.post", side_effect=ElevenLabsSynthesisError("Quota exhausted")):
            with patch("src.media.tts_service.synthesize_speech_async") as mock_edge_synth:
                import asyncio
                mock_edge_synth.return_value = 12.0
                res = generate_tts_for_listing(
                    sample,
                    output_dir=out_dir,
                    tts_engine="elevenlabs",
                    voice_speed=1.15,
                )
                self.assertEqual(len(res), 6)
                _script, _a_p, _s_p, _dur, engine_used, fallback_triggered = res
                self.assertEqual(engine_used, "edge_fallback")
                self.assertTrue(fallback_triggered)

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


class TestAccountRouterVoiceAndDistrict(unittest.TestCase):
    """Asserts 100% ElevenLabs voice routing, numeric voice_speed, and geographic district precedence."""

    def test_100_percent_elevenlabs_and_numeric_voice_speed(self):
        from src.worker.account_router import (
            route_listing_to_channel,
            CHANNEL_TIKTOK,
            CHANNEL_LUXURY,
            CHANNEL_AFFORDABLE,
            CHANNEL_GENERAL,
        )
        from config.settings import ELEVENLABS_VOICE_ARIF, ELEVENLABS_VOICE_BANU

        # 1. TIKTOK niche (urgent or price drop >= 10%)
        res_tiktok = route_listing_to_channel({"price": 500_000, "is_urgent": True})
        self.assertEqual(res_tiktok["channel_niche"], CHANNEL_TIKTOK)
        self.assertEqual(res_tiktok["voice_engine"], "elevenlabs")
        self.assertEqual(res_tiktok["voice_id"], ELEVENLABS_VOICE_BANU)
        self.assertEqual(res_tiktok["voice_speed"], 1.15)
        self.assertIsInstance(res_tiktok["voice_speed"], float)

        # 2. LUXURY niche
        res_lux = route_listing_to_channel({"price": 300_000})
        self.assertEqual(res_lux["channel_niche"], CHANNEL_LUXURY)
        self.assertEqual(res_lux["voice_engine"], "elevenlabs")
        self.assertEqual(res_lux["voice_id"], ELEVENLABS_VOICE_ARIF)
        self.assertEqual(res_lux["voice_speed"], 1.0)
        self.assertIsInstance(res_lux["voice_speed"], float)

        # 3. AFFORDABLE niche
        res_aff = route_listing_to_channel({"price": 95_000})
        self.assertEqual(res_aff["channel_niche"], CHANNEL_AFFORDABLE)
        self.assertEqual(res_aff["voice_engine"], "elevenlabs")
        self.assertEqual(res_aff["voice_id"], ELEVENLABS_VOICE_BANU)
        self.assertEqual(res_aff["voice_speed"], 1.0)
        self.assertIsInstance(res_aff["voice_speed"], float)

        # 4. GENERAL niche
        res_gen = route_listing_to_channel({"price": 180_000, "location": "Yasamal"})
        self.assertEqual(res_gen["channel_niche"], CHANNEL_GENERAL)
        self.assertEqual(res_gen["voice_engine"], "elevenlabs")
        self.assertEqual(res_gen["voice_id"], ELEVENLABS_VOICE_ARIF)
        self.assertEqual(res_gen["voice_speed"], 1.0)
        self.assertIsInstance(res_gen["voice_speed"], float)

    def test_geographic_district_routing_precedence(self):
        from src.worker.account_router import (
            route_listing_to_channel,
            CHANNEL_LUXURY,
            CHANNEL_AFFORDABLE,
            CHANNEL_GENERAL,
            CHANNEL_TIKTOK,
        )

        # Elite central districts -> LUXURY even if price is < 250k
        elite_samples = [
            {"location": "Səbail rayonu, Sahil m.", "price": 180000},
            {"district_normalized": "Nəsimi", "price": 150000},
            {"location": "Nərimanov m.", "price": 190000},
            {"location": "Gənclik Mall yaxınlığı", "price": 160000},
            {"location": "Ağ Şəhər, Fəvvarələr meydanı", "price": 210000},
            {"location": "Badamdar qəs.", "price": 200000},
            {"location": "Bilgəh bağları", "price": 220000},
            {"location": "Mərdəkan qəsəbəsi", "price": 195000},
        ]
        for sample in elite_samples:
            res = route_listing_to_channel(sample)
            self.assertEqual(res["channel_niche"], CHANNEL_LUXURY, f"Failed for {sample}")
            self.assertEqual(res["voice_engine"], "elevenlabs")

        # Suburban districts -> AFFORDABLE even if price is > 120k (but < 250k)
        suburban_samples = [
            {"location": "Xırdalan şəhəri, Heydər Əliyev pr.", "price": 140000},
            {"district_normalized": "Masazır", "price": 135000},
            {"location": "Hövsan qəsəbəsi", "price": 130000},
            {"location": "Zabrat 1 qəs.", "price": 125000},
            {"location": "Suraxanı rayonu, Qaraçuxur", "price": 150000},
            {"location": "Binəqədi qəs.", "price": 145000},
            {"location": "Sabunçu rayonu, Bakıxanov qəs.", "price": 160000},
        ]
        for sample in suburban_samples:
            res = route_listing_to_channel(sample)
            self.assertEqual(res["channel_niche"], CHANNEL_AFFORDABLE, f"Failed for {sample}")
            self.assertEqual(res["voice_engine"], "elevenlabs")

        # Price boundary <= 120k -> AFFORDABLE
        res_aff_price = route_listing_to_channel({"price": 120000, "location": "Yasamal"})
        self.assertEqual(res_aff_price["channel_niche"], CHANNEL_AFFORDABLE)

        # Price boundary > 120k and < 250k non-elite non-suburban -> GENERAL
        res_gen_price = route_listing_to_channel({"price": 120001, "location": "Yasamal"})
        self.assertEqual(res_gen_price["channel_niche"], CHANNEL_GENERAL)

        # Priority 1: urgent overrides elite central district
        res_urgent_elite = route_listing_to_channel({
            "price": 400000,
            "location": "Ağ Şəhər",
            "is_urgent": True,
        })
        self.assertEqual(res_urgent_elite["channel_niche"], CHANNEL_TIKTOK)

    def test_generate_tts_for_listing_accepts_visual_profile(self):
        """Verifies generate_tts_for_listing accepts visual_profile without error and weaves into script."""
        from unittest.mock import patch
        from src.media.tts_service import generate_tts_for_listing
        from src.ai.vision_analyzer import PropertyVisualProfile

        sample_listing = {
            "bina_id": "test_vp_999",
            "location": "Nərimanov r.",
            "rooms": 3,
            "area": 120,
            "price": 280000,
        }
        vp = PropertyVisualProfile(
            renovation_quality="modern_luxury",
            hook_sentence_az="Lüks təmirli gözəl mənzil!",
            standout_features=["genis zal", "panoramik pəncərələr"],
        )
        with tempfile.TemporaryDirectory() as td:
            with patch("src.media.tts_service.synthesize_speech_async", return_value=25.0):
                res = generate_tts_for_listing(
                    listing=sample_listing,
                    output_dir=Path(td),
                    tts_engine="edge-tts",
                    visual_profile=vp,
                )
                script_text = res[0]
                self.assertIn("Lüks təmirli gözəl mənzil!", script_text)



if __name__ == "__main__":
    unittest.main()
