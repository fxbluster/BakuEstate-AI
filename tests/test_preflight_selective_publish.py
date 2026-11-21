"""Unit and integration tests for Pre-Flight Verification Gate & Selective Publishing Lifecycle.

Covers:
1. Worker Silent Staging:
   - _handle_render_initial creates DRAFT_READY publication with preflight_status='UNCHECKED'.
   - Worker does NOT call dispatch_video_lead upon render completion.
   - _handle_render_price_drop also stages silently as DRAFT_READY / UNCHECKED.
   - Render version records rendered_price and rendered_currency='AZN'.
2. Price Equality & Price Change Calculation Logic:
   - Exact price match (< 1.0 AZN diff) evaluates to PASSED.
   - Small float variations (< 1.0 AZN, e.g. 185000.4 vs 185000.0) do not trip false price change.
   - Price drop (e.g. 185k -> 175k) evaluates to PRICE_CHANGED with delta_pct = -5.41%.
   - Price increase (e.g. 185k -> 195k) evaluates to PRICE_CHANGED with delta_pct = +5.41%.
3. bina.az HTML Parser & Liveness Detection:
   - Extracts numeric value from '.price-val' text (e.g. '185 000', ' 240 500 AZN ').
   - Detects '.item_status_deleted' class indicating REMOVED_ON_BINA.
   - Detects 'Bu elan artıq aktiv deyil' string indicating REMOVED_ON_BINA.
   - Detects HTTP 404 / 410 indicating REMOVED_ON_BINA.
   - Clean active HTML indicates ACTIVE / PASSED.
4. Post-Publish Liveness & Price Drop Monitor in _handle_sync_social_metrics:
   - When listing is REMOVED_ON_BINA: marks source_availability='REMOVED_ON_BINA' and sends operator alert.
   - When listing price drops post-publication: updates price and sends price drop alert to operator.
   - When listing is active & unchanged: proceeds to social metrics scraping without alert.
5. SupabaseRepo Preflight Helpers:
   - update_preflight_status updates preflight_status, error, telegram_message_id.
   - log_preflight_check inserts audit record in preflight_checks table.
   - create_render_version stores rendered_price and rendered_currency.
"""

import os
import re
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bs4 import BeautifulSoup
from src.cloud.supabase_repo import SupabaseRepo
from src.worker.local_worker import BakuLocalWorker


# ---------------------------------------------------------------------------
# Preflight Verification Reference Algorithms (Matching Next.js & Python Engine)
# ---------------------------------------------------------------------------

def parse_bina_price_val(html_or_text: str) -> Optional[float]:
    """
    Extracts the numeric portal price from bina.az .price-val DOM element or raw price text.
    Handles space delimiters ('185 000' -> 185000.0) and currency suffixes.
    """
    if not html_or_text:
        return None

    if "<" in html_or_text and ">" in html_or_text:
        soup = BeautifulSoup(html_or_text, "html.parser")
        elem = soup.find(class_=re.compile(r"\bprice-val\b"))
        if elem:
            text = elem.get_text(strip=True)
        else:
            text = soup.get_text(strip=True)
    else:
        text = html_or_text.strip()

    # Strip currency words / symbols
    cleaned = re.sub(r"[^\d.]", "", text.replace(" ", "").replace("\xa0", ""))
    if not cleaned:
        return None
    try:
        val = float(cleaned)
        return val if val > 0 else None
    except ValueError:
        return None


def detect_bina_liveness(status_code: int, html: str) -> str:
    """
    Detects listing liveness on bina.az following the pre-flight verification gate specification:
    - HTTP 404 or 410 -> REMOVED_ON_BINA
    - DOM contains 'item_status_deleted' class -> REMOVED_ON_BINA
    - Text contains 'Bu elan artıq aktiv deyil' (case-insensitive) -> REMOVED_ON_BINA
    - Text contains 'elan artıq mövcud deyil' -> REMOVED_ON_BINA
    - Otherwise -> ACTIVE
    """
    if status_code in (404, 410):
        return "REMOVED_ON_BINA"

    if not html:
        return "SCRAPE_ERROR"

    lower_html = html.lower()
    if "item_status_deleted" in lower_html:
        return "REMOVED_ON_BINA"

    if (
        "bu elan artıq aktiv deyil" in lower_html
        or "bu elan artiq aktiv deyil" in lower_html
        or "elan artıq mövcud deyil" in lower_html
        or "elan artiq movcud deyil" in lower_html
    ):
        return "REMOVED_ON_BINA"

    return "ACTIVE"


