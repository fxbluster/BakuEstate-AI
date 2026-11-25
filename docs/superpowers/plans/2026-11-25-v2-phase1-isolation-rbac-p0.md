# BakuEstate-AI v2 Phase 1: Isolated Supabase, Multi-Agent RBAC & P0 Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a new isolated BakuEstate-AI Supabase project with Multi-Agent RBAC RLS, migrate data cleanly from the shared Citadel database without altering Citadel tables, lock down all Next.js auth/middleware bypasses, and fix all P0 concurrency, billing, telemetry, and Python worker/scraper bugs.

**Architecture:** Provision a clean baseline Postgres schema (`202611260001`, `202611260002`) with `agency_id` tenancy, separated owner-contact PII (`listing_owner_contacts`), zero `anon`/`PUBLIC` privileges, and atomic SQL RPCs; enforce central cookie/Bearer JWT + active `agency_members` resolution across Next.js 15 routes; fix Worker/Scraper/Edge Function column mismatches, Kupça defaults, Telegram double-send races, and AI Copilot `503` error honesty. This phase deploys standalone before Phase 2.

**Tech Stack:** PostgreSQL 15+ (Supabase, `pg_cron`, `pg_net`, `pg_trgm`, `supabase_vault`), Next.js 15 (`@supabase/ssr`, TypeScript 5.8, React 19, Vitest), Python 3.13 (`unittest`, `requests`), Deno Edge Functions.

