import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_0001 = PROJECT_ROOT / "supabase" / "migrations" / "202611260001_v2_baseline_and_rbac.sql"
MIGRATION_0002 = PROJECT_ROOT / "supabase" / "migrations" / "202611260002_v2_p0_atomic_rpcs.sql"


class TestV2Phase1DbMigrations(unittest.TestCase):
    def test_migration_0001_revokes_public_anon_and_enforces_rbac_matrix(self):
        sql = MIGRATION_0001.read_text(encoding="utf-8")

        # Extensions
        for ext in ("pg_trgm", "pg_cron", "pg_net", "supabase_vault"):
            self.assertIn(ext, sql)

        # Complete anon / PUBLIC lockdown
        self.assertIn("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon", sql)
        self.assertIn("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon", sql)
        self.assertIn("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon", sql)
        self.assertIn("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon", sql)

        # Multi-tenant & RBAC core tables
        for tbl in (
            "CREATE TABLE IF NOT EXISTS public.agencies",
            "CREATE TABLE IF NOT EXISTS public.agency_members",
            "CREATE TABLE IF NOT EXISTS public.agency_settings",
            "CREATE TABLE IF NOT EXISTS public.listing_owner_contacts",
            "CREATE TABLE IF NOT EXISTS public.cockpit_cards",
            "CREATE TABLE IF NOT EXISTS public.agent_messages",
            "CREATE TABLE IF NOT EXISTS public.agency_ai_usage_monthly",
            "CREATE TABLE IF NOT EXISTS public.social_accounts",
            "CREATE TABLE IF NOT EXISTS public.lead_listing_matches",
        ):
            self.assertIn(tbl, sql)

        # Baseline fixes integrated cleanly
        self.assertIn("'DRAFT_READY'", sql)
        self.assertIn("'PASSED_WITH_DB_FALLBACK'", sql)
        self.assertIn("'SNOOZED'", sql)
        self.assertIn("'CANCELLED'", sql)
        self.assertIn("uq_listings_agency_bina_id", sql)
        self.assertIn("uq_social_comments_platform_id", sql)
        self.assertIn("GENERATED ALWAYS AS IDENTITY", sql)

        # RBAC helper functions enforce active membership
        self.assertIn("is_active = TRUE", sql)
        self.assertIn("public.current_agency_id()", sql)
        self.assertIn("public.is_agency_member(", sql)
        self.assertIn("public.is_agency_admin(", sql)
        self.assertIn("SECURITY DEFINER", sql)
        self.assertIn("SET search_path = public", sql)

        # SMM PII isolation & service_role-only secrets
        self.assertIn("listing_owner_contacts", sql)
        self.assertIn("REVOKE ALL ON TABLE public.social_accounts", sql)
        self.assertIn("REVOKE ALL ON TABLE public.agency_ai_usage_monthly", sql)

    def test_migration_0002_atomic_rpcs_leases_and_budget_locking(self):
        sql = MIGRATION_0002.read_text(encoding="utf-8")

        # Partial unique indexes
        self.assertIn("uq_pipeline_jobs_active_listing", sql)
        self.assertIn("uq_pipeline_jobs_active_utility", sql)
        self.assertIn("uq_pipeline_jobs_idempotency_active", sql)
        self.assertIn("WHERE status <> 'CANCELLED'", sql)

        # Two-phase Telegram dispatch lease columns & RPCs
        self.assertIn("dispatch_lock_token", sql)
        self.assertIn("dispatch_locked_until", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.claim_telegram_dispatch_slot", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.confirm_telegram_dispatch", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.release_telegram_dispatch_slot", sql)

        # Atomic job & CRM RPCs
        self.assertIn("CREATE OR REPLACE FUNCTION public.enqueue_listing_render_atomic", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.retry_or_cancel_pipeline_job", sql)
        self.assertIn("JOB_STILL_RUNNING", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.complete_pipeline_job", sql)
        self.assertIn("'CANCELLED'", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.claim_next_pipeline_job", sql)
        self.assertIn("cancel_requested_at IS NULL", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.create_buyer_lead_atomic", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.confirm_publication_atomic", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.resolve_duplicate_listing_atomic", sql)

        # Serialized AI budget reservation & reconciliation
        self.assertIn("CREATE OR REPLACE FUNCTION public.check_and_reserve_ai_budget", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.reconcile_ai_budget_run", sql)
        self.assertIn("FOR UPDATE", sql)


class TestV2MigrationScript(unittest.TestCase):
    def test_migration_script_covers_16_objects_and_two_pass_self_fk(self):
        from scripts.migrate_from_shared_supabase import (
            BAKU_EXPORT_TABLES,
            CITADEL_BLOCKLIST,
            prepare_listings_two_pass,
            extract_listing_owner_contacts,
            decompose_conversations_to_messages,
        )

        expected_16 = {
            "listings",
            "listing_events",
            "render_versions",
            "publications",
            "buyer_leads",
            "lead_listings",
            "follow_up_tasks",
            "pipeline_jobs",
            "preflight_checks",
            "agent_conversations",
            "agent_learned_insights",
            "ai_copilot_runs",
            "lead_timeline_events",
            "social_comments",
            "publication_telemetry_snapshots",
            "baku_estate_config",
        }
        self.assertTrue(expected_16.issubset(set(BAKU_EXPORT_TABLES)))
        self.assertEqual(len(BAKU_EXPORT_TABLES), 16)

        for citadel_tbl in ("leads", "tasks", "calls", "cockpit_cards"):
            self.assertIn(citadel_tbl, CITADEL_BLOCKLIST)
            self.assertNotIn(citadel_tbl, BAKU_EXPORT_TABLES)

        # Two-pass self-FK resolution
        first_pass, dup_patches = prepare_listings_two_pass([
            {"id": "a", "duplicate_of_listing_id": "b", "bina_id": "101", "url": "https://bina.az/items/101"},
            {"id": "b", "duplicate_of_listing_id": None, "bina_id": "102", "url": "https://bina.az/items/102"},
        ], agency_id="11111111-1111-1111-1111-111111111111")
        self.assertIsNone(first_pass[0]["duplicate_of_listing_id"])
        self.assertEqual(first_pass[0]["agency_id"], "11111111-1111-1111-1111-111111111111")
        self.assertEqual(dup_patches, [("a", "b")])

        # Owner contacts separation
        contacts = extract_listing_owner_contacts([
            {"id": "a", "contact_name": "Elvin", "owner_phone_raw": "0501234567", "owner_phone_normalized": "+994501234567"},
            {"id": "b", "contact_name": None, "owner_phone_raw": None, "owner_phone_normalized": None},
        ], agency_id="11111111-1111-1111-1111-111111111111")
        self.assertEqual(len(contacts), 1)
        self.assertEqual(contacts[0]["listing_id"], "a")
        self.assertEqual(contacts[0]["owner_phone_normalized"], "+994501234567")

        # Conversations -> agent_messages decomposition
        convs, msgs = decompose_conversations_to_messages([
            {
                "id": "conv-1",
                "operator_id": "083d8ea3-4a73-4b85-8479-0c532ce939f0",
                "agent_id": "mudir",
                "room_type": "OMNI",
                "title": "Test",
                "messages": [
                    {"role": "user", "content": "Salam", "created_at": "2026-11-24T10:00:00Z"},
                    {"role": "assistant", "sender_name": "Müdir", "content": "Salam!", "created_at": "2026-11-24T10:00:05Z"},
                ],
            }
        ], agency_id="11111111-1111-1111-1111-111111111111", operator_map={"083d8ea3-4a73-4b85-8479-0c532ce939f0": "22222222-2222-2222-2222-222222222222"})
        self.assertEqual(len(convs), 1)
        self.assertEqual(convs[0]["operator_id"], "22222222-2222-2222-2222-222222222222")
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[0]["sender_type"], "USER")
        self.assertEqual(msgs[1]["sender_type"], "AGENT")
        self.assertEqual(msgs[1]["sender_name"], "Müdir")

    def test_migration_script_dry_run_and_citadel_guard(self):
        import io
        from contextlib import redirect_stdout
        from scripts.migrate_from_shared_supabase import _assert_safe_table, main

        with self.assertRaises(ValueError):
            _assert_safe_table("leads")
        with self.assertRaises(ValueError):
            _assert_safe_table("cockpit_cards")

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(["--dry-run"])
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("DRY-RUN", out)
        self.assertIn("setWebhook", out)


if __name__ == "__main__":
    unittest.main()
