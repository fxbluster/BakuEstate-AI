import re
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_0003 = (
    PROJECT_ROOT
    / "supabase"
    / "migrations"
    / "202611260003_v2_p1_cloud_studio_and_pagination.sql"
)
STORAGE_PRUNER_TS = (
    PROJECT_ROOT / "supabase" / "functions" / "storage-pruner" / "index.ts"
)
COCKPIT_GENERATOR_TS = (
    PROJECT_ROOT / "supabase" / "functions" / "cockpit-generator" / "index.ts"
)


class TestV2Phase2Migration0003(unittest.TestCase):
    def test_migration_0003_exists_and_adds_r2_storage_provider(self):
        self.assertTrue(
            MIGRATION_0003.exists(),
            f"Expected migration file {MIGRATION_0003} to exist",
        )
        sql = MIGRATION_0003.read_text(encoding="utf-8")

        # render_versions.storage_provider default 'r2' & CHECK constraint
        self.assertIn("render_versions", sql)
        self.assertIn("storage_provider", sql)
        self.assertIn("SET DEFAULT 'r2'", sql)
        self.assertRegex(
            sql,
            r"CHECK\s*\(\s*storage_provider\s+IN\s*\(\s*'supabase'\s*,\s*'r2'\s*\)\s*\)",
        )

    def test_migration_0003_creates_composite_and_trgm_pagination_indexes(self):
        sql = MIGRATION_0003.read_text(encoding="utf-8")

        # Extension & listings composite + pg_trgm GIN indexes
        self.assertIn("CREATE EXTENSION IF NOT EXISTS pg_trgm", sql)
        self.assertIn("idx_listings_agency_created", sql)
        self.assertIn("(agency_id, created_at DESC)", sql)
        self.assertIn("idx_listings_agency_editorial_created", sql)
        self.assertIn("(agency_id, editorial_status, created_at DESC)", sql)
        self.assertIn("idx_listings_agency_niche_created", sql)
        self.assertIn("(agency_id, canonical_niche, created_at DESC)", sql)
        self.assertIn("gin_trgm_ops", sql)
        self.assertRegex(sql, r"ON\s+public\.listings\s+USING\s+GIN\s*\(\s*title\s+gin_trgm_ops\s*\)")
        self.assertRegex(sql, r"ON\s+public\.listings\s+USING\s+GIN\s*\(\s*address\s+gin_trgm_ops\s*\)")

        # buyer_leads composite + pg_trgm GIN indexes
        self.assertIn("(agency_id, stage, next_followup_at)", sql)
        self.assertRegex(
            sql,
            r"ON\s+public\.buyer_leads\s+USING\s+GIN\s*\(\s*client_name\s+gin_trgm_ops\s*\)",
        )
        self.assertRegex(
            sql,
            r"ON\s+public\.buyer_leads\s+USING\s+GIN\s*\(\s*phone_normalized\s+gin_trgm_ops\s*\)",
        )

    def test_migration_0003_creates_district_price_medians_view(self):
        sql = MIGRATION_0003.read_text(encoding="utf-8")

        self.assertIn("CREATE OR REPLACE VIEW public.district_price_medians", sql)
        self.assertIn("security_invoker = true", sql)
        self.assertIn("PERCENTILE_CONT(0.5)", sql)
        self.assertIn("INTERVAL '60 days'", sql)
        self.assertIn("median_azn_per_m2", sql)
        self.assertIn("sample_count", sql)
        self.assertIn("district_normalized", sql)
        self.assertIn(
            "REVOKE ALL ON TABLE public.district_price_medians FROM PUBLIC, anon",
            sql,
        )
        self.assertIn(
            "GRANT SELECT ON TABLE public.district_price_medians TO authenticated, service_role",
            sql,
        )

    def test_migration_0003_creates_kpi_and_analytics_rpcs_with_rbac_and_zero_anon(self):
        sql = MIGRATION_0003.read_text(encoding="utf-8")

        # get_agency_crm_kpis()
        self.assertIn("CREATE OR REPLACE FUNCTION public.get_agency_crm_kpis()", sql)
        self.assertIn("RETURNS JSONB", sql)
        self.assertIn("current_agency_id()", sql)
        self.assertIn("current_agency_role()", sql)
        self.assertIn("commission_split_pct", sql)
        self.assertIn("expected_broker_commission_azn", sql)
        self.assertIn("expected_agency_commission_azn", sql)
        self.assertIn("actual_broker_commission_azn", sql)
        self.assertIn("actual_agency_commission_azn", sql)
        self.assertIn("FORBIDDEN_SMM_NO_CRM_ACCESS", sql)
        self.assertIn(
            "REVOKE ALL ON FUNCTION public.get_agency_crm_kpis() FROM PUBLIC, anon",
            sql,
        )
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION public.get_agency_crm_kpis() TO authenticated, service_role",
            sql,
        )

        # get_analytics_summary(p_days INT DEFAULT 30)
        self.assertRegex(
            sql,
            r"CREATE OR REPLACE FUNCTION public\.get_analytics_summary\s*\(\s*p_days\s+INT\s+DEFAULT\s+30\s*\)",
        )
        self.assertIn("by_niche", sql)
        self.assertIn("by_hook_type", sql)
        self.assertIn("by_duration_bucket", sql)
        self.assertIn("engagement_rate_pct", sql)
        self.assertIn("funnel", sql)
        self.assertIn(
            "REVOKE ALL ON FUNCTION public.get_analytics_summary(INT) FROM PUBLIC, anon",
            sql,
        )
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION public.get_analytics_summary(INT) TO authenticated, service_role",
            sql,
        )

        # No anon or PUBLIC grants anywhere in migration
        self.assertNotRegex(sql, r"GRANT\s+.*\s+TO\s+(PUBLIC|anon)\b")

    def test_migration_0003_schedules_cockpit_generator_pg_cron(self):
        sql = MIGRATION_0003.read_text(encoding="utf-8")

        self.assertIn("baku_estate_cockpit_generator", sql)
        self.assertIn("0 4 * * *", sql)
        self.assertIn("invoke_edge_function_cron('cockpit-generator')", sql)


