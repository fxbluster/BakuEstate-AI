"""Unit and integration tests for Social Lifecycle, Publication Tracking & Audience Intelligence.

Covers:
1. Tier 1 zero-token regex heuristic filter (positive Azerbaijani keywords and negative noise/emoji/spam cases).
2. 4-phase decay schedule calculation (T+4h, T+12h, T+24h, T+36h..T+72h, T+96h..T+168h, T>168h FROZEN, budget <= 11).
3. Circuit breaker logic (2 consecutive HTTP 429/CAPTCHA errors trip 4-hour backoff).
4. NER (Normalized Engagement Ratio) formula mathematical validation.
5. SupabaseRepo social methods (create_or_update_publication, get_active_telemetry, upsert_social_comment idempotency).
6. SocialTelemetryObserver metric parsing and rate-limit detection.
"""

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config.settings import (
    INSTAGRAM_REEL_PATTERN,
    TIKTOK_VIDEO_PATTERN,
    SOCIAL_CIRCUIT_BREAKER_HOURS,
    SOCIAL_POLL_BUDGET_MAX,
)
from src.cloud.supabase_repo import SupabaseRepo
from src.social.intent_classifier import (
    IntentClassifier,
    IntentCategory,
    ClassifiedComment,
    TIER1_TOKEN_REGEX,
    TIER1_STEM_REGEX,
)
from src.social.observer import (
    SocialTelemetryObserver,
    RateLimitException,
    SocialScrapeException,
    parse_metric_count,
)
from src.worker.local_worker import (
    BakuLocalWorker,
    calculate_decay_schedule,
    calculate_ner_score,
    SCHEDULE_OFFSETS_HOURS,
    TOTAL_POLL_BUDGET,
)


class TestTier1RegexHeuristicFilter(unittest.TestCase):
    """Test Tier 1 zero-token regex heuristic filter with Azerbaijani keywords and spam."""

    def setUp(self):
        self.classifier = IntentClassifier()

    def test_positive_azerbaijani_keywords(self):
        """Positive cases must match Tier 1 filter and return True."""
        positive_cases = [
            "qiyməti nə qədərdir?",
            "hardadır?",
            "ipotekaya yararlıdır?",
            "wp nömrəniz?",
            "050-123-45-67",
            "Salam, qiymət son nə olar?",
            "Zəhmət olmasa dəqiq ünvanı yazardınız",
            "Mənzil kreditlə verilir?",
            "Kupçası (çıxarışı) var?",
            "Əlaqə nömrəsi qeyd edin",
            "WhatsApp nömrəniz var?",
            "Kvadratı neçəyə düşür?",
            "Razılaşma yolu var?",
            "055-987-65-43",
            "070 333 22 11",
            "077-555-44-33",
            "099-111-22-33",
            "010-777-88-99",
        ]
        for text in positive_cases:
            with self.subTest(text=text):
                self.assertTrue(
                    self.classifier.is_tier1_match(text),
                    f"Expected True for positive inquiry: '{text}'",
                )
                self.assertTrue(
                    self.classifier.filter_tier1(text),
                    f"filter_tier1 alias failed for: '{text}'",
                )

    def test_negative_cases_emojis_short_spam_tags(self):
        """Negative cases (emojis, spam, friend tags, generic praise) must return False."""
        negative_cases = [
            "🔥🔥🔥",
            "😍",
            "👍👍",
            "🏠✨",
            "ok",
            "super",
            "hi",
            "a",
            "??",
            "...",
            "@samir bax",
            "@elnur_baku @ali",
            "Çox gözəl mənzildir",
            "Uğurlar arzulayıram",
            "Təşəkkürlər",
            "Bəh bəh əla",
        ]
        for text in negative_cases:
            with self.subTest(text=text):
                self.assertFalse(
                    self.classifier.is_tier1_match(text),
                    f"Expected False for noise/spam: '{text}'",
                )

    def test_noise_comment_classification_structure(self):
        """Noise comments must be classified without LLM invocation."""
        noise_text = "🔥🔥 super @dost"
        result = self.classifier.classify_comment(noise_text)
        self.assertIsInstance(result, ClassifiedComment)
        self.assertFalse(result.is_intent_lead)
        self.assertEqual(result.intent_category, IntentCategory.NOISE.value)
        self.assertIsNone(result.suggested_reply)
        self.assertFalse(result.tier1_matched)

    def test_positive_comment_classification_fallback(self):
        """Positive inquiry with unconfigured Gemini must produce structured fallback reply."""
        inquiry_text = "Salam, bu mənzilin qiyməti nə qədərdir?"
        listing_ctx = {
            "bina_id": "5616503",
            "price": 185000,
            "currency": "AZN",
            "location": "Nərimanov",
            "has_bill_of_sale": True,
        }
        result = self.classifier.classify_comment(inquiry_text, listing_context=listing_ctx)
        self.assertTrue(result.is_intent_lead)
        self.assertIn(result.intent_category, ["PRICE", "LOCATION", "MORTGAGE", "PHONE_REQUEST"])
        self.assertIsNotNone(result.suggested_reply)
        self.assertIn("185000", result.suggested_reply)


