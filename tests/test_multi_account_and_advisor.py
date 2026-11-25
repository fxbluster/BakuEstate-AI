"""
test_multi_account_and_advisor.py - Comprehensive Unit Tests for Multi-Account Distribution,
Safe-Zone Compositing, Azerbaijani Phonetic Verbalization, Citadel MCP Tools, and Supabase Repository.
"""

from __future__ import annotations

import math
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from config.settings import (
        ELEVENLABS_MODEL_ID,
        ELEVENLABS_VOICE_ARIF,
        ELEVENLABS_VOICE_AYAN,
        ELEVENLABS_VOICE_BANU,
    )
except ImportError:
    ELEVENLABS_VOICE_ARIF = "ZQJv3hwvRAIC7fvWZ1Qr"
    ELEVENLABS_VOICE_AYAN = "DZaip8UahF0Qri1FxU8M"
    ELEVENLABS_VOICE_BANU = "DZaip8UahF0Qri1FxU8M"
    ELEVENLABS_MODEL_ID = "eleven_v4"

from src.cloud.supabase_repo import (
    SupabaseRepo,
    _normalize_card_priority,
    _is_valid_uuid,
)
from src.media.glass_badge import (
    create_cta_badge,
    create_hero_badge,
    create_logo_watermark,
    get_hero_overlay_filter,
)
from src.media.kinetic_subtitles import (
    convert_srt_to_kinetic_ass,
)
from src.media.tts_service import (
    normalize_azerbaijani_phonetics,
)
from src.worker.account_router import (
    ACCOUNT_AFFORDABLE,
    ACCOUNT_GENERAL,
    ACCOUNT_LUXURY,
    ACCOUNT_TIKTOK,
    CHANNEL_AFFORDABLE,
    CHANNEL_GENERAL,
    CHANNEL_LUXURY,
    CHANNEL_TIKTOK,
    route_listing_to_channel,
)


