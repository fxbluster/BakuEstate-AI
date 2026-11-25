# BakuEstate-AI v2 Phase 2: Railway Cloud Workers, Private Cloudflare R2, Proxy, Server Pagination & Pre-Render Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate video rendering from the single Windows PC to multi-replica Railway Docker containers backed by a private Cloudflare R2 bucket (`media.bakuestate.az`, `<= 18 MB` MP4s), add `BINA_PROXY_URL` Webshare ISP proxy with circuit breaker, enable `OFF_MARKET` listings + Pre-Render Studio + Admin `/settings` + formula-safe CSV export, and replace 200/500-row SSR caps with `< 300 ms` server-side pagination and SQL KPIs.

**Architecture:** Extend the Phase 1 database schema (`202611260003`) with `storage_provider`, composite/`pg_trgm` indexes, SQL KPI/analytics RPCs, `district_price_medians`, and `cockpit-generator` `pg_cron` scheduling; run stateless Railway `--no-scheduler` workers calling `run_pipeline.py` with cooperative cancellation and R2 S3 upload; update Next.js SSR pages and Pre-Render Studio/manual listing APIs.

**Tech Stack:** PostgreSQL (`pg_trgm`, `pg_cron`), Next.js 15, Vercel Pro (`undici.ProxyAgent`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`), Railway Docker (`python:3.13-slim`, `ffmpeg`, `boto3`, `fonts-dejavu-core`, `fonts-noto-core`), Cloudflare R2 & Worker CDN, Deno Edge Functions.

**Spec:** [v2_isolated_multi_agent_architecture_and_cloud_scale.md](file:///c:/Users/HP/BakuEstate-AI/docs/designs/v2_isolated_multi_agent_architecture_and_cloud_scale.md)

## Global Constraints

- Depends on Phase 1 merged and deployed standalone first (`202611260001`, `202611260002`, `resolve-operator.ts`, `agent_messages`, `admin.ts`).
- Private R2 Bucket Only: Never store 7-day S3 SigV4 pre-signed URLs in `render_versions.video_cdn_url`; store `storage_object_path` + `storage_provider` (`'supabase' | 'r2'`) and serve via signed Cloudflare Worker domain `https://media.bakuestate.az`.
- Telegram 20 MB Cap: All rendered MP4s must enforce a strict `<= 18 MB` 2-pass FFmpeg cap.
- Pre-Render Studio Security: `selected_photo_urls` (`4 <= len <= 10`) strictly allowlisted against listing/agency R2 URLs (no SSRF); `custom_script_text <= 1,000` characters.
- Proxy Budget: `BINA_PROXY_URL` = Webshare ISP / Static Residential (`HTTP`, `15 GB / $20` monthly cap) with 5-failure circuit breaker returning `MANUAL_OVERRIDE`.

## Review Focus

1. Attempting to render an arbitrary internal IP (`http://169.254.169.254/...`) in `selected_photo_urls` or pasting >1,000 chars in `custom_script_text` must be rejected `HTTP 400` in both `/api/pipeline/queue-render` and `run_pipeline.py` (pinned to Task 5).
2. Cancelling a `RUNNING` render job mid-TTS or mid-FFmpeg must delete partial temp directories and partial R2 uploads cleanly via `try/finally`, call `complete_pipeline_job(..., 'CANCELLED')`, and allow immediate re-queueing without hitting a legacy `idempotency_key` collision (pinned to Task 2).
3. `storage-pruner` running during Phase 2 dual-path rollout must route `'supabase'` rows to legacy Supabase Storage and `'r2'` rows to Cloudflare R2 SigV4 deletion, setting `video_cdn_url = NULL` + `storage_pruned_at = NOW()` (pinned to Task 3).
4. Exporting `/api/export/commissions` with a `buyer_leads.client_name` or `notes` starting with `=`, `+`, `-`, `@`, `\t`, or `\r` must escape the cell with a leading `'`, include UTF-8 BOM, respect `BROKER` (own leads) vs `ADMIN` (agency leads), and reject `SMM` with `403` (pinned to Task 7).
5. Clicking `/listings/[bina_id]` or calling `/api/listings/[bina_id]/preflight` with an `OFF_MARKET` UUID (`bina_id IS NULL`) must load cleanly without `parseInt` `400` errors or hitting `bina.az` HTTP 404 (pinned to Task 4).

---

### Task 1: Phase 2 Schema Indexes, `storage_provider`, KPI/Analytics RPCs & `district_price_medians`

**Files:**
- Create: `supabase/migrations/202611260003_v2_p1_cloud_studio_and_pagination.sql`
- Modify: `web/lib/supabase/env.ts`
- Test: `tests/test_v2_p1_r2_and_pipeline_cancel.py`

**Interfaces:**
- Consumes: Phase 1 schema (`listings`, `render_versions`, `buyer_leads`, `follow_up_tasks`, `pipeline_jobs`, `cockpit_cards`, `agency_members`, `baku_estate_config`).
- Produces:
  - `render_versions.storage_provider TEXT NOT NULL DEFAULT 'r2' CHECK (storage_provider IN ('supabase','r2'))`.
  - Composite & `pg_trgm` GIN indexes on `listings` (`(agency_id, created_at DESC)`, `(agency_id, editorial_status, created_at DESC)`, `(agency_id, canonical_niche, created_at DESC)`, `gin_trgm_ops` on `title`, `address`) and `buyer_leads` (`(agency_id, stage, next_followup_at)`, `gin_trgm_ops` on `client_name`, `phone_normalized`).
  - `public.district_price_medians` view (60-day active listings `PERCENTILE_CONT(0.5)` AZN/m² per district).
  - SQL RPCs (auth-derived `current_agency_id()` & role check): `get_agency_crm_kpis() RETURNS JSONB` (includes agency vs broker commission totals weighted by `commission_split_pct`), `get_analytics_summary(p_days INT DEFAULT 30) RETURNS JSONB`.
  - `pg_cron` schedule for `cockpit-generator` (`0 4 * * *` UTC = `08:00` Bakı).

- [ ] **Step 1: Write failing migration test in `tests/test_v2_p1_r2_and_pipeline_cancel.py`**

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_v2_p1_r2_and_pipeline_cancel -v`
Expected: FAIL.

- [ ] **Step 3: Author `202611260003_v2_p1_cloud_studio_and_pagination.sql` and update `web/lib/supabase/env.ts` (`NEXT_PUBLIC_R2_MEDIA_BASE_URL`)**

- [ ] **Step 4: Run test to verify pass**

Run: `python -m unittest tests.test_v2_p1_r2_and_pipeline_cancel -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202611260003_v2_p1_cloud_studio_and_pagination.sql web/lib/supabase/env.ts tests/test_v2_p1_r2_and_pipeline_cancel.py
git commit -m "feat(db): add Phase 2 R2 storage_provider, pagination/trgm indexes, KPI RPCs, and medians view"
```

---

### Task 2: Private Cloudflare R2 Storage, Railway Worker Container & `run_pipeline.py` Cooperative Cancellation

**Files:**
- Modify: `requirements.txt` (`boto3>=1.35.0`)
- Create: `src/cloud/r2_storage.py`
- Modify: `src/cloud/supabase_repo.py`
- Modify: `run_pipeline.py:540-1034`
- Modify: `src/worker/local_worker.py`
- Create: `Dockerfile.worker`
- Create: `railway.toml`
- Test: `tests/test_v2_p1_r2_and_pipeline_cancel.py`

**Interfaces:**
- Produces:
  - `R2StorageClient` in `src/cloud/r2_storage.py`: `upload_video(local_path, object_key) -> R2UploadResult(object_path, cdn_url, size_bytes)`, `delete_object(object_path) -> bool`, `mint_signed_media_url(object_path, ttl_seconds=3600) -> str`.
  - `BakuEstatePipeline.process_listing_video_and_dispatch(..., selected_photo_urls: Optional[List[str]] = None, custom_script_text: Optional[str] = None, agency_settings: Optional[Dict[str, Any]] = None, cancel_check_cb: Optional[Callable[[], bool]] = None)`: checks `cancel_check_cb()` between photo download, script generation, TTS, FFmpeg render, and R2 upload; enforces two-pass `<= 18 MB` FFmpeg target bitrate; applies `try/finally` temp cleanup; deletes partial R2 object on cancel.
  - `local_worker.py`: adds `--no-scheduler` CLI flag (required for Railway multi-replica); registers `SIGTERM` handler interrupting FFmpeg subprocess; calls `complete_pipeline_job(job_id, worker_id, "CANCELLED")`.
  - `Dockerfile.worker`: `python:3.13-slim` + `ffmpeg` + `fonts-dejavu-core` + `fonts-noto-core`, `CMD ["python", "-m", "src.worker.local_worker", "--no-scheduler"]`.

- [ ] **Step 1: Add failing tests for R2 upload/delete, 18 MB cap config, and `cancel_check_cb` cleanup in `tests/test_v2_p1_r2_and_pipeline_cancel.py`**

- [ ] **Step 2: Run Python unittest to verify failure**

Run: `python -m unittest tests.test_v2_p1_r2_and_pipeline_cancel -v`
Expected: FAIL.

- [ ] **Step 3: Implement `r2_storage.py`, update `requirements.txt`, `supabase_repo.py`, `run_pipeline.py`, `local_worker.py`, `Dockerfile.worker`, `railway.toml`**

- [ ] **Step 4: Run Python unittest to verify pass**

Run: `python -m unittest tests.test_v2_p1_r2_and_pipeline_cancel -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add requirements.txt src/cloud/r2_storage.py src/cloud/supabase_repo.py run_pipeline.py src/worker/local_worker.py Dockerfile.worker railway.toml tests/test_v2_p1_r2_and_pipeline_cancel.py
git commit -m "feat(media): add Cloudflare R2 storage, <=18MB cap, cooperative cancel, and Railway worker container"
```

---

### Task 3: Dual-Path `storage-pruner` & Automated `cockpit-generator` Edge Functions

**Files:**
- Modify: `supabase/functions/storage-pruner/index.ts`
- Create: `supabase/functions/cockpit-generator/index.ts`
- Test: `tests/test_v2_p1_r2_and_pipeline_cancel.py`

**Interfaces:**
- Produces:
  - `storage-pruner/index.ts`: fail-closed `CRON_SECRET`; switches on `render_versions.storage_provider` (`'r2'` uses Deno WebCrypto AWS SigV4 `DELETE` against R2 S3 endpoint, `'supabase'` uses Storage remove); updates `storage_pruned_at = NOW(), video_cdn_url = NULL`.
  - `cockpit-generator/index.ts`: fail-closed `CRON_SECRET`; expires prior unactioned `PENDING` cards (`expires_at < NOW()`); iterates active agencies in bounded batches (<= 20 per invocation), reads overdue tasks/stale high-value leads, invokes `gemini-3.8-flash` (recording usage in `ai_copilot_runs` via `agency_ai_usage_monthly`), writes uppercase `priority`/`status='PENDING'`/`strategic_rationale` cards to `cockpit_cards`.

- [ ] **Step 1: Add failing assertions verifying `storage-pruner` SigV4/dual-path routing and `cockpit-generator` `CRON_SECRET`/expiry contract**

- [ ] **Step 2: Run test to verify failure**

Run: `python -m unittest tests.test_v2_p1_r2_and_pipeline_cancel -v`
Expected: FAIL.

- [ ] **Step 3: Update `storage-pruner/index.ts` and create `cockpit-generator/index.ts`**

- [ ] **Step 4: Run test to verify pass**

Run: `python -m unittest tests.test_v2_p1_r2_and_pipeline_cancel -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/storage-pruner/index.ts supabase/functions/cockpit-generator/index.ts tests/test_v2_p1_r2_and_pipeline_cancel.py
git commit -m "feat(edge): add dual-path R2 storage-pruner and cron-driven cockpit-generator"
```

---

### Task 4: Webshare ISP Proxy + `OFF_MARKET` Manual Listings API & Slug Routing

**Files:**
- Modify: `web/package.json` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `undici`)
- Modify: `web/app/api/listings/[bina_id]/preflight/route.ts`
- Modify: `src/scraper/bina_scraper.py` (`BINA_PROXY_URL` session support + `max_photos=10`)
- Create: `web/app/api/listings/manual/route.ts`
- Modify: `web/app/listings/[bina_id]/page.tsx`
- Test: `web/__tests__/v2-p1-pagination-studio-export.test.ts`
- Test: `tests/test_v2_p1_r2_and_pipeline_cancel.py`

**Interfaces:**
- Produces:
  - `preflight/route.ts` (`runtime = "nodejs"`): supports `bina_id` OR UUID param; routes `bina.az` fetches via `undici.ProxyAgent(process.env.BINA_PROXY_URL)` with 5-error circuit breaker returning `{ ok: false, reason: "PROXY_CIRCUIT_OPEN", manual_override_allowed: true }`.
  - `POST /api/listings/manual`: `requireOperator(req, ["ADMIN", "BROKER"])`; validates `{ title, price_azn, area_m2, rooms, district, address, has_bill_of_sale, owner_name?, owner_phone?, photo_files?: { name, contentType, sizeBytes }[] }` (`image/jpeg|png|webp`, `<= 10 MB`, `4..10` items); inserts `listings` (`source_type: 'OFF_MARKET'`, `bina_id: null`) + `listing_owner_contacts`; returns `{ listing_id, upload_urls: [{ object_key, put_url, public_path }] }` (`@aws-sdk/s3-request-presigner`, 900s TTL); `PATCH /api/listings/manual` confirms uploaded `photo_urls`.
  - `/listings/[bina_id]/page.tsx`: resolves UUID or numeric `bina_id` seamlessly within caller's `agency_id`.

- [ ] **Step 1: Add failing tests for `OFF_MARKET` pre-signed PUT generation, proxy circuit breaker, `max_photos=10`, and UUID listing page resolution**

- [ ] **Step 2: Run Vitest + Python unittest to verify failure**

Run: `cd web && npm test -- __tests__/v2-p1-pagination-studio-export.test.ts` and `python -m unittest tests.test_v2_p1_r2_and_pipeline_cancel -v`
Expected: FAIL.

- [ ] **Step 3: Implement `package.json`, `preflight/route.ts`, `bina_scraper.py`, `listings/manual/route.ts`, and `listings/[bina_id]/page.tsx`**

- [ ] **Step 4: Run Vitest + Python unittest to verify pass**

Run: `cd web && npm test -- __tests__/v2-p1-pagination-studio-export.test.ts` and `python -m unittest tests.test_v2_p1_r2_and_pipeline_cancel -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/app/api/listings/[bina_id]/preflight/route.ts src/scraper/bina_scraper.py web/app/api/listings/manual/route.ts web/app/listings/[bina_id]/page.tsx web/__tests__/v2-p1-pagination-studio-export.test.ts tests/test_v2_p1_r2_and_pipeline_cancel.py
git commit -m "feat(listings): add Webshare proxy circuit breaker and OFF_MARKET R2 manual listing flow"
```

---

### Task 5: Pre-Render Studio (`generate_render_script` + SSRF Guarded `queue-render` + `ListingDetailClient`)

**Files:**
- Modify: `web/app/api/ai/copilot/route.ts` (add `action: "generate_render_script"`)
- Modify: `web/app/api/pipeline/queue-render/route.ts`
- Modify: `web/components/ListingDetailClient.tsx`
- Test: `web/__tests__/v2-p1-pagination-studio-export.test.ts`

**Interfaces:**
- Consumes: `invokeCopilot({ action: "generate_render_script", listing_id })`, `enqueue_listing_render_atomic`.
- Produces:
  - `copilot/route.ts`: `action: "generate_render_script"` returning `{ ok: true, data: { draft_script: string, hook_type: HookType } }` (capped `<= 1,000` chars).
  - `queue-render/route.ts`: validates `selected_photo_urls` (`4 <= len <= 10`, every URL must match listing's `photo_urls` or `https://media.bakuestate.az/staging/${operator.agencyId}/`, else `HTTP 400`), validates `custom_script_text.length <= 1000` (else `HTTP 400`).
  - `ListingDetailClient.tsx`: renders Pre-Render Studio panel (select/reorder 4–10 photos, generate/edit script, account/voice select; disabled with warning when `< 4` photos) and converts `handleQuickStatus`, `handleSaveOwner`, `handleAddPublication` to atomic RPC/API calls.

- [ ] **Step 1: Add failing tests for SSRF photo URL rejection (`400`), `> 1,000` script rejection (`400`), `generate_render_script`, and `< 4` photo guard**

- [ ] **Step 2: Run Vitest to verify failure**

Run: `cd web && npm test -- __tests__/v2-p1-pagination-studio-export.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `copilot/route.ts`, `queue-render/route.ts`, and `ListingDetailClient.tsx`**

- [ ] **Step 4: Run Vitest to verify pass**

Run: `cd web && npm test -- __tests__/v2-p1-pagination-studio-export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/ai/copilot/route.ts web/app/api/pipeline/queue-render/route.ts web/components/ListingDetailClient.tsx web/__tests__/v2-p1-pagination-studio-export.test.ts
git commit -m "feat(studio): add Pre-Render Studio script generator, SSRF photo guard, and atomic detail mutations"
```

---

### Task 6: `< 300 ms` Server-Side Pagination (`listings`, `leads`, `analytics`, `jobs`) & Multi-Replica Worker Monitor

**Files:**
- Modify: `web/app/listings/page.tsx`
- Modify: `web/components/ListingsClient.tsx`
- Modify: `web/app/leads/page.tsx`
- Modify: `web/components/LeadsClient.tsx`
- Modify: `web/app/analytics/page.tsx`
- Modify: `web/components/AnalyticsClient.tsx`
- Modify: `web/app/jobs/page.tsx`
- Modify: `web/components/WorkerMonitorClient.tsx`
- Test: `web/__tests__/v2-p1-pagination-studio-export.test.ts`

**Interfaces:**
- Consumes: `PaginatedResult<T>`, `get_agency_crm_kpis()`, `get_analytics_summary(p_days)`, `listings.canonical_niche`.
- Produces: URL query-driven pagination (`page` [1-based, resets to `1` on filter change], `pageSize=24`, escaped `search`, `niche`, `editorial`, `stage`, `sort`) using `.range()` + `.in("listing_id", pageIds)` instead of hardcoded 200/500 table scans; `ListingsClient` adds "+ Eksklüziv Elan Əlavə Et" (`OFF_MARKET`) modal and `confirm_publication_atomic`; `WorkerMonitorClient` lists all active Railway container replicas instead of `workers[0]` + PowerShell command.

- [ ] **Step 1: Add failing tests verifying `PaginatedResult` slicing, PostgREST wildcard escaping, `page=1` filter reset, and multi-replica `WorkerMonitorClient` rendering**

- [ ] **Step 2: Run Vitest to verify failure**

Run: `cd web && npm test -- __tests__/v2-p1-pagination-studio-export.test.ts __tests__/components/WorkerMonitorClient.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Refactor the 4 SSR pages and 4 client components**

- [ ] **Step 4: Run Vitest to verify pass**

Run: `cd web && npm test -- __tests__/v2-p1-pagination-studio-export.test.ts __tests__/components/WorkerMonitorClient.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/listings/page.tsx web/components/ListingsClient.tsx web/app/leads/page.tsx web/components/LeadsClient.tsx web/app/analytics/page.tsx web/components/AnalyticsClient.tsx web/app/jobs/page.tsx web/components/WorkerMonitorClient.tsx web/__tests__/v2-p1-pagination-studio-export.test.ts
git commit -m "feat(crm): replace 200/500 row caps with indexed server-side pagination, SQL KPIs, and multi-replica monitor"
```

---

### Task 7: Admin `/settings`, `commission_split_pct` Management, Formula-Safe CSV Export & Phase 2 Checkpoint

**Files:**
- Create: `web/app/api/agency/settings/route.ts`
- Create: `web/app/api/agency/members/route.ts`
- Create: `web/app/api/export/commissions/route.ts`
- Create: `web/app/settings/page.tsx`
- Create: `web/components/SettingsClient.tsx`
- Modify: `web/components/LeadsClient.tsx` (CSV Export button + broker assignment UI)
- Test: `web/__tests__/v2-p1-pagination-studio-export.test.ts`

**Interfaces:**
- Produces:
  - `GET/PATCH /api/agency/settings` (`requireOperator(req, ["ADMIN"])`): updates `public_phone`, `telegram_chat_id`, `niche_rules_json`, `watermark_preset_json`, `monthly_ai_budget_usd`, `ai_rate_limit_rpm`; recalculates `listings.canonical_niche` when `niche_rules_json` changes.
  - `GET/PATCH /api/agency/members` (`requireOperator(req, ["ADMIN"])`): updates `role`, `commission_split_pct`, `is_active`.
  - `GET /api/export/commissions?from=&to=` (`ADMIN` all agency won/negotiating leads; `BROKER` own `assigned_agent_id`; `SMM -> 403`): streams `text/csv; charset=utf-8` with UTF-8 BOM `\uFEFF`, columns `lead_id,client_name,phone_normalized,stage,agent_name,commission_pct,commission_split_pct,expected_broker_azn,expected_agency_azn,updated_at`, prefixes `[=+\-@\t\r]` cells with `'`, max 365 days / 10,000 rows.

- [ ] **Step 1: Add failing tests for CSV formula injection (`=CMD|...` -> `'=CMD|...`), `SMM` `403` export rejection, and `ADMIN`-only settings/member guards**

- [ ] **Step 2: Run Vitest to verify failure**

Run: `cd web && npm test -- __tests__/v2-p1-pagination-studio-export.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `/api/agency/settings`, `/api/agency/members`, `/api/export/commissions`, `/settings/page.tsx`, `SettingsClient.tsx`, and wire export button in `LeadsClient.tsx`**

- [ ] **Step 4: Run full Phase 2 Verification Checkpoint**

Run:
1. `cd web && npm test && npm run lint && npx tsc --noEmit && npm run build`
2. `python -m unittest discover -s tests -v`
Expected: Both exit `0` cleanly.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/agency/settings/route.ts web/app/api/agency/members/route.ts web/app/api/export/commissions/route.ts web/app/settings/page.tsx web/components/SettingsClient.tsx web/components/LeadsClient.tsx web/__tests__/v2-p1-pagination-studio-export.test.ts
git commit -m "feat(admin,export): add Admin agency settings/splits UI and formula-safe commission CSV export"
```
