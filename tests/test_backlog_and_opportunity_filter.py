"""TDD tests for backlog-first video rendering and special-opportunity scraping filter."""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class TestBacklogAndOpportunityFilter(unittest.TestCase):
    def test_is_special_opportunity_detects_below_market_and_urgent_owner_kupca(self):
        from src.pipeline.opportunity_filter import is_special_opportunity

        # 1. Yasamal floor is 2200 AZN/m2; 1700 AZN/m2 is >15% below floor
        hot_price, reason_price = is_special_opportunity(
            {
                "price_azn_normalized": 170000,
                "area": 100,
                "district_normalized": "Yasamal",
                "is_owner": False,
                "has_bill_of_sale": False,
                "title": "Yasamal 3 otaqlı mənzil",
            }
        )
        self.assertTrue(hot_price)
        self.assertEqual(reason_price, "BELOW_MARKET_M2")

        # 2. Owner-direct + Kupça + urgent keyword
        hot_urgent, reason_urgent = is_special_opportunity(
            {
                "price_azn_normalized": 260000,
                "area": 100,
                "district_normalized": "Yasamal",
                "is_owner": True,
                "has_bill_of_sale": True,
                "title": "Təcili dəyərindən ucuz satılır",
                "description": "Əla təmirli mənzil",
            }
        )
        self.assertTrue(hot_urgent)
        self.assertEqual(reason_urgent, "URGENT_OWNER_KUPCA")

        # 3. Ordinary Yasamal listing at 2500 AZN/m2
        normal, reason_normal = is_special_opportunity(
            {
                "price_azn_normalized": 250000,
                "area": 100,
                "district_normalized": "Yasamal",
                "is_owner": True,
                "has_bill_of_sale": True,
                "title": "Yasamalda 3 otaqlı mənzil",
            }
        )
        self.assertFalse(normal)
        self.assertEqual(reason_normal, "STANDARD_MARKET")

        # 4. Daily/monthly rental (e.g. 90 AZN for 200 m2) must NOT be treated as a sale deal
        rental, reason_rental = is_special_opportunity(
            {
                "price_azn_normalized": 90,
                "area": 200,
                "district_normalized": "Nəsimi",
                "is_owner": True,
                "has_bill_of_sale": True,
                "title": "4 otaqlı mənzil, 200 m²",
            }
        )
        self.assertFalse(rental)
        self.assertEqual(reason_rental, "RENTAL_OR_INVALID_PRICE")

    def test_ingest_scraped_listing_special_opportunities_only(self):
        from run_pipeline import BakuEstatePipeline

        pipeline = object.__new__(BakuEstatePipeline)
        pipeline.use_cloud_backend = True
        pipeline.db_path = "unused.db"
        pipeline.supabase_repo = MagicMock()
        pipeline.supabase_repo.get_listing_by_bina_id.return_value = None
        pipeline.supabase_repo.find_repost_candidates.return_value = []
        pipeline.supabase_repo.upsert_listing.return_value = {
            "id": "uuid-special-1",
            "bina_id": "9001001",
            "price": 170000,
            "currency": "AZN",
            "price_azn_normalized": 170000,
            "location": "Yasamal",
        }

        # Ordinary listing should be skipped when special_opportunities_only=True
        res_skip = pipeline.ingest_scraped_listing(
            {
                "bina_id": "9001000",
                "price": 250000,
                "currency": "AZN",
                "price_azn_normalized": 250000,
                "area": 100,
                "location": "Yasamal",
                "title": "Adi Yasamal mənzil",
            },
            enqueue_render_jobs=True,
            special_opportunities_only=True,
        )
        self.assertEqual(res_skip["action"], "skipped_not_special")
        pipeline.supabase_repo.upsert_listing.assert_not_called()
        pipeline.supabase_repo.enqueue_pipeline_job.assert_not_called()

        # Special opportunity should be saved with video deferred (job is None)
        res_keep = pipeline.ingest_scraped_listing(
            {
                "bina_id": "9001001",
                "price": 170000,
                "currency": "AZN",
                "price_azn_normalized": 170000,
                "area": 100,
                "location": "Yasamal",
                "title": "Yasamal fürsət",
            },
            enqueue_render_jobs=True,
            special_opportunities_only=True,
        )
        self.assertEqual(res_keep["action"], "created")
        self.assertIsNone(res_keep["job"])
        pipeline.supabase_repo.upsert_listing.assert_called_once()
        upserted_payload = pipeline.supabase_repo.upsert_listing.call_args[0][0]
        self.assertEqual(upserted_payload["pipeline_status"], "NEW")
        pipeline.supabase_repo.enqueue_pipeline_job.assert_not_called()

    def test_handle_scrape_new_prioritizes_unrendered_backlog_and_filters_special_only(self):
        from src.worker.local_worker import BakuLocalWorker

        repo = MagicMock()
        repo.is_configured.return_value = True
        repo.count_today_auto_renders_baku.return_value = 0
        repo.get_unrendered_backlog_listings.return_value = [
            {"id": "uuid-b1", "bina_id": "1001"},
            {"id": "uuid-b2", "bina_id": "1002"},
        ]
        repo.enqueue_pipeline_job.side_effect = [
            {"id": "job-r1", "job_type": "RENDER_INITIAL"},
            {"id": "job-r2", "job_type": "RENDER_INITIAL"},
        ]

        pipeline = MagicMock()
        pipeline.run_ingestion.return_value = []

        worker = BakuLocalWorker(
            repo=repo,
            pipeline=pipeline,
            worker_id="test-worker",
            poll_interval_seconds=0.05,
            heartbeat_interval_seconds=0.05,
            enable_periodic_scheduler=False,
        )

        result = worker._handle_scrape_new(
            {
                "id": "job-scrape-1",
                "trigger_source": "WEB_UI",
                "params_json": {"pages": 2, "limit": 3, "enqueue_render_jobs": True},
            }
        )

        self.assertEqual(result["backlog_renders_enqueued"], 2)
        self.assertTrue(result["special_opportunities_only"])
        self.assertEqual(repo.enqueue_pipeline_job.call_count, 2)
        pipeline.run_ingestion.assert_called_once_with(
            pages=2,
            limit_per_page=3,
            specific_id=None,
            enqueue_render_jobs=False,
            check_existing_for_changes=True,
            special_opportunities_only=True,
        )

        # When backlog is empty, normal scraping resumes
        repo.reset_mock()
        pipeline.reset_mock()
        repo.get_unrendered_backlog_listings.return_value = []
        result_empty = worker._handle_scrape_new(
            {
                "id": "job-scrape-2",
                "trigger_source": "AUTO_SCHEDULER",
                "params_json": {"pages": 1, "limit": 3},
            }
        )
        self.assertEqual(result_empty["backlog_renders_enqueued"], 0)
        self.assertFalse(result_empty["special_opportunities_only"])
        pipeline.run_ingestion.assert_called_once_with(
            pages=1,
            limit_per_page=3,
            specific_id=None,
            enqueue_render_jobs=True,
            check_existing_for_changes=True,
            special_opportunities_only=False,
        )


if __name__ == "__main__":
    unittest.main()
