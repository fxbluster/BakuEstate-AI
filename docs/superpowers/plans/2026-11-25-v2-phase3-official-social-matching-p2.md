# BakuEstate-AI v2 Phase 3: Official Meta/TikTok APIs, Smart Matching & P2 Unified Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect official Meta Graph & TikTok Content Posting APIs via Supabase Vault with a 45-day `TELEGRAM_FALLBACK` transition flag, automate buyer↔listing matching across both `bina.az` and `OFF_MARKET` inventory with quiet-hours Telegram digests, unify all UI/backend niche routing (`<= 120,000 AZN` affordable rule) and live `district_price_medians`, remove remaining hub card demo data, and execute full-scale v2 verification.

**Architecture:** Add Phase 3 schema (`202611260004`: `social_accounts`, Vault `service_role` RPCs, `lead_listing_matches`, `match_listing_to_leads`, `upsert_social_comment_returning_is_new`), Next.js OAuth/Meta Webhook routes, Python `official_clients.py` + SHA-256 fallback `observer.py`, shared TS/Python canonical niche routers, dynamic market benchmarks, and a full automated cutover/benchmark verification script.

**Tech Stack:** PostgreSQL (`supabase_vault`), Next.js 15 App Router, Meta Graph API v21+ (Reels Container API + HMAC Webhooks), TikTok Content Posting API v2 (`PULL_FROM_URL`), Python 3.13, Deno Edge Functions.

