"""Unit tests for currency normalization, null-safe repost scoring, Rejim 3 guardrails,
and BinaScraper pre-scrape skip & liveness handling."""

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.dedup.change_detector import (
    compute_photo_urls_hash,
    detect_listing_changes,
    evaluate_price_drop_retrigger,
    find_best_repost_match,
    normalize_district,
    normalize_price_to_azn,
    score_repost_candidate,
)
from src.scraper.bina_scraper import (
    BinaScraper,
    LIVENESS_ACTIVE,
    LIVENESS_REMOVED,
    LIVENESS_TRANSIENT_ERROR,
)


class TestCurrencyNormalizationAndDiff(unittest.TestCase):
    def test_usd_to_azn_zero_delta_currency_flip(self):
        usd_azn = normalize_price_to_azn(100000, "USD", usd_rate=1.70)
        azn_val = normalize_price_to_azn(170000, "AZN", usd_rate=1.70)
        self.assertEqual(usd_azn, 170000.0)
        self.assertEqual(azn_val, 170000.0)

        existing = {
            "bina_id": "5616503",
            "price": 100000,
            "currency": "USD",
            "price_azn_normalized": 170000.0,
            "has_bill_of_sale": True,
        }
        incoming = {
            "bina_id": "5616503",
            "price": 170000,
            "currency": "AZN",
            "has_bill_of_sale": True,
        }
        diff = detect_listing_changes(existing, incoming, usd_rate=1.70)
        self.assertFalse(diff["price_changed"])
        self.assertFalse(diff["has_changes"])
        self.assertEqual(diff["price_delta_pct"], 0.0)
        self.assertEqual(diff["price_drop_pct"], 0.0)
        self.assertEqual(diff["events"], [])

    def test_eur_and_symbol_normalization(self):
        self.assertEqual(normalize_price_to_azn(100000, "EUR", eur_rate=1.85), 185000.0)
        self.assertEqual(normalize_price_to_azn("100 000", "$", usd_rate=1.70), 170000.0)
        self.assertEqual(normalize_price_to_azn("200.000", "€", eur_rate=1.85), 370000.0)
        self.assertEqual(normalize_price_to_azn(150000, "₼"), 150000.0)
        self.assertEqual(normalize_price_to_azn(None, "AZN"), 0.0)
        self.assertEqual(normalize_price_to_azn(0, "USD"), 0.0)

    def test_detect_listing_changes_price_kupca_photos(self):
        old_photos = ["https://cdn.bina.az/1.jpg", "https://cdn.bina.az/2.jpg"]
        new_photos = ["https://cdn.bina.az/1.jpg", "https://cdn.bina.az/3.jpg"]
        existing = {
            "bina_id": "5616503",
            "price": 175000,
            "currency": "AZN",
            "price_azn_normalized": 175000.0,
            "has_bill_of_sale": False,
            "photo_urls_hash": compute_photo_urls_hash(old_photos),
        }
        incoming = {
            "bina_id": "5616503",
            "price": 165000,
            "currency": "AZN",
            "has_bill_of_sale": True,
            "photo_urls": new_photos,
        }
        diff = detect_listing_changes(existing, incoming)
        self.assertTrue(diff["has_changes"])
        self.assertTrue(diff["price_changed"])
        self.assertTrue(diff["kupca_changed"])
        self.assertTrue(diff["photos_changed"])
        self.assertAlmostEqual(diff["price_drop_pct"], 5.71, places=2)
        self.assertAlmostEqual(diff["price_delta_pct"], -5.71, places=2)
        event_types = [e["event_type"] for e in diff["events"]]
        self.assertEqual(event_types, ["PRICE_CHANGED", "KUPCA_CHANGED", "PHOTOS_CHANGED"])

    def test_photo_urls_hash_is_order_independent_and_null_safe(self):
        h1 = compute_photo_urls_hash(["https://a.jpg", "https://b.jpg"])
        h2 = compute_photo_urls_hash(["https://b.jpg", "https://a.jpg", "https://a.jpg"])
        self.assertEqual(h1, h2)
        self.assertEqual(compute_photo_urls_hash([]), "")
        self.assertEqual(compute_photo_urls_hash(None), "")

    def test_normalize_district_landmarks(self):
        self.assertEqual(normalize_district("Gənclik m."), "Nərimanov")
        self.assertEqual(normalize_district("Xalqlar Dostluğu m."), "Nizami")
        self.assertEqual(normalize_district("Elmlər Akademiyası m."), "Yasamal")
        self.assertEqual(normalize_district(""), "")

    def test_same_currency_eur_rate_shift_never_triggers_phantom_drop(self):
        existing = {
            "bina_id": "5616599",
            "price": 100000,
            "currency": "EUR",
            "price_azn_normalized": 195000.0,  # Stored under old EUR=1.95 rate
            "has_bill_of_sale": True,
            "editorial_status": "PUBLISHED",
            "source_availability": "ACTIVE",
            "owner_outreach_status": "NOT_CONTACTED",
        }
        incoming = {
            "bina_id": "5616599",
            "price": 100000,
            "currency": "EUR",
            "has_bill_of_sale": True,
        }
        # EUR rate drops from 1.95 -> 1.80 (-7.7% FX move), raw EUR price unchanged
        diff = detect_listing_changes(existing, incoming, eur_rate=1.80)
        self.assertFalse(diff["price_changed"])
        self.assertFalse(diff["has_changes"])
        self.assertEqual(diff["price_delta_pct"], 0.0)
        self.assertEqual(diff["price_drop_pct"], 0.0)
        self.assertEqual(diff["events"], [])

        retrigger = evaluate_price_drop_retrigger(
            existing,
            100000,
            "EUR",
            eur_rate=1.80,
            now=datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc),
        )
        self.assertFalse(retrigger["should_trigger"])
        self.assertEqual(retrigger["price_drop_pct"], 0.0)

    def test_same_currency_eur_real_drop_uses_raw_price_not_fx(self):
        existing = {
            "bina_id": "5616600",
            "price": 100000,
            "currency": "EUR",
            "price_azn_normalized": 195000.0,
        }
        incoming = {
            "bina_id": "5616600",
            "price": 90000,
            "currency": "EUR",
        }
        diff = detect_listing_changes(existing, incoming, eur_rate=1.80)
        self.assertTrue(diff["price_changed"])
        self.assertAlmostEqual(diff["price_delta_pct"], -10.0, places=2)
        self.assertAlmostEqual(diff["price_drop_pct"], 10.0, places=2)

    def test_same_currency_noise_guard_under_1_azn(self):
        existing = {
            "bina_id": "5616601",
            "price": 175000.0,
            "currency": "AZN",
            "price_azn_normalized": 175000.0,
        }
        incoming = {
            "bina_id": "5616601",
            "price": 174999.5,
            "currency": "AZN",
        }
        diff = detect_listing_changes(existing, incoming)
        self.assertFalse(diff["price_changed"])
        self.assertFalse(diff["has_changes"])
        self.assertEqual(diff["events"], [])

    def test_cross_currency_real_drop_uses_fx_normalized_azn(self):
        existing = {
            "bina_id": "5616602",
            "price": 100000,
            "currency": "USD",
            "price_azn_normalized": 170000.0,
        }
        incoming = {
            "bina_id": "5616602",
            "price": 153000,
            "currency": "AZN",
        }
        diff = detect_listing_changes(existing, incoming, usd_rate=1.70)
        self.assertTrue(diff["price_changed"])
        self.assertAlmostEqual(diff["price_delta_pct"], -10.0, places=2)
        self.assertAlmostEqual(diff["price_drop_pct"], 10.0, places=2)