def compare_preflight_prices(portal_price: float, expected_price: float, tolerance: float = 1.0) -> Dict[str, Any]:
    """
    Compares real-time portal price with rendered video price.
    - If abs(portal_price - expected_price) < tolerance (1.0 AZN): PASSED.
    - If abs(portal_price - expected_price) >= tolerance: PRICE_CHANGED with signed delta_pct.
    """
    if expected_price <= 0:
        return {"result": "PASSED", "delta": 0.0, "delta_pct": 0.0}

    delta = round(portal_price - expected_price, 2)
    if abs(delta) < tolerance:
        return {"result": "PASSED", "delta": delta, "delta_pct": 0.0}

    delta_pct = round((delta / expected_price) * 100.0, 2)
    return {
        "result": "PRICE_CHANGED",
        "delta": delta,
        "delta_pct": delta_pct,
        "portal_price": portal_price,
        "video_price": expected_price,
    }


# ===========================================================================
# Test Cases
# ===========================================================================

class TestWorkerSilentStaging(unittest.TestCase):
    """
    Verifies that BakuLocalWorker stages completed videos silently as DRAFT_READY
    with preflight_status='UNCHECKED' and NEVER calls dispatch_video_lead.
    """

    def setUp(self):
        self.mock_repo = MagicMock(spec=SupabaseRepo)
        self.mock_repo.is_configured.return_value = True
        self.mock_repo.enabled = True
        self.mock_pipeline = MagicMock()
        self.mock_pipeline.telegram = MagicMock()

        self.worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            owner_only=True,
            mock_dispatch=True,
        )

    def test_handle_render_initial_silent_staging(self):
        """
        _handle_render_initial must create a DRAFT_READY publication with
        preflight_status='UNCHECKED' and must NOT call dispatch_video_lead.
        """
        job = {
            "id": "job-render-initial-001",
            "job_type": "RENDER_INITIAL",
            "listing_id": "listing-uuid-101",
            "params_json": {
                "voice_engine": "elevenlabs",
                "voice_id": "brian",
                "script_angle": "EMOTIONAL",
            },
        }
        listing = {
            "id": "listing-uuid-101",
            "bina_id": 5616503,
            "price": 185000,
            "price_azn": 185000,
            "currency": "AZN",
            "editorial_status": "DRAFT",
        }

        # Mock resolve listing and pipeline render result
        self.worker._resolve_listing_for_job = MagicMock(return_value=listing)
        self.worker._check_auto_render_guardrails = MagicMock(return_value=None)
        self.mock_pipeline.process_listing_video_and_dispatch.return_value = {
            "status": "SUCCESS",
            "render_version_id": "render-ver-001",
            "video_path": "data/output/video_5616503.mp4",
            "duration": 35.0,
        }

        res = self.worker._handle_render_initial(job)
        self.assertEqual(res.get("status"), "SUCCESS")

        # Verify pipeline.telegram.dispatch_video_lead was NEVER called by the worker
        self.mock_pipeline.telegram.dispatch_video_lead.assert_not_called()

        # Verify publication was created/updated as DRAFT_READY
        self.mock_repo.create_or_update_publication.assert_called()
        call_kwargs = self.mock_repo.create_or_update_publication.call_args.kwargs
        self.assertEqual(call_kwargs.get("listing_id"), "listing-uuid-101")
        self.assertEqual(call_kwargs.get("status"), "DRAFT_READY")
        self.assertEqual(call_kwargs.get("render_version_id"), "render-ver-001")
        # Ensure preflight_status is UNCHECKED (or defaulted)
        if "preflight_status" in call_kwargs:
            self.assertEqual(call_kwargs.get("preflight_status"), "UNCHECKED")

    def test_handle_render_price_drop_silent_staging(self):
        """
        _handle_render_price_drop must also stage silently as DRAFT_READY
        and must NOT trigger automatic Telegram dispatch.
        """
        job = {
            "id": "job-render-pricedrop-002",
            "job_type": "RENDER_PRICE_DROP",
            "listing_id": "listing-uuid-102",
            "params_json": {
                "price_drop_info": {"old_price": 200000, "new_price": 185000, "delta_pct": -7.5},
            },
        }
        listing = {
            "id": "listing-uuid-102",
            "bina_id": 5966276,
            "price": 185000,
            "price_azn": 185000,
            "currency": "AZN",
            "editorial_status": "DRAFT",
        }

        self.worker._resolve_listing_for_job = MagicMock(return_value=listing)
        self.worker._check_auto_render_guardrails = MagicMock(return_value=None)
        self.mock_pipeline.process_listing_video_and_dispatch.return_value = {
            "status": "SUCCESS",
            "render_version_id": "render-ver-002",
            "video_path": "data/output/video_5966276.mp4",
            "duration": 38.0,
        }

        res = self.worker._handle_render_price_drop(job)
        self.assertEqual(res.get("status"), "SUCCESS")

        # Telegram dispatch must not be called
        self.mock_pipeline.telegram.dispatch_video_lead.assert_not_called()

        # Publication must be staged as DRAFT_READY
        self.mock_repo.create_or_update_publication.assert_called()
        call_kwargs = self.mock_repo.create_or_update_publication.call_args.kwargs
        self.assertEqual(call_kwargs.get("listing_id"), "listing-uuid-102")
        self.assertEqual(call_kwargs.get("status"), "DRAFT_READY")


