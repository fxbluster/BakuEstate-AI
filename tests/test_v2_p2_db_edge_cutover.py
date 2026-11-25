"""Phase 3 TDD tests for Migration 0004, Edge Functions (followup-dispatcher,
telegram-webhook), and scripts/verify_v2_cutover.py.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_0004 = (
    PROJECT_ROOT
    / "supabase"
    / "migrations"
    / "202611260004_v2_p2_social_and_matching.sql"
)
FOLLOWUP_DISPATCHER_TS = (
    PROJECT_ROOT / "supabase" / "functions" / "followup-dispatcher" / "index.ts"
)
TELEGRAM_WEBHOOK_TS = (
    PROJECT_ROOT / "supabase" / "functions" / "telegram-webhook" / "index.ts"
)
VERIFY_CUTOVER_PY = PROJECT_ROOT / "scripts" / "verify_v2_cutover.py"


class TestV2Phase3Migration0004(unittest.TestCase):
    def test_migration_0004_exists_with_social_accounts_matches_and_indexes(self):
        self.assertTrue(
            MIGRATION_0004.exists(),
            f"Expected migration file {MIGRATION_0004} to exist",
        )
        sql = MIGRATION_0004.read_text(encoding="utf-8")

        # social_accounts extensions & constraints
        self.assertIn("public.social_accounts", sql)
        self.assertIn("refresh_vault_secret_id", sql)
        self.assertIn("status", sql)
        self.assertIn("'ACTIVE'", sql)
        self.assertIn("idx_publications_channel_ext_post", sql)
        self.assertIn("ON public.publications (channel, external_post_id)", sql)

        # pipeline_jobs PUBLISH_SOCIAL support
        self.assertIn("'PUBLISH_SOCIAL'", sql)

        # lead_listing_matches & unique pair constraint
        self.assertIn("public.lead_listing_matches", sql)
        self.assertIn("UNIQUE (lead_id, listing_id)", sql)
        self.assertIn("idx_lead_listing_matches_new_dispatch", sql)

        # social_comments unique constraint
        self.assertIn("uq_social_comments_platform_id", sql)

    def test_migration_0004_defines_service_role_vault_rpcs(self):
        sql = MIGRATION_0004.read_text(encoding="utf-8")

        self.assertRegex(
            sql,
            r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.store_social_secret\s*\(\s*p_name\s+TEXT\s*,\s*p_secret\s+TEXT\s*\)\s*RETURNS\s+UUID",
        )
        self.assertRegex(
            sql,
            r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.read_social_secret\s*\(\s*p_secret_id\s+UUID\s*\)\s*RETURNS\s+TEXT",
        )
        self.assertIn("vault.create_secret", sql)
        self.assertIn("vault.decrypted_secrets", sql)
        self.assertIn("FORBIDDEN_SERVICE_ROLE_ONLY", sql)

        self.assertIn(
            "REVOKE ALL ON FUNCTION public.store_social_secret(TEXT, TEXT) FROM PUBLIC, anon, authenticated",
            sql,
        )
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION public.store_social_secret(TEXT, TEXT) TO service_role",
            sql,
        )
        self.assertIn(
            "REVOKE ALL ON FUNCTION public.read_social_secret(UUID) FROM PUBLIC, anon, authenticated",
            sql,
        )
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION public.read_social_secret(UUID) TO service_role",
            sql,
        )

    def test_migration_0004_defines_comment_dedup_and_matching_rpcs_with_zero_anon(self):
        sql = MIGRATION_0004.read_text(encoding="utf-8")

        # upsert_social_comment_returning_is_new
        self.assertIn(
            "CREATE OR REPLACE FUNCTION public.upsert_social_comment_returning_is_new",
            sql,
        )
        self.assertIn("RETURNS TABLE", sql)
        self.assertIn("comment_id UUID", sql)
        self.assertIn("is_new BOOLEAN", sql)
        self.assertIn("ON CONFLICT (publication_id, platform_comment_id) DO NOTHING", sql)
        self.assertIn("RETURNING id", sql)
        self.assertIn("FROM PUBLIC, anon", sql)

        # match_listing_to_leads
        self.assertRegex(
            sql,
            r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.match_listing_to_leads\s*\(\s*p_listing_id\s+UUID\s*\)\s*RETURNS\s+INT",
        )
        self.assertIn("budget_max_azn", sql)
        self.assertIn("preferred_districts", sql)
        self.assertIn("min_rooms", sql)
        self.assertIn("requires_kupca", sql)
        self.assertIn("WON_CLOSED", sql)
        self.assertIn("match_score >= 60", sql)
        self.assertIn("ON CONFLICT (lead_id, listing_id) DO NOTHING", sql)
        self.assertIn(
            "REVOKE ALL ON FUNCTION public.match_listing_to_leads(UUID) FROM PUBLIC, anon",
            sql,
        )
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION public.match_listing_to_leads(UUID) TO authenticated, service_role",
            sql,
        )

        # Zero PUBLIC / anon grants anywhere in migration
        self.assertNotRegex(sql, r"GRANT\s+.*\s+TO\s+(PUBLIC|anon)\b")


class TestV2Phase3EdgeFunctions(unittest.TestCase):
    def test_followup_dispatcher_batches_new_lead_listing_matches_with_quiet_hours(self):
        src = FOLLOWUP_DISPATCHER_TS.read_text(encoding="utf-8")

        # Existing quiet hours guard still enforces 21:30 - 09:00 Baku
        self.assertIn("isQuietHours", src)
        self.assertIn("quiet_hours_baku", src)

        # Queries NEW lead_listing_matches and joins buyer_leads + listings
        self.assertIn('from("lead_listing_matches")', src)
        self.assertIn('.eq("status", "NEW")', src)
        self.assertIn("assigned_agent_id", src)
        self.assertIn("agency_members", src)

        # Groups per agency/broker chat and chunks Telegram digest respecting rate limits
        self.assertIn("chunkLinesForTelegram", src)
        self.assertIn("match_digests_sent", src)

        # Marks sent matches as NOTIFIED with notified_at
        self.assertIn('status: "NOTIFIED"', src)
        self.assertIn("notified_at", src)

    def test_telegram_webhook_keenable_queries_district_price_medians(self):
        src = TELEGRAM_WEBHOOK_TS.read_text(encoding="utf-8")

        # keenable callback must query live public.district_price_medians view
        self.assertIn('from("district_price_medians")', src)
        self.assertIn("median_azn_per_m2", src)
        self.assertIn("sample_count", src)

        # Static BAKU_DISTRICT_MEDIAN_M2 must be deprecated/fallback-only, not the primary source
        self.assertNotIn("const BAKU_DISTRICT_MEDIAN_M2", src)
        self.assertIn("FALLBACK_DISTRICT_MEDIAN_M2", src)


class TestV2CutoverVerificationSuite(unittest.TestCase):
    def test_verify_v2_cutover_exists_and_builds_2000_synthetic_records(self):
        self.assertTrue(VERIFY_CUTOVER_PY.exists(), "scripts/verify_v2_cutover.py must exist")
        from scripts.verify_v2_cutover import build_synthetic_dataset

        listings, leads = build_synthetic_dataset(
            count=2000,
            agency_id="11111111-1111-1111-1111-111111111111",
        )
        self.assertEqual(len(listings), 2000)
        self.assertEqual(len(leads), 2000)
        self.assertIn("canonical_niche", listings[0])
        self.assertIn("source_type", listings[0])
        self.assertIn("price_azn_normalized", listings[0])
        self.assertIn("budget_max_azn", leads[0])
        self.assertIn("preferred_districts", leads[0])

    def test_anon_lockdown_check_passes_only_on_401_403(self):
        from scripts.verify_v2_cutover import check_anon_lockdown

        ok_session = MagicMock()
        resp_401 = MagicMock(status_code=401)
        ok_session.get.return_value = resp_401
        ok_session.post.return_value = resp_401

        passed = check_anon_lockdown(
            "https://v2.supabase.co",
            "anon-key",
            session=ok_session,
        )
        self.assertTrue(passed.ok, passed.details)

        # If any table leaks 200, must fail
        bad_session = MagicMock()
        bad_session.get.return_value = MagicMock(status_code=200)
        bad_session.post.return_value = MagicMock(status_code=401)
        failed = check_anon_lockdown(
            "https://v2.supabase.co",
            "anon-key",
            session=bad_session,
        )
        self.assertFalse(failed.ok)

    def test_rbac_smm_and_inactive_checks(self):
        from scripts.verify_v2_cutover import check_rbac_smm_and_inactive

        mock_session = MagicMock()
        # SMM GET listing_owner_contacts -> 403 or [] (0 rows), inactive POST API -> 403, unauth API -> 401
        resp_empty = MagicMock(status_code=200)
        resp_empty.json.return_value = []
        resp_403 = MagicMock(status_code=403)
        resp_401 = MagicMock(status_code=401)

        mock_session.get.side_effect = [resp_empty, resp_403, resp_401]
        mock_session.post.return_value = resp_403

        res = check_rbac_smm_and_inactive(
            supabase_url="https://v2.supabase.co",
            anon_key="anon",
            web_url="https://app.bakuestate.az",
            smm_jwt="smm-jwt",
            inactive_jwt="inactive-jwt",
            session=mock_session,
        )
        self.assertTrue(res.ok, res.details)

    def test_ssr_latency_benchmark_enforces_under_300ms(self):
        from scripts.verify_v2_cutover import check_ssr_latency_benchmark

        fast_session = MagicMock()
        fast_session.get.return_value = MagicMock(status_code=200)
        res_fast = check_ssr_latency_benchmark(
            web_url="https://app.bakuestate.az",
            auth_cookie_or_jwt="jwt",
            max_ms=300.0,
            session=fast_session,
            clock_fn=iter([0.0, 0.05, 0.1, 0.16, 0.2, 0.28]).__next__,
        )
        self.assertTrue(res_fast.ok, res_fast.details)

        res_slow = check_ssr_latency_benchmark(
            web_url="https://app.bakuestate.az",
            auth_cookie_or_jwt="jwt",
            max_ms=300.0,
            session=fast_session,
            clock_fn=iter([0.0, 0.45, 0.5, 0.92, 1.0, 1.38]).__next__,
        )
        self.assertFalse(res_slow.ok)

    def test_meta_hmac_and_csv_formula_protection_checks(self):
        from scripts.verify_v2_cutover import (
            check_csv_formula_protection,
            check_meta_webhook_hmac,
            verify_csv_payload_formula_safe,
        )

        # CSV formula escaping helper check
        bom_safe = b"\xef\xbb\xbflead_id,client_name\n1,'=cmd|'/C calc'!A0\n2,'+123\n3,'-456\n4,'@SUM(A1)\n"
        self.assertTrue(verify_csv_payload_formula_safe(bom_safe))

        bom_unsafe = b"\xef\xbb\xbflead_id,client_name\n1,=cmd|'/C calc'!A0\n"
        self.assertFalse(verify_csv_payload_formula_safe(bom_unsafe))

        mock_session = MagicMock()
        mock_session.get.side_effect = lambda url, **kw: MagicMock(
            status_code=200,
            text=kw.get("params", {}).get("hub.challenge", ""),
        )
        post_bad_sig = MagicMock(status_code=401)
        post_good_sig = MagicMock(status_code=200)
        mock_session.post.side_effect = [post_bad_sig, post_good_sig]

        hmac_res = check_meta_webhook_hmac(
            web_url="https://app.bakuestate.az",
            verify_token="verify-tok",
            app_secret="meta-secret",
            session=mock_session,
        )
        self.assertTrue(hmac_res.ok, hmac_res.details)

        csv_session = MagicMock()
        csv_session.get.return_value = MagicMock(status_code=200, content=bom_safe)
        csv_res = check_csv_formula_protection(
            web_url="https://app.bakuestate.az",
            auth_jwt="admin-jwt",
            session=csv_session,
        )
        self.assertTrue(csv_res.ok, csv_res.details)

    def test_citadel_zero_drift_check_and_blocklist_guard(self):
        from scripts.verify_v2_cutover import (
            CITADEL_TABLES,
            check_citadel_zero_drift,
        )

        self.assertEqual(set(CITADEL_TABLES), {"leads", "tasks", "calls", "cockpit_cards"})

        mock_session = MagicMock()
        def _fake_head_or_get(url, **kwargs):
            r = MagicMock(status_code=200)
            r.headers = {"Content-Range": "0-0/42"}
            return r

        mock_session.get.side_effect = _fake_head_or_get
        before = {"leads": 42, "tasks": 42, "calls": 42, "cockpit_cards": 42}
        res_ok = check_citadel_zero_drift(
            old_url="https://ejsaccbeatmwqodwwzwu.supabase.co",
            old_key="old-ro-key",
            before_counts=before,
            session=mock_session,
        )
        self.assertTrue(res_ok.ok, res_ok.details)

        before_drift = {"leads": 41, "tasks": 42, "calls": 42, "cockpit_cards": 42}
        res_drift = check_citadel_zero_drift(
            old_url="https://ejsaccbeatmwqodwwzwu.supabase.co",
            old_key="old-ro-key",
            before_counts=before_drift,
            session=mock_session,
        )
        self.assertFalse(res_drift.ok)

    def test_verify_v2_cutover_dry_run_exits_zero(self):
        from scripts.verify_v2_cutover import main

        rc = main(["--dry-run", "--seed-synthetic", "2000"])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