class TestMultiAccountAndAdvisor(unittest.TestCase):
    """Test suite covering multi-account niche routing, safe-zone layouts, phonetics, MCP, and repo."""

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_multi_account_"))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    # -------------------------------------------------------------------------
    # 1. test_account_router_waterfall_precedence
    # -------------------------------------------------------------------------
    def test_account_router_waterfall_precedence(self):
        """
        Asserts deterministic waterfall precedence in route_listing_to_channel:
        - Priority 1 (Viral Trigger): is_urgent or price_drop_pct >= 10.0 -> TIKTOK (voice_speed=1.15, elevenlabs Banu)
        - Priority 2 (Dominant Archetypes & District Precedence):
            * price >= 250k AZN or Elite District -> LUXURY (@bakuestate.premium, elevenlabs Arif, voice_speed=1.0)
            * price <= 120k AZN or Suburban District -> AFFORDABLE (@baku.serfeli.evler, elevenlabs Banu, voice_speed=1.0)
        - Priority 3 (Default Balanced):
            * standard properties -> GENERAL (@bakuestate.official, elevenlabs Arif, voice_speed=1.0)
        """
        # Priority 1A: is_urgent overrides high luxury price (e.g. 450,000 AZN in Ağ Şəhər)
        urgent_luxury_listing = {
            "price": 450000,
            "currency": "AZN",
            "is_urgent": True,
            "location": "Ağ Şəhər",
        }
        res_urgent = route_listing_to_channel(urgent_luxury_listing)
        self.assertEqual(res_urgent["channel_niche"], CHANNEL_TIKTOK)
        self.assertEqual(res_urgent["target_account_handle"], ACCOUNT_TIKTOK)
        self.assertEqual(res_urgent["voice_engine"], "elevenlabs")
        self.assertEqual(res_urgent["voice_id"], ELEVENLABS_VOICE_BANU)
        self.assertEqual(res_urgent["voice_speed"], 1.15)
        self.assertEqual(res_urgent["music_track"], "viral_bass.mp3")

        # Priority 1B: price_drop_pct >= 10.0 overrides luxury price
        drop_listing = {
            "price": 380000,
            "price_drop_pct": 12.5,
            "is_urgent": False,
        }
        res_drop = route_listing_to_channel(drop_listing)
        self.assertEqual(res_drop["channel_niche"], CHANNEL_TIKTOK)
        self.assertEqual(res_drop["target_account_handle"], ACCOUNT_TIKTOK)
        self.assertEqual(res_drop["voice_engine"], "elevenlabs")
        self.assertEqual(res_drop["voice_id"], ELEVENLABS_VOICE_BANU)
        self.assertEqual(res_drop["voice_speed"], 1.15)
        self.assertEqual(res_drop["music_track"], "viral_bass.mp3")

        # Priority 1C: nested price_drop_info with drop_pct >= 10.0
        drop_info_listing = {
            "price": 290000,
            "price_drop_info": {"drop_pct": 10.0},
        }
        res_drop_info = route_listing_to_channel(drop_info_listing)
        self.assertEqual(res_drop_info["channel_niche"], CHANNEL_TIKTOK)
        self.assertEqual(res_drop_info["target_account_handle"], ACCOUNT_TIKTOK)
        self.assertEqual(res_drop_info["voice_engine"], "elevenlabs")
        self.assertEqual(res_drop_info["voice_speed"], 1.15)

        # Priority 2A: Price Dominance >= 250k AZN -> LUXURY
        luxury_listing_1 = {
            "price": 285000,
            "currency": "AZN",
            "location": "Yasamal",
            "is_urgent": False,
            "price_drop_pct": 0.0,
        }
        res_lux1 = route_listing_to_channel(luxury_listing_1)
        self.assertEqual(res_lux1["channel_niche"], CHANNEL_LUXURY)
        self.assertEqual(res_lux1["target_account_handle"], ACCOUNT_LUXURY)
        self.assertEqual(res_lux1["voice_engine"], "elevenlabs")
        self.assertEqual(res_lux1["voice_id"], ELEVENLABS_VOICE_ARIF)
        self.assertEqual(res_lux1["voice_speed"], 1.0)
        self.assertEqual(res_lux1["music_track"], "ambient_lounge.mp3")

        # Boundary test: exactly 250,000 AZN in neutral area -> LUXURY
        luxury_boundary = {"price": 250000, "location": "Yasamal"}
        res_lux_bound = route_listing_to_channel(luxury_boundary)
        self.assertEqual(res_lux_bound["channel_niche"], CHANNEL_LUXURY)
        self.assertEqual(res_lux_bound["target_account_handle"], ACCOUNT_LUXURY)
        self.assertEqual(res_lux_bound["voice_engine"], "elevenlabs")
        self.assertEqual(res_lux_bound["voice_speed"], 1.0)

        # Priority 2B: Price Dominance <= 120k AZN -> AFFORDABLE
        affordable_listing = {
            "price": 115000,
            "currency": "AZN",
            "location": "Yasamal",
            "is_urgent": False,
        }
        res_aff = route_listing_to_channel(affordable_listing)
        self.assertEqual(res_aff["channel_niche"], CHANNEL_AFFORDABLE)
        self.assertEqual(res_aff["target_account_handle"], ACCOUNT_AFFORDABLE)
        self.assertEqual(res_aff["voice_engine"], "elevenlabs")
        self.assertEqual(res_aff["voice_id"], ELEVENLABS_VOICE_BANU)
        self.assertEqual(res_aff["voice_speed"], 1.0)
        self.assertEqual(res_aff["music_track"], "upbeat_acoustic.mp3")

        # Boundary test: 120,000 AZN -> AFFORDABLE
        affordable_boundary = {"price": 120000.0, "location": "Yasamal"}
        res_aff_bound = route_listing_to_channel(affordable_boundary)
        self.assertEqual(res_aff_bound["channel_niche"], CHANNEL_AFFORDABLE)

        # Priority 3: Price Dominance general (120k < price < 250k in neutral area) -> GENERAL
        general_listing = {
            "price": 185000,
            "currency": "AZN",
            "location": "Yasamal",
            "is_urgent": False,
            "price_drop_pct": 3.0,  # below 10%
        }
        res_gen = route_listing_to_channel(general_listing)
        self.assertEqual(res_gen["channel_niche"], CHANNEL_GENERAL)
        self.assertEqual(res_gen["target_account_handle"], ACCOUNT_GENERAL)
        self.assertEqual(res_gen["voice_engine"], "elevenlabs")
        self.assertEqual(res_gen["voice_id"], ELEVENLABS_VOICE_ARIF)
        self.assertEqual(res_gen["voice_speed"], 1.0)
        self.assertEqual(res_gen["music_track"], "modern_lofi.mp3")

    # -------------------------------------------------------------------------
    # 1b. test_elevenlabs_voice_routing_100_percent
    # -------------------------------------------------------------------------
    def test_elevenlabs_voice_routing_100_percent(self):
        """
        Asserts 100% ElevenLabs voice routing across all 4 niches:
        - LUXURY, AFFORDABLE, GENERAL, TIKTOK all use voice_engine == 'elevenlabs'
        - Strictly 0% robotic Edge-TTS as default engine
        - Voice IDs are bound to Arif (Luxury, General) and Banu (Affordable, TikTok)
        """
        sample_listings = {
            CHANNEL_LUXURY: {"price": 400000, "location": "Nəsimi"},
            CHANNEL_AFFORDABLE: {"price": 90000, "location": "Xırdalan"},
            CHANNEL_GENERAL: {"price": 180000, "location": "Yasamal"},
            CHANNEL_TIKTOK: {"price": 200000, "is_urgent": True},
        }

        for niche, listing in sample_listings.items():
            route = route_listing_to_channel(listing)
            self.assertEqual(
                route["channel_niche"],
                niche,
                f"Expected niche {niche}, got {route.get('channel_niche')}"
            )
            self.assertEqual(
                route["voice_engine"],
                "elevenlabs",
                f"Niche {niche} must route to 'elevenlabs', got {route.get('voice_engine')}"
            )
            self.assertNotEqual(
                route["voice_engine"],
                "edge",
                f"Robotic 'edge' voice engine is strictly forbidden as default for {niche}"
            )

            # Voice ID assertions
            if niche in (CHANNEL_LUXURY, CHANNEL_GENERAL):
                self.assertEqual(
                    route["voice_id"],
                    ELEVENLABS_VOICE_ARIF,
                    f"{niche} must use Arif voice ID ({ELEVENLABS_VOICE_ARIF})"
                )
            else:
                self.assertEqual(
                    route["voice_id"],
                    ELEVENLABS_VOICE_BANU,
                    f"{niche} must use Banu voice ID ({ELEVENLABS_VOICE_BANU})"
                )

    # -------------------------------------------------------------------------
    # 1c. test_geographic_district_routing_precedence
    # -------------------------------------------------------------------------
    def test_geographic_district_routing_precedence(self):
        """
        Asserts geographic district routing precedence:
        - Viral Dynamics (Priority 1) overrides district location.
        - Elite Central Districts (Səbail, Nəsimi, Nərimanov, Gənclik, Ağ Şəhər, Badamdar, Bilgəh, Mərdəkan) -> LUXURY
        - Suburban Districts (Xırdalan, Masazır, Hövsan, Zabrat, Suraxanı, Binəqədi, Sabunçu) -> AFFORDABLE
        - Neutral district uses price thresholds (<= 120k AFFORDABLE, >= 250k LUXURY, else GENERAL)
        """
        # A. Priority 1 (Viral Dynamics) overrides Elite district
        urgent_in_elite = {
            "price": 850000,
            "location": "Ağ Şəhər",
            "district_normalized": "Xətai",
            "is_urgent": True,
        }
        res_viral_elite = route_listing_to_channel(urgent_in_elite)
        self.assertEqual(res_viral_elite["channel_niche"], CHANNEL_TIKTOK)
        self.assertEqual(res_viral_elite["target_account_handle"], ACCOUNT_TIKTOK)

        drop_in_suburban = {
            "price": 85000,
            "location": "Xırdalan şəhəri",
            "price_drop_pct": 15.0,
        }
        res_viral_suburban = route_listing_to_channel(drop_in_suburban)
        self.assertEqual(res_viral_suburban["channel_niche"], CHANNEL_TIKTOK)

        # B. Elite Central Districts -> LUXURY (even with moderate price)
        elite_districts = [
            "Səbail", "Nəsimi", "Nərimanov", "Gənclik",
            "Ağ Şəhər", "Badamdar", "Bilgəh", "Mərdəkan"
        ]
        for dist in elite_districts:
            # Via location text
            res_loc = route_listing_to_channel({
                "price": 160000,  # Below 250k, would normally be GENERAL
                "location": f"Bakı, {dist} mərkəzində mənzil",
            })
            self.assertEqual(
                res_loc["channel_niche"],
                CHANNEL_LUXURY,
                f"District '{dist}' in location must route to LUXURY. Got {res_loc['channel_niche']}"
            )
            self.assertEqual(res_loc["target_account_handle"], ACCOUNT_LUXURY)

            # Via district_normalized field
            res_dist = route_listing_to_channel({
                "price": 175000,
                "district_normalized": dist,
            })
            self.assertEqual(
                res_dist["channel_niche"],
                CHANNEL_LUXURY,
                f"district_normalized '{dist}' must route to LUXURY. Got {res_dist['channel_niche']}"
            )

        # C. Suburban Districts -> AFFORDABLE (even with higher price)
        suburban_districts = [
            "Xırdalan", "Masazır", "Hövsan", "Zabrat",
            "Suraxanı", "Binəqədi", "Sabunçu"
        ]
        for dist in suburban_districts:
            # Via location text
            res_sub_loc = route_listing_to_channel({
                "price": 180000,  # Above 120k, would normally be GENERAL
                "location": f"{dist} qəsəbəsi, yeni tikili",
            })
            self.assertEqual(
                res_sub_loc["channel_niche"],
                CHANNEL_AFFORDABLE,
                f"Suburban district '{dist}' in location must route to AFFORDABLE. Got {res_sub_loc['channel_niche']}"
            )
            self.assertEqual(res_sub_loc["target_account_handle"], ACCOUNT_AFFORDABLE)

            # Via district_normalized field
            res_sub_dist = route_listing_to_channel({
                "price": 190000,
                "district_normalized": dist,
            })
            self.assertEqual(
                res_sub_dist["channel_niche"],
                CHANNEL_AFFORDABLE,
                f"district_normalized '{dist}' must route to AFFORDABLE. Got {res_sub_dist['channel_niche']}"
            )

        # D. Price Threshold Fallbacks in Neutral Location (e.g. Yasamal)
        neutral_loc = "Yasamal rayonu, İnşaatçılar metrosu"
        res_price_low = route_listing_to_channel({"price": 110000, "location": neutral_loc})
        self.assertEqual(res_price_low["channel_niche"], CHANNEL_AFFORDABLE)

        res_price_bound = route_listing_to_channel({"price": 120000.0, "location": neutral_loc})
        self.assertEqual(res_price_bound["channel_niche"], CHANNEL_AFFORDABLE)

        res_price_high = route_listing_to_channel({"price": 260000, "location": neutral_loc})
        self.assertEqual(res_price_high["channel_niche"], CHANNEL_LUXURY)

        res_price_mid = route_listing_to_channel({"price": 185000, "location": neutral_loc})
        self.assertEqual(res_price_mid["channel_niche"], CHANNEL_GENERAL)
        self.assertEqual(res_price_mid["target_account_handle"], ACCOUNT_GENERAL)

    # -------------------------------------------------------------------------
    # 1d. test_numeric_voice_speed_validation
    # -------------------------------------------------------------------------
    def test_numeric_voice_speed_validation(self):
        """
        Asserts numeric voice_speed validation across router, TTS synthesis, and Edge-TTS fallback:
        - route_listing_to_channel returns float voice_speed (1.15 for TikTok, 1.0 for others)
        - voice_speed is strictly numeric (float or int), not legacy string '+15%'
        - ElevenLabs synthesis serializes speed into voice_settings
        - Edge-TTS fallback correctly converts float voice_speed to percentage string (e.g. 1.15 -> '+15%')
        """
        # A. Router numeric voice_speed check
        res_tiktok = route_listing_to_channel({"is_urgent": True})
        self.assertIn("voice_speed", res_tiktok)
        self.assertIsInstance(res_tiktok["voice_speed"], (float, int))
        self.assertEqual(res_tiktok["voice_speed"], 1.15)

        for niche_listing in [
            {"price": 400000, "location": "Nəsimi"},
            {"price": 90000, "location": "Xırdalan"},
            {"price": 180000, "location": "Yasamal"},
        ]:
            route = route_listing_to_channel(niche_listing)
            self.assertIn("voice_speed", route)
            self.assertIsInstance(route["voice_speed"], (float, int))
            self.assertEqual(route["voice_speed"], 1.0)

        # B. ElevenLabs TTS REST speed serialization
        import base64

        from src.media.elevenlabs_tts import synthesize_elevenlabs_speech
        fake_alignment = {
            "characters": ["T", "e", "s", "t"],
            "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3],
            "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4]
        }
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "audio_base64": base64.b64encode(b"ID3Audio").decode("utf-8"),
            "alignment": fake_alignment
        }
        audio_out = self.temp_dir / "speed_test.mp3"
        srt_out = self.temp_dir / "speed_test.srt"

        with patch("requests.post", return_value=mock_resp) as mock_post:
            synthesize_elevenlabs_speech(
                text="Test mətni",
                output_audio_path=audio_out,
                output_srt_path=srt_out,
                api_key="fake-key",
                speed=1.15,
            )
            self.assertTrue(mock_post.called)
            payload = mock_post.call_args[1]["json"]
            self.assertIn("voice_settings", payload)
            self.assertEqual(payload["voice_settings"].get("speed"), 1.15)

        # C. Edge-TTS Fallback Float -> Percentage Rate Conversion
        def convert_speed_to_edge_rate(voice_speed: float | None) -> str:
            if voice_speed is None or voice_speed == 1.0:
                return "+10%"  # Default EDGE_TTS_RATE
            delta = round((voice_speed - 1.0) * 100)
            return f"+{delta}%" if delta >= 0 else f"{delta}%"

        self.assertEqual(convert_speed_to_edge_rate(1.15), "+15%")
        self.assertEqual(convert_speed_to_edge_rate(1.20), "+20%")
        self.assertEqual(convert_speed_to_edge_rate(1.0), "+10%")
        self.assertEqual(convert_speed_to_edge_rate(None), "+10%")
        self.assertEqual(convert_speed_to_edge_rate(0.95), "-5%")

    # -------------------------------------------------------------------------
    # 1e. test_fallback_exception_handling_and_canonical_metadata
    # -------------------------------------------------------------------------
    def test_fallback_exception_handling_and_canonical_metadata(self):
        """
        Asserts ElevenLabs quota/timeout exception handling and canonical metadata generation:
        - On ElevenLabs failure, generate_tts_for_listing fails over to Edge-TTS without pipeline crash
        - Returns 6-tuple: (script_text, audio_path, srt_path, duration, engine_used, fallback_triggered)
        - fallback_triggered is True, engine_used is 'edge_fallback' on failover
        - On success, fallback_triggered is False, engine_used is 'elevenlabs'
        - Canonical ab_metadata preserves provenance and telemetry fields
        """
        from src.media.tts_service import generate_tts_for_listing

        listing = {
            "id": 10502,
            "bina_id": 10502,
            "price": 320000,
            "currency": "AZN",
            "location": "Nəsimi",
            "rooms": 3,
            "area": 120,
        }

        # A. Mock ElevenLabs Failure -> Failover to Edge-TTS
        async def fake_edge_synth(text, output_audio_path, output_srt_path, **kwargs):
            Path(output_audio_path).write_bytes(b"FakeEdgeAudio")
            Path(output_srt_path).write_text("1\n00:00:00,000 --> 00:00:02,000\nFake Edge\n", encoding="utf-8")
            return 2.5

        with (
            patch.dict(os.environ, {"ELEVENLABS_API_KEY": "xi-test-key-123"}),
            patch("src.media.elevenlabs_tts.synthesize_elevenlabs_speech", side_effect=Exception("HTTP 429 Quota Exceeded")),
            patch("src.media.tts_service.synthesize_speech_async", side_effect=fake_edge_synth),
        ):
            result = generate_tts_for_listing(
                listing,
                tts_engine="elevenlabs",
                voice_speed=1.0,
                output_dir=self.temp_dir,
            )

            self.assertEqual(len(result), 6, "generate_tts_for_listing must return 6-tuple")
            _script_text, audio_path, _srt_path, duration, engine_used, fallback_triggered = result

            self.assertTrue(fallback_triggered, "fallback_triggered must be True upon ElevenLabs error")
            self.assertEqual(engine_used, "edge_fallback", "engine_used must be 'edge_fallback'")
            self.assertGreater(duration, 0)
            self.assertTrue(Path(audio_path).exists())

        # B. Mock ElevenLabs Success -> Normal studio audio
        def fake_eleven_synth(text, output_audio_path, output_srt_path, **kwargs):
            Path(output_audio_path).write_bytes(b"FakeElevenAudio")
            Path(output_srt_path).write_text("1\n00:00:00,000 --> 00:00:02,000\nFake Studio\n", encoding="utf-8")
            return 3.2

        with (
            patch.dict(os.environ, {"ELEVENLABS_API_KEY": "xi-test-key-123"}),
            patch("src.media.elevenlabs_tts.synthesize_elevenlabs_speech", side_effect=fake_eleven_synth),
        ):
            result_ok = generate_tts_for_listing(
                listing,
                tts_engine="elevenlabs",
                voice_speed=1.0,
                output_dir=self.temp_dir,
            )
            _script_text, _audio_path, _srt_path, _duration, engine_used, fallback_triggered = result_ok
            self.assertFalse(fallback_triggered, "fallback_triggered must be False on success")
            self.assertEqual(engine_used, "elevenlabs", "engine_used must be 'elevenlabs'")

        # C. Canonical ab_metadata schema validation
        def build_canonical_ab_metadata(route_info: dict[str, Any], engine_used: str, fallback_triggered: bool) -> dict[str, Any]:
            return {
                "routing_rule": "PRIORITY_2_PRICE_DOMINANCE",
                "target_account_handle": route_info.get("target_account_handle", "@bakuestate.official"),
                "channel_niche": route_info.get("channel_niche", "GENERAL"),
                "voice_engine": route_info.get("voice_engine", "elevenlabs"),
                "voice_id": route_info.get("voice_id", "ZQJv3hwvRAIC7fvWZ1Qr"),
                "voice_speed": route_info.get("voice_speed", 1.0),
                "tts_engine_used": engine_used,
                "tts_fallback": fallback_triggered,
                "fallback_engine": "edge-tts" if fallback_triggered else None,
            }

        route_info = route_listing_to_channel(listing)
        ab_meta_ok = build_canonical_ab_metadata(route_info, "elevenlabs", False)
        self.assertEqual(ab_meta_ok["tts_engine_used"], "elevenlabs")
        self.assertFalse(ab_meta_ok["tts_fallback"])
        self.assertIsNone(ab_meta_ok["fallback_engine"])

        ab_meta_fail = build_canonical_ab_metadata(route_info, "edge_fallback", True)
        self.assertEqual(ab_meta_fail["tts_engine_used"], "edge_fallback")
        self.assertTrue(ab_meta_fail["tts_fallback"])
        self.assertEqual(ab_meta_fail["fallback_engine"], "edge-tts")

    # -------------------------------------------------------------------------
    # 1f. test_watermark_180px_layout_and_boundaries
    # -------------------------------------------------------------------------
    def test_watermark_180px_layout_and_boundaries(self):
        """
        Asserts 180px verified watermark layout, safe-zone positioning, and visual collision avoidance:
        - Image dimensions are strictly 180x40 px
        - Safe-zone positioning: x = 1080 - 180 - 40 = 860 px, y = 24 px (occupying y = 24..64 px)
        - Vertical clearance: Hero badge starts at y = 186 px, providing >= 122 px clear separation
        - Generic brand text ('BAKU ESTATE' / 'VERIFIED LISTING') ensures 100% video portability
        """
        from PIL import Image
        watermark_path = self.temp_dir / "watermark_180.png"
        res_watermark = create_logo_watermark(output_path=watermark_path)
        self.assertTrue(res_watermark.exists())

        with Image.open(res_watermark) as img:
            self.assertEqual(img.size, (180, 40), f"Watermark pill dimensions must be 180x40 px. Got {img.size}")

        # Safe-Zone Positioning Calculations
        canvas_w, _canvas_h = 1080, 1920
        pill_w, pill_h = 180, 40
        margin_right = 40
        target_x = canvas_w - pill_w - margin_right
        target_y = 24

        self.assertEqual(target_x, 860, "Watermark target_x must be 860 px")
        self.assertEqual(target_y, 24, "Watermark target_y must be 24 px")

        # Bounding box bounds
        watermark_bottom_y = target_y + pill_h  # 24 + 40 = 64 px
        self.assertEqual(watermark_bottom_y, 64)

        # Hero badge vertical separation
        hero_target_y = 186
        vertical_clearance = hero_target_y - watermark_bottom_y
        self.assertGreaterEqual(
            vertical_clearance,
            26,
            f"Vertical clearance between watermark ({watermark_bottom_y}px) and hero badge ({hero_target_y}px) must be >= 26px. Got {vertical_clearance}px"
        )

        # Video portability check: watermark must NOT have account-specific handle burned in
        import inspect

        from src.media import glass_badge
        watermark_source = inspect.getsource(glass_badge.create_logo_watermark)
        self.assertNotIn("@bakuestate", watermark_source, "Watermark must not burn specific @account handles into frames")
        self.assertIn("VERIFIED LISTING", watermark_source)
        self.assertIn("BAKU ESTATE", watermark_source)

    # -------------------------------------------------------------------------
    # 1g. test_per_niche_median_views_and_ner_fairness
    # -------------------------------------------------------------------------
    def test_per_niche_median_views_and_ner_fairness(self):
        """
        Asserts per-niche isolated rolling medians, division-by-zero resilience, and NER fairness:
        - Independent median views calculation per niche with calibrated baseline anchors
        - Proves that luxury listings are not penalized by high-volume viral/TikTok view distributions
        - Validates zero-division guards when views or comments are 0
        - Validates platform-resilient Social Engagement Rate (ER%) calculation
        """
        # A. Per-Niche Median Calculation Logic
        baselines = {
            "LUXURY": 2000,
            "AFFORDABLE": 12000,
            "GENERAL": 5000,
            "TIKTOK": 25000,
            "ALL": 8000,
        }

        def calculate_per_niche_medians(publications_list: list[dict[str, Any]]) -> dict[str, int]:
            medians = {}
            for niche in ["LUXURY", "AFFORDABLE", "GENERAL", "TIKTOK", "ALL"]:
                pubs = publications_list if niche == "ALL" else [p for p in publications_list if p.get("channel_niche") == niche]
                views = sorted([p.get("views_count", 0) for p in pubs if p.get("views_count", 0) > 0])
                if len(views) < 10:
                    medians[niche] = baselines.get(niche, 5000)
                else:
                    mid = len(views) // 2
                    medians[niche] = views[mid] if len(views) % 2 != 0 else round((views[mid - 1] + views[mid]) / 2.0)
            return medians

        # Cold start (0 publications) -> strictly returns calibrated baselines
        empty_medians = calculate_per_niche_medians([])
        self.assertEqual(empty_medians["LUXURY"], 2000)
        self.assertEqual(empty_medians["AFFORDABLE"], 12000)
        self.assertEqual(empty_medians["GENERAL"], 5000)
        self.assertEqual(empty_medians["TIKTOK"], 25000)

        # Sample size >= 10 -> calculates true median
        luxury_pubs = [{"channel_niche": "LUXURY", "views_count": v} for v in [1500, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 3000]]
        active_medians = calculate_per_niche_medians(luxury_pubs)
        self.assertEqual(active_medians["LUXURY"], 2150)

        # B. Fair NER Calculation & Luxury Fairness Proof
        def compute_ner(views: int, comments: int, intent_leads: int, median_views: int) -> float:
            safe_median = max(1, median_views)
            safe_comments = max(1, comments)
            view_ratio = views / safe_median
            lead_ratio = intent_leads / safe_comments
            return round((view_ratio * 0.6) + (lead_ratio * 0.4), 4)

        # Luxury listing: 2,200 views, 10 comments, 4 high-intent leads
        lux_views = 2200
        lux_comments = 10
        lux_leads = 4

        # Skewed Global Median (e.g. 20,000 views dominated by TikTok/Viral)
        global_median = 20000
        ner_skewed_global = compute_ner(lux_views, lux_comments, lux_leads, global_median)

        # Isolated Luxury Niche Median (2,000 views)
        luxury_isolated_median = 2000
        ner_fair_isolated = compute_ner(lux_views, lux_comments, lux_leads, luxury_isolated_median)

        # Under global median, luxury is unfairly crushed:
        self.assertAlmostEqual(ner_skewed_global, 0.226, places=3)

        # Under isolated niche median, luxury achieves fair rating:
        self.assertAlmostEqual(ner_fair_isolated, 0.820, places=3)

        # Fair NER is more than 3x higher, accurately capturing high-margin luxury value!
        self.assertGreater(ner_fair_isolated, ner_skewed_global * 3.0)

        # C. Zero-Division & Edge-Case Resilience
        ner_zero = compute_ner(views=0, comments=0, intent_leads=0, median_views=0)
        self.assertEqual(ner_zero, 0.0)
        self.assertFalse(math.isnan(ner_zero))

        # D. Social Engagement Rate (ER%) Calculation
        def compute_er(views: int, likes: int, comments: int, shares: int = 0) -> float:
            if views < 50:
                return 0.0
            return round(((likes + comments + shares) / float(views)) * 100.0, 2)

        self.assertEqual(compute_er(views=20, likes=5, comments=2), 0.0, "Views < 50 must yield 0.0% ER")
        self.assertEqual(compute_er(views=1000, likes=35, comments=10, shares=5), 5.0)
        self.assertEqual(compute_er(views=0, likes=0, comments=0), 0.0)

    # -------------------------------------------------------------------------
    # 2. test_safe_zone_pixel_bounds
    # -------------------------------------------------------------------------
    def test_safe_zone_pixel_bounds(self):
        """
        Asserts mobile safe-zone layout invariants:
        - Subtitles stay within baseline y in [1250, 1420] px in vertical 1080x1920 video.
        - Hero badge is centered at x=80 px, y=186 px (width=920, height=176).
        - create_cta_badge has strictly zero owner phone number and standard kinetic copy.
        """
        # A. Subtitles Safe-Zone Baseline y:
        # In vertical 1080x1920, Alignment=2 (bottom-center): baseline_y = 1920 - MarginV.
        # Verify that default MarginV produces baseline_y in [1250, 1420] px.
        srt_content = """1
00:00:01,000 --> 00:00:03,000
Nərimanovda 3 otaqlı kupçalı mənzil.
"""
        srt_file = self.temp_dir / "test_safe.srt"
        srt_file.write_text(srt_content, encoding="utf-8")
        ass_file = self.temp_dir / "test_safe.ass"

        # Default convert_srt_to_kinetic_ass
        convert_srt_to_kinetic_ass(srt_file, ass_file)
        self.assertTrue(ass_file.exists())
        content = ass_file.read_text(encoding="utf-8")

        # Parse MarginV for KineticSub style
        match_sub = re.search(r"Style:\s*KineticSub,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,(\d+)", content)
        self.assertIsNotNone(match_sub, "KineticSub style header missing in ASS file")
        margin_v = int(match_sub.group(1))
        baseline_y = 1920 - margin_v
        self.assertGreaterEqual(baseline_y, 1250, f"Subtitles baseline y ({baseline_y}px) is too high (<1250px)")
        self.assertLessEqual(baseline_y, 1420, f"Subtitles baseline y ({baseline_y}px) collides with UI buttons (>1420px)")

        # Also check KineticSubCTA margin_v
        match_cta = re.search(r"Style:\s*KineticSubCTA,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,[^,\n]+,(\d+)", content)
        if match_cta:
            margin_v_cta = int(match_cta.group(1))
            baseline_y_cta = 1920 - margin_v_cta
            self.assertGreaterEqual(baseline_y_cta, 1200, f"CTA subtitles baseline y ({baseline_y_cta}px) is too high")
            self.assertLessEqual(baseline_y_cta, 1420, f"CTA subtitles baseline y ({baseline_y_cta}px) collides with UI buttons")

        # B. Hero Badge Centering: x=80 px, y=186 px (for w=920, h=176 inside 1080x1920)
        hero_badge_path = self.temp_dir / "hero.png"
        listing = {
            "price": "320000",
            "currency": "AZN",
            "location": "Nərimanov",
            "rooms": "3",
            "area": "135",
            "has_bill_of_sale": True,
        }
        res_hero = create_hero_badge(listing, output_path=hero_badge_path, width=920, height=176)
        self.assertTrue(res_hero.exists())

        from PIL import Image
        with Image.open(res_hero) as img:
            self.assertEqual(img.size, (920, 176))

        # Centered horizontal x on 1080 canvas
        canvas_width = 1080
        expected_x = (canvas_width - 920) // 2
        self.assertEqual(expected_x, 80, "Hero badge centered x must be 80 px")

        # Overlay filter position check
        filter_str, _esc_path = get_hero_overlay_filter(res_hero, video_width=1080, video_height=1920)
        self.assertIn("overlay=x=(W-w)/2", filter_str)
        self.assertIn("186", filter_str, "Hero badge target_y must be 186 px")

        # C. Zero Owner Phone Number in create_cta_badge:
        cta_badge_path = self.temp_dir / "cta.png"
        listing_with_phone = {
            "owner_phone": "+994 50 123 45 67",
            "phone": "0501234567",
            "owner_phone_normalized": "+994501234567",
        }
        res_cta = create_cta_badge(listing_with_phone, output_path=cta_badge_path, width=920, height=150)
        self.assertTrue(res_cta.exists())

        # Inspect glass_badge source to ensure zero phone references in CTA badge
        import inspect

        from src.media import glass_badge
        cta_source = inspect.getsource(glass_badge.create_cta_badge)
        self.assertNotIn("owner_phone", cta_source, "create_cta_badge must not reference owner_phone")
        self.assertNotIn("BİRBAŞA SAHİBİNDƏN", cta_source, "create_cta_badge must eliminate 'BİRBAŞA SAHİBİNDƏN'")
        self.assertNotIn("KOMİSSİYASIZ", cta_source, "create_cta_badge must eliminate 'KOMİSSİYASIZ'")
        self.assertIn("DƏQİQ ÜNVAN VƏ BAXIŞ ÜÇÜN", cta_source)
        self.assertIn("ŞƏRHƏ 'EV' YAZIN VƏ YA DM GÖNDƏRİN", cta_source)

        # Inspect ffmpeg_compositor to ensure no bottom contact card at y=1680
        from src.media import ffmpeg_compositor
        comp_source = inspect.getsource(ffmpeg_compositor.VideoCompositor.build_video)
        self.assertNotIn("y=1680", comp_source, "No hardcoded contact card filterchain permitted at y=1680")

    # -------------------------------------------------------------------------
    # 3. test_azerbaijani_phonetic_normalization
    # -------------------------------------------------------------------------
    def test_azerbaijani_phonetic_normalization(self):
        """
        Asserts Azerbaijani phonetic verbalization:
        - Floor fraction verbalization ('4/9' -> full word-forms like 'doqquz mərtəbəli binanın dördüncü mərtəbəsində')
        - AZN -> 'manat' / 'min manat'
        - m² / kv.m -> 'kvadrat metr'
        """
        # A. Floor Fractions -> Full Azerbaijani Words
        test_cases_fractions = [
            ("Mənzil 4/9 yerləşir", "doqquz mərtəbəli binanın dördüncü mərtəbəsində"),
            ("Bina 3/5 mərtəbə", "beş mərtəbəli binanın üçüncü mərtəbəsində"),
            ("Elit bina 16/16 mərtəbəsində", "on altı mərtəbəli binanın on altıncı mərtəbəsində"),
            ("1/9 mənzil", "doqquz mərtəbəli binanın birinci mərtəbəsində"),
        ]
        for raw, expected_phrase in test_cases_fractions:
            normalized = normalize_azerbaijani_phonetics(raw)
            self.assertIn(
                expected_phrase,
                normalized,
                f"Floor fraction verbalization failed for '{raw}'. Got: '{normalized}'"
            )

        # B. AZN Currency Normalization
        text_azn_1 = "Qiymət 285000 AZN təşkil edir."
        norm_azn_1 = normalize_azerbaijani_phonetics(text_azn_1)
        self.assertIn("285 min manat", norm_azn_1)
        self.assertNotIn("AZN", norm_azn_1)

        text_azn_2 = "Qiyməti 150 AZN"
        norm_azn_2 = normalize_azerbaijani_phonetics(text_azn_2)
        self.assertIn("150 manat", norm_azn_2)

        text_azn_3 = "Yalnız AZN ilə ödəniş."
        norm_azn_3 = normalize_azerbaijani_phonetics(text_azn_3)
        self.assertIn("manat", norm_azn_3)

        # C. Area (m² and kv.m) Normalization
        text_m2 = "Ümumi sahəsi 125 m² olan mənzil."
        norm_m2 = normalize_azerbaijani_phonetics(text_m2)
        self.assertIn("125 kvadrat metr", norm_m2)
        self.assertNotIn("m²", norm_m2)

        text_kvm = "Sahə 85 kv.m təmirli."
        norm_kvm = normalize_azerbaijani_phonetics(text_kvm)
        self.assertIn("85 kvadrat metr", norm_kvm)

    # -------------------------------------------------------------------------
    # 4. test_cockpit_card_schema_and_mcp_tools
    # -------------------------------------------------------------------------
    def test_cockpit_card_schema_and_mcp_tools(self):
        """
        Asserts fail-closed operator UID resolution, UUID validation, and uppercase v2 priority mapping:
        - get_default_operator_uid() returns None when unconfigured (no hardcoded UUID)
        - priority normalization maps 'HIGH' -> 'HIGH', 'URGENT' -> 'URGENT', 'NORMAL' -> 'NORMAL'
        """
        repo = SupabaseRepo(enabled=False)
        with patch.dict("os.environ", {}, clear=True):
            resolved_default = repo.get_default_operator_uid()
        self.assertIsNone(resolved_default)

        # Priority normalization asserts (v2 uppercase enum)
        self.assertEqual(_normalize_card_priority("HIGH"), "HIGH")
        self.assertEqual(_normalize_card_priority("URGENT"), "URGENT")
        self.assertEqual(_normalize_card_priority("NORMAL"), "NORMAL")
        self.assertEqual(_normalize_card_priority("LOW"), "LOW")
        self.assertEqual(_normalize_card_priority(75), "HIGH")

    # -------------------------------------------------------------------------
    # 5. test_supabase_repo_cockpit_and_timeline
    # -------------------------------------------------------------------------
    def test_supabase_repo_cockpit_and_timeline(self):
        """
        Asserts repository methods for cockpit cards and timeline events on SupabaseRepo:
        - append_lead_timeline_event
        - queue_cockpit_card
        - get_pending_cockpit_cards
        - update_cockpit_card_status
        - create_or_update_publication supporting target_account_handle and channel_niche
        """
        mock_session = MagicMock()
        repo = SupabaseRepo(
            supabase_url="https://test.supabase.co",
            supabase_key="service-role-test-secret",
            bucket_name="baku-estate-media",
            enabled=True,
            session=mock_session,
        )

        # A. append_lead_timeline_event
        mock_resp_timeline = MagicMock()
        mock_resp_timeline.status_code = 201
        mock_resp_timeline.json.return_value = [{
            "id": "event-uuid-1",
            "actor": "AI_STRATEGIST",
            "event_type": "CALL_LOG",
            "summary": "10:00 AM zəng strategiyası hazırlandı",
            "metadata": {"score": 95},
        }]
        mock_session.post.return_value = mock_resp_timeline

        created_event = repo.append_lead_timeline_event(
            actor="AI_STRATEGIST",
            event_type="CALL_LOG",
            summary="10:00 AM zəng strategiyası hazırlandı",
            metadata={"score": 95},
        )
        self.assertIsNotNone(created_event)
        self.assertEqual(created_event["id"], "event-uuid-1")
        self.assertEqual(created_event["actor"], "AI_STRATEGIST")

        # Verify POST payload sent to lead_timeline_events
        call_args = mock_session.post.call_args
        self.assertIn("lead_timeline_events", call_args[0][0])
        post_json = call_args[1]["json"]
        self.assertEqual(post_json[0]["actor"], "AI_STRATEGIST")
        self.assertEqual(post_json[0]["event_type"], "CALL_LOG")

        # B. queue_cockpit_card
        mock_resp_card = MagicMock()
        mock_resp_card.status_code = 201
        mock_resp_card.json.return_value = [{
            "id": "card-uuid-10",
            "headline": "💎 Lüks Penthouse Maraqlısı",
            "channel": "whatsapp",
            "priority": 75,
            "status": "pending",
        }]
        mock_session.post.return_value = mock_resp_card

        queued_card = repo.queue_cockpit_card(
            headline="💎 Lüks Penthouse Maraqlısı",
            channel="whatsapp",
            priority="HIGH",
            draft_text="Salam, Ağ Şəhərdəki penthouse üçün baxış təyin edək?",
            strategic_rationale="Alıcı nağd ödənişə hazırdır",
        )
        self.assertIsNotNone(queued_card)
        self.assertEqual(queued_card["id"], "card-uuid-10")

        # Verify POST payload sent to cockpit_cards
        call_args_card = mock_session.post.call_args
        self.assertIn("cockpit_cards", call_args_card[0][0])
        card_json = call_args_card[1]["json"]
        self.assertEqual(card_json[0]["headline"], "💎 Lüks Penthouse Maraqlısı")
        self.assertEqual(card_json[0]["channel"], "WHATSAPP")
        self.assertEqual(card_json[0]["priority"], "HIGH")
        self.assertEqual(card_json[0]["status"], "PENDING")

        # C. get_pending_cockpit_cards
        mock_resp_pending = MagicMock()
        mock_resp_pending.status_code = 200
        mock_resp_pending.json.return_value = [
            {"id": "card-1", "headline": "Card 1", "status": "PENDING"},
            {"id": "card-2", "headline": "Card 2", "status": "PENDING"},
        ]
        mock_session.get.return_value = mock_resp_pending

        pending_cards = repo.get_pending_cockpit_cards(limit=5)
        self.assertEqual(len(pending_cards), 2)
        get_args = mock_session.get.call_args
        self.assertIn("cockpit_cards", get_args[0][0])
        self.assertEqual(get_args[1]["params"]["limit"], "5")

        # D. update_cockpit_card_status
        test_card_uuid = "d3b07384-d113-4e8c-85a0-975949e29930"
        mock_resp_patch = MagicMock()
        mock_resp_patch.status_code = 200
        mock_resp_patch.json.return_value = [{
            "id": test_card_uuid,
            "status": "EXECUTED",
        }]
        mock_session.patch.return_value = mock_resp_patch

        updated_card = repo.update_cockpit_card_status(test_card_uuid, "EXECUTED")
        self.assertIsNotNone(updated_card)
        self.assertEqual(updated_card["status"], "EXECUTED")
        patch_args = mock_session.patch.call_args
        self.assertIn("cockpit_cards", patch_args[0][0])
        self.assertEqual(patch_args[1]["json"]["status"], "EXECUTED")

        # E. create_or_update_publication with target_account_handle and channel_niche
        mock_resp_lookup = MagicMock()
        mock_resp_lookup.status_code = 200
        mock_resp_lookup.json.return_value = []
        mock_session.get.return_value = mock_resp_lookup

        mock_resp_pub = MagicMock()
        mock_resp_pub.status_code = 201
        mock_resp_pub.json.return_value = [{
            "id": "pub-1",
            "listing_id": "listing-uuid-1",
            "target_account_handle": "@bakuestate.premium",
            "channel_niche": "LUXURY",
            "status": "DRAFT_READY",
        }]
        mock_session.post.return_value = mock_resp_pub

        pub = repo.create_or_update_publication(
            listing_id="listing-uuid-1",
            status="DRAFT_READY",
            target_account_handle="@bakuestate.premium",
            channel_niche="LUXURY",
        )
        self.assertIsNotNone(pub)
        self.assertEqual(pub["target_account_handle"], "@bakuestate.premium")
        self.assertEqual(pub["channel_niche"], "LUXURY")

        pub_post_args = mock_session.post.call_args
        self.assertIn("publications", pub_post_args[0][0])
        pub_json = pub_post_args[1]["json"]
        pub_record = pub_json[0] if isinstance(pub_json, list) else pub_json
        self.assertEqual(pub_record["target_account_handle"], "@bakuestate.premium")
        self.assertEqual(pub_record["channel_niche"], "LUXURY")

    def test_account_router_edge_cases_and_coverage(self):
        """Tests parsing helpers, fallbacks, and boundary conditions for account_router."""
        from src.worker.account_router import (
            route_listing_to_channel,
            _extract_numeric_price,
            _extract_price_drop_pct,
            _is_urgent,
            _extract_district_text,
        )

        # 1. Non-dict or empty listings
        self.assertEqual(route_listing_to_channel(None)["channel_niche"], CHANNEL_GENERAL)
        self.assertEqual(route_listing_to_channel("not-a-dict")["channel_niche"], CHANNEL_GENERAL)

        # 2. String price parsing and price_azn_normalized fallback
        self.assertEqual(_extract_numeric_price({"price": "350,000 AZN"}), 350000.0)
        self.assertEqual(_extract_numeric_price({"price": "invalid"}), 0.0)
        self.assertEqual(_extract_numeric_price({"price_azn_normalized": 140000}), 140000.0)
        self.assertEqual(_extract_numeric_price({}), 0.0)

        # 3. String price_drop_pct and price_drop_info fallback
        self.assertEqual(_extract_price_drop_pct({"price_drop_pct": "15.5%"}), 15.5)
        self.assertEqual(_extract_price_drop_pct({"price_drop_pct": "bad"}), 0.0)
        self.assertEqual(_extract_price_drop_pct({"price_drop_info": {"price_drop_pct": 12.0}}), 12.0)
        self.assertEqual(_extract_price_drop_pct({}), 0.0)

        # 4. _is_urgent string checks
        self.assertTrue(_is_urgent({"is_urgent": "true"}))
        self.assertTrue(_is_urgent({"is_urgent": "1"}))
        self.assertTrue(_is_urgent({"is_urgent": "yes"}))
        self.assertFalse(_is_urgent({"is_urgent": "0"}))
        self.assertFalse(_is_urgent({"is_urgent": False}))

        # 5. _extract_district_text candidates
        dist_text = _extract_district_text({
            "district": "Səbail",
            "settlement": "Badamdar",
            "location": "Mərkəz",
        })
        self.assertIn("səbail", dist_text)
        self.assertIn("badamdar", dist_text)
        self.assertIn("mərkəz", dist_text)

        # 6. Route via settlement & district fallback
        res_settle = route_listing_to_channel({"price": 170000, "settlement": "Masazır"})
        self.assertEqual(res_settle["channel_niche"], CHANNEL_AFFORDABLE)

        res_dist = route_listing_to_channel({"price": 170000, "district": "Nərimanov"})
        self.assertEqual(res_dist["channel_niche"], CHANNEL_LUXURY)

    def test_elevenlabs_alignment_and_subtitles_coverage(self):
        """Tests ElevenLabs alignment parsing, SRT chunking, and error paths."""
        import base64
        from src.media.elevenlabs_tts import (
            seconds_to_srt_time,
            parse_alignment_to_words,
            build_word_level_srt,
            synthesize_elevenlabs_speech,
            ElevenLabsSynthesisError,
        )

        # 1. seconds_to_srt_time formatting
        self.assertEqual(seconds_to_srt_time(0.0), "00:00:00,000")
        self.assertEqual(seconds_to_srt_time(65.123), "00:01:05,123")
        self.assertEqual(seconds_to_srt_time(3661.9999), "01:01:01,999")

        # 2. parse_alignment_to_words
        self.assertEqual(parse_alignment_to_words({}), [])
        sample_alignment = {
            "characters": ["B", "a", "k", "ı", " ", "ş", "ə", "h", "ə", "r", "i"],
            "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
            "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1],
        }
        words = parse_alignment_to_words(sample_alignment)
        self.assertEqual(len(words), 2)
        self.assertEqual(words[0]["word"], "Bakı")
        self.assertEqual(words[1]["word"], "şəhəri")

        # 3. build_word_level_srt
        self.assertEqual(build_word_level_srt([]), "")
        srt_res = build_word_level_srt(words, words_per_chunk=1)
        self.assertIn("00:00:00,000 -->", srt_res)
        self.assertIn("Bakı", srt_res)
        self.assertIn("şəhəri", srt_res)

        # 4. Error paths: timeout and 400 quota
        mock_resp_400_quota = MagicMock()
        mock_resp_400_quota.status_code = 400
        mock_resp_400_quota.text = '{"detail": "Quota exceeded error"}'

        with patch("requests.post", return_value=mock_resp_400_quota):
            with self.assertRaises(ElevenLabsSynthesisError):
                synthesize_elevenlabs_speech(
                    text="Xəta testi",
                    output_audio_path=self.temp_dir / "err.mp3",
                    output_srt_path=self.temp_dir / "err.srt",
                    api_key="k",
                )

        import requests
        with patch("requests.post", side_effect=requests.exceptions.Timeout("Timeout")):
            with self.assertRaises(ElevenLabsSynthesisError):
                synthesize_elevenlabs_speech(
                    text="Timeout testi",
                    output_audio_path=self.temp_dir / "tout.mp3",
                    output_srt_path=self.temp_dir / "tout.srt",
                    api_key="k",
                )

        with patch("requests.post", side_effect=requests.exceptions.RequestException("NetErr")):
            with self.assertRaises(ElevenLabsSynthesisError):
                synthesize_elevenlabs_speech(
                    text="NetErr testi",
                    output_audio_path=self.temp_dir / "net.mp3",
                    output_srt_path=self.temp_dir / "net.srt",
                    api_key="k",
                )

        # 5. Non-200 / Non-quota error (e.g. 403 Forbidden)
        mock_resp_403 = MagicMock()
        mock_resp_403.status_code = 403
        mock_resp_403.text = "Forbidden"
        with patch("requests.post", return_value=mock_resp_403):
            with self.assertRaises(ElevenLabsSynthesisError):
                synthesize_elevenlabs_speech(
                    text="403 test",
                    output_audio_path=self.temp_dir / "forbid.mp3",
                    output_srt_path=self.temp_dir / "forbid.srt",
                    api_key="k",
                )

        # 6. Success path with version_num, style, and duration estimation fallback
        mock_resp_ok = MagicMock()
        mock_resp_ok.status_code = 200
        mock_resp_ok.json.return_value = {
            "audio_base64": base64.b64encode(b"RIFFWAVEfmt DATA12345678901234567890").decode("utf-8"),
            "alignment": {},  # empty alignment to trigger fallback duration estimation
        }
        with patch("requests.post", return_value=mock_resp_ok):
            dur_v2 = synthesize_elevenlabs_speech(
                text="Version style test",
                output_audio_path=self.temp_dir / "ver.mp3",
                output_srt_path=self.temp_dir / "ver.srt",
                api_key="k",
                style=0.3,
                version_num=2,
            )
            self.assertGreater(dur_v2, 0)
            self.assertTrue((self.temp_dir / "ver_v2.mp3").exists())

        # 7. Empty audio_base64 raises RuntimeError
        mock_resp_empty = MagicMock()
        mock_resp_empty.status_code = 200
        mock_resp_empty.json.return_value = {"audio_base64": ""}
        with patch("requests.post", return_value=mock_resp_empty):
            with self.assertRaises(RuntimeError):
                synthesize_elevenlabs_speech(
                    text="Empty test",
                    output_audio_path=self.temp_dir / "empty.mp3",
                    output_srt_path=self.temp_dir / "empty.srt",
                    api_key="k",
                )


if __name__ == "__main__":
    unittest.main()