**Spec:** [v2_isolated_multi_agent_architecture_and_cloud_scale.md](file:///c:/Users/HP/BakuEstate-AI/docs/designs/v2_isolated_multi_agent_architecture_and_cloud_scale.md)

## Global Constraints

- Depends on Phases 1 and 2 passing their verification checkpoints.
- `SOCIAL_API_MODE=TELEGRAM_FALLBACK` retained for a maximum of **45 days** while Meta/TikTok approvals finalize, then switched to `OFFICIAL` (`TELEGRAM_FALLBACK` only for emergency rollback).
- Canonical Niche Rule (`<= 120,000 AZN`): `>= 10%` price drop or urgent -> `TIKTOK` (`@baku_emlak_ai`); `>= 250,000 AZN` or elite central districts -> `LUXURY` (`@bakuestate.premium`); `<= 120,000 AZN` or suburban districts -> `AFFORDABLE` (`@baku.serfeli.evler`); `120,001–249,999 AZN` -> `GENERAL` (`@bakuestate.official`).
- All Vault secret decryption must run exclusively via `service_role`-only SQL RPCs (`read_social_secret`, `store_social_secret`); never query `vault` schema directly over PostgREST.

## Review Focus

1. Meta Webhook `GET` verification must return `hub.challenge` when `hub.verify_token` matches, and `POST` deliveries with an invalid or missing `X-Hub-Signature-256` HMAC must reject with `401/403` before touching `upsert_social_comment_returning_is_new` (pinned to Task 2).
2. A single attractive Yasamal listing matching 100+ active `buyer_leads` (`match_score >= 60`) must write idempotent rows to `lead_listing_matches` without stalling `local_worker.py` or violating Telegram's 1 msg/sec chat cap — `followup-dispatcher` sends batched digests only inside `09:00–21:30` Baku hours (pinned to Task 4).
3. Fallback `observer.py` polling the same Instagram comment twice must produce identical normalized SHA-256 comment IDs and `upsert_social_comment_returning_is_new` must return `is_new = FALSE` on poll #2 (pinned to Task 3).
4. Switching a listing's canonical niche threshold in `agency_settings.niche_rules_json` or viewing any listing across `ListingsClient`, `PreflightModal`, `VideoPipelineCard`, `AnalyticsTelemetryCard`, and Python `account_router.py` must yield the exact same channel/handle (`<= 120,000 AZN` rule, pinned to Task 5).
5. `scripts/verify_v2_cutover.py` seeded with 2,000 synthetic listings/leads must prove `< 300 ms` SSR pagination queries, `401/403` on all `anon` and `SMM -> listing_owner_contacts` checks, and `0` row delta on `ejsaccbeatmwqodwwzwu` Citadel tables (pinned to Task 7).

---

### Task 1: Phase 3 Social OAuth Vault Schema, `lead_listing_matches` & Matching/Deduplication RPCs

**Files:**
- Create: `supabase/migrations/202611260004_v2_p2_social_and_matching.sql`
- Test: `tests/test_v2_p2_official_social_and_matching.py`

**Interfaces:**
- Consumes: `buyer_leads` (`min_rooms`, `requires_kupca`, `budget_max_azn`, `preferred_districts`, `stage`), `listings`, `publications`, `social_comments` (`UNIQUE(publication_id, platform_comment_id)`).
- Produces:
  - `public.social_accounts (id UUID PK, agency_id UUID NOT NULL, platform TEXT CHECK IN ('INSTAGRAM','TIKTOK'), account_handle TEXT NOT NULL, external_account_id TEXT NOT NULL, vault_secret_id UUID NOT NULL, refresh_vault_secret_id UUID NULL, token_expires_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE')`.
  - `public.lead_listing_matches` with `UNIQUE (lead_id, listing_id)`.
  - Index `idx_publications_channel_ext_post ON public.publications (channel, external_post_id) WHERE external_post_id IS NOT NULL`; extend `pipeline_jobs.job_type` CHECK with `'PUBLISH_SOCIAL'`.
  - `service_role`-only Vault RPCs: `store_social_secret(p_name TEXT, p_secret TEXT) RETURNS UUID`, `read_social_secret(p_secret_id UUID) RETURNS TEXT`.
  - `upsert_social_comment_returning_is_new(...) RETURNS TABLE(comment_id UUID, is_new BOOLEAN)` (`ON CONFLICT (publication_id, platform_comment_id) DO NOTHING RETURNING id`).
  - `match_listing_to_leads(p_listing_id UUID) RETURNS INT` (0–100 score formula, `match_score >= 60`, `ON CONFLICT DO NOTHING`, skips `WON_CLOSED`/`LOST`/`COLD`).

- [ ] **Step 1: Write failing migration assertions in `tests/test_v2_p2_official_social_and_matching.py`**

- [ ] **Step 2: Run Python unittest to verify failure**

Run: `python -m unittest tests.test_v2_p2_official_social_and_matching -v`
Expected: FAIL.

- [ ] **Step 3: Author `supabase/migrations/202611260004_v2_p2_social_and_matching.sql`**

- [ ] **Step 4: Run Python unittest to verify pass**

Run: `python -m unittest tests.test_v2_p2_official_social_and_matching -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202611260004_v2_p2_social_and_matching.sql tests/test_v2_p2_official_social_and_matching.py
git commit -m "feat(db): add Vault-backed social_accounts, comment dedup RPC, and smart buyer matching schema"
```

---

### Task 2: Official Meta/TikTok OAuth Callback & HMAC-Verified Webhook Routes

**Files:**
- Create: `web/app/api/social/oauth/[platform]/route.ts`
- Create: `web/app/api/social/webhooks/meta/route.ts`
- Test: `web/__tests__/v2-p2-social-and-niche.test.ts`

**Interfaces:**
- Consumes: `requireOperator(req, ["ADMIN", "SMM"])` (OAuth start), signed HTTP-only CSRF `state` cookie containing `{ agencyId, userId, nonce }` (OAuth callback), `store_social_secret` RPC, `upsert_social_comment_returning_is_new` RPC.
- Produces:
  - `GET /api/social/oauth/[platform]` (`platform IN ('instagram', 'tiktok')`): without `?code=` initiates provider OAuth redirect with scopes (`instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `pages_show_list` | `video.publish`, `video.list`); with `?code=&state=` validates CSRF state, exchanges code for token + refresh token, stores secrets via `store_social_secret`, upserts `social_accounts`.
  - `GET /api/social/webhooks/meta`: validates `hub.mode === 'subscribe'` and `hub.verify_token === process.env.META_WEBHOOK_VERIFY_TOKEN`, returns raw `hub.challenge`.
  - `POST /api/social/webhooks/meta`: verifies `X-Hub-Signature-256` HMAC-SHA256 using `process.env.META_APP_SECRET` (`crypto.timingSafeEqual`, else `401`); resolves `(agency_id, publication_id)` via indexed `external_post_id` and records comment via `upsert_social_comment_returning_is_new`.

- [ ] **Step 1: Add failing tests for OAuth CSRF state mismatch, Meta `GET` challenge, and invalid `X-Hub-Signature-256` (`401`)**

- [ ] **Step 2: Run Vitest to verify failure**

Run: `cd web && npm test -- __tests__/v2-p2-social-and-niche.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `/api/social/oauth/[platform]/route.ts` and `/api/social/webhooks/meta/route.ts`**

- [ ] **Step 4: Run Vitest to verify pass**

Run: `cd web && npm test -- __tests__/v2-p2-social-and-niche.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/social/oauth/[platform]/route.ts web/app/api/social/webhooks/meta/route.ts web/__tests__/v2-p2-social-and-niche.test.ts
git commit -m "feat(social): add Meta/TikTok OAuth Vault flow and HMAC-verified Meta comment webhook"
```

---

### Task 3: Python Official Meta/TikTok Clients, Token Refresh & SHA-256 Comment Fallback

**Files:**
- Create: `src/social/official_clients.py`
- Modify: `src/social/observer.py`
- Modify: `src/worker/local_worker.py`
- Test: `tests/test_v2_p2_official_social_and_matching.py`

**Interfaces:**
- Consumes: `read_social_secret` / `store_social_secret` RPCs, signed R2 custom domain `https://media.bakuestate.az`, `upsert_social_comment_returning_is_new`.
- Produces:
  - `OfficialSocialPublisher` & `refresh_expiring_social_tokens()` in `src/social/official_clients.py`: Meta 2-step Reels container (`POST /{ig_user_id}/media` -> poll `status_code == 'FINISHED'` -> `POST /{ig_user_id}/media_publish`), TikTok `PULL_FROM_URL` (`media.bakuestate.az`), telemetry/comment sync, and automatic token refresh before 24h TikTok / 60d Meta expiration.
  - `observer.py`: restricted to `SOCIAL_API_MODE=TELEGRAM_FALLBACK`; computes deterministic `sha256(f"{platform}:{code}:{author_handle}:{clean_text[:120]}".encode("utf-8")).hexdigest()[:32]` instead of positional index IDs.
  - `local_worker.py`: branches `PUBLISH_SOCIAL` & telemetry handlers on `agency_settings.social_api_mode`, filters duplicate comments via `upsert_social_comment_returning_is_new`.

- [ ] **Step 1: Add failing tests for Meta 2-step container polling, TikTok refresh handling, SHA-256 deterministic comment hash, and zero duplicate lead alerts on repeat comment poll**

- [ ] **Step 2: Run Python unittest to verify failure**

Run: `python -m unittest tests.test_v2_p2_official_social_and_matching -v`
Expected: FAIL.

- [ ] **Step 3: Implement `official_clients.py`, update `observer.py` and `local_worker.py`**

- [ ] **Step 4: Run Python unittest to verify pass**

Run: `python -m unittest tests.test_v2_p2_official_social_and_matching -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/social/official_clients.py src/social/observer.py src/worker/local_worker.py tests/test_v2_p2_official_social_and_matching.py
git commit -m "feat(social): implement official Meta/TikTok publishing, token refresh, and SHA-256 comment dedup"
```

---

### Task 4: Smart Buyer↔Listing Matching Execution & Batched Quiet-Hours Digest Alerts

**Files:**
- Modify: `web/app/api/listings/manual/route.ts`
- Modify: `src/worker/local_worker.py`
- Modify: `web/components/LeadsClient.tsx`
- Modify: `supabase/functions/followup-dispatcher/index.ts`
- Test: `tests/test_v2_p2_official_social_and_matching.py`

**Interfaces:**
- Consumes: `match_listing_to_leads(p_listing_id)` SQL RPC, `lead_listing_matches`.
- Produces:
  - Both `/api/listings/manual` (`OFF_MARKET`) and `local_worker.py` (new/price-drop `ACTIVE` scrape) invoke `match_listing_to_leads(listing_id)`.
  - `followup-dispatcher/index.ts` queries `lead_listing_matches WHERE status = 'NEW'` during `09:00–21:30` Baku time (`UTC+4`), groups per agency/broker into a single batched Telegram digest message (respecting rate limits), and marks matches `status = 'NOTIFIED', notified_at = NOW()`.
  - `LeadsClient.tsx` displays top `lead_listing_matches` badges/suggestions on each buyer row.

- [ ] **Step 1: Add failing tests for off-market + scrape matching trigger, quiet-hours digest batching, and `NOTIFIED` status transition**

- [ ] **Step 2: Run Python unittest to verify failure**

Run: `python -m unittest tests.test_v2_p2_official_social_and_matching -v`
Expected: FAIL.

- [ ] **Step 3: Update `listings/manual/route.ts`, `local_worker.py`, `followup-dispatcher/index.ts`, and `LeadsClient.tsx`**

- [ ] **Step 4: Run tests to verify pass**

Run: `python -m unittest tests.test_v2_p2_official_social_and_matching -v && cd web && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/listings/manual/route.ts src/worker/local_worker.py web/components/LeadsClient.tsx supabase/functions/followup-dispatcher/index.ts tests/test_v2_p2_official_social_and_matching.py
git commit -m "feat(matching): wire automated buyer-listing matching across scrape/off-market and batched quiet-hours digests"
```

---

### Task 5: Canonical Niche Router (`<= 120,000 AZN` Rule) Across Web & Python

**Files:**
- Create: `web/lib/niche-router.ts`
- Modify: `src/worker/account_router.py`
- Modify: `web/components/ListingsClient.tsx`
- Modify: `web/components/PreflightModal.tsx`
- Modify: `web/components/hub/stage/VideoPipelineCard.tsx`
- Modify: `web/components/hub/stage/AnalyticsTelemetryCard.tsx`
- Test: `web/__tests__/v2-p2-social-and-niche.test.ts`
- Test: `tests/test_v2_p2_official_social_and_matching.py`

**Interfaces:**
- Produces: `resolveCanonicalListingNiche(listing, rules?) -> { niche: ChannelNiche; account: string }` in `web/lib/niche-router.ts` matching `src/worker/account_router.py` (`>= 10%` drop/urgent -> `TIKTOK`, `>= 250k`/elite -> `LUXURY`, `<= 120k`/suburban -> `AFFORDABLE`, else `GENERAL`); removes legacy heuristics in `ListingsClient` (`< 150k`), `PreflightModal`, `VideoPipelineCard`, and `AnalyticsTelemetryCard` (`> 3000/m2`).

- [ ] **Step 1: Add cross-boundary parity tests verifying Web & Python produce identical niches across 115k, 135k, 260k, and 12% drop cases**

- [ ] **Step 2: Run Vitest + Python unittest to verify failure**

Run: `cd web && npm test -- __tests__/v2-p2-social-and-niche.test.ts` and `python -m unittest tests.test_v2_p2_official_social_and_matching -v`
Expected: FAIL.

- [ ] **Step 3: Create `web/lib/niche-router.ts` and update `account_router.py`, `ListingsClient.tsx`, `PreflightModal.tsx`, `VideoPipelineCard.tsx`, `AnalyticsTelemetryCard.tsx`**

- [ ] **Step 4: Run Vitest + Python unittest to verify pass**

Run: `cd web && npm test -- __tests__/v2-p2-social-and-niche.test.ts` and `python -m unittest tests.test_v2_p2_official_social_and_matching -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/niche-router.ts src/worker/account_router.py web/components/ListingsClient.tsx web/components/PreflightModal.tsx web/components/hub/stage/VideoPipelineCard.tsx web/components/hub/stage/AnalyticsTelemetryCard.tsx web/__tests__/v2-p2-social-and-niche.test.ts tests/test_v2_p2_official_social_and_matching.py
git commit -m "refactor(niche): unify channel routing under <=120k canonical rule across Web and Python"
```

---

### Task 6: Live District Medians & P2 Stage Card Demo Cleanup

**Files:**
- Modify: `web/lib/market-benchmarks.ts`
- Modify: `web/lib/agent-personas.ts`
- Modify: `web/components/hub/stage/VideoPipelineCard.tsx`
- Modify: `web/components/hub/stage/AnalyticsTelemetryCard.tsx`
- Modify: `web/components/hub/stage/CrmNegotiationCard.tsx`
- Modify: `supabase/functions/telegram-webhook/index.ts` (`keenable` callback median query)
- Modify: `config/settings.py` (mark `BAKU_DISTRICT_MEDIAN_M2` fallback-only)
- Test: `web/__tests__/v2-p2-social-and-niche.test.ts`

**Interfaces:**
- Consumes: `public.district_price_medians` view, `resolveOperator` / auth token.
- Produces:
  - Zero `ForBiggerBlazes.mp4`, `385,000 AZN`, `Badamdar` fake defaults, Unsplash placeholder URLs, `ElevenLabs Arif` hardcode, `"Rəşad Əliyev"`, `994502123456`, or `226000`/`95` fallback strings across hub stage cards.
  - `VideoPipelineCard` links directly to `/jobs?tab=worker`; `AnalyticsTelemetryCard` replaces unbounded `buyer_leads` fetch with filtered/count query; `CrmNegotiationCard` sends Bearer auth header and checks `!res.ok || !data.ok`.
  - `telegram-webhook` `keenable` callback and `market-benchmarks.ts` query `public.district_price_medians`.

- [ ] **Step 1: Add failing grep/render tests asserting zero legacy demo strings/URLs and checking `CrmNegotiationCard` `!data.ok` failure handling**

- [ ] **Step 2: Run Vitest to verify failure**

Run: `cd web && npm test -- __tests__/v2-p2-social-and-niche.test.ts __tests__/lib/marketBenchmarks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Clean up stage cards, `market-benchmarks.ts`, `agent-personas.ts`, `telegram-webhook/index.ts`, and `config/settings.py`**

- [ ] **Step 4: Run Vitest to verify pass**

Run: `cd web && npm test -- __tests__/v2-p2-social-and-niche.test.ts __tests__/lib/marketBenchmarks.test.ts __tests__/agent-personas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/market-benchmarks.ts web/lib/agent-personas.ts web/components/hub/stage/VideoPipelineCard.tsx web/components/hub/stage/AnalyticsTelemetryCard.tsx web/components/hub/stage/CrmNegotiationCard.tsx supabase/functions/telegram-webhook/index.ts config/settings.py web/__tests__/v2-p2-social-and-niche.test.ts
git commit -m "fix(hub,benchmarks): replace static district medians with district_price_medians and scrub stage demo fixtures"
```

---

### Task 7: End-to-End Red-Team, 2,000-Row Scale Benchmark & Final Phase 3 Verification

**Files:**
- Create: `scripts/verify_v2_cutover.py`
- Modify: `docs/designs/SITEMAP.md`
- Modify: `docs/designs/v2_isolated_multi_agent_architecture_and_cloud_scale.md` (`Status: Accepted` post-release)

**Interfaces:**
- Produces: `python scripts/verify_v2_cutover.py --seed-synthetic 2000` checking live `anon` `401/403` across all tables/RPCs, `SMM -> listing_owner_contacts` denial, disabled member `403`, parallel render/Telegram lock idempotency, `< 300 ms` SSR pagination latency at 2,000 rows, CSV formula escaping, and `0` row delta on `ejsaccbeatmwqodwwzwu` Citadel tables.

- [ ] **Step 1: Write `scripts/verify_v2_cutover.py`**

- [ ] **Step 2: Run full compilation, Web & Python test suites**

Run:
1. `cd web && npm test && npm run lint && npx tsc --noEmit && npm run build`
2. `python -m unittest discover -s tests -v`
Expected: Exit `0` across all checks.

- [ ] **Step 3: Execute live cutover/red-team check against isolated staging/prod & update `SITEMAP.md`**

Run: `python scripts/verify_v2_cutover.py --seed-synthetic 2000`
Expected: Exit `0` (`< 300 ms` pagination, `100%` `anon` blocked, `0` Citadel drift).

- [ ] **Step 4: Final commit**

```bash
git add scripts/verify_v2_cutover.py docs/designs/SITEMAP.md docs/designs/v2_isolated_multi_agent_architecture_and_cloud_scale.md
git commit -m "chore(release): add v2 cutover/red-team verifier and mark architecture design Accepted"
```
