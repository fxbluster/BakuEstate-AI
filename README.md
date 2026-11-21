# BakuEstate-AI — 24/7 Real Estate Video Engine, Follow-Up & Web CRM

An autonomous Azerbaijani real estate media & CRM platform built on a **3-tier Cloud-First architecture**:
1. **Supabase Cloud Core** — Single source of truth (8 Postgres tables with strict RLS, versioned MP4 Storage CDN, 24/7 Telegram Webhook Edge Function, and `pg_cron` follow-up & storage-pruning dispatchers).
2. **24/7 Hosted Web CRM (`web/`)** — Mobile-responsive Next.js App Router + Supabase Auth panel accessible anytime, even when the Windows PC is powered off.
3. **Windows Local Render & Scrape Worker (`src/worker/local_worker.py`)** — Unified daemon polling `pipeline_jobs` via `FOR UPDATE SKIP LOCKED`, running `bina.az` scraping/liveness checks, TTS narration, and FFmpeg 9:16 vertical video rendering.

---

## Architecture Overview

```
Operator (Phone / Browser) ──► Next.js Web CRM (Anon Key + Supabase Auth + RLS) ──┐
Operator (Telegram Mobile) ◄──► Supabase Edge Function: telegram-webhook ─────────┼──► Supabase Postgres (8 Tables)
Supabase pg_cron (5m / daily) ─► followup-dispatcher & storage-pruner ────────────┤         ▲
                                                                                  │         │ Poll (10s) + Heartbeat (60s)
Windows PC (start_worker.bat) ─► src/worker/local_worker.py ──────────────────────┘         │
                                  ├── bina.az Scraper (pre-scrape skip + liveness)          │
                                  ├── ChangeDetector (AZN norm, repost score, Rejim 3)      │
                                  ├── TTS (ElevenLabs / OpenAI / Edge, versioned audio)     │
                                  ├── FFmpeg 1080x1920 Video (video_{bina_id}_v{n}.mp4)     │
                                  └── Versioned Storage Upload + Idempotent Telegram Send ──┘
```

### Core Capabilities
- **Zero-Duplicate Ingestion & Repost Scoring:** Pre-scrape `known_bina_ids` filtering prevents page-1 starvation. Reposts under a new `bina_id` are scored null-safely (`owner_phone_normalized` + `district` + `rooms` + `area ±3%` + `floor`; empty phone never auto-blocks; score `>= 0.85` flags `PENDING_REVIEW` in the Web CRM).
- **Rejim 3 Price-Drop Auto-Rerender (`>= 5%` AZN):** Normalizes USD/EUR/AZN into `price_azn_normalized` to eliminate fake currency-switch drops. Auto-enqueues `RENDER_PRICE_DROP` only when all 4 guardrails pass: `editorial_status` active, `source_availability = 'ACTIVE'`, `owner_outreach_status` not `OWNER_SOLD`/`REFUSED_AGENT`, and within 24h cooldown + daily budget (`DAILY_AUTO_RENDER_LIMIT=5`).
- **Versioned Videos & Idempotent Telegram Delivery:** Outputs `data/output/video_{bina_id}_v{n}.mp4` and uploads to `videos/{bina_id}/v{n}.mp4`. Prior `render_versions` are marked `SUPERSEDED` (never overwritten). `telegram_message_id` is persisted immediately after `sendVideo`; re-renders update the existing Telegram message in-place via `editMessageMedia`.
- **24/7 Follow-Up & Mobile CRM:** `/lead` and `/today` commands + inline callbacks run 24/7 on Supabase Edge Functions. `followup-dispatcher` enforces Baku quiet hours (`21:30–09:00 UTC+4`), sends a `09:30` morning digest for normal tasks, and pings immediately for `HIGH` priority tasks.
- **Security Hardening:** Zero hardcoded keys in source code, RLS enabled on all 8 Postgres tables, Telegram Webhook requires `X-Telegram-Bot-Api-Secret-Token` + `TELEGRAM_CHAT_ID`, and local `telegram_bot_service.py` enforces strict `chat_id` verification with zero `os.environ` mutation. Active Notion sync is deprecated and disabled by default (`NOTION_LEGACY_SYNC=true` to opt in).

---

## Project Structure