class TestDecayScheduleCalculation(unittest.TestCase):
    """Test 4-phase exponential decay schedule calculation, snapshots, and 7-day freeze."""

    def setUp(self):
        self.published_at = datetime(2026, 11, 1, 10, 0, 0, tzinfo=timezone.utc)

    def test_schedule_phase_1_day_1_polls(self):
        """T+0 to T+24h: 3 polls scheduled at T+4h, T+12h, T+24h."""
        # Poll 0 completed (initial state right at publish)
        next_poll_0, status_0, phase_0 = calculate_decay_schedule(
            self.published_at, completed_polls=0, now=self.published_at
        )
        self.assertEqual(next_poll_0, self.published_at + timedelta(hours=4))
        self.assertEqual(status_0, "ACTIVE")

        # Poll 1 completed (T+4h poll done) -> next is T+12h
        t_plus_4h = self.published_at + timedelta(hours=4)
        next_poll_1, status_1, phase_1 = calculate_decay_schedule(
            self.published_at, completed_polls=1, now=t_plus_4h
        )
        self.assertEqual(phase_1, "T+4h")
        self.assertEqual(next_poll_1, self.published_at + timedelta(hours=12))
        self.assertEqual(status_1, "ACTIVE")

        # Poll 2 completed (T+12h poll done) -> next is T+24h
        t_plus_12h = self.published_at + timedelta(hours=12)
        next_poll_2, status_2, phase_2 = calculate_decay_schedule(
            self.published_at, completed_polls=2, now=t_plus_12h
        )
        self.assertEqual(phase_2, "T+12h")
        self.assertEqual(next_poll_2, self.published_at + timedelta(hours=24))
        self.assertEqual(status_2, "ACTIVE")

        # Poll 3 completed (T+24h poll done) -> next is T+36h
        t_plus_24h = self.published_at + timedelta(hours=24)
        next_poll_3, status_3, phase_3 = calculate_decay_schedule(
            self.published_at, completed_polls=3, now=t_plus_24h
        )
        self.assertEqual(phase_3, "T+24h")
        self.assertEqual(next_poll_3, self.published_at + timedelta(hours=36))
        self.assertEqual(status_3, "ACTIVE")

    def test_schedule_phase_2_days_2_3_polls_and_ner_snapshot(self):
        """T+24h to T+72h: every 12h (T+36h, T+48h, T+60h, T+72h). Snapshot at T+48h marked."""
        # Poll 4 completed (T+36h done) -> next is T+48h
        next_poll_4, status_4, phase_4 = calculate_decay_schedule(
            self.published_at, completed_polls=4, now=self.published_at + timedelta(hours=36)
        )
        self.assertEqual(phase_4, "T+36h")
        self.assertEqual(next_poll_4, self.published_at + timedelta(hours=48))

        # Poll 5 completed (T+48h done) -> MUST be marked "T+48h" for NER score calculation
        next_poll_5, status_5, phase_5 = calculate_decay_schedule(
            self.published_at, completed_polls=5, now=self.published_at + timedelta(hours=48)
        )
        self.assertEqual(phase_5, "T+48h")
        self.assertEqual(next_poll_5, self.published_at + timedelta(hours=60))
        self.assertEqual(status_5, "ACTIVE")

        # Poll 6 completed (T+60h done) -> next is T+72h
        next_poll_6, status_6, phase_6 = calculate_decay_schedule(
            self.published_at, completed_polls=6, now=self.published_at + timedelta(hours=60)
        )
        self.assertEqual(phase_6, "T+60h")
        self.assertEqual(next_poll_6, self.published_at + timedelta(hours=72))

        # Poll 7 completed (T+72h done) -> next is T+96h (daily starts)
        next_poll_7, status_7, phase_7 = calculate_decay_schedule(
            self.published_at, completed_polls=7, now=self.published_at + timedelta(hours=72)
        )
        self.assertEqual(phase_7, "T+72h")
        self.assertEqual(next_poll_7, self.published_at + timedelta(hours=96))

    def test_schedule_phase_3_days_4_7_daily_polls(self):
        """T+72h to T+168h: daily polls (T+96h, T+120h, T+144h, T+168h)."""
        expected_offsets = [(8, 96, 120), (9, 120, 144), (10, 144, 168)]
        for completed, current_h, next_h in expected_offsets:
            with self.subTest(completed=completed):
                next_dt, status, phase = calculate_decay_schedule(
                    self.published_at,
                    completed_polls=completed,
                    now=self.published_at + timedelta(hours=current_h),
                )
                self.assertEqual(phase, f"T+{current_h}h")
                self.assertEqual(next_dt, self.published_at + timedelta(hours=next_h))
                self.assertEqual(status, "ACTIVE")

    def test_schedule_phase_4_freeze_after_day_7(self):
        """T > 168h (Day 7) or completed_polls >= 11 freezes telemetry."""
        # 11th poll completed (T+168h done)
        t_plus_168h = self.published_at + timedelta(hours=168)
        next_dt, status, phase = calculate_decay_schedule(
            self.published_at, completed_polls=11, now=t_plus_168h
        )
        self.assertIsNone(next_dt)
        self.assertEqual(status, "FROZEN")
        self.assertEqual(phase, "T+7d")

        # Elapsed time exceeds 168h even if fewer polls occurred
        t_plus_200h = self.published_at + timedelta(hours=200)
        next_dt_over, status_over, _ = calculate_decay_schedule(
            self.published_at, completed_polls=5, now=t_plus_200h
        )
        self.assertIsNone(next_dt_over)
        self.assertEqual(status_over, "FROZEN")

    def test_lifetime_poll_budget_strictly_bounded(self):
        """Lifetime poll budget is strictly <= 11 polls across full lifecycle."""
        current_now = self.published_at
        polls_count = 0
        status = "ACTIVE"

        while status == "ACTIVE":
            next_poll_dt, status, _ = calculate_decay_schedule(
                self.published_at, completed_polls=polls_count, now=current_now
            )
            if status == "ACTIVE":
                self.assertIsNotNone(next_poll_dt)
                current_now = next_poll_dt
                polls_count += 1
            else:
                self.assertEqual(status, "FROZEN")
                self.assertIsNone(next_poll_dt)
                break

        self.assertEqual(polls_count, TOTAL_POLL_BUDGET)
        self.assertEqual(polls_count, 11)
        self.assertEqual(TOTAL_POLL_BUDGET, SOCIAL_POLL_BUDGET_MAX)