**Spec:** [v2_isolated_multi_agent_architecture_and_cloud_scale.md](file:///c:/Users/HP/BakuEstate-AI/docs/designs/v2_isolated_multi_agent_architecture_and_cloud_scale.md)

## Global Constraints

- Primary AI Model: `gemini-3.8-flash-high` (`OPENAI_API_KEY` / mock fallbacks forbidden; Gemini errors return `HTTP 503` `UPSTREAM_UNAVAILABLE`).
- Citadel Isolation: Never read/write/alter Citadel CRM tables (`leads`, `tasks`, `calls`, Citadel `cockpit_cards`) on `ejsaccbeatmwqodwwzwu`; `ejsaccbeatmwqodwwzwu` stays untouched as read-only backup after cutover.
- Zero Anon & Fail-Closed Auth: `REVOKE ALL` for `PUBLIC, anon` across tables, views, sequences, functions; remove all `test-jwt`, `ALLOW_DEV_OPERATOR`, hardcoded `083d8ea3-4a73-4b85-8479-0c532ce939f0`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` admin fallbacks.
- Test Runners: Web via `cd web && npm test && npm run lint && npx tsc --noEmit && npm run build`; Python via `python -m unittest discover -s tests -v`.
- Webshare Proxy (`BINA_PROXY_URL`) monthly ceiling: 15 GB / $20 HTTP; `TELEGRAM_FALLBACK` transition window <= 45 days; Phase 1 launches standalone first.

## Review Focus

1. Unauthenticated external requests to `/api/social/webhooks/*` and `/api/social/oauth/*` must NOT be 307-redirected to `/login` by `web/middleware.ts`, and protected `/api/*` calls without cookies must return `401` JSON rather than `307` HTML redirects (pinned to Task 3).
2. A deactivated broker (`agency_members.is_active = false`) holding an unexpired Supabase JWT must immediately fail both `is_agency_member()` RLS checks and `resolveOperator()` API calls with `403`, and an `SMM` user must receive `0` rows / `403` on `listing_owner_contacts` and `buyer_leads` (pinned to Tasks 1 & 3).
3. Two simultaneous `POST /api/listings/[bina_id]/preflight` clicks (`dispatch_to_telegram: true`) must acquire only one 60s `claim_telegram_dispatch_slot` lease, release that lease if Telegram `sendVideo` fails (without updating `telegram_dispatched_at`), and block `RETRY` on a `RUNNING` job with `409` (pinned to Tasks 2 & 6).
4. Legacy `local_worker.py` calls (`_handle_sync_social_metrics`, `_handle_telegram_dispatch`) must write `price_azn_normalized` and invoke `SupabaseRepo.insert_listing_event(..., actor="local_worker")` without passing unsupported `summary=`/`metadata=` kwargs or triggering Postgres actor `CHECK` errors (pinned to Task 8).
5. Fresh Supabase bootstrap and selective migration (`migrate_from_shared_supabase.py`) must replay `cockpit_cards` + `DRAFT_READY` + `PASSED_WITH_DB_FALLBACK` cleanly on an empty database, insert self-referencing `listings.duplicate_of_listing_id` rows in two passes without FK violations, and migrate all 16 BakuEstate objects while excluding Citadel rows (pinned to Tasks 1 & 2).

---

### Task 1: Isolated Supabase Baseline Schema, RBAC RLS & Complete Anon Lockdown

**Files:**
- Create: `supabase/migrations/202611260001_v2_baseline_and_rbac.sql`
- Test: `tests/test_v2_p0_worker_and_scraper.py`

**Interfaces:**
- Consumes: Clean Postgres 15+ Supabase instance (`extensions: pg_cron, pg_net, pg_trgm, supabase_vault`).
- Produces: Tables `agencies`, `agency_members`, `agency_settings`, `listing_owner_contacts`, `cockpit_cards`, `agent_messages`, `agency_ai_usage_monthly`, plus full BakuEstate base tables (`listings` with `agency_id`, `assigned_agent_id`, `created_by`, `source_type`, nullable `bina_id`/`url`, `uq_listings_agency_bina_id`, `'DRAFT_READY'`; `listing_events` & `lead_timeline_events` with `actor_user_id`; `preflight_checks` with `'PASSED_WITH_DB_FALLBACK'` & nullable `bina_id`; `social_comments` with `UNIQUE (publication_id, platform_comment_id)`); helper functions `current_agency_id() RETURNS UUID`, `is_agency_member(p_agency_id UUID) RETURNS BOOLEAN`, `is_agency_admin(p_agency_id UUID) RETURNS BOOLEAN` (`SECURITY DEFINER SET search_path = public`).

- [ ] **Step 1: Write failing migration-audit test in `tests/test_v2_p0_worker_and_scraper.py`**

```python
def test_migration_0001_revokes_public_anon_and_enforces_rbac_matrix(self):
    sql = Path("supabase/migrations/202611260001_v2_baseline_and_rbac.sql").read_text(encoding="utf-8")
    assert "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon" in sql
    assert "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon" in sql
    assert "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon" in sql
    assert "CREATE TABLE public.listing_owner_contacts" in sql
    assert "is_active = TRUE" in sql
    assert "CREATE TABLE public.cockpit_cards" in sql
    assert "'SNOOZED'" in sql
    assert "'CANCELLED'" in sql
    assert "uq_listings_agency_bina_id" in sql
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_v2_p0_worker_and_scraper -v`
Expected: FAIL with `FileNotFoundError` for `202611260001_v2_baseline_and_rbac.sql`.

- [ ] **Step 3: Author `supabase/migrations/202611260001_v2_baseline_and_rbac.sql`**

Create extensions (`pg_cron`, `pg_net`, `pg_trgm`, `supabase_vault`), full baseline BakuEstate tables (incorporating `'DRAFT_READY'`, `'PASSED_WITH_DB_FALLBACK'`, standalone `cockpit_cards`), multi-tenant DDL (`agencies`, `agency_members` with `user_id PK`, `agency_settings` with `niche_rules_json DEFAULT '{"luxury_min_azn":250000,"affordable_max_azn":120000,"viral_drop_pct":10}'`, `listing_owner_contacts`, `agent_messages` with `seq_num BIGINT GENERATED ALWAYS AS IDENTITY`, `agency_ai_usage_monthly`), `REVOKE ALL` for `PUBLIC, anon` across tables/views/sequences/functions + `ALTER DEFAULT PRIVILEGES`, `SECURITY DEFINER SET search_path = public` helpers verifying `is_active = TRUE`, and the complete `Table × Role` (`ADMIN`/`BROKER`/`SMM`/`service_role`) RLS policies isolating `listing_owner_contacts` and `buyer_leads` from `SMM` and locking down `social_accounts`/`baku_estate_config`/`agency_ai_usage_monthly` to `service_role`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m unittest tests.test_v2_p0_worker_and_scraper -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202611260001_v2_baseline_and_rbac.sql tests/test_v2_p0_worker_and_scraper.py
git commit -m "feat(db): add isolated v2 baseline schema and strict multi-agent RBAC RLS"
```

---

### Task 2: P0 Atomic RPCs, Two-Phase Dispatch Leases & Selective Data Migration Script

**Files:**
- Create: `supabase/migrations/202611260002_v2_p0_atomic_rpcs.sql`
- Create: `scripts/migrate_from_shared_supabase.py`
- Test: `tests/test_v2_p0_worker_and_scraper.py`

**Interfaces:**
- Consumes: Task 1 schema (`pipeline_jobs`, `publications`, `listings`, `listing_owner_contacts`, `agent_messages`, `agency_ai_usage_monthly`).
- Produces:
  - Partial unique indexes: `uq_pipeline_jobs_active_listing`, `uq_pipeline_jobs_active_utility`, `uq_pipeline_jobs_idempotency_active`.
  - Columns on `publications`: `dispatch_lock_token UUID NULL`, `dispatch_locked_until TIMESTAMPTZ NULL`.
  - SQL RPCs (all deriving tenant from `auth.uid()` via `current_agency_id()` unless `service_role`):
    - `enqueue_listing_render_atomic(p_listing_id UUID, p_job_type TEXT DEFAULT 'RENDER_INITIAL', p_target_account TEXT DEFAULT NULL, p_voice_preset TEXT DEFAULT NULL, p_params_json JSONB DEFAULT '{}'::jsonb) RETURNS JSONB`
    - `retry_or_cancel_pipeline_job(p_job_id UUID, p_action TEXT) RETURNS JSONB` (raises/returns `JOB_STILL_RUNNING` on `RETRY` against `RUNNING`)
    - `complete_pipeline_job(p_job_id UUID, p_worker_id TEXT, p_status TEXT, p_error_message TEXT DEFAULT NULL) RETURNS BOOLEAN` (accepts `'CANCELLED'`)
    - `claim_next_pipeline_job(p_worker_id TEXT, p_lease_minutes INT DEFAULT 5)` (checks `cancel_requested_at IS NULL`)
    - `claim_telegram_dispatch_slot(p_publication_id UUID, p_cooldown_seconds INT DEFAULT 300) RETURNS TABLE(acquired BOOLEAN, lock_token UUID, locked_until TIMESTAMPTZ)`
    - `confirm_telegram_dispatch(p_publication_id UUID, p_lock_token UUID, p_message_id BIGINT) RETURNS BOOLEAN`
    - `release_telegram_dispatch_slot(p_publication_id UUID, p_lock_token UUID) RETURNS BOOLEAN`
    - `create_buyer_lead_atomic(...) RETURNS JSONB`, `confirm_publication_atomic(...) RETURNS JSONB`, `resolve_duplicate_listing_atomic(...) RETURNS JSONB`
    - `check_and_reserve_ai_budget(p_operator_id UUID, p_agency_id UUID, p_estimated_usd NUMERIC DEFAULT 0.015) RETURNS TABLE(allowed BOOLEAN, run_id UUID, reason TEXT)`
    - `reconcile_ai_budget_run(p_run_id UUID, p_prompt_tokens INT, p_output_tokens INT, p_audio_seconds NUMERIC, p_actual_usd NUMERIC, p_status TEXT) RETURNS BOOLEAN`
  - Migration CLI: `python scripts/migrate_from_shared_supabase.py --dry-run` (reads 16 BakuEstate objects read-only from `OLD_SUPABASE_URL`, bootstraps default agency/admin member, splits `listings.duplicate_of_listing_id` into pass-2 PATCH, backfills `listing_owner_contacts` and `agent_messages`, verifies counts + checksums).

- [ ] **Step 1: Add failing RPC & migration tests to `tests/test_v2_p0_worker_and_scraper.py`**

```python
def test_migration_script_covers_16_objects_and_two_pass_self_fk(self):
    from scripts.migrate_from_shared_supabase import BAKU_EXPORT_TABLES, prepare_listings_two_pass
    assert set(BAKU_EXPORT_TABLES) >= {
        "listings", "listing_events", "render_versions", "publications",
        "buyer_leads", "lead_listings", "follow_up_tasks", "pipeline_jobs",
        "preflight_checks", "agent_conversations", "agent_learned_insights",
        "ai_copilot_runs", "lead_timeline_events", "social_comments",
        "publication_telemetry_snapshots", "baku_estate_config",
    }
    assert "leads" not in BAKU_EXPORT_TABLES and "tasks" not in BAKU_EXPORT_TABLES
    first_pass, dup_patches = prepare_listings_two_pass([
        {"id": "a", "duplicate_of_listing_id": "b"},
        {"id": "b", "duplicate_of_listing_id": None},
    ])
    assert first_pass[0]["duplicate_of_listing_id"] is None
    assert dup_patches == [("a", "b")]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_v2_p0_worker_and_scraper -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'scripts.migrate_from_shared_supabase'`.

- [ ] **Step 3: Author `202611260002_v2_p0_atomic_rpcs.sql` and `scripts/migrate_from_shared_supabase.py`**

Implement all partial unique indexes, 2-phase Telegram lease columns & RPCs, serialized `agency_ai_usage_monthly` (`SELECT ... FOR UPDATE`) reservation + reconciliation RPCs, `complete_pipeline_job` accepting `'CANCELLED'`, and atomic CRM RPCs (`SECURITY INVOKER` or internal `current_agency_id()` validation + `actor_user_id = auth.uid()`). Implement `migrate_from_shared_supabase.py` with `--dry-run`, `LEG_OP_MAP`, Citadel-table blocklist, `agent_conversations.messages` -> `agent_messages` decomposition, `listings` -> `listing_owner_contacts` split, two-pass self-FK resolution, row-count verification, and runbook check output reminding operators to disable legacy `pg_cron` jobs and run Telegram `setWebhook`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m unittest tests.test_v2_p0_worker_and_scraper -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202611260002_v2_p0_atomic_rpcs.sql scripts/migrate_from_shared_supabase.py tests/test_v2_p0_worker_and_scraper.py
git commit -m "feat(db): add P0 atomic RPCs, dispatch leases, AI budget locking, and selective cutover script"
```

---

### Task 3: Central Auth Resolution, Fail-Closed Supabase Clients & Middleware Lockdown

**Files:**
- Modify: `web/middleware.ts`
- Modify: `web/app/login/page.tsx:33-58`
- Modify: `web/lib/supabase/admin.ts:1-20`
- Modify: `web/lib/supabase/server.ts:1-35`
- Modify: `web/lib/supabase/client.ts:1-12`
- Create: `web/lib/auth/resolve-operator.ts`
- Modify: `web/app/layout.tsx`
- Test: `web/__tests__/v2-p0-security-and-rpc.test.ts`

**Interfaces:**
- Produces:
  - `createAdminClient()` in `web/lib/supabase/admin.ts`: throws explicit `Error` when `SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing (zero fallback to `SUPABASE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, or `ejsaccbeatmwqodwwzwu`).
  - `createClient()` in `web/lib/supabase/client.ts`: module-level singleton browser client (`resetBrowserClientForTest()` for tests).
  - `getServerSessionMember()` in `web/lib/supabase/server.ts`.
  - `resolveOperator(request: Request): Promise<ResolvedOperator | null>` and `requireOperator(request: Request, allowedRoles?: AgencyRole[]): Promise<{ ok: true; operator: ResolvedOperator } | { ok: false; response: NextResponse }>` in `web/lib/auth/resolve-operator.ts`, returning `{ operatorId, email, agencyId, role, displayName }` (`401` on invalid/missing JWT or session, `403` when `agency_members` missing or `is_active === false` or role disallowed).
  - `middleware(request: NextRequest)`: exempts `/login`, `/_next/*`, `/favicon.ico`, `/api/social/webhooks/*`, `/api/social/oauth/*`, passes `/api/*` directly without 307 redirect, redirects unauthenticated page requests to `/login`.

- [ ] **Step 1: Write failing auth, middleware, and fail-closed client tests in `web/__tests__/v2-p0-security-and-rpc.test.ts`**

```ts
it("redirects unauthenticated /listings to /login, passes /api/social/webhooks/meta and /api/* without 307", async () => {
  const pageRes = await middleware(new NextRequest("https://app.test/listings"));
  expect(pageRes.status).toBe(307);
  expect(new URL(pageRes.headers.get("location")!).pathname).toBe("/login");

  const hookRes = await middleware(new NextRequest("https://app.test/api/social/webhooks/meta"));
  expect(hookRes.status).toBe(200);

  const apiRes = await middleware(new NextRequest("https://app.test/api/ai/copilot"));
  expect(apiRes.status).toBe(200);
});

it("rejects test-jwt tokens and inactive agency_members with 401/403", async () => {
  const bad = await requireOperator(new Request("https://app.test/api/x", { headers: { Authorization: "Bearer test-jwt-123" } }));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.response.status).toBe(401);
});

it("throws in createAdminClient when SUPABASE_SERVICE_ROLE_KEY is unset", () => {
  expect(() => createAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
});
```

- [ ] **Step 2: Run Vitest to verify tests fail**

Run: `cd web && npm test -- __tests__/v2-p0-security-and-rpc.test.ts`
Expected: FAIL on `/login` redirect assertion, `resolve-operator` missing module, and `createAdminClient` fallback.

- [ ] **Step 3: Implement `middleware.ts`, `login/page.tsx`, `admin.ts`, `server.ts`, `client.ts`, `resolve-operator.ts`, `layout.tsx`**

Update `middleware.ts` to inspect `supabase.auth.getUser()`, enforce allowlist (`/login`, `/api/social/webhooks/*`, `/api/social/oauth/*`, `/_next/*`) and pass `/api/*` through cleanly. In `login/page.tsx`, verify active `agency_members` membership post-sign-in and sign out with an explicit error if missing/inactive. Remove `ejsaccbeatmwqodwwzwu`, `SUPABASE_KEY`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` fallbacks from `admin.ts`. Cache singleton browser client in `client.ts`. Create `resolve-operator.ts` and wire SSR session context in `layout.tsx`.

- [ ] **Step 4: Run Vitest to verify tests pass**

Run: `cd web && npm test -- __tests__/v2-p0-security-and-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/middleware.ts web/app/login/page.tsx web/lib/supabase/admin.ts web/lib/supabase/server.ts web/lib/supabase/client.ts web/lib/auth/resolve-operator.ts web/app/layout.tsx web/__tests__/v2-p0-security-and-rpc.test.ts
git commit -m "feat(auth): restore session middleware, fail-closed admin client, and RBAC operator resolver"
```

---

### Task 4: Domain Types, Status Map Parity & AI Client Error Contract

**Files:**
- Modify: `web/lib/types.ts:97-115,202-208,442-465`
- Modify: `web/lib/format.ts:325-335`
- Modify: `web/lib/ai-client.ts:110-129,178-191,233-260`
- Test: `web/__tests__/v2-p0-security-and-rpc.test.ts`

**Interfaces:**
- Produces:
  - `AgencyRole = "ADMIN" | "BROKER" | "SMM"`, `AgencyMember`, `AgencySettings`, `AgentMessage`, `PaginatedResult<T>`.
  - `CockpitStatus` updated with `"SNOOZED"`; `JobStatus` updated with `"CANCELLED"`; `PipelineJob.cancel_requested_at?: string | null`.
  - `JOB_STATUS_META.CANCELLED = { label: "Ləğv edilib", tone: "neutral" }` in `web/lib/format.ts`.
  - `CopilotErrorCode` updated with `"UPSTREAM_UNAVAILABLE"` (preserved verbatim in `invokeCopilot()`); `QueueRenderPayload` extended with `selected_photo_urls?: string[]; custom_script_text?: string;`.

- [ ] **Step 1: Add failing assertions for `JOB_STATUS_META.CANCELLED` and `UPSTREAM_UNAVAILABLE` preservation in `web/__tests__/v2-p0-security-and-rpc.test.ts`**

```ts
it("preserves UPSTREAM_UNAVAILABLE in invokeCopilot and maps CANCELLED in JOB_STATUS_META", async () => {
  expect(JOB_STATUS_META.CANCELLED.label).toBeTruthy();
  mockFetchOnce(503, { ok: false, code: "UPSTREAM_UNAVAILABLE", error: "Gemini offline", fallback_available: false });
  const res = await invokeCopilot({ action: "agent_chat", agent_id: "mudir", message: "Salam" });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe("UPSTREAM_UNAVAILABLE");
});
```

- [ ] **Step 2: Run Vitest + Typecheck to verify failure**

Run: `cd web && npm test -- __tests__/v2-p0-security-and-rpc.test.ts`
Expected: FAIL (`JOB_STATUS_META.CANCELLED` undefined and `res.code` collapses to `"UPSTREAM_ERROR"`).

- [ ] **Step 3: Implement type updates across `types.ts`, `format.ts`, and `ai-client.ts`**

- [ ] **Step 4: Run Vitest + `tsc --noEmit` to verify pass**

Run: `cd web && npm test -- __tests__/v2-p0-security-and-rpc.test.ts && npx tsc --noEmit`
Expected: PASS (`0` TypeScript errors).

- [ ] **Step 5: Commit**

```bash
git add web/lib/types.ts web/lib/format.ts web/lib/ai-client.ts web/__tests__/v2-p0-security-and-rpc.test.ts
git commit -m "feat(types): add CANCELLED, SNOOZED, UPSTREAM_UNAVAILABLE, and multi-agency domain types"
```

---

### Task 5: AI Copilot Hardening (`agent_messages`, Budget RPC, `save_insight` Fix, Injection Removal & Honest `503`)

**Files:**
- Modify: `web/app/api/ai/copilot/route.ts`
- Test: `web/__tests__/v2-p0-security-and-rpc.test.ts`

**Interfaces:**
- Consumes: `requireOperator` (`web/lib/auth/resolve-operator.ts`), `check_and_reserve_ai_budget` & `reconcile_ai_budget_run` RPCs, `public.agent_messages`, Gemini `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`).
- Produces: Auth-enforced `POST /api/ai/copilot`:
  - `ALLOW_DEV_OPERATOR` and `test-jwt` removed; uses `requireOperator()`.
  - All 5 `.or(...)` filter sites (`L366, L409, L549, L828, L1074`) replaced with `UUID_REGEX` / parameterized `.in("agent_id", [agentId, canonicalAgent])`.
  - `get_conversation`, `reset_conversation`, and sliding-window `agent_chat` history read/write `public.agent_messages` ordered by `(created_at ASC, seq_num ASC)`.
  - `save_insight` inserts `{ operator_id, agency_id, agent_id, persona_scope, domain, insight_text, confidence_score }` (drops invalid `metadata` column).
  - Real USD pricing rate table (`gemini-2.5-flash`/`gemini-3.8-flash`: `$0.15/1M` input, `$0.60/1M` output, `$0.000025/s` audio) reconciles via `reconcile_ai_budget_run`.
  - Gemini failure / missing API key returns `HTTP 503` `{ ok: false, code: "UPSTREAM_UNAVAILABLE", fallback_available: false }` across `L589`, `L977`, `L989`, `L1064–1454` (zero hardcoded `#5616503` / `175,000 AZN` / `994501234567` mocks).

- [ ] **Step 1: Add failing tests for `save_insight` column shape, injection prevention, `agent_messages`, and `503` Gemini failure in `web/__tests__/v2-p0-security-and-rpc.test.ts`**

- [ ] **Step 2: Run Vitest to verify tests fail**

Run: `cd web && npm test -- __tests__/v2-p0-security-and-rpc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor `web/app/api/ai/copilot/route.ts`**

- [ ] **Step 4: Run Vitest to verify tests pass**

Run: `cd web && npm test -- __tests__/v2-p0-security-and-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/ai/copilot/route.ts web/__tests__/v2-p0-security-and-rpc.test.ts
git commit -m "fix(copilot): enforce auth, agent_messages append-only history, real token billing, and honest 503 errors"
```

---

### Task 6: P0 API Route Hardening (`queue-render`, `preflight`, `dispatch-video`)

**Files:**
- Modify: `web/app/api/pipeline/queue-render/route.ts`
- Modify: `web/app/api/listings/[bina_id]/preflight/route.ts`
- Modify: `web/app/api/telegram/dispatch-video/route.ts`
- Test: `web/__tests__/v2-p0-security-and-rpc.test.ts`

**Interfaces:**
- Consumes: `requireOperator`, RPCs `enqueue_listing_render_atomic`, `claim_telegram_dispatch_slot`, `confirm_telegram_dispatch`, `release_telegram_dispatch_slot`, `agency_settings`.
- Produces:
  - `queue-render`: validates optional `job_type` (`"RENDER_INITIAL" | "RERENDER"`), invokes `enqueue_listing_render_atomic`.
  - `preflight`: enforces `requireOperator`; short-circuits `source_type === "OFF_MARKET"` (skips `bina.az` HTTP scrape, requires broker confirmation); reads `public_phone`/`telegram_chat_id` from `agency_settings`; acquires 2-phase lease via `claim_telegram_dispatch_slot`; on Telegram failure calls `release_telegram_dispatch_slot` and returns `502` `{ telegram_dispatched: false }`; removes `fs.existsSync`, `getPublicUrl` fallback without `storage_pruned_at`, `"Kupçalı"` default title, and mock dispatch on missing Telegram creds (returns `503`).
  - `dispatch-video`: enforces `requireOperator`; resolves listing UUID before querying `render_versions`; returns `410 Gone` if `renderVersion.storage_pruned_at !== null`; returns `503` if Telegram creds missing; supplies `agency_id` in `enqueueTelegramWorker`.

- [ ] **Step 1: Add failing API tests for unauth `401`, concurrent dispatch lease lock/release, `410 Gone` pruned video, UUID vs `bina_id` resolution, and `503` missing Telegram creds**

- [ ] **Step 2: Run Vitest to verify tests fail**

Run: `cd web && npm test -- __tests__/v2-p0-security-and-rpc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `queue-render/route.ts`, `preflight/route.ts`, and `dispatch-video/route.ts`**

- [ ] **Step 4: Run Vitest + existing API tests to verify pass**

Run: `cd web && npm test -- __tests__/v2-p0-security-and-rpc.test.ts __tests__/api/queue-render.test.ts __tests__/telegram-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/pipeline/queue-render/route.ts web/app/api/listings/[bina_id]/preflight/route.ts web/app/api/telegram/dispatch-video/route.ts web/__tests__/v2-p0-security-and-rpc.test.ts
git commit -m "fix(api): enforce auth, 2-phase Telegram leases, pruned-asset 410 guard, and atomic render queueing"
```

---

### Task 7: Web UI Atomic Conversions, `SpecialistRoom` Error Recovery, `WorkerStatusBadge` Deduplication & Shell Hygiene

**Files:**
- Modify: `web/components/AppShell.tsx`
- Modify: `web/components/CockpitCardHUD.tsx`
- Modify: `web/components/hub/ActionCardView.tsx`
- Modify: `web/components/hub/OmniChatRoom.tsx`
- Modify: `web/components/hub/SpecialistRoom.tsx`
- Modify: `web/components/PreflightModal.tsx`
- Modify: `web/components/DashboardClient.tsx`
- Modify: `web/components/LeadsClient.tsx`
- Modify: `web/components/JobsClient.tsx`
- Modify: `web/components/WorkerStatusBadge.tsx`
- Modify: `web/components/CopilotDrawer.tsx`
- Test: `web/__tests__/components/JobsClient.test.tsx`
- Test: `web/__tests__/v2-p0-security-and-rpc.test.ts`

**Interfaces:**
- Consumes: `AgencyMember` prop from `layout.tsx`, `invokeCopilot`, atomic SQL RPCs (`create_buyer_lead_atomic`, `resolve_duplicate_listing_atomic`, `retry_or_cancel_pipeline_job`).
- Produces:
  - `AppShell`: displays signed-in member name/role, Sign Out button clearing all `bakuestate_*` `localStorage` keys, mounts `CockpitCardHUD` only when `pathname === "/"`, and shares single worker status state with `WorkerStatusBadge`.
  - `CockpitCardHUD`: clean uppercase `status`/`priority` contract, zero automatic `localStorage`-driven `/api/ai/copilot` calls.
  - `ActionCardView`: routes `SAVE_INSIGHT` through `/api/ai/copilot` (`action: "save_insight"`).
  - `OmniChatRoom` & `SpecialistRoom`: load/append `agent_messages`, surface `FAILED` + `Yenidən Göndər` retry banner on `503` without writing failed turns to `localStorage`.
  - `PreflightModal`: `AbortController` on close/listing change, honest `dispatch_to_telegram: false` update, atomic `/api/pipeline/queue-render` in `handleRerenderPriceDrop`.
  - `DashboardClient`, `LeadsClient`, `JobsClient`, `CopilotDrawer`: replace non-atomic multi-table writes and missing `phone_raw` query with atomic RPCs (`RETRY` gated to `FAILED`/`EXPIRED` + new `CANCEL` button; 1.5s debounced `agency_id`-filtered Realtime pausing polling when `SUBSCRIBED`).

- [ ] **Step 1: Add failing UI component tests for `SpecialistRoom` 503 retry, `JobsClient` cancel/retry guard, `PreflightModal` abort, and Sign Out `localStorage` purge**

- [ ] **Step 2: Run Vitest to verify tests fail**

Run: `cd web && npm test -- __tests__/components/JobsClient.test.tsx __tests__/v2-p0-security-and-rpc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Apply UI updates across the 11 component files**

- [ ] **Step 4: Run Vitest to verify tests pass**

Run: `cd web && npm test -- __tests__/components/JobsClient.test.tsx __tests__/v2-p0-security-and-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components/AppShell.tsx web/components/CockpitCardHUD.tsx web/components/hub/ActionCardView.tsx web/components/hub/OmniChatRoom.tsx web/components/hub/SpecialistRoom.tsx web/components/PreflightModal.tsx web/components/DashboardClient.tsx web/components/LeadsClient.tsx web/components/JobsClient.tsx web/components/WorkerStatusBadge.tsx web/components/CopilotDrawer.tsx web/__tests__/components/JobsClient.test.tsx web/__tests__/v2-p0-security-and-rpc.test.ts
git commit -m "fix(ui): wire atomic RPCs, SpecialistRoom 503 recovery, WorkerStatusBadge context, and Sign Out cache purge"
```

---

### Task 8: Python Worker, Scraper, Telegram & Edge Function P0 Fixes + Phase 1 Checkpoint

**Files:**
- Modify: `src/cloud/supabase_repo.py:78-90,1905-1920,2021-2182`
- Modify: `src/worker/local_worker.py:1545-1560,1730-1780`
- Modify: `src/scraper/bina_scraper.py:285-295,360-375`
- Modify: `src/dispatcher/telegram_crm.py:200-230`
- Modify: `supabase/functions/telegram-webhook/index.ts:265-285,585-640,980-1045,1350-1365,1575-1595`
- Modify: `supabase/functions/followup-dispatcher/index.ts:175-220`
- Modify: `config/settings.py:210-220`
- Modify: `.env.example`
- Test: `tests/test_v2_p0_worker_and_scraper.py`

**Interfaces:**
- Produces:
  - `SupabaseRepo.get_render_version_by_id(render_version_id: str) -> Optional[Dict[str, Any]]`, `SupabaseRepo.is_job_cancel_requested(job_id: str) -> bool`, clean uppercase `cockpit_cards` methods using `agency_id` + `strategic_rationale`, removal of hardcoded `083d8ea3-4a73-4b85-8479-0c532ce939f0` in `get_default_operator_uid()`.
  - `local_worker.py`: writes `price_azn_normalized` (lines 1549 & 1552) and calls `repo.insert_listing_event(listing_id=..., event_type=..., new_value=..., triggered_job_id=..., actor="local_worker")`.
  - `bina_scraper.py`, `config/settings.py`, `telegram_crm.py`, `telegram-webhook/index.ts`: `has_bill_of_sale` defaults to `False`; unconditional `"Kupçalı"` caption prefixes removed.
  - `telegram-webhook/index.ts` & `followup-dispatcher/index.ts`: resolve `agency_id` and per-agency `telegram_chat_id` from `agency_settings` on every write/send.

- [ ] **Step 1: Add failing Python unit tests in `tests/test_v2_p0_worker_and_scraper.py`**

Verify: (a) `bina_scraper` with `hasBillOfSale=None` & HTML fallback returns `has_bill_of_sale is False`; (b) `local_worker._handle_sync_social_metrics` patches `price_azn_normalized` (never `price_azn`); (c) `local_worker._handle_telegram_dispatch` calls `get_render_version_by_id` and `insert_listing_event` with `actor="local_worker"` and valid kwargs; (d) `SupabaseRepo.get_default_operator_uid()` returns `None` instead of `083d8ea3-...`; (e) `followup-dispatcher` & `telegram-webhook` scope by `agency_id`.

- [ ] **Step 2: Run Python unittest to verify failure**

Run: `python -m unittest tests.test_v2_p0_worker_and_scraper -v`
Expected: FAIL.

- [ ] **Step 3: Implement P0 fixes in Python modules, Edge Functions, `config/settings.py`, and `.env.example`**

- [ ] **Step 4: Run full Phase 1 Verification Checkpoint**

Run:
1. `cd web && npm test && npm run lint && npx tsc --noEmit && npm run build`
2. `python -m unittest discover -s tests -v`
Expected: Both exit `0` with zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/supabase_repo.py src/worker/local_worker.py src/scraper/bina_scraper.py src/dispatcher/telegram_crm.py supabase/functions/telegram-webhook/index.ts supabase/functions/followup-dispatcher/index.ts config/settings.py .env.example tests/test_v2_p0_worker_and_scraper.py
git commit -m "fix(worker,edge): complete Phase 1 P0 integrity, Kupca defaults, and multi-tenant Edge routing"
```
