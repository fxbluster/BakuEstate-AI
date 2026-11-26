"""Unit tests for SupabaseRepo phone preservation, versioned uploads, and RPC/REST contracts."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.cloud.supabase_repo import SupabaseRepo, build_versioned_storage_path


class TestSupabaseRepo(unittest.TestCase):
    def setUp(self):
        self.mock_session = MagicMock()
        self.repo = SupabaseRepo(
            supabase_url="https://example.supabase.co",
            supabase_key="test-service-role-secret",
            bucket_name="baku-estate-media",
            enabled=True,
            session=self.mock_session,
        )

    def test_fail_closed_configuration(self):
        self.assertTrue(self.repo.is_configured())
        no_url = SupabaseRepo(supabase_url="", supabase_key="abc", enabled=True)
        self.assertFalse(no_url.is_configured())
        no_key = SupabaseRepo(supabase_url="https://example.supabase.co", supabase_key="", enabled=True)
        self.assertFalse(no_key.is_configured())
        disabled = SupabaseRepo(supabase_url="https://example.supabase.co", supabase_key="abc", enabled=False)
        self.assertFalse(disabled.is_configured())

    def test_build_versioned_storage_path(self):
        self.assertEqual(build_versioned_storage_path("5616503", 1), "videos/5616503/v1.mp4")
        self.assertEqual(build_versioned_storage_path("5616503", 3), "videos/5616503/v3.mp4")
        self.assertEqual(build_versioned_storage_path(" 5616503 ", 0), "videos/5616503/v1.mp4")

    def test_upsert_payload_preserves_existing_phone_when_incoming_empty(self):
        existing = {
            "bina_id": "5616503",
            "owner_phone_normalized": "+994501234567",
            "owner_phone_raw": "(050) 123-45-67",
        }
        incoming_empty_phone = {
            "bina_id": "5616503",
            "title": "3 otaqlı mənzil",
            "price": 165000,
            "currency": "AZN",
            "location": "Nərimanov",
            "owner_phone": "",
            "owner_phone_raw": "",
            "owner_phone_normalized": "",
        }
        payload = self.repo.build_listing_upsert_payload(incoming_empty_phone, existing=existing)
        self.assertEqual(payload["owner_phone_normalized"], "+994501234567")
        self.assertEqual(payload["owner_phone_raw"], "(050) 123-45-67")

    def test_upsert_payload_omits_phone_keys_when_empty_and_no_existing(self):
        incoming_no_phone = {
            "bina_id": "5616503",
            "price": 165000,
            "currency": "AZN",
            "owner_phone": "",
        }
        payload = self.repo.build_listing_upsert_payload(incoming_no_phone)
        self.assertNotIn("owner_phone_normalized", payload)
        self.assertNotIn("owner_phone_raw", payload)

    def test_upsert_listing_normalizes_valid_incoming_phone(self):
        resp = MagicMock()
        resp.status_code = 201
        resp.json.return_value = [{"id": "uuid-1", "bina_id": "5616503", "owner_phone_normalized": "+994509998877"}]
        self.mock_session.post.return_value = resp

        saved = self.repo.upsert_listing({
            "bina_id": "5616503",
            "price": 100000,
            "currency": "USD",
            "location": "Gənclik m.",
            "owner_phone": "(050) 999-88-77",
        })
        self.assertIsNotNone(saved)
        args, kwargs = self.mock_session.post.call_args
        self.assertIn("/rest/v1/listings", args[0])
        self.assertNotIn("params", kwargs)
        sent = kwargs["json"][0]
        self.assertEqual(sent["owner_phone_normalized"], "+994509998877")
        self.assertEqual(sent["price_azn_normalized"], 170000.0)
        self.assertEqual(sent["district_normalized"], "Nərimanov")

    def test_upsert_listing_handles_409_partial_index_conflict_with_patch(self):
        post_resp = MagicMock()
        post_resp.status_code = 409
        patch_resp = MagicMock()
        patch_resp.status_code = 200
        patch_resp.json.return_value = [{"id": "uuid-existing", "bina_id": "5616503"}]
        self.mock_session.post.return_value = post_resp
        self.mock_session.patch.return_value = patch_resp

        saved = self.repo.upsert_listing({"bina_id": "5616503", "price": 150000, "currency": "AZN"})
        self.assertEqual(saved["id"], "uuid-existing")
        _, patch_kwargs = self.mock_session.patch.call_args
        self.assertEqual(patch_kwargs["params"], {"bina_id": "eq.5616503"})

    def test_enqueue_pipeline_job_uses_plain_post_and_handles_409_idempotently(self):
        resp_409 = MagicMock()
        resp_409.status_code = 409
        self.mock_session.post.return_value = resp_409

        result = self.repo.enqueue_pipeline_job(
            idempotency_key="initial:6588580",
            job_type="RENDER_INITIAL",
            listing_id="uuid-1",
            agency_id="ag-uuid-1",
            params_json={"bina_id": "6588580"},
        )
        self.assertIsNone(result)
        _, kwargs = self.mock_session.post.call_args
        self.assertNotIn("params", kwargs)
        self.assertEqual(kwargs["json"][0]["agency_id"], "ag-uuid-1")

    def test_update_listing_blocks_accidental_phone_clear(self):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = [{"id": "uuid-1", "editorial_status": "PUBLISHED"}]
        self.mock_session.patch.return_value = resp

        self.repo.update_listing(
            "uuid-1",
            {"editorial_status": "PUBLISHED", "owner_phone_normalized": "", "owner_phone_raw": None},
        )
        _, kwargs = self.mock_session.patch.call_args
        self.assertEqual(kwargs["json"], {"editorial_status": "PUBLISHED"})

    def test_upload_versioned_video_uses_versioned_path(self):
        resp = MagicMock()
        resp.status_code = 200
        self.mock_session.post.return_value = resp

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp.write(b"fake-mp4-binary-payload")
            tmp_path = tmp.name

        try:
            obj_path, cdn_url = self.repo.upload_versioned_video(tmp_path, "5616503", 2)
            self.assertEqual(obj_path, "videos/5616503/v2.mp4")
            self.assertEqual(
                cdn_url,
                "https://example.supabase.co/storage/v1/object/public/baku-estate-media/videos/5616503/v2.mp4",
            )
            args, kwargs = self.mock_session.post.call_args
            self.assertEqual(
                args[0],
                "https://example.supabase.co/storage/v1/object/baku-estate-media/videos/5616503/v2.mp4",
            )
            self.assertEqual(kwargs["headers"]["Content-Type"], "video/mp4")
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def test_upload_versioned_video_missing_file(self):
        obj_path, cdn_url = self.repo.upload_versioned_video("does_not_exist_v9.mp4", "5616503", 9)
        self.assertIsNone(obj_path)
        self.assertIsNone(cdn_url)
        self.mock_session.post.assert_not_called()

    def test_find_repost_candidates_skips_http_on_empty_phone(self):
        self.assertEqual(self.repo.find_repost_candidates(""), [])
        self.assertEqual(self.repo.find_repost_candidates(None), [])
        self.mock_session.get.assert_not_called()

        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = [{"id": "u1", "bina_id": "111"}]
        self.mock_session.get.return_value = resp
        rows = self.repo.find_repost_candidates("050 123 45 67", exclude_bina_id="222")
        self.assertEqual(len(rows), 1)
        _, kwargs = self.mock_session.get.call_args
        self.assertEqual(kwargs["params"]["owner_phone_normalized"], "eq.+994501234567")
        self.assertEqual(kwargs["params"]["bina_id"], "neq.222")

    def test_render_version_increment_and_supersede(self):
        resp_latest = MagicMock()
        resp_latest.status_code = 200
        resp_latest.json.return_value = [{"id": "rv-2", "version_num": 2}]
        self.mock_session.get.return_value = resp_latest

        self.assertEqual(self.repo.get_next_render_version_num("uuid-listing"), 3)

        resp_patch = MagicMock()
        resp_patch.status_code = 204
        self.mock_session.patch.return_value = resp_patch
        self.assertTrue(self.repo.mark_previous_versions_superseded("uuid-listing", keep_version_num=3))
        _, kwargs = self.mock_session.patch.call_args
        self.assertEqual(kwargs["params"]["version_num"], "lt.3")
        self.assertEqual(kwargs["params"]["status"], "eq.COMPLETED")
        self.assertEqual(kwargs["json"], {"status": "SUPERSEDED"})

    def test_worker_rpcs_claim_heartbeat_and_daily_count(self):
        # claim_next_pipeline_job
        resp_claim = MagicMock()
        resp_claim.status_code = 200
        resp_claim.json.return_value = [{"id": "job-1", "job_type": "RENDER_PRICE_DROP"}]
        self.mock_session.post.return_value = resp_claim
        job = self.repo.claim_next_pipeline_job(worker_id="win-1", lease_minutes=5)
        self.assertEqual(job["id"], "job-1")
        args, kwargs = self.mock_session.post.call_args
        self.assertTrue(args[0].endswith("/rest/v1/rpc/claim_next_pipeline_job"))
        self.assertEqual(kwargs["json"], {"p_worker_id": "win-1", "p_lease_minutes": 5})

        # heartbeat_pipeline_job
        resp_hb = MagicMock()
        resp_hb.status_code = 200
        resp_hb.json.return_value = True
        self.mock_session.post.return_value = resp_hb
        self.assertTrue(self.repo.heartbeat_pipeline_job("job-1", worker_id="win-1", lease_minutes=5))

        # count_today_auto_renders_baku
        resp_cnt = MagicMock()
        resp_cnt.status_code = 200
        resp_cnt.json.return_value = 3
        self.mock_session.post.return_value = resp_cnt
        self.assertEqual(self.repo.count_today_auto_renders_baku(), 3)

    def test_notion_enabled_defaults_to_false(self):
        project_root = str(Path(__file__).resolve().parent.parent)
        env_without_notion = {k: v for k, v in os.environ.items() if k != "NOTION_ENABLED"}
        code = (
            f"import sys; sys.path.insert(0, {project_root!r}); "
            "from pathlib import Path; "
            "import config.settings as s; "
            "src = Path(s.__file__).read_text(encoding='utf-8'); "
            "assert 'os.getenv(\"NOTION_ENABLED\", \"false\")' in src; "
            "print(s.NOTION_ENABLED)"
        )
        proc = subprocess.run(
            [sys.executable, "-c", code],
            cwd=project_root,
            env=env_without_notion,
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(proc.stdout.strip(), "False")

    def test_complete_pipeline_job_fenced_rpc_with_worker_id(self):
        resp_ok = MagicMock()
        resp_ok.status_code = 200
        resp_ok.json.return_value = True
        self.mock_session.post.return_value = resp_ok

        res = self.repo.complete_pipeline_job(
            "job-1",
            "SUCCEEDED",
            error_message=None,
            worker_id="win-1",
        )
        self.assertTrue(res)
        args, kwargs = self.mock_session.post.call_args
        self.assertTrue(args[0].endswith("/rest/v1/rpc/complete_pipeline_job"))
        self.assertEqual(
            kwargs["json"],
            {
                "p_job_id": "job-1",
                "p_worker_id": "win-1",
                "p_status": "SUCCEEDED",
                "p_error_message": None,
            },
        )

        # Lease lost -> RPC returns False
        resp_false = MagicMock()
        resp_false.status_code = 200
        resp_false.json.return_value = False
        self.mock_session.post.return_value = resp_false
        self.assertFalse(self.repo.complete_pipeline_job("job-1", "SUCCEEDED", worker_id="win-1"))

    def test_complete_pipeline_job_404_falls_back_to_fenced_patch(self):
        resp_404 = MagicMock()
        resp_404.status_code = 404
        resp_404.text = "Not Found"
        self.mock_session.post.return_value = resp_404

        resp_patch = MagicMock()
        resp_patch.status_code = 200
        resp_patch.json.return_value = [{"id": "job-1", "status": "QUEUED"}]
        self.mock_session.patch.return_value = resp_patch

        res = self.repo.complete_pipeline_job(
            "job-1",
            status="QUEUED",
            error_message="transient timeout",
            worker_id="win-1",
        )
        self.assertTrue(res)
        args, kwargs = self.mock_session.patch.call_args
        self.assertTrue(args[0].endswith("/rest/v1/pipeline_jobs"))
        self.assertEqual(
            kwargs["params"],
            {
                "id": "eq.job-1",
                "locked_by": "eq.win-1",
                "status": "eq.RUNNING",
            },
        )
        self.assertEqual(kwargs["json"]["status"], "QUEUED")
        self.assertEqual(kwargs["json"]["error_message"], "transient timeout")
        self.assertNotIn("finished_at", kwargs["json"])

        # Empty rows from fenced PATCH -> lease lost -> False
        resp_patch_empty = MagicMock()
        resp_patch_empty.status_code = 200
        resp_patch_empty.json.return_value = []
        self.mock_session.patch.return_value = resp_patch_empty
        self.assertFalse(
            self.repo.complete_pipeline_job("job-1", status="SUCCEEDED", worker_id="win-1")
        )

    def test_complete_pipeline_job_backward_compat_without_worker_id(self):
        resp_patch = MagicMock()
        resp_patch.status_code = 200
        resp_patch.json.return_value = [{"id": "job-legacy", "status": "SUCCEEDED"}]
        self.mock_session.patch.return_value = resp_patch

        row = self.repo.complete_pipeline_job("job-legacy", status="SUCCEEDED")
        self.assertEqual(row, {"id": "job-legacy", "status": "SUCCEEDED"})
        self.mock_session.post.assert_not_called()
        _, kwargs = self.mock_session.patch.call_args
        self.assertEqual(kwargs["params"], {"id": "eq.job-legacy"})

    def test_create_sold_listing_lead_alerts_creates_high_tasks_for_open_leads_only(self):
        resp_get = MagicMock()
        resp_get.status_code = 200
        resp_get.json.return_value = [
            {
                "lead_id": "lead-1",
                "buyer_leads": {"id": "lead-1", "client_name": "Elvin", "stage": "VIEWING_SCHEDULED"},
            },
            {
                "lead_id": "lead-2",
                "buyer_leads": {"id": "lead-2", "client_name": "Aysel", "stage": "QUALIFIED"},
            },
            {
                "lead_id": "lead-closed",
                "buyer_leads": {"id": "lead-closed", "client_name": "Köhnə", "stage": "LOST"},
            },
        ]
        self.mock_session.get.return_value = resp_get

        def fake_post(url, headers=None, json=None, timeout=None):
            r = MagicMock()
            r.status_code = 201
            r.json.return_value = json
            return r

        self.mock_session.post.side_effect = fake_post

        created = self.repo.create_sold_listing_lead_alerts("uuid-listing-1", "5616503")
        self.assertEqual(len(created), 2)

        # Verify query joined lead_listings with open buyer_leads
        get_args, get_kwargs = self.mock_session.get.call_args
        self.assertTrue(get_args[0].endswith("/rest/v1/lead_listings"))
        self.assertEqual(get_kwargs["params"]["listing_id"], "eq.uuid-listing-1")
        self.assertEqual(
            get_kwargs["params"]["buyer_leads.stage"],
            "not.in.(WON_CLOSED,LOST,COLD)",
        )

        # Verify HIGH priority follow_up_tasks inserted for Elvin and Aysel only
        self.assertEqual(self.mock_session.post.call_count, 2)
        titles = [c.kwargs["json"][0]["title"] for c in self.mock_session.post.call_args_list]
        self.assertEqual(
            titles,
            [
                "⚠️ #5616503 satılıb — Elvin üçün alternativ mənzil təklif et",
                "⚠️ #5616503 satılıb — Aysel üçün alternativ mənzil təklif et",
            ],
        )
        for call in self.mock_session.post.call_args_list:
            payload = call.kwargs["json"][0]
            self.assertEqual(payload["entity_type"], "BUYER_LEAD")
            self.assertEqual(payload["priority"], "HIGH")
            self.assertEqual(payload["listing_id"], "uuid-listing-1")
            self.assertEqual(payload["status"], "OPEN")
            self.assertTrue(payload["due_at"])

    def test_create_or_update_publication_persists_account_and_niche(self):
        resp_get = MagicMock()
        resp_get.status_code = 200
        resp_get.json.return_value = []
        self.mock_session.get.return_value = resp_get

        resp_post = MagicMock()
        resp_post.status_code = 201
        resp_post.json.return_value = [{
            "id": "pub-uuid-1",
            "listing_id": "listing-uuid-1",
            "target_account_handle": "@bakuestate.premium",
            "channel_niche": "LUXURY",
            "status": "DRAFT_READY",
        }]
        self.mock_session.post.return_value = resp_post

        result = self.repo.create_or_update_publication(
            listing_id="listing-uuid-1",
            status="DRAFT_READY",
            target_account_handle="@bakuestate.premium",
            channel_niche="LUXURY",
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["target_account_handle"], "@bakuestate.premium")
        self.assertEqual(result["channel_niche"], "LUXURY")

        # Verify POST payload contained multi-account columns
        post_args, post_kwargs = self.mock_session.post.call_args
        self.assertTrue(post_args[0].endswith("/rest/v1/publications"))
        payload = post_kwargs["json"][0]
        self.assertEqual(payload["target_account_handle"], "@bakuestate.premium")
        self.assertEqual(payload["channel_niche"], "LUXURY")

    def test_append_lead_timeline_event(self):
        resp_post = MagicMock()
        resp_post.status_code = 201
        resp_post.json.return_value = [{
            "id": "event-uuid-1",
            "lead_id": "083d8ea3-4a73-4b85-8479-0c532ce939f0",
            "listing_id": "8581f8be-82ca-466f-a02c-a978b9ec9220",
            "actor": "AI_SENTINEL",
            "event_type": "OBJECTION",
            "summary": "Qiymət endirimi tələb edildi",
            "metadata": {"discount_pct": 5},
        }]
        self.mock_session.post.return_value = resp_post

        event = self.repo.append_lead_timeline_event(
            lead_id="083d8ea3-4a73-4b85-8479-0c532ce939f0",
            listing_id="8581f8be-82ca-466f-a02c-a978b9ec9220",
            actor="AI_SENTINEL",
            event_type="OBJECTION",
            summary="Qiymət endirimi tələb edildi",
            metadata={"discount_pct": 5},
        )
        self.assertIsNotNone(event)
        self.assertEqual(event["actor"], "AI_SENTINEL")
        self.assertEqual(event["event_type"], "OBJECTION")

        post_args, post_kwargs = self.mock_session.post.call_args
        self.assertTrue(post_args[0].endswith("/rest/v1/lead_timeline_events"))
        payload = post_kwargs["json"][0]
        self.assertEqual(payload["actor"], "AI_SENTINEL")
        self.assertEqual(payload["event_type"], "OBJECTION")
        self.assertEqual(payload["lead_id"], "083d8ea3-4a73-4b85-8479-0c532ce939f0")
        self.assertEqual(payload["listing_id"], "8581f8be-82ca-466f-a02c-a978b9ec9220")

    def test_queue_cockpit_card_and_priority_normalization(self):
        resp_post = MagicMock()
        resp_post.status_code = 201
        resp_post.json.return_value = [{
            "id": "card-uuid-1",
            "priority": "URGENT",
            "channel": "WHATSAPP",
            "headline": "Təcili Qiymət Endirimi",
            "status": "PENDING",
        }]
        self.mock_session.post.return_value = resp_post

        card = self.repo.queue_cockpit_card(
            lead_id="11111111-1111-1111-1111-111111111111",
            listing_id="8581f8be-82ca-466f-a02c-a978b9ec9220",
            channel="WHATSAPP",
            priority="URGENT",
            headline="Təcili Qiymət Endirimi",
            draft_text="Salam, qiymət endirildi.",
            target_uri="https://wa.me/994501234567",
            strategic_rationale="Bina.az qiyməti 10% düşdü",
        )
        self.assertIsNotNone(card)
        post_args, post_kwargs = self.mock_session.post.call_args
        self.assertTrue(post_args[0].endswith("/rest/v1/cockpit_cards"))
        payload = post_kwargs["json"][0]
        self.assertEqual(payload["priority"], "URGENT")
        self.assertEqual(payload["channel"], "WHATSAPP")
        self.assertEqual(payload["status"], "PENDING")
        self.assertEqual(payload["headline"], "Təcili Qiymət Endirimi")
        self.assertEqual(payload["reason"], "Bina.az qiyməti 10% düşdü")
        self.assertEqual(payload["strategic_rationale"], "Bina.az qiyməti 10% düşdü")
        self.assertEqual(payload["target_uri"], "https://wa.me/994501234567")

    def test_get_pending_cockpit_cards(self):
        resp_get = MagicMock()
        resp_get.status_code = 200
        resp_get.json.return_value = [
            {"id": "card-1", "priority": "URGENT", "status": "PENDING"},
            {"id": "card-2", "priority": "NORMAL", "status": "PENDING"},
        ]
        self.mock_session.get.return_value = resp_get

        cards = self.repo.get_pending_cockpit_cards(limit=5)
        self.assertEqual(len(cards), 2)
        get_args, get_kwargs = self.mock_session.get.call_args
        self.assertTrue(get_args[0].endswith("/rest/v1/cockpit_cards"))
        self.assertEqual(get_kwargs["params"]["status"], "eq.PENDING")
        self.assertEqual(get_kwargs["params"]["limit"], "5")

    def test_update_cockpit_card_status(self):
        card_uuid = "11111111-1111-1111-1111-111111111111"
        resp_patch = MagicMock()
        resp_patch.status_code = 200
        resp_patch.json.return_value = [{"id": card_uuid, "status": "EXECUTED"}]
        self.mock_session.patch.return_value = resp_patch

        updated = self.repo.update_cockpit_card_status(card_uuid, "EXECUTED")
        self.assertIsNotNone(updated)
        patch_args, patch_kwargs = self.mock_session.patch.call_args
        self.assertTrue(patch_args[0].endswith("/rest/v1/cockpit_cards"))
        self.assertEqual(patch_kwargs["params"]["id"], f"eq.{card_uuid}")
        self.assertEqual(patch_kwargs["json"]["status"], "EXECUTED")
        self.assertIn("acted_at", patch_kwargs["json"])


if __name__ == "__main__":
    unittest.main()