class TestNERFormulaCalculation(unittest.TestCase):
    """Test Normalized Engagement Ratio (NER) mathematical test cases."""

    def test_ner_exact_mathematical_cases(self):
        """
        NER = (Views_48h / Median_Views) * 0.6 + (Leads_48h / max(1, Comments_48h)) * 0.4
        """
        # Case 1: Baseline median views, 50% comment-to-lead ratio
        # (1000 / 1000) * 0.6 + (10 / 20) * 0.4 = 1.0 * 0.6 + 0.5 * 0.4 = 0.6 + 0.2 = 0.8
        score_1 = calculate_ner_score(views=1000, leads=10, comments=20, median_views=1000.0)
        self.assertAlmostEqual(score_1, 0.8, places=4)

        # Case 2: Viral views (2.5x median), zero leads
        # (2500 / 1000) * 0.6 + (0 / 50) * 0.4 = 2.5 * 0.6 + 0 = 1.5
        score_2 = calculate_ner_score(views=2500, leads=0, comments=50, median_views=1000.0)
        self.assertAlmostEqual(score_2, 1.5, places=4)

        # Case 3: Low views (0.5x median), 100% conversion (5 leads from 5 comments)
        # (500 / 1000) * 0.6 + (5 / 5) * 0.4 = 0.3 + 0.4 = 0.7
        score_3 = calculate_ner_score(views=500, leads=5, comments=5, median_views=1000.0)
        self.assertAlmostEqual(score_3, 0.7, places=4)

        # Case 4: Zero comments protection (avoid ZeroDivisionError)
        # (1200 / 1000) * 0.6 + (0 / max(1, 0)) * 0.4 = 1.2 * 0.6 + 0 = 0.72
        score_4 = calculate_ner_score(views=1200, leads=0, comments=0, median_views=1000.0)
        self.assertAlmostEqual(score_4, 0.72, places=4)

        # Case 5: Zero median views protection (fallback to 1.0)
        score_5 = calculate_ner_score(views=100, leads=1, comments=2, median_views=0.0)
        self.assertGreater(score_5, 0.0)


