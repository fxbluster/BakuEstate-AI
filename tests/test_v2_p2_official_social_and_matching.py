"""TDD tests for v2 Phase 3: Official Meta/TikTok APIs, SHA-256 comment dedup,
smart buyer-listing matching triggers, canonical <=120k niche routing, and settings deprecation."""

import hashlib
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.cloud.supabase_repo import SupabaseRepo


class TestOfficialSocialClients(unittest.TestCase):
    """Tests for Vault RPC wrappers, Meta 2-step Reels, TikTok PULL_FROM_URL, telemetry & token refresh."""

    def setUp(self):
        self.mock_session = MagicMock()
        self.repo = SupabaseRepo(
            supabase_url="https://example.supabase.co",
            supabase_key="service-role-secret",
            enabled=True,
            session=self.mock_session,
        )

    def test_vault_rpcs_use_service_role_endpoints_not_direct_vault_table(self):
        from src.social.official_clients import read_social_secret, store_social_secret

        read_resp = MagicMock()
        read_resp.status_code = 200
        read_resp.json.return_value = "ig-access-token-123"

        store_resp = MagicMock()
        store_resp.status_code = 200
        store_resp.json.return_value = "11111111-2222-3333-4444-555555555555"

        self.mock_session.post.side_effect = [read_resp, store_resp]

        secret = read_social_secret(self.repo, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        self.assertEqual(secret, "ig-access-token-123")

        new_id = store_social_secret(self.repo, "meta_ig_token", "new-secret-val")
        self.assertEqual(new_id, "11111111-2222-3333-4444-555555555555")

        calls = self.mock_session.post.call_args_list
        self.assertEqual(
            calls[0].args[0],
            "https://example.supabase.co/rest/v1/rpc/read_social_secret",
        )
        self.assertEqual(
            calls[0].kwargs["json"],
            {"p_secret_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
        )
        self.assertEqual(
            calls[1].args[0],
            "https://example.supabase.co/rest/v1/rpc/store_social_secret",
        )
        self.assertEqual(
            calls[1].kwargs["json"],
            {"p_name": "meta_ig_token", "p_secret": "new-secret-val"},
        )

    def test_meta_two_step_reels_container_polling_and_publish(self):
        from src.social.official_clients import MediaPublishError, OfficialSocialPublisher

        http = MagicMock()
        # 1) Vault read_social_secret
        vault_resp = MagicMock(status_code=200)
        vault_resp.json.return_value = "meta-tok-abc"
        self.mock_session.post.return_value = vault_resp

        # 2) Meta HTTP calls: create container -> poll IN_PROGRESS -> poll FINISHED -> media_publish -> permalink
        create_resp = MagicMock(status_code=200)
        create_resp.json.return_value = {"id": "cont_999"}
        poll_in_prog = MagicMock(status_code=200)
        poll_in_prog.json.return_value = {"id": "cont_999", "status_code": "IN_PROGRESS"}
        poll_done = MagicMock(status_code=200)
        poll_done.json.return_value = {"id": "cont_999", "status_code": "FINISHED"}
        publish_resp = MagicMock(status_code=200)
        publish_resp.json.return_value = {"id": "ig_media_777"}
        permalink_resp = MagicMock(status_code=200)
        permalink_resp.json.return_value = {
            "id": "ig_media_777",
            "permalink": "https://www.instagram.com/reel/C9MetaReel/",
        }

        http.post.side_effect = [create_resp, publish_resp]
        http.get.side_effect = [poll_in_prog, poll_done, permalink_resp]

        sleep_calls = []
        publisher = OfficialSocialPublisher(
            repo=self.repo,
            http_session=http,
            poll_interval_seconds=0.1,
            max_poll_attempts=5,
            sleep_fn=lambda s: sleep_calls.append(s),
        )
        account = {
            "id": "acc-1",
            "platform": "INSTAGRAM",
            "external_account_id": "17841400001",
            "vault_secret_id": "sec-uuid-1",
            "account_handle": "@bakuestate.official",
        }
        res = publisher.publish_instagram_reel(
            account=account,
            video_url="https://media.bakuestate.az/v/videos/a1/l1/v1.mp4",
            caption="Yasamalda 3 otaqlı mənzil",
        )

        self.assertEqual(res["external_post_id"], "ig_media_777")
        self.assertEqual(res["container_id"], "cont_999")
        self.assertEqual(res["post_url"], "https://www.instagram.com/reel/C9MetaReel/")
        self.assertEqual(len(sleep_calls), 1)

        # Verify container creation & publish endpoints
        first_post_url = http.post.call_args_list[0].args[0]
        second_post_url = http.post.call_args_list[1].args[0]
        self.assertIn("/17841400001/media", first_post_url)
        self.assertIn("/17841400001/media_publish", second_post_url)

        # Error status code raises MediaPublishError
        self.mock_session.post.return_value = vault_resp
        err_poll = MagicMock(status_code=200)
        err_poll.json.return_value = {"id": "cont_bad", "status_code": "ERROR", "status": "Invalid video"}
        http.post.side_effect = [MagicMock(status_code=200, json=lambda: {"id": "cont_bad"})]
        http.get.side_effect = [err_poll]
        with self.assertRaises(MediaPublishError):
            publisher.publish_instagram_reel(
                account=account,
                video_url="https://media.bakuestate.az/v/videos/a1/l1/v1.mp4",
                caption="Test",
            )

    def test_tiktok_pull_from_url_requires_verified_domain_and_polls_status(self):
        from src.social.official_clients import MediaPublishError, OfficialSocialPublisher

        http = MagicMock()
        vault_resp = MagicMock(status_code=200)
        vault_resp.json.return_value = "tt-access-tok"
        self.mock_session.post.return_value = vault_resp

        publisher = OfficialSocialPublisher(
            repo=self.repo,
            http_session=http,
            poll_interval_seconds=0.01,
            max_poll_attempts=4,
            sleep_fn=lambda _: None,
        )
        account = {
            "id": "acc-tt-1",
            "platform": "TIKTOK",
            "external_account_id": "tt-open-id-1",
            "vault_secret_id": "sec-tt-1",
            "account_handle": "@baku_emlak_ai",
        }

        # Reject non-verified R2 origin URL
        with self.assertRaises(MediaPublishError):
            publisher.publish_tiktok_video(
                account=account,
                video_url="https://acct.r2.cloudflarestorage.com/baku-estate-media/v1.mp4",
                title="Təcili satış!",
            )

        init_resp = MagicMock(status_code=200)
        init_resp.json.return_value = {
            "data": {"publish_id": "v_pub_001"},
            "error": {"code": "ok", "message": ""},
        }
        status_proc = MagicMock(status_code=200)
        status_proc.json.return_value = {
            "data": {"status": "PROCESSING_DOWNLOAD"},
            "error": {"code": "ok"},
        }
        status_done = MagicMock(status_code=200)
        status_done.json.return_value = {
            "data": {
                "status": "PUBLISH_COMPLETE",
                "publicaly_available_post_id": ["7444111222333"],
            },
            "error": {"code": "ok"},
        }
        http.post.side_effect = [init_resp, status_proc, status_done]

        res = publisher.publish_tiktok_video(
            account=account,
            video_url="https://media.bakuestate.az/v/videos/a1/l1/v1.mp4?exp=1800000000&sig=abc",
            title="Endirimli mənzil!",
        )
        self.assertEqual(res["platform"], "TIKTOK")
        self.assertEqual(res["external_post_id"], "7444111222333")
        self.assertIn("media.bakuestate.az", http.post.call_args_list[0].kwargs["json"]["source_info"]["video_url"])
        self.assertEqual(http.post.call_args_list[0].kwargs["json"]["source_info"]["source"], "PULL_FROM_URL")

    def test_token_refresh_handles_24h_tiktok_and_60d_meta_windows(self):
        from src.social.official_clients import refresh_expiring_social_tokens

        now = datetime(2026, 11, 25, 12, 0, 0, tzinfo=timezone.utc)
        accounts = [
            {
                "id": "acc-tt-expiring",
                "agency_id": "ag-1",
                "platform": "TIKTOK",
                "account_handle": "@baku_emlak_ai",
                "vault_secret_id": "sec-tt-old",
                "refresh_vault_secret_id": "sec-tt-ref",
                "token_expires_at": (now + timedelta(hours=2)).isoformat(),
                "is_active": True,
            },
            {
                "id": "acc-ig-expiring",
                "agency_id": "ag-1",
                "platform": "INSTAGRAM",
                "account_handle": "@bakuestate.official",
                "vault_secret_id": "sec-ig-old",
                "refresh_vault_secret_id": None,
                "token_expires_at": (now + timedelta(days=3)).isoformat(),
                "is_active": True,
            },
            {
                "id": "acc-ig-fresh",
                "agency_id": "ag-1",
                "platform": "INSTAGRAM",
                "account_handle": "@bakuestate.premium",
                "vault_secret_id": "sec-ig-fresh",
                "refresh_vault_secret_id": None,
                "token_expires_at": (now + timedelta(days=45)).isoformat(),
                "is_active": True,
            },
        ]

        get_accounts_resp = MagicMock(status_code=200)
        get_accounts_resp.json.return_value = accounts
        self.mock_session.get.return_value = get_accounts_resp

        # Repo RPC responses: read tt refresh -> store tt access -> store tt refresh -> read ig access -> store ig access
        self.mock_session.post.side_effect = [
            MagicMock(status_code=200, json=lambda: "old-tt-refresh-tok"),
            MagicMock(status_code=200, json=lambda: "new-tt-sec-uuid"),
            MagicMock(status_code=200, json=lambda: "new-tt-ref-uuid"),
            MagicMock(status_code=200, json=lambda: "old-ig-access-tok"),
            MagicMock(status_code=200, json=lambda: "new-ig-sec-uuid"),
        ]
        self.mock_session.patch.return_value = MagicMock(status_code=200, json=lambda: [{}])

        http = MagicMock()
        tt_refresh_resp = MagicMock(status_code=200)
        tt_refresh_resp.json.return_value = {
            "access_token": "new-tt-access",
            "refresh_token": "new-tt-refresh",
            "expires_in": 86400,
        }
        ig_refresh_resp = MagicMock(status_code=200)
        ig_refresh_resp.json.return_value = {
            "access_token": "new-ig-long-lived",
            "expires_in": 5184000,  # 60 days
        }
        http.post.return_value = tt_refresh_resp
        http.get.return_value = ig_refresh_resp

        summary = refresh_expiring_social_tokens(
            self.repo,
            http_session=http,
            now=now,
            meta_app_id="meta-id",
            meta_app_secret="meta-sec",
            tiktok_client_key="tt-key",
            tiktok_client_secret="tt-sec",
        )

        self.assertEqual(summary["refreshed_count"], 2)
        self.assertEqual(summary["skipped_count"], 1)
        self.assertEqual(summary["failed_count"], 0)
        self.assertEqual(self.mock_session.patch.call_count, 2)

    def test_official_telemetry_sync_fetches_instagram_and_tiktok_metrics(self):
        from src.social.official_clients import OfficialSocialPublisher

        http = MagicMock()
        vault_resp = MagicMock(status_code=200)
        vault_resp.json.return_value = "tok-sync-123"
        self.mock_session.post.return_value = vault_resp

        # Mock social_accounts lookup
        acc_get_resp = MagicMock(status_code=200)
        acc_get_resp.json.return_value = [{
            "id": "acc-ig",
            "agency_id": "ag-1",
            "platform": "INSTAGRAM",
            "account_handle": "@bakuestate.official",
            "vault_secret_id": "sec-ig",
            "is_active": True,
            "status": "ACTIVE",
        }]
        self.mock_session.get.return_value = acc_get_resp

        ig_media_resp = MagicMock(status_code=200, json=lambda: {"like_count": 42, "comments_count": 2})
        ig_ins_resp = MagicMock(status_code=200, json=lambda: {"data": [{"name": "plays", "values": [{"value": 1500}]}, {"name": "shares", "values": [{"value": 7}]}]})
        ig_comm_resp = MagicMock(status_code=200, json=lambda: {"data": [{"id": "ig_c_1", "username": "ali_baku", "text": "Qiyməti nədir?", "like_count": 3}]})
        http.get.side_effect = [ig_media_resp, ig_ins_resp, ig_comm_resp]

        publisher = OfficialSocialPublisher(repo=self.repo, http_session=http)
        ig_tel = publisher.fetch_telemetry({
            "id": "pub-ig-1",
            "agency_id": "ag-1",
            "channel": "INSTAGRAM_REELS",
            "external_post_id": "179000111",
            "target_account_handle": "@bakuestate.official",
        })
        self.assertEqual(ig_tel["platform"], "INSTAGRAM")
        self.assertEqual(ig_tel["views_count"], 1500)
        self.assertEqual(ig_tel["likes_count"], 42)
        self.assertEqual(ig_tel["shares_count"], 7)
        self.assertEqual(len(ig_tel["comments"]), 1)
        self.assertEqual(ig_tel["comments"][0]["comment_id"], "ig_c_1")

        # TikTok video/query telemetry
        tt_resp = MagicMock(status_code=200, json=lambda: {
            "data": {"videos": [{"id": "tt_v_9", "view_count": 8200, "like_count": 310, "comment_count": 19, "share_count": 24}]}
        })
        http.post.return_value = tt_resp
        tt_tel = publisher.fetch_tiktok_telemetry({"vault_secret_id": "sec-tt"}, "tt_v_9")
        self.assertEqual(tt_tel["platform"], "TIKTOK")
        self.assertEqual(tt_tel["views_count"], 8200)
        self.assertEqual(tt_tel["shares_count"], 24)


class TestFallbackObserverSHA256AndModeGuard(unittest.TestCase):
    """Tests for observer.py TELEGRAM_FALLBACK restriction and deterministic SHA-256 comment IDs."""

    def test_observer_blocked_when_social_api_mode_is_official(self):
        from src.social.observer import SocialScrapeException, SocialTelemetryObserver

        obs = SocialTelemetryObserver(social_api_mode="OFFICIAL")
        with self.assertRaises(SocialScrapeException):
            obs.fetch_telemetry("https://www.instagram.com/reel/DCXYZ123/")

    def test_instagram_embed_produces_deterministic_sha256_comment_ids(self):
        from src.social.observer import SocialTelemetryObserver

        html_poll_1 = """
        <html><body>
          <div>1,250 likes 4,500 views</div>
          <ul>
            <li class="Comment"><a class="Username">@samir_baku</a> Qiyməti nə qədərdir?</li>
            <li class="Comment"><a class="Username">@leyla99</a> Kupça var?</li>
          </ul>
        </body></html>
        """
        # Poll 2 prepends a new comment, shifting indices of both prior comments!
        html_poll_2 = """
        <html><body>
          <div>1,260 likes 4,600 views</div>
          <ul>
            <li class="Comment"><a class="Username">@anar_new</a> Salam</li>
            <li class="Comment"><a class="Username">@samir_baku</a> Qiyməti nə qədərdir?</li>
            <li class="Comment"><a class="Username">@leyla99</a> Kupça var?</li>
          </ul>
        </body></html>
        """

        responses = [
            MagicMock(status_code=200, text=html_poll_1, url="https://www.instagram.com/reel/DCXYZ123/embed/captioned/"),
            MagicMock(status_code=200, text=html_poll_2, url="https://www.instagram.com/reel/DCXYZ123/embed/captioned/"),
        ]
        obs = SocialTelemetryObserver(
            social_api_mode="TELEGRAM_FALLBACK",
            custom_fetcher=lambda url, headers: responses.pop(0),
        )

        res1 = obs.fetch_telemetry("https://www.instagram.com/reel/DCXYZ123/")
        res2 = obs.fetch_telemetry("https://www.instagram.com/reel/DCXYZ123/")

        expected_samir_id = hashlib.sha256(
            "INSTAGRAM:DCXYZ123:samir_baku:Qiyməti nə qədərdir?".encode("utf-8")
        ).hexdigest()[:32]
        expected_leyla_id = hashlib.sha256(
            "INSTAGRAM:DCXYZ123:leyla99:Kupça var?".encode("utf-8")
        ).hexdigest()[:32]

        ids_1 = {c["author_handle"]: c["comment_id"] for c in res1["comments"]}
        ids_2 = {c["author_handle"]: c["comment_id"] for c in res2["comments"]}

        self.assertEqual(ids_1["samir_baku"], expected_samir_id)
        self.assertEqual(ids_2["samir_baku"], expected_samir_id)
        self.assertEqual(ids_1["leyla99"], expected_leyla_id)
        self.assertEqual(ids_2["leyla99"], expected_leyla_id)
        self.assertFalse(ids_1["samir_baku"].startswith("ig_c_"))


class TestLocalWorkerOfficialSocialAndMatching(unittest.TestCase):
    """Tests for local_worker.py SOCIAL_API_MODE branching, comment dedup, and match_listing_to_leads."""

    def test_sync_social_metrics_dedups_comments_via_rpc_no_duplicate_lead_alerts(self):
        from src.worker.local_worker import BakuLocalWorker

        mock_session = MagicMock()
        repo = SupabaseRepo(
            supabase_url="https://example.supabase.co",
            supabase_key="service-role-secret",
            enabled=True,
            session=mock_session,
        )
        # Mock repo helpers for publication/listing lookup & telemetry writes
        repo.get_publication_by_id = MagicMock(return_value={
            "id": "pub-1",
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "listing_id": "lst-1",
            "post_url": "https://www.instagram.com/reel/DCXYZ123/",
            "poll_count": 0,
            "published_at": datetime.now(timezone.utc).isoformat(),
        })
        repo.get_agency_settings = MagicMock(return_value={
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "social_api_mode": "TELEGRAM_FALLBACK",
        })
        repo.get_listing_by_id = MagicMock(return_value={
            "id": "lst-1",
            "agency_id": "11111111-1111-1111-1111-111111111111",
            "price": 150000,
            "currency": "AZN",
            "location": "Yasamal",
        })
        repo.create_social_buyer_lead = MagicMock(return_value={"id": "lead-1"})
        repo.update_publication_telemetry = MagicMock()
        repo.record_telemetry_snapshot = MagicMock()

        # Poll #1 returns is_new=True; Poll #2 returns is_new=False
        rpc_new = MagicMock(status_code=200)
        rpc_new.json.return_value = [{"comment_id": "comm-uuid-1", "is_new": True}]
        rpc_dup = MagicMock(status_code=200)
        rpc_dup.json.return_value = [{"comment_id": "comm-uuid-1", "is_new": False}]
        mock_session.post.side_effect = [rpc_new, rpc_dup]
        mock_session.patch.return_value = MagicMock(status_code=200)

        worker = BakuLocalWorker(repo=repo, pipeline=MagicMock(), enable_periodic_scheduler=False)
        worker._notify_social_inbound_lead = MagicMock()

        comment_payload = {
            "comment_id": "deadbeef12345678deadbeef12345678",
            "author_handle": "samir_baku",
            "comment_text": "Qiyməti nə qədərdir? Əlaqə nömrəsi yazın",
            "like_count": 1,
        }
        job = {"id": "job-sync-1", "job_type": "SYNC_SOCIAL_METRICS", "params_json": {"publication_id": "pub-1"}}

        with patch("src.social.observer.SocialTelemetryObserver.fetch_telemetry", return_value={
            "platform": "INSTAGRAM",
            "views_count": 500,
            "likes_count": 20,
            "comments_count": 1,
            "shares_count": 0,
            "comments": [comment_payload],
        }):
            res1 = worker._handle_sync_social_metrics(job)
            res2 = worker._handle_sync_social_metrics(job)

        self.assertEqual(res1["leads_captured"], 1)
        self.assertEqual(res2["leads_captured"], 0)
        repo.create_social_buyer_lead.assert_called_once()
        worker._notify_social_inbound_lead.assert_called_once()

    def test_scrape_new_triggers_match_listing_to_leads_for_active_listings(self):
        from src.worker.local_worker import BakuLocalWorker

        mock_session = MagicMock()
        repo = SupabaseRepo(
            supabase_url="https://example.supabase.co",
            supabase_key="service-role-secret",
            enabled=True,
            session=mock_session,
        )
        rpc_resp = MagicMock(status_code=200)
        rpc_resp.json.return_value = 4
        mock_session.post.return_value = rpc_resp

        mock_pipeline = MagicMock()
        mock_pipeline.run_ingestion.return_value = [
            {
                "id": "11111111-1111-1111-1111-111111111111",
                "bina_id": "6588858",
                "source_availability": "ACTIVE",
            },
            {
                "id": "22222222-2222-2222-2222-222222222222",
                "bina_id": "6588859",
                "source_availability": "REMOVED_ON_BINA",
            },
        ]

        worker = BakuLocalWorker(repo=repo, pipeline=mock_pipeline, enable_periodic_scheduler=False)
        res = worker._handle_scrape_new({
            "id": "job-scrape-1",
            "job_type": "SCRAPE_NEW",
            "params_json": {"pages": 1, "limit": 5},
        })

        self.assertEqual(res["ingested_count"], 2)
        self.assertEqual(res["matched_leads_count"], 4)
        mock_session.post.assert_called_once()
        self.assertEqual(
            mock_session.post.call_args.args[0],
            "https://example.supabase.co/rest/v1/rpc/match_listing_to_leads",
        )
        self.assertEqual(
            mock_session.post.call_args.kwargs["json"],
            {"p_listing_id": "11111111-1111-1111-1111-111111111111"},
        )

    def test_publish_social_branches_on_social_api_mode(self):
        from src.worker.local_worker import BakuLocalWorker

        mock_repo = MagicMock()
        mock_repo.is_configured.return_value = True
        mock_repo.get_listing_by_id.return_value = {
            "id": "lst-1",
            "agency_id": "ag-1",
            "bina_id": "6588858",
            "price": 180000,
        }
        mock_repo.get_publication_by_id.return_value = {
            "id": "pub-1",
            "agency_id": "ag-1",
            "listing_id": "lst-1",
            "channel": "INSTAGRAM_REELS",
            "target_account_handle": "@bakuestate.official",
            "render_version_id": "rv-1",
            "caption_used": "Yasamal mənzil",
        }
        mock_repo.get_render_version_by_id.return_value = {
            "id": "rv-1",
            "storage_provider": "r2",
            "storage_object_path": "videos/ag-1/lst-1/v1.mp4",
        }

        worker = BakuLocalWorker(repo=mock_repo, pipeline=MagicMock(), enable_periodic_scheduler=False)

        # OFFICIAL mode calls OfficialSocialPublisher
        mock_repo.get_agency_settings.return_value = {"agency_id": "ag-1", "social_api_mode": "OFFICIAL"}
        with patch("src.social.official_clients.OfficialSocialPublisher") as mock_pub_cls:
            mock_pub_cls.return_value.publish_publication.return_value = {
                "platform": "INSTAGRAM",
                "external_post_id": "ig_999",
                "post_url": "https://www.instagram.com/reel/C9xyz/",
            }
            res_official = worker.execute_job({
                "id": "job-pub-1",
                "job_type": "PUBLISH_SOCIAL",
                "listing_id": "lst-1",
                "params_json": {"publication_id": "pub-1"},
            })

        self.assertEqual(res_official["status"], "SUCCEEDED")
        self.assertEqual(res_official["result"]["mode"], "OFFICIAL")
        mock_pub_cls.return_value.publish_publication.assert_called_once()

        # TELEGRAM_FALLBACK mode delegates to _handle_telegram_dispatch
        mock_repo.get_agency_settings.return_value = {"agency_id": "ag-1", "social_api_mode": "TELEGRAM_FALLBACK"}
        worker._handle_telegram_dispatch = MagicMock(return_value={"status": "DISPATCHED", "message_id": 55})
        res_fb = worker.execute_job({
            "id": "job-pub-2",
            "job_type": "PUBLISH_SOCIAL",
            "listing_id": "lst-1",
            "params_json": {"publication_id": "pub-1"},
        })
        self.assertEqual(res_fb["status"], "SUCCEEDED")
        self.assertEqual(res_fb["result"]["mode"], "TELEGRAM_FALLBACK")
        worker._handle_telegram_dispatch.assert_called_once()

    def test_sync_social_metrics_official_mode_and_price_drop_matching(self):
        from src.worker.local_worker import BakuLocalWorker

        mock_session = MagicMock()
        repo = SupabaseRepo(
            supabase_url="https://example.supabase.co",
            supabase_key="service-role-secret",
            enabled=True,
            session=mock_session,
        )
        repo.get_publication_by_id = MagicMock(return_value={
            "id": "pub-off-1",
            "agency_id": "ag-1",
            "listing_id": "lst-off-1",
            "channel": "INSTAGRAM_REELS",
            "external_post_id": "179000222",
            "poll_count": 0,
            "published_at": datetime.now(timezone.utc).isoformat(),
        })
        repo.get_agency_settings = MagicMock(return_value={
            "agency_id": "ag-1",
            "social_api_mode": "OFFICIAL",
        })
        repo.get_listing_by_id = MagicMock(return_value={
            "id": "lst-off-1",
            "agency_id": "ag-1",
            "bina_id": "6588860",
            "price": 200000.0,
            "currency": "AZN",
        })
        repo.update_listing = MagicMock()
        repo.update_publication_telemetry = MagicMock()
        repo.record_telemetry_snapshot = MagicMock()

        match_resp = MagicMock(status_code=200)
        match_resp.json.return_value = 3
        mock_session.post.return_value = match_resp

        worker = BakuLocalWorker(repo=repo, pipeline=MagicMock(), enable_periodic_scheduler=False)
        worker._check_listing_liveness_and_price = MagicMock(return_value={
            "status": "ACTIVE",
            "price": 175000.0,
            "price_dropped": True,
        })
        worker._send_operator_alert = MagicMock()

        with patch("src.social.official_clients.OfficialSocialPublisher") as mock_pub_cls:
            mock_pub_cls.return_value.fetch_telemetry.return_value = {
                "platform": "INSTAGRAM",
                "views_count": 900,
                "likes_count": 30,
                "comments_count": 0,
                "shares_count": 2,
                "comments": [],
            }
            outcome = worker._handle_sync_social_metrics({
                "id": "job-sync-off",
                "job_type": "SYNC_SOCIAL_METRICS",
                "params_json": {"publication_id": "pub-off-1"},
            })

        self.assertEqual(outcome["views_count"], 900)
        mock_pub_cls.return_value.fetch_telemetry.assert_called_once()
        mock_session.post.assert_called_once()
        self.assertEqual(
            mock_session.post.call_args.args[0],
            "https://example.supabase.co/rest/v1/rpc/match_listing_to_leads",
        )
        self.assertEqual(mock_session.post.call_args.kwargs["json"], {"p_listing_id": "lst-off-1"})


class TestCanonicalNicheRouterAndSettings(unittest.TestCase):
    """Cross-boundary parity tests for <= 120,000 AZN canonical rule, niche_rules_json, and settings."""

    def test_canonical_niche_boundaries_match_web_contract(self):
        from src.worker.account_router import resolve_canonical_listing_niche, route_listing_to_channel

        # Neutral district (Yasamal) across key price & drop boundaries
        self.assertEqual(
            resolve_canonical_listing_niche({"price": 115000, "location": "Yasamal"}),
            {"niche": "AFFORDABLE", "account": "@baku.serfeli.evler"},
        )
        self.assertEqual(
            resolve_canonical_listing_niche({"price": 120000, "location": "Yasamal"}),
            {"niche": "AFFORDABLE", "account": "@baku.serfeli.evler"},
        )
        self.assertEqual(
            resolve_canonical_listing_niche({"price": 135000, "location": "Yasamal"}),
            {"niche": "GENERAL", "account": "@bakuestate.official"},
        )
        self.assertEqual(
            resolve_canonical_listing_niche({"price": 260000, "location": "Yasamal"}),
            {"niche": "LUXURY", "account": "@bakuestate.premium"},
        )
        self.assertEqual(
            resolve_canonical_listing_niche({"price": 260000, "location": "Yasamal", "price_drop_pct": 12}),
            {"niche": "TIKTOK", "account": "@baku_emlak_ai"},
        )

        # Normalized AZN price takes precedence over raw USD figure
        res_usd = route_listing_to_channel({"price": 100000, "currency": "USD", "price_azn_normalized": 170000, "location": "Yasamal"})
        self.assertEqual(res_usd["channel_niche"], "GENERAL")

    def test_agency_settings_niche_rules_json_overrides_thresholds(self):
        from src.worker.account_router import resolve_canonical_listing_niche, route_listing_to_channel

        custom_rules = {
            "affordable_max_azn": 140000,
            "luxury_min_azn": 300000,
            "viral_drop_pct": 15,
        }
        # 135k becomes AFFORDABLE when affordable_max_azn = 140000
        self.assertEqual(
            resolve_canonical_listing_niche({"price": 135000, "location": "Yasamal"}, custom_rules)["niche"],
            "AFFORDABLE",
        )
        # 260k becomes GENERAL when luxury_min_azn = 300000
        self.assertEqual(
            resolve_canonical_listing_niche({"price": 260000, "location": "Yasamal"}, custom_rules)["niche"],
            "GENERAL",
        )
        # 12% drop does NOT trigger TIKTOK when viral_drop_pct = 15
        res = route_listing_to_channel(
            {"price": 180000, "location": "Yasamal", "price_drop_pct": 12},
            niche_rules=custom_rules,
        )
        self.assertEqual(res["channel_niche"], "GENERAL")

    def test_settings_baku_district_median_marked_deprecated_fallback(self):
        import config.settings as settings

        self.assertTrue(isinstance(settings.BAKU_DISTRICT_MEDIAN_M2, dict))
        self.assertTrue(getattr(settings, "BAKU_DISTRICT_MEDIAN_M2_DEPRECATED", False))


if __name__ == "__main__":
    unittest.main()
