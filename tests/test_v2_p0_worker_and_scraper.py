"""Phase 1 P0 TDD tests for Python Worker, Scraper, SupabaseRepo, Telegram & Edge Functions."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config.settings as settings
from src.cloud.supabase_repo import SupabaseRepo, _normalize_card_priority
from src.dispatcher.telegram_crm import generate_public_caption
from src.scraper.bina_scraper import BinaScraper
from src.worker.local_worker import BakuLocalWorker


REPO_ROOT = Path(__file__).resolve().parent.parent


class TestV2P0KupcaDefaults(unittest.TestCase):
    def test_settings_scrape_has_bill_of_sale_defaults_false(self):
        self.assertFalse(settings.SCRAPE_HAS_BILL_OF_SALE)

    def test_bina_scraper_next_data_none_bill_of_sale_defaults_false(self):
        scraper = BinaScraper()
        res = scraper._parse_next_data(
            "6588858",
            "https://bina.az/items/6588858",
            {
                "id": 6588858,
                "rooms": 2,
                "area": 75,
                "hasBillOfSale": None,
                "price": {"currency": "AZN", "total": 180000},
                "photos": [],
            },
        )
        self.assertIs(res["has_bill_of_sale"], False)

    def test_bina_scraper_html_fallback_defaults_false(self):
        scraper = BinaScraper()
        soup = BeautifulSoup(
            "<html><body><span class='price-val'>150000</span></body></html>",
            "html.parser",
        )
        res = scraper._parse_html_fallback("6588858", "https://bina.az/items/6588858", soup)
        self.assertIs(res["has_bill_of_sale"], False)

    def test_telegram_crm_caption_never_claims_kupca_when_false_or_missing(self):
        caption_missing = generate_public_caption(
            {
                "bina_id": "6588858",
                "price": 150000,
                "currency": "AZN",
                "location": "Yasamal",
                "rooms": 2,
                "area": 70,
            }
        )
        self.assertNotIn("KUPÇALI", caption_missing.upper())
        self.assertNotIn("Kupça) var", caption_missing)
        self.assertNotIn("#kupcali", caption_missing)

        caption_false = generate_public_caption(
            {
                "bina_id": "6588858",
                "price": 150000,
                "currency": "AZN",
                "location": "Yasamal",
                "rooms": 2,
                "area": 70,
                "has_bill_of_sale": False,
            }
        )
        self.assertNotIn("KUPÇALI", caption_false.upper())
        self.assertNotIn("Kupça) var", caption_false)
        self.assertNotIn("#kupcali", caption_false)

        caption_true = generate_public_caption(
            {
                "bina_id": "6588858",
                "price": 150000,
                "currency": "AZN",
                "location": "Yasamal",
                "rooms": 2,
                "area": 70,
                "has_bill_of_sale": True,
            }
        )
        self.assertIn("KUPÇALI", caption_true.upper())
        self.assertIn("Kupça) var", caption_true)


class TestV2P0SupabaseRepoAndWorker(unittest.TestCase):
    def setUp(self):
        self.mock_session = MagicMock()
        self.repo = SupabaseRepo(
            supabase_url="https://v2-isolated.supabase.co",
            supabase_key="service-role-secret",
            enabled=True,
            session=self.mock_session,
        )

    def test_get_default_operator_uid_returns_none_without_hardcoded_uuid(self):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = []
        self.mock_session.get.return_value = resp

        with patch.dict("os.environ", {}, clear=True):
            uid = self.repo.get_default_operator_uid()

        self.assertIsNone(uid)
        self.assertNotEqual(uid, "083d8ea3-4a73-4b85-8479-0c532ce939f0")

    def test_get_render_version_by_id(self):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = [
            {"id": "rv-uuid-1", "listing_id": "lst-1", "video_cdn_url": "https://cdn.test/v1.mp4"}
        ]
        self.mock_session.get.return_value = resp

        rv = self.repo.get_render_version_by_id("rv-uuid-1")
        self.assertIsNotNone(rv)
        self.assertEqual(rv["id"], "rv-uuid-1")
        get_url = self.mock_session.get.call_args[0][0]
        get_params = self.mock_session.get.call_args.kwargs["params"]
        self.assertTrue(get_url.endswith("/rest/v1/render_versions"))
        self.assertEqual(get_params["id"], "eq.rv-uuid-1")

    def test_is_job_cancel_requested(self):
        resp_yes = MagicMock()
        resp_yes.status_code = 200
        resp_yes.json.return_value = [{"id": "job-1", "status": "RUNNING", "cancel_requested_at": "2026-11-25T10:00:00Z"}]
        self.mock_session.get.return_value = resp_yes
        self.assertTrue(self.repo.is_job_cancel_requested("job-1"))

        resp_no = MagicMock()
        resp_no.status_code = 200
        resp_no.json.return_value = [{"id": "job-2", "status": "RUNNING", "cancel_requested_at": None}]
        self.mock_session.get.return_value = resp_no
        self.assertFalse(self.repo.is_job_cancel_requested("job-2"))

    def test_complete_pipeline_job_accepts_cancelled(self):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = True
        self.mock_session.post.return_value = resp

        ok = self.repo.complete_pipeline_job("job-1", status="CANCELLED", worker_id="worker-1")
        self.assertTrue(ok)
        post_json = self.mock_session.post.call_args.kwargs["json"]
        self.assertEqual(post_json["p_status"], "CANCELLED")
        self.assertEqual(post_json["p_worker_id"], "worker-1")

    def test_cockpit_cards_uppercase_schema_and_agency_id(self):
        self.assertEqual(_normalize_card_priority("URGENT"), "URGENT")
        self.assertEqual(_normalize_card_priority("HIGH"), "HIGH")
        self.assertEqual(_normalize_card_priority(95), "URGENT")
        self.assertEqual(_normalize_card_priority(20), "LOW")

        resp_post = MagicMock()
        resp_post.status_code = 201
        resp_post.json.return_value = [
            {
                "id": "card-1",
                "agency_id": "11111111-1111-1111-1111-111111111111",
                "priority": "URGENT",
                "status": "PENDING",
            }
        ]
        self.mock_session.post.return_value = resp_post

        card = self.repo.queue_cockpit_card(
            listing_id="8581f8be-82ca-466f-a02c-a978b9ec9220",
            agency_id="11111111-1111-1111-1111-111111111111",
            channel="WHATSAPP",
            priority="URGENT",
            headline="Qiymət endirimi",
            strategic_rationale="10% endirim oldu",
        )
        self.assertIsNotNone(card)
        payload = self.mock_session.post.call_args.kwargs["json"][0]
        self.assertEqual(payload["status"], "PENDING")
        self.assertEqual(payload["priority"], "URGENT")
        self.assertEqual(payload["channel"], "WHATSAPP")
        self.assertEqual(payload["agency_id"], "11111111-1111-1111-1111-111111111111")
        self.assertEqual(payload["strategic_rationale"], "10% endirim oldu")
        self.assertNotIn("owner_id", payload)

        resp_patch = MagicMock()
        resp_patch.status_code = 200
        resp_patch.json.return_value = [{"id": "d3b07384-d113-4e8c-85a0-975949e29930", "status": "EXECUTED"}]
        self.mock_session.patch.return_value = resp_patch
        self.repo.update_cockpit_card_status("d3b07384-d113-4e8c-85a0-975949e29930", "executed")
        patch_json = self.mock_session.patch.call_args.kwargs["json"]
        self.assertEqual(patch_json["status"], "EXECUTED")

    def test_local_worker_sync_social_metrics_updates_price_azn_normalized(self):
        mock_repo = MagicMock()
        mock_repo.is_configured.return_value = True
        mock_repo.get_publication_by_id.return_value = {
            "id": "pub-1",
            "listing_id": "lst-uuid-1",
            "post_url": "https://www.instagram.com/reel/abc123/",
            "poll_count": 0,
            "published_at": "2026-11-25T08:00:00+00:00",
        }
        mock_repo.get_listing_by_id.return_value = {
            "id": "lst-uuid-1",
            "bina_id": "6588858",
            "price": 200000.0,
            "price_azn_normalized": 200000.0,
            "currency": "AZN",
        }

        worker = BakuLocalWorker(repo=mock_repo, pipeline=MagicMock())
        worker._check_listing_liveness_and_price = MagicMock(
            return_value={"status": "ACTIVE", "price": 180000.0, "price_dropped": True}
        )
        worker._send_operator_alert = MagicMock()

        with patch("src.social.observer.SocialTelemetryObserver") as mock_obs_cls:
            mock_obs_cls.return_value.fetch_telemetry.return_value = {
                "platform": "INSTAGRAM",
                "views_count": 100,
                "likes_count": 10,
                "comments_count": 0,
                "shares_count": 0,
                "comments": [],
            }
            worker._handle_sync_social_metrics(
                {"id": "job-1", "params_json": {"publication_id": "pub-1"}}
            )

        mock_repo.update_listing.assert_called_once()
        _, patch_fields = mock_repo.update_listing.call_args[0]
        self.assertEqual(patch_fields["price"], 180000.0)
        self.assertEqual(patch_fields["price_azn_normalized"], 180000.0)
        self.assertNotIn("price_azn", patch_fields)

    def test_local_worker_telegram_dispatch_uses_valid_repo_methods_and_actor(self):
        mock_repo = MagicMock()
        mock_repo.is_configured.return_value = True
        mock_repo.get_listing_by_id.return_value = {
            "id": "lst-uuid-1",
            "bina_id": "6588858",
            "price": 180000.0,
            "currency": "AZN",
            "location": "Yasamal",
        }
        mock_repo.get_render_version_by_id.return_value = {
            "id": "rv-uuid-1",
            "video_cdn_url": "https://cdn.test/v1.mp4",
        }

        worker = BakuLocalWorker(repo=mock_repo, pipeline=MagicMock())
        mock_http_resp = MagicMock()
        mock_http_resp.status_code = 200
        mock_http_resp.iter_content.return_value = [b"mp4bytes"]

        with tempfile.TemporaryDirectory() as tmpdir, patch(
            "src.worker.local_worker.OUTPUT_DIR", Path(tmpdir)
        ), patch("src.worker.local_worker.TelegramCRMDispatcher") as mock_disp_cls, patch(
            "requests.get", return_value=mock_http_resp
        ):
            mock_disp_cls.return_value.send_video_lead.return_value = {
                "status": "MOCK_SUCCESS",
                "message_id": "mock_msg_6588858",
                "public_message_id": "",
            }
            res = worker._handle_telegram_dispatch(
                {
                    "id": "job-tg-1",
                    "listing_id": "lst-uuid-1",
                    "params_json": {
                        "listing_id": "lst-uuid-1",
                        "render_version_id": "rv-uuid-1",
                    },
                }
            )

        self.assertEqual(res["status"], "MOCK_SUCCESS")
        mock_repo.get_render_version_by_id.assert_called_once_with("rv-uuid-1")
        mock_repo.insert_listing_event.assert_called_once()
        event_kwargs = mock_repo.insert_listing_event.call_args.kwargs
        self.assertEqual(event_kwargs["listing_id"], "lst-uuid-1")
        self.assertEqual(event_kwargs["event_type"], "STATUS_CHANGED")
        self.assertEqual(event_kwargs["actor"], "local_worker")
        self.assertEqual(event_kwargs["triggered_job_id"], "job-tg-1")
        self.assertNotIn("summary", event_kwargs)
        self.assertNotIn("metadata", event_kwargs)

    def test_execute_job_cooperatively_cancels_when_cancel_requested(self):
        mock_repo = MagicMock()
        mock_repo.is_configured.return_value = True
        mock_repo.is_job_cancel_requested.return_value = True
        mock_repo.complete_pipeline_job.return_value = True

        worker = BakuLocalWorker(repo=mock_repo, pipeline=MagicMock(), worker_id="worker-cancel-test")
        res = worker.execute_job(
            {
                "id": "job-cancel-1",
                "job_type": "SCRAPE_NEW",
                "trigger_source": "WEB_UI",
                "params_json": {},
            }
        )
        self.assertEqual(res["status"], "CANCELLED")
        mock_repo.complete_pipeline_job.assert_called_once()
        call_kwargs = mock_repo.complete_pipeline_job.call_args.kwargs
        self.assertEqual(call_kwargs["status"], "CANCELLED")
        self.assertEqual(call_kwargs["worker_id"], "worker-cancel-test")


class TestV2P0EdgeFunctionsAndEnvExample(unittest.TestCase):
    def test_telegram_webhook_resolves_agency_id_and_fixes_kupca_caption(self):
        ts = (REPO_ROOT / "supabase/functions/telegram-webhook/index.ts").read_text(encoding="utf-8")
        self.assertIn("agency_settings", ts)
        self.assertIn("resolveAgencyIdForChat", ts)
        self.assertIn("agency_id", ts)
        self.assertIn("const hasKupca = Boolean(listing.has_bill_of_sale);", ts)
        self.assertIn("const headline = hasKupca", ts)
        self.assertIn("🔥 <b>${propType} SATILIR!</b> 🔥", ts)

    def test_followup_dispatcher_routes_per_agency_telegram_chat_id(self):
        ts = (REPO_ROOT / "supabase/functions/followup-dispatcher/index.ts").read_text(encoding="utf-8")
        self.assertIn("agency_settings", ts)
        self.assertIn("agency_id", ts)
        # Must resolve per-agency chat_id rather than sending all rows to a single global primaryChatId
        self.assertNotIn("sendTelegramMessage(botToken, primaryChatId", ts)

    def test_env_example_documents_v2_variables(self):
        env_text = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
        for key in (
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "BINA_PROXY_URL",
            "R2_ACCOUNT_ID",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_BUCKET",
            "WORKER_MODE",
            "SOCIAL_API_MODE",
            "CRON_SECRET",
        ):
            self.assertIn(key, env_text)


if __name__ == "__main__":
    unittest.main()