```
BakuEstate-AI/
├── config/settings.py                # Env-only config, currency rates, Rejim 3 guardrails
├── supabase/
│   ├── migrations/
│   │   ├── 202611180001_crm_core_schema.sql      # 8 tables, constraints, indexes, strict RLS
│   │   └── 202611180002_worker_rpc_and_cron.sql  # claim/heartbeat/quota RPCs & pg_cron jobs
│   └── functions/
│       ├── telegram-webhook/index.ts             # 24/7 Bot API webhook (/lead, /today, callbacks)
│       ├── followup-dispatcher/index.ts          # Baku UTC+4 reminder & morning digest dispatcher
│       └── storage-pruner/index.ts               # 14-day SUPERSEDED/ARCHIVED MP4 pruner
├── web/                              # 24/7 Next.js App Router Web CRM (Vercel-ready)
│   ├── middleware.ts                 # Supabase Auth route guard
│   └── app/                          # /login, /, /listings, /listings/[bina_id], /leads, /jobs
├── src/
│   ├── cloud/supabase_repo.py        # Supabase Postgres REST/RPC & versioned Storage repo
│   ├── dedup/change_detector.py      # Currency norm, photo hash, repost scoring, Rejim 3 guardrails
│   ├── scraper/bina_scraper.py       # Pre-scrape skip, photo hash refresh, 404/429 liveness check
│   ├── media/                        # Versioned TTS (explicit engine/voice/angle) & FFmpeg compositor
│   ├── worker/local_worker.py        # Unified Windows worker daemon (10s poll + 60s heartbeat)
│   ├── dispatcher/
│   │   ├── telegram_crm.py           # Telegram video dispatch & captions
│   │   ├── telegram_bot_service.py   # Local dev/fallback bot (strict chat_id auth, thread-safe)
│   │   ├── supabase_sync.py          # Legacy-compatible Supabase sync adapter
│   │   └── notion_crm.py             # [DEPRECATED] Disabled unless NOTION_LEGACY_SYNC=true
│   └── database.py                   # Local SQLite fallback (USE_CLOUD_BACKEND=false)
├── scripts/
│   └── migrate_sqlite_to_supabase.py # Idempotent one-time SQLite -> Postgres migration
├── run_pipeline.py                   # End-to-end orchestrator (cloud + SQLite fallback)
├── start_worker.bat                  # 1-click Windows Local Worker launcher
└── tests/                            # Full unit & integration test suite
```

---

## Setup & Deployment Steps

### 1. Environment & Key Security
Copy `.env.example` to `.env` and populate your credentials (rotate any previously exposed Supabase `service_role` key in the Supabase Dashboard first):
```env
USE_CLOUD_BACKEND=true
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<rotated-service-role-key>
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_BUCKET=baku-estate-media

TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_CHAT_ID=<operator-chat-id>
TELEGRAM_WEBHOOK_SECRET=<random-secret-token>
TELEGRAM_MOCK_DISPATCH=false

# Rejim 3 Guardrails & Worker
USD_TO_AZN_RATE=1.70
EUR_TO_AZN_RATE=1.85
PRICE_DROP_TRIGGER_PCT=5.0
DAILY_AUTO_RENDER_LIMIT=5
AUTO_RENDER_COOLDOWN_HOURS=24
AUTO_JOB_TTL_HOURS=24
STORAGE_PRUNE_DAYS=14
WORKER_ID=windows-local-worker
```

### 2. Supabase Schema, RLS & Edge Functions
1. Apply `supabase/migrations/202611180001_crm_core_schema.sql` and `supabase/migrations/202611180002_worker_rpc_and_cron.sql` in Supabase (configure your operator Auth UUID for RLS policies).
2. Deploy Edge Functions (`telegram-webhook`, `followup-dispatcher`, `storage-pruner`) and set Supabase Edge Function secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`).
3. Register the Telegram webhook with your secret token:
   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d "url=https://<project-ref>.supabase.co/functions/v1/telegram-webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```

### 3. One-Time SQLite Migration
Preview first with `--dry-run`, then run live:
```bash
python scripts/migrate_sqlite_to_supabase.py --dry-run
python scripts/migrate_sqlite_to_supabase.py
```

### 4. Deploy / Run the 24/7 Web CRM (`web/`)
Configure `web/.env.local` (or Vercel Environment Variables) using **only** the public anon key (never `service_role`):
```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
```
Run locally or build for production:
```bash
cd web
npm install
npm run build
npm run dev
```

### 5. Launch the Windows Local Worker
Double-click `start_worker.bat` or run via CLI:
```cmd
start_worker.bat
```
Optional CLI flags for `src/worker/local_worker.py`:
- `--poll-interval 10` — Seconds between `claim_next_pipeline_job()` polls (default `10`).
- `--heartbeat-interval 60` — Lease heartbeat renewal interval in seconds (default `60`).
- `--scrape-times 12:30,19:30` — Periodic Baku daily times to enqueue `SCRAPE_NEW` jobs.
- `--liveness-interval-hours 12` — Hours between periodic `LIVENESS_CHECK` job enqueues.
- `--once` — Claim and execute at most one job, then exit.

### 6. Direct Pipeline CLI & Local SQLite Rollback
To run a single pipeline pass directly:
```bash
python run_pipeline.py --pages 1 --limit 1 --live-dispatch
```
To temporarily roll back to local SQLite mode without Supabase Cloud:
```bash
set USE_CLOUD_BACKEND=false
python run_pipeline.py --pages 1 --limit 1
```

---

## Running Automated Tests

Python test suite:
```bash
python -m unittest discover -s tests
```
Web CRM build & lint check:
```bash
cd web
npm run lint
npm run build
```