class TestCircuitBreakerLogic(unittest.TestCase):
    """Test social telemetry circuit breaker behavior on rate-limit / CAPTCHA errors."""

    def setUp(self):
        self.mock_repo = MagicMock()
        self.mock_repo.is_configured.return_value = True
        self.mock_pipeline = MagicMock()
        self.worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            worker_id="test-breaker-worker",
            poll_interval_seconds=0.01,
            enable_periodic_scheduler=False,
        )
        self.worker._send_sre_alert = MagicMock()
        self.worker._send_operator_alert = MagicMock()

    @patch("src.social.observer.SocialTelemetryObserver.fetch_telemetry")
    def test_single_rate_limit_does_not_trip_breaker(self, mock_fetch):
        """1 rate-limit error increments counter but does not trip breaker."""
        mock_fetch.side_effect = RateLimitException("HTTP 429 Too Many Requests", status_code=429)
        self.mock_repo.get_publication_by_id.return_value = {
            "id": "pub-uuid-1",
            "post_url": "https://www.instagram.com/reel/DCXYZ123/",
            "poll_count": 1,
            "views_count": 100,
            "likes_count": 5,
            "comments_count": 2,
            "scrape_error_count": 0,
        }

        job = {
            "id": "job-1",
            "job_type": "SYNC_SOCIAL_METRICS",
            "params_json": {
                "publication_id": "pub-uuid-1",
                "post_url": "https://www.instagram.com/reel/DCXYZ123/",
            },
        }

        with self.assertRaises(RateLimitException):
            self.worker._handle_sync_social_metrics(job)

        self.assertEqual(self.worker._consecutive_social_rate_limits, 1)
        self.mock_repo.trip_social_circuit_breaker.assert_not_called()

    @patch("src.social.observer.SocialTelemetryObserver.fetch_telemetry")
    def test_two_consecutive_rate_limits_trip_circuit_breaker(self, mock_fetch):
        """2 consecutive rate-limits trip breaker, setting 4h backoff across publications."""
        mock_fetch.side_effect = RateLimitException("HTTP 429 Too Many Requests", status_code=429)
        self.mock_repo.get_publication_by_id.return_value = {
            "id": "pub-uuid-1",
            "post_url": "https://www.instagram.com/reel/DCXYZ123/",
            "poll_count": 1,
            "views_count": 100,
            "likes_count": 5,
            "comments_count": 2,
            "scrape_error_count": 1,
        }

        job = {
            "id": "job-1",
            "job_type": "SYNC_SOCIAL_METRICS",
            "params_json": {
                "publication_id": "pub-uuid-1",
                "post_url": "https://www.instagram.com/reel/DCXYZ123/",
            },
        }

        # First error: counter becomes 1
        with self.assertRaises(RateLimitException):
            self.worker._handle_sync_social_metrics(job)
        self.assertEqual(self.worker._consecutive_social_rate_limits, 1)

        # Second error: counter becomes 2 -> trips breaker
        with self.assertRaises(RateLimitException):
            self.worker._handle_sync_social_metrics(job)
        self.assertEqual(self.worker._consecutive_social_rate_limits, 2)
        self.mock_repo.trip_social_circuit_breaker.assert_called_once_with(
            backoff_hours=SOCIAL_CIRCUIT_BREAKER_HOURS
        )
        self.worker._send_sre_alert.assert_called_once()

    @patch("src.social.observer.SocialTelemetryObserver.fetch_telemetry")
    def test_successful_fetch_resets_rate_limit_counter(self, mock_fetch):
        """A successful fetch resets consecutive rate-limit counter back to 0."""
        self.worker._consecutive_social_rate_limits = 1
        mock_fetch.return_value = {
            "views_count": 250,
            "likes_count": 15,
            "comments_count": 1,
            "shares_count": 0,
            "comments": [],
            "platform": "INSTAGRAM",
        }
        self.mock_repo.get_publication_by_id.return_value = {
            "id": "pub-uuid-1",
            "post_url": "https://www.instagram.com/reel/DCXYZ123/",
            "poll_count": 1,
            "published_at": datetime.now(timezone.utc).isoformat(),
        }

        job = {
            "id": "job-1",
            "job_type": "SYNC_SOCIAL_METRICS",
            "params_json": {
                "publication_id": "pub-uuid-1",
                "post_url": "https://www.instagram.com/reel/DCXYZ123/",
            },
        }

        outcome = self.worker._handle_sync_social_metrics(job)
        self.assertEqual(outcome["job_type"], "SYNC_SOCIAL_METRICS")
        self.assertEqual(self.worker._consecutive_social_rate_limits, 0)