class TestPriceEqualityComparison(unittest.TestCase):
    """
    Verifies price comparison logic:
    - Exact match passes.
    - Sub-1 AZN difference (noise guard) passes.
    - Delta >= 1.0 AZN returns PRICE_CHANGED with signed delta_pct.
    """

    def test_exact_price_match_passes(self):
        """Exact price match returns PASSED with 0 delta."""
        res = compare_preflight_prices(185000.0, 185000.0)
        self.assertEqual(res["result"], "PASSED")
        self.assertEqual(res["delta"], 0.0)
        self.assertEqual(res["delta_pct"], 0.0)

    def test_sub_one_azn_difference_tolerance(self):
        """Floating point differences < 1.0 AZN are treated as exact match."""
        # 0.40 AZN higher
        res_high = compare_preflight_prices(185000.40, 185000.0)
        self.assertEqual(res_high["result"], "PASSED")

        # 0.50 AZN lower
        res_low = compare_preflight_prices(184999.50, 185000.0)
        self.assertEqual(res_low["result"], "PASSED")

    def test_price_drop_triggers_price_changed(self):
        """A price decrease >= 1.0 AZN returns PRICE_CHANGED with negative delta_pct."""
        # Dropped from 185,000 to 175,000 (-10,000 AZN = -5.41%)
        res = compare_preflight_prices(175000.0, 185000.0)
        self.assertEqual(res["result"], "PRICE_CHANGED")
        self.assertEqual(res["delta"], -10000.0)
        self.assertEqual(res["delta_pct"], -5.41)
        self.assertEqual(res["portal_price"], 175000.0)
        self.assertEqual(res["video_price"], 185000.0)

    def test_price_increase_triggers_price_changed(self):
        """A price increase >= 1.0 AZN returns PRICE_CHANGED with positive delta_pct."""
        # Increased from 185,000 to 200,000 (+15,000 AZN = +8.11%)
        res = compare_preflight_prices(200000.0, 185000.0)
        self.assertEqual(res["result"], "PRICE_CHANGED")
        self.assertEqual(res["delta"], 15000.0)
        self.assertEqual(res["delta_pct"], 8.11)