class TestNullSafeRepostScoring(unittest.TestCase):
    def test_empty_phone_never_auto_blocks_even_if_all_other_fields_match(self):
        existing = {
            "id": "uuid-existing-1",
            "bina_id": "100001",
            "owner_phone_normalized": "+994501234567",
            "location": "Nərimanov r-nu",
            "rooms": 3,
            "area": 100.0,
            "floor": 7,
        }
        candidate_no_phone = {
            "bina_id": "100002",
            "owner_phone": "",
            "location": "Nərimanov r-nu",
            "rooms": 3,
            "area": 100.0,
            "floor": 7,
        }
        res = score_repost_candidate(candidate_no_phone, existing)
        self.assertTrue(res["phone_missing"])
        self.assertFalse(res["is_potential_duplicate"])
        self.assertEqual(res["duplicate_resolution"], "NONE")
        self.assertAlmostEqual(res["score"], 0.55, places=2)
        self.assertIsNone(find_best_repost_match(candidate_no_phone, [existing]))

    def test_both_empty_phones_and_null_fields_never_collide(self):
        existing = {
            "id": "uuid-1",
            "bina_id": "200001",
            "owner_phone": "",
            "location": "",
            "rooms": None,
            "area": None,
            "floor": None,
        }
        candidate = {
            "bina_id": "200002",
            "owner_phone": None,
            "location": "",
            "rooms": None,
            "area": None,
            "floor": None,
        }
        res = score_repost_candidate(candidate, existing)
        self.assertEqual(res["score"], 0.0)
        self.assertEqual(res["matched_fields"], [])
        self.assertFalse(res["is_potential_duplicate"])
        self.assertEqual(res["duplicate_resolution"], "NONE")

    def test_same_building_same_layout_different_owner_phone_not_flagged(self):
        existing = {
            "id": "uuid-1",
            "bina_id": "300001",
            "owner_phone_normalized": "+994501112233",
            "location": "Yasamal",
            "rooms": 2,
            "area": 75.0,
            "floor": 8,
        }
        candidate = {
            "bina_id": "300002",
            "owner_phone": "+994559998877",
            "location": "Yasamal",
            "rooms": 2,
            "area": 75.0,
            "floor": 8,
        }
        res = score_repost_candidate(candidate, existing)
        self.assertFalse(res["phone_missing"])
        self.assertAlmostEqual(res["score"], 0.55, places=2)
        self.assertFalse(res["is_potential_duplicate"])
        self.assertEqual(res["duplicate_resolution"], "NONE")

    def test_repost_score_ge_085_flags_pending_review(self):
        existing = {
            "id": "uuid-orig",
            "bina_id": "400001",
            "owner_phone_normalized": "+994501234567",
            "location": "Gənclik m.",
            "rooms": 2,
            "area": 74.4,
            "floor": 6,
        }
        # Slightly altered area within 3% tolerance (75.1 vs 74.4 = 0.93% diff), same phone/district/rooms
        candidate = {
            "bina_id": "400002",
            "owner_phone": "(050) 123-45-67",
            "location": "Nərimanov r-nu",
            "rooms": 2,
            "area": 75.1,
            "floor": 9,  # Different floor -> 0.45 + 0.15 + 0.15 + 0.15 = 0.90 >= 0.85
        }
        res = score_repost_candidate(candidate, existing)
        self.assertAlmostEqual(res["score"], 0.90, places=2)
        self.assertTrue(res["is_potential_duplicate"])
        self.assertEqual(res["duplicate_resolution"], "PENDING_REVIEW")
        self.assertEqual(set(res["matched_fields"]), {"phone", "district", "rooms", "area"})

        best = find_best_repost_match(candidate, [existing])
        self.assertIsNotNone(best)
        self.assertEqual(best["existing_id"], "uuid-orig")

    def test_same_bina_id_is_not_treated_as_repost(self):
        listing = {
            "id": "uuid-same",
            "bina_id": "500001",
            "owner_phone_normalized": "+994501234567",
            "location": "Nərimanov",
            "rooms": 3,
            "area": 100,
            "floor": 5,
        }
        res = score_repost_candidate(listing, listing)
        self.assertEqual(res["score"], 0.0)
        self.assertFalse(res["is_potential_duplicate"])