class TestSupabaseRepoSocialMethods(unittest.TestCase):
    """Test SupabaseRepo social publication, comment upsert idempotency, and lead creation."""

    def setUp(self):
        self.mock_session = MagicMock()
        self.repo = SupabaseRepo(
            supabase_url="https://example.supabase.co",
            supabase_key="test-key",
            enabled=True,
            session=self.mock_session,
        )

    def test_create_or_update_publication_draft_ready(self):
        """Creates DRAFT_READY publication row for a newly rendered video."""
        resp = MagicMock()
        resp.status_code = 201
        resp.json.return_value = [{
            "id": "pub-uuid-1",
            "listing_id": "listing-uuid-1",
            "status": "DRAFT_READY",
            "channel": "INSTAGRAM_REELS",
        }]
        self.mock_session.post.return_value = resp

        pub = self.repo.create_or_update_publication(
            listing_id="listing-uuid-1",
            render_version_id="render-uuid-1",
            channel="INSTAGRAM_REELS",
            status="DRAFT_READY",
        )
        self.assertIsNotNone(pub)
        self.assertEqual(pub["status"], "DRAFT_READY")

    def test_idempotent_comment_upserting(self):
        """Duplicate platform_comment_id does not create duplicate entries (upsert with resolution)."""
        resp = MagicMock()
        resp.status_code = 201
        resp.json.return_value = [{
            "id": "comment-uuid-1",
            "publication_id": "pub-uuid-1",
            "platform_comment_id": "ig_comm_999",
            "author_handle": "samir_baku",
            "comment_text": "Qiyməti nə qədərdir?",
            "is_intent_lead": True,
        }]
        self.mock_session.post.return_value = resp

        # First insert
        comm_1 = self.repo.upsert_social_comment(
            publication_id="pub-uuid-1",
            platform_comment_id="ig_comm_999",
            author_handle="samir_baku",
            comment_text="Qiyməti nə qədərdir?",
            is_intent_lead=True,
            intent_category="PRICE",
            suggested_reply="Salam, qiymət 185000 AZN-dir.",
        )
        self.assertIsNotNone(comm_1)

        # Second insert with same platform_comment_id passes on_conflict clause
        comm_2 = self.repo.upsert_social_comment(
            publication_id="pub-uuid-1",
            platform_comment_id="ig_comm_999",
            author_handle="samir_baku",
            comment_text="Qiyməti nə qədərdir?",
            is_intent_lead=True,
            intent_category="PRICE",
            suggested_reply="Salam, qiymət 185000 AZN-dir.",
        )
        self.assertIsNotNone(comm_2)

        # Verify resolution header specifies publication_id,platform_comment_id conflict target
        call_args = self.mock_session.post.call_args
        self.assertIn("resolution=merge-duplicates", call_args[1]["headers"]["Prefer"])
        self.assertEqual(call_args[1]["params"].get("on_conflict"), "publication_id,platform_comment_id")

    def test_create_social_buyer_lead(self):
        """Creates buyer lead linked with IG_DM channel, lead_listings, and 30-min follow_up_task."""
        lead_resp = MagicMock()
        lead_resp.status_code = 201
        lead_resp.json.return_value = [{"id": "lead-uuid-101", "name": "samir_baku", "source_channel": "IG_DM"}]

        link_resp = MagicMock()
        link_resp.status_code = 201
        link_resp.json.return_value = [{"lead_id": "lead-uuid-101", "listing_id": "listing-uuid-1"}]

        task_resp = MagicMock()
        task_resp.status_code = 201
        task_resp.json.return_value = [{"id": "task-uuid-201", "priority": "HIGH"}]

        self.mock_session.post.side_effect = [lead_resp, link_resp, task_resp]

        lead = self.repo.create_social_buyer_lead(
            author_handle="@samir_baku",
            listing_id="listing-uuid-1",
            suggested_reply="Salam!",
            platform="INSTAGRAM",
        )
        self.assertIsNotNone(lead)
        self.assertEqual(lead["id"], "lead-uuid-101")
        self.assertEqual(self.mock_session.post.call_count, 3)