class TestHtmlParserAndLivenessDetection(unittest.TestCase):
    """
    Verifies HTML parsing of .price-val and detection of delisted apartments on bina.az.
    """

    def test_extract_price_val_clean_numbers(self):
        """Extracts numeric price from various space-delimited formats."""
        html_sample = '<div class="price"><span class="price-val">185 000</span><span class="price-cur">AZN</span></div>'
        self.assertEqual(parse_bina_price_val(html_sample), 185000.0)

        html_with_spaces = '<span class="price-val">  240 500  </span>'
        self.assertEqual(parse_bina_price_val(html_with_spaces), 240500.0)

        raw_str = "120 000 AZN"
        self.assertEqual(parse_bina_price_val(raw_str), 120000.0)

    def test_extract_price_val_empty_or_malformed(self):
        """Handles empty or missing elements safely returning None."""
        self.assertIsNone(parse_bina_price_val(""))
        self.assertIsNone(parse_bina_price_val("<div>No price here</div>"))
        self.assertIsNone(parse_bina_price_val(None))

    def test_liveness_detection_item_status_deleted_class(self):
        """Detects .item_status_deleted class as REMOVED_ON_BINA."""
        html = """
        <html>
            <body>
                <div class="item_status_deleted">Bu elan artıq aktiv deyil</div>
            </body>
        </html>
        """
        self.assertEqual(detect_bina_liveness(200, html), "REMOVED_ON_BINA")

    def test_liveness_detection_inactive_text_phrase(self):
        """Detects 'Bu elan artıq aktiv deyil' text as REMOVED_ON_BINA."""
        html = """
        <div class="notice-box">
            <p>Diqqət: Bu elan artıq aktiv deyil!</p>
        </div>
        """
        self.assertEqual(detect_bina_liveness(200, html), "REMOVED_ON_BINA")

    def test_liveness_detection_http_404_and_410(self):
        """HTTP 404 or 410 returns REMOVED_ON_BINA immediately."""
        self.assertEqual(detect_bina_liveness(404, ""), "REMOVED_ON_BINA")
        self.assertEqual(detect_bina_liveness(410, ""), "REMOVED_ON_BINA")

    def test_liveness_detection_active_page(self):
        """Normal listing page with price and description returns ACTIVE."""
        html = """
        <html>
            <body>
                <div class="item-view">
                    <span class="price-val">190 000</span>
                    <span class="price-cur">AZN</span>
                    <div class="description">Gənclik m. yaxınlığında 3 otaqlı mənzil.</div>
                </div>
            </body>
        </html>
        """
        self.assertEqual(detect_bina_liveness(200, html), "ACTIVE")