class TestV2Phase2EdgeFunctions(unittest.TestCase):
    def test_storage_pruner_dual_path_r2_sigv4_and_null_cdn_url(self):
        self.assertTrue(STORAGE_PRUNER_TS.exists())
        src = STORAGE_PRUNER_TS.read_text(encoding="utf-8")

        # Mandatory fail-closed CRON_SECRET guard
        self.assertIn('Deno.env.get("CRON_SECRET")', src)
        self.assertIn("x-cron-secret", src)
        self.assertIn("timingSafeEqual", src)
        self.assertIn("status: 403", src)

        # Dual-path switching on render_versions.storage_provider
        self.assertIn("storage_provider", src)
        self.assertIn('"r2"', src)
        self.assertIn('"supabase"', src)

        # WebCrypto AWS SigV4 DELETE for Cloudflare R2
        self.assertIn("crypto.subtle", src)
        self.assertIn("AWS4-HMAC-SHA256", src)
        self.assertIn('method: "DELETE"', src)
        self.assertIn("x-amz-content-sha256", src)
        self.assertIn("x-amz-date", src)
        self.assertIn("R2_ACCESS_KEY_ID", src)
        self.assertIn("R2_SECRET_ACCESS_KEY", src)

        # Legacy Supabase storage removal preserved
        self.assertRegex(src, r"supabase\.storage\s*\.from\(bucket\)\s*\.remove")

        # Sets BOTH storage_pruned_at AND video_cdn_url = null on both paths
        matches = re.findall(
            r"storage_pruned_at\s*:\s*nowIso\s*,\s*video_cdn_url\s*:\s*null",
            src,
        )
        self.assertGreaterEqual(
            len(matches),
            2,
            "Both supabase and r2 prune paths must set storage_pruned_at and video_cdn_url: null",
        )

        # Fail-closed when R2 credentials missing
        self.assertIn("r2_config_missing", src)

    def test_cockpit_generator_cron_secret_expiry_batching_budget_and_uppercase_cards(self):
        self.assertTrue(
            COCKPIT_GENERATOR_TS.exists(),
            f"Expected edge function {COCKPIT_GENERATOR_TS} to exist",
        )
        src = COCKPIT_GENERATOR_TS.read_text(encoding="utf-8")

        # Mandatory fail-closed CRON_SECRET guard
        self.assertIn('Deno.env.get("CRON_SECRET")', src)
        self.assertIn("x-cron-secret", src)
        self.assertIn("timingSafeEqual", src)
        self.assertIn("status: 403", src)

        # Expires prior unactioned PENDING cards where expires_at < NOW()
        self.assertIn("cockpit_cards", src)
        self.assertIn("expires_at", src)
        self.assertIn('"PENDING"', src)
        self.assertIn('"DISMISSED"', src)

        # Bounded agency batching <= 20 per invocation
        self.assertIn("MAX_AGENCIES_PER_RUN = 20", src)

        # Reads overdue follow_up_tasks & stale high-value buyer_leads
        self.assertIn("follow_up_tasks", src)
        self.assertIn("buyer_leads", src)

        # Invokes gemini-3.8-flash & records usage via check_and_reserve_ai_budget + reconcile_ai_budget_run
        self.assertIn("gemini-3.8-flash", src)
        self.assertIn("check_and_reserve_ai_budget", src)
        self.assertIn("reconcile_ai_budget_run", src)
        self.assertIn("ai_copilot_runs", src)
        self.assertIn("usageMetadata", src)

        # Writes clean uppercase priority, status='PENDING', strategic_rationale
        self.assertIn("strategic_rationale", src)
        self.assertIn('"URGENT"', src)
        self.assertIn('"HIGH"', src)
        self.assertIn('"NORMAL"', src)
        self.assertIn('"LOW"', src)


if __name__ == "__main__":
    unittest.main()