class TestRejim3PriceDropGuardrails(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
        self.active_listing = {
            "bina_id": "5616503",
            "price": 175000,
            "currency": "AZN",
            "price_azn_normalized": 175000.0,
            "editorial_status": "PUBLISHED",
            "source_availability": "ACTIVE",
            "owner_outreach_status": "NOT_CONTACTED",
            "last_auto_rendered_at": None,
        }

    def test_valid_ge_5pct_drop_triggers_rejim3(self):
        res = evaluate_price_drop_retrigger(
            self.active_listing,
            165000,
            "AZN",
            today_auto_render_count=2,
            now=self.now,
        )
        self.assertTrue(res["should_trigger"])
        self.assertEqual(res["blocked_reasons"], [])
        self.assertAlmostEqual(res["price_drop_pct"], 5.71, places=2)
        self.assertEqual(res["idempotency_key"], "price_drop:5616503:165000")
        self.assertIsNotNone(res["price_drop_info"])
        self.assertEqual(res["price_drop_info"]["drop_amount_azn"], 10000.0)

    def test_currency_flip_does_not_trigger(self):
        usd_listing = {
            **self.active_listing,
            "price": 100000,
            "currency": "USD",
            "price_azn_normalized": 170000.0,
        }
        res = evaluate_price_drop_retrigger(usd_listing, 170000, "AZN", now=self.now, usd_rate=1.70)
        self.assertFalse(res["should_trigger"])
        self.assertEqual(res["price_drop_pct"], 0.0)
        self.assertTrue(any(r.startswith("DROP_BELOW_THRESHOLD") for r in res["blocked_reasons"]))

    def test_guardrail_1_archived_and_rejected_blocked(self):
        for status in ("ARCHIVED", "REJECTED"):
            listing = {**self.active_listing, "editorial_status": status}
            res = evaluate_price_drop_retrigger(listing, 160000, "AZN", now=self.now)
            self.assertFalse(res["should_trigger"])
            self.assertIn(f"EDITORIAL_BLOCKED:{status}", res["blocked_reasons"])

    def test_guardrail_2_unavailable_source_blocked(self):
        for avail in ("REMOVED_ON_BINA", "CONFIRMED_SOLD"):
            listing = {**self.active_listing, "source_availability": avail}
            res = evaluate_price_drop_retrigger(listing, 160000, "AZN", now=self.now)
            self.assertFalse(res["should_trigger"])
            self.assertIn(f"SOURCE_UNAVAILABLE:{avail}", res["blocked_reasons"])

    def test_guardrail_3_owner_sold_and_refused_agent_blocked(self):
        for outreach in ("OWNER_SOLD", "REFUSED_AGENT"):
            listing = {**self.active_listing, "owner_outreach_status": outreach}
            res = evaluate_price_drop_retrigger(listing, 160000, "AZN", now=self.now)
            self.assertFalse(res["should_trigger"])
            self.assertIn(f"OUTREACH_BLOCKED:{outreach}", res["blocked_reasons"])

    def test_guardrail_4a_24h_cooldown_enforced(self):
        recent = (self.now - timedelta(hours=12)).isoformat()
        listing_recent = {**self.active_listing, "last_auto_rendered_at": recent}
        res_blocked = evaluate_price_drop_retrigger(listing_recent, 160000, "AZN", now=self.now)
        self.assertFalse(res_blocked["should_trigger"])
        self.assertIn("COOLDOWN_ACTIVE", res_blocked["blocked_reasons"])

        expired = (self.now - timedelta(hours=25)).isoformat()
        listing_old = {**self.active_listing, "last_auto_rendered_at": expired}
        res_ok = evaluate_price_drop_retrigger(listing_old, 160000, "AZN", now=self.now)
        self.assertTrue(res_ok["should_trigger"])

    def test_guardrail_4b_daily_limit_5_enforced(self):
        res_at_limit = evaluate_price_drop_retrigger(
            self.active_listing,
            160000,
            "AZN",
            today_auto_render_count=5,
            daily_limit=5,
            now=self.now,
        )
        self.assertFalse(res_at_limit["should_trigger"])
        self.assertIn("DAILY_LIMIT_REACHED", res_at_limit["blocked_reasons"])

        res_under_limit = evaluate_price_drop_retrigger(
            self.active_listing,
            160000,
            "AZN",
            today_auto_render_count=4,
            daily_limit=5,
            now=self.now,
        )
        self.assertTrue(res_under_limit["should_trigger"])


class TestScraperPreScrapeAndLiveness(unittest.TestCase):
    def test_pre_scrape_known_bina_ids_skip_eliminates_page1_starvation(self):
        scraper = BinaScraper(owner_only=True)
        fetched_details = []

        def fake_fetch_details(item_id):
            fetched_details.append(item_id)
            return {
                "bina_id": item_id,
                "url": f"https://bina.az/items/{item_id}",
                "title": f"Mənzil {item_id}",
                "price": 150000,
                "currency": "AZN",
                "is_owner": True,
                "photo_urls": [],
                "status": "NEW",
            }

        with patch.object(scraper, "fetch_item_ids_from_page", return_value=["101", "102", "103", "104", "105"]):
            with patch.object(scraper, "fetch_item_details", side_effect=fake_fetch_details):
                with patch.object(scraper, "fetch_contact_phone", return_value="+994501234567"):
                    with patch("src.scraper.bina_scraper.time.sleep"):
                        results = scraper.scrape_and_process_page(
                            page=1,
                            limit=2,
                            known_bina_ids={"101", "102", "103"},
                        )

        self.assertEqual([r["bina_id"] for r in results], ["104", "105"])
        self.assertEqual(fetched_details, ["104", "105"])

    def test_pre_scrape_with_repo_touches_last_seen(self):
        scraper = BinaScraper(owner_only=True)
        mock_repo = MagicMock()
        mock_repo.get_listings_by_bina_ids.return_value = {
            "201": {"bina_id": "201", "price_azn_normalized": 150000},
            "202": {"bina_id": "202", "price_azn_normalized": 180000},
        }

        with patch.object(scraper, "fetch_item_ids_from_page", return_value=["201", "202", "203"]):
            with patch.object(
                scraper,
                "fetch_item_details",
                return_value={
                    "bina_id": "203",
                    "url": "https://bina.az/items/203",
                    "is_owner": True,
                    "photo_urls": [],
                },
            ):
                with patch.object(scraper, "fetch_contact_phone", return_value="+994501112233"):
                    with patch("src.scraper.bina_scraper.time.sleep"):
                        results = scraper.scrape_and_process_page(page=1, limit=1, repo=mock_repo)

        self.assertEqual([r["bina_id"] for r in results], ["203"])
        mock_repo.get_listings_by_bina_ids.assert_called_once_with(["201", "202", "203"])
        mock_repo.touch_listings_last_seen.assert_called_once_with(["201", "202"])

    def test_liveness_404_and_410_return_removed(self):
        scraper = BinaScraper()
        for code in (404, 410):
            resp = MagicMock()
            resp.status_code = code
            resp.text = ""
            with patch.object(scraper.session, "get", return_value=resp):
                self.assertEqual(scraper.check_listing_liveness("5616503"), LIVENESS_REMOVED)

    def test_liveness_429_403_503_and_network_error_return_transient_error(self):
        scraper = BinaScraper()
        for code in (429, 403, 500, 503):
            resp = MagicMock()
            resp.status_code = code
            resp.text = "Rate limited"
            with patch.object(scraper.session, "get", return_value=resp):
                self.assertEqual(scraper.check_listing_liveness("5616503"), LIVENESS_TRANSIENT_ERROR)

        with patch.object(scraper.session, "get", side_effect=ConnectionError("timeout")):
            self.assertEqual(scraper.check_listing_liveness("5616503"), LIVENESS_TRANSIENT_ERROR)

    def test_liveness_200_active_vs_removed_dom_vs_bot_challenge(self):
        scraper = BinaScraper()

        # Active __NEXT_DATA__
        active_payload = {"props": {"pageProps": {"currentItemData": {"id": 5616503, "status": "active"}}}}
        resp_active = MagicMock()
        resp_active.status_code = 200
        resp_active.text = f'<html><script id="__NEXT_DATA__">{json.dumps(active_payload)}</script></html>'
        with patch.object(scraper.session, "get", return_value=resp_active):
            self.assertEqual(scraper.check_listing_liveness("5616503"), LIVENESS_ACTIVE)

        # Removed DOM phrase
        resp_removed = MagicMock()
        resp_removed.status_code = 200
        resp_removed.text = "<html><body><h1>Bu elan silinib</h1></body></html>"
        with patch.object(scraper.session, "get", return_value=resp_removed):
            self.assertEqual(scraper.check_listing_liveness("5616503"), LIVENESS_REMOVED)

        # Cloudflare bot challenge -> TRANSIENT_ERROR (not REMOVED!)
        resp_cf = MagicMock()
        resp_cf.status_code = 200
        resp_cf.text = "<html><body>Just a moment... Checking your browser</body></html>"
        with patch.object(scraper.session, "get", return_value=resp_cf):
            self.assertEqual(scraper.check_listing_liveness("5616503"), LIVENESS_TRANSIENT_ERROR)

    def test_download_photos_refreshes_when_hash_changes(self):
        scraper = BinaScraper()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            with patch("src.scraper.bina_scraper.DOWNLOADS_DIR", tmp_path):
                img_dir = tmp_path / "999001"
                img_dir.mkdir(parents=True, exist_ok=True)
                old_photo = img_dir / "photo_01.jpg"
                old_photo.write_bytes(b"OLD" * 600)
                (img_dir / ".photo_urls_hash").write_text("oldhash123", encoding="utf-8")

                resp = MagicMock()
                resp.status_code = 200
                resp.content = b"NEW" * 600
                with patch.object(scraper.session, "get", return_value=resp):
                    with patch("src.scraper.bina_scraper.time.sleep"):
                        paths = scraper.download_full_hd_photos(
                            "999001",
                            ["https://cdn.bina.az/new_01.jpg"],
                            photo_urls_hash="newhash456",
                        )

                self.assertEqual(len(paths), 1)
                self.assertEqual(Path(paths[0]).read_bytes(), b"NEW" * 600)
                self.assertEqual((img_dir / ".photo_urls_hash").read_text(encoding="utf-8").strip(), "newhash456")


if __name__ == "__main__":
    unittest.main()