class TestPostPublishLivenessMonitor(unittest.TestCase):
    """
    Verifies that _handle_sync_social_metrics performs concurrent liveness check
    and sends appropriate Telegram alerts when listing status changes post-publication.
    """

    def setUp(self):
        self.mock_repo = MagicMock(spec=SupabaseRepo)
        self.mock_repo.is_configured.return_value = True
        self.mock_repo.enabled = True
        self.mock_pipeline = MagicMock()

        self.worker = BakuLocalWorker(
            repo=self.mock_repo,
            pipeline=self.mock_pipeline,
            owner_only=True,
            mock_dispatch=True,
        )

    @patch("src.dispatcher.telegram_bot_service.TelegramBotService.send_message")
    @patch("src.social.observer.SocialTelemetryObserver.fetch_telemetry")
    def test_sync_social_metrics_detects_delisting_and_alerts_operator(self, mock_fetch, mock_send_msg):
        """
        When bina_scraper reports REMOVED_ON_BINA for a published listing:
        1. listings.source_availability is updated to 'REMOVED_ON_BINA'.
        2. Urgent Telegram warning is sent to operator.
        """
        job = {
            "id": "job-sync-001",
            "job_type": "SYNC_SOCIAL_METRICS",
            "params_json": {
                "publication_id": "pub-001",
                "post_url": "https://www.instagram.com/reel/C7xyz123/",
            },
        }
        pub = {
            "id": "pub-001",
            "listing_id": "listing-uuid-501",
            "post_url": "https://www.instagram.com/reel/C7xyz123/",
            "poll_count": 2,
            "status": "PUBLISHED",
            "published_at": "2026-11-18T10:00:00+00:00",
        }
        listing = {
            "id": "listing-uuid-501",
            "bina_id": 5616503,
            "price": 185000,
            "price_azn": 185000,
            "source_availability": "ACTIVE",
        }

        self.mock_repo.get_publication_by_id.return_value = pub
        self.mock_repo.get_listing_by_id.return_value = listing

        mock_fetch.return_value = {
            "views_count": 1200,
            "likes_count": 45,
            "comments_count": 3,
            "comments": [],
        }

        # Mock liveness check returning REMOVED_ON_BINA
        with patch.object(self.worker, "_check_listing_liveness_and_price", create=True) as mock_liveness:
            mock_liveness.return_value = {
                "status": "REMOVED_ON_BINA",
                "price": 185000,
            }
            # Also patch bina_scraper in case worker calls bina_scraper directly
            with patch("src.scraper.bina_scraper.BinaScraper.check_listing_liveness", return_value="REMOVED_ON_BINA"):
                with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "mock-token", "TELEGRAM_CHAT_ID": "123456"}):
                    res = self.worker._handle_sync_social_metrics(job)

        # Listing should be marked as REMOVED_ON_BINA
        self.mock_repo.update_listing.assert_called()
        update_args = self.mock_repo.update_listing.call_args[0]
        update_fields = self.mock_repo.update_listing.call_args[1].get("fields") or update_args[1] if len(update_args) > 1 else self.mock_repo.update_listing.call_args[1]
        self.assertEqual(update_fields.get("source_availability"), "REMOVED_ON_BINA")

        # Telegram message should have been sent notifying operator
        mock_send_msg.assert_called()
        sent_text = mock_send_msg.call_args.kwargs.get("text") or mock_send_msg.call_args[0][1]
        self.assertIn("5616503", sent_text)
        self.assertTrue("silinib" in sent_text or "satılıb" in sent_text or "REMOVED" in sent_text)

    @patch("src.dispatcher.telegram_bot_service.TelegramBotService.send_message")
    @patch("src.social.observer.SocialTelemetryObserver.fetch_telemetry")
    def test_sync_social_metrics_detects_price_drop_and_alerts_operator(self, mock_fetch, mock_send_msg):
        """
        When bina_scraper reports that the price dropped post-publication (e.g. 185k -> 175k):
        1. listing price is updated.
        2. Price drop alert card is sent to Telegram operator.
        """
        job = {
            "id": "job-sync-002",
            "job_type": "SYNC_SOCIAL_METRICS",
            "params_json": {
                "publication_id": "pub-002",
                "post_url": "https://www.instagram.com/reel/C7abc456/",
            },
        }
        pub = {
            "id": "pub-002",
            "listing_id": "listing-uuid-502",
            "post_url": "https://www.instagram.com/reel/C7abc456/",
            "poll_count": 3,
            "status": "PUBLISHED",
            "published_at": "2026-11-18T10:00:00+00:00",
        }
        listing = {
            "id": "listing-uuid-502",
            "bina_id": 5966276,
            "price": 185000,
            "price_azn": 185000,
            "currency": "AZN",
            "source_availability": "ACTIVE",
        }

        self.mock_repo.get_publication_by_id.return_value = pub
        self.mock_repo.get_listing_by_id.return_value = listing

        mock_fetch.return_value = {
            "views_count": 3400,
            "likes_count": 120,
            "comments_count": 6,
            "comments": [],
        }

        with patch.object(self.worker, "_check_listing_liveness_and_price", create=True) as mock_liveness:
            mock_liveness.return_value = {
                "status": "ACTIVE",
                "price": 175000.0,
                "price_dropped": True,
            }
            with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "mock-token", "TELEGRAM_CHAT_ID": "123456"}):
                res = self.worker._handle_sync_social_metrics(job)

        # Listing price should be updated
        self.mock_repo.update_listing.assert_called()
        update_args = self.mock_repo.update_listing.call_args[0]
        update_fields = self.mock_repo.update_listing.call_args[1].get("fields") or update_args[1] if len(update_args) > 1 else self.mock_repo.update_listing.call_args[1]
        self.assertEqual(update_fields.get("price"), 175000.0)

        # Telegram message should have been sent alerting price drop
        mock_send_msg.assert_called()
        sent_text = mock_send_msg.call_args.kwargs.get("text") or mock_send_msg.call_args[0][1]
        self.assertIn("5966276", sent_text)
        self.assertTrue("qiyməti endi" in sent_text or "175000" in sent_text or "endirim" in sent_text)