class TestSocialTelemetryObserver(unittest.TestCase):
    """Test public post metric parsing and URL validation."""

    def test_metric_parsing_suffixes(self):
        """Parses counts with K, M, B, commas, and raw integers."""
        self.assertEqual(parse_metric_count("1,450"), 1450)
        self.assertEqual(parse_metric_count("12.5K"), 12500)
        self.assertEqual(parse_metric_count("1.2M"), 1200000)
        self.assertEqual(parse_metric_count("500"), 500)
        self.assertEqual(parse_metric_count(350), 350)
        self.assertEqual(parse_metric_count(None), 0)
        self.assertEqual(parse_metric_count("invalid"), 0)

    def test_canonical_url_regex_validation(self):
        """Validates canonical Instagram Reel and TikTok URL structures."""
        valid_ig = "https://www.instagram.com/reel/DCXYZ123_45/"
        valid_tt = "https://www.tiktok.com/@baku_emlak/video/7123456789012345678"
        invalid_url = "https://example.com/not-a-reel"

        self.assertTrue(bool(INSTAGRAM_REEL_PATTERN.match(valid_ig)))
        self.assertTrue(bool(TIKTOK_VIDEO_PATTERN.match(valid_tt)))
        self.assertFalse(bool(INSTAGRAM_REEL_PATTERN.match(invalid_url)))
        self.assertFalse(bool(TIKTOK_VIDEO_PATTERN.match(invalid_url)))


if __name__ == "__main__":
    unittest.main()