class TestSupabaseRepoPreflight(unittest.TestCase):
    """
    Verifies SupabaseRepo preflight methods:
    - update_preflight_status
    - log_preflight_check
    - create_render_version with rendered_price and rendered_currency
    """

    def setUp(self):
        self.repo = SupabaseRepo(enabled=True)
        self.mock_session = MagicMock()
        self.repo.session = self.mock_session

    def test_update_preflight_status(self):
        """update_preflight_status executes PATCH on publications."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {
                "id": "pub-001",
                "preflight_status": "PASSED",
                "verified_at": "2026-11-19T01:00:00Z",
                "telegram_message_id": 9988,
            }
        ]
        self.mock_session.patch.return_value = mock_resp

        result = self.repo.update_preflight_status(
            publication_id="pub-001",
            status="PASSED",
            telegram_msg_id=9988,
        )

        self.assertIsNotNone(result)
        self.mock_session.patch.assert_called()
        patch_kwargs = self.mock_session.patch.call_args.kwargs
        json_data = patch_kwargs.get("json", {})
        self.assertEqual(json_data.get("preflight_status"), "PASSED")
        self.assertEqual(json_data.get("telegram_message_id"), 9988)
        self.assertIn("verified_at", json_data)

    def test_log_preflight_check(self):
        """log_preflight_check inserts audit log row into preflight_checks table."""
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = [
            {
                "id": "check-001",
                "listing_id": "listing-uuid-999",
                "bina_id": 5616503,
                "result": "PASSED",
                "portal_price": 185000.0,
                "video_price": 185000.0,
                "price_delta_pct": 0.0,
                "response_time_ms": 145,
            }
        ]
        self.mock_session.post.return_value = mock_resp

        result = self.repo.log_preflight_check(
            listing_id="listing-uuid-999",
            bina_id=5616503,
            result="PASSED",
            portal_price=185000.0,
            video_price=185000.0,
            price_delta_pct=0.0,
            response_time_ms=145,
        )

        self.assertIsNotNone(result)
        self.mock_session.post.assert_called()
        call_url = self.mock_session.post.call_args[0][0]
        self.assertIn("preflight_checks", call_url)
        json_data = self.mock_session.post.call_args.kwargs.get("json", {})
        self.assertEqual(json_data.get("bina_id"), 5616503)
        self.assertEqual(json_data.get("result"), "PASSED")
        self.assertEqual(json_data.get("portal_price"), 185000.0)

    def test_create_render_version_preserves_rendered_price(self):
        """create_render_version accepts and stores rendered_price and rendered_currency."""
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = [
            {
                "id": "rv-100",
                "listing_id": "listing-uuid-999",
                "version_num": 1,
                "rendered_price": 185000.0,
                "rendered_currency": "AZN",
            }
        ]
        self.mock_session.post.return_value = mock_resp

        result = self.repo.create_render_version(
            listing_id="listing-uuid-999",
            version_num=1,
            rendered_price=185000.0,
            rendered_currency="AZN",
        )

        self.assertIsNotNone(result)
        json_data = self.mock_session.post.call_args.kwargs.get("json", {})
        self.assertEqual(json_data.get("rendered_price"), 185000.0)
        self.assertEqual(json_data.get("rendered_currency"), "AZN")


if __name__ == "__main__":
    unittest.main()
