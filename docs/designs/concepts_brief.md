# Social Lifecycle, Publication Tracking & Audience Intelligence

* **Author:** fxbluster
* **Date:** 2026-11-18
* **Status:** Synthesized Concept Brief (Post-Goldfish Multi-Lens Review)

## Overview

An expansion to BakuEstate-AI decoupling generated video drafts from published social media assets, introducing automated performance telemetry (views, likes, comments) for personal creator accounts on Instagram and TikTok, extracting buyer leads from inquiries in comments, and feeding engagement data back into video generation templates.

## Analysis & Goldfish Multi-Lens Synthesis

The concept underwent a 4-lens adversarial review across Contrarian/YAGNI (`egm-zoom-out`), Architecture & Security (`egm-design`), Codebase Integrity (`egm-codebase-details`), and TRIZ Contradiction Elimination (`egm-inventive-catalyst`). The resulting synthesis establishes five foundational architectural invariants:

### 1. The Publisher vs. Observer Decoupling (Anti-Ban Guarantee)
* **Contradiction Resolved (TRIZ #2 Extraction & #10 Cheap Dispensables):** The operator must publish natively via their personal/creator profile to capture maximum organic Reels/TikTok distribution. Custom background daemons must **NEVER** hold, store, or transmit the operator's personal session cookies (`sessionid`, `csrftoken`).
* **Mechanism:** The observation pipeline operates out-of-band via unauthenticated public URL inspection and rotating proxy workers. Because the ingestion layer never authenticates as the operator, the creator profile faces **zero account checkpoint, ban, or shadowban risk**.

### 2. 4-Phase Exponential Decay Telemetry with 7-Day Hard Freeze
* **YAGNI & Infrastructure Economics:** Indefinite polling of past posts produces cumulative scrape debt (100+ videos = 300–900 scrapes/day). Social video engagement exhibits an exponential decay: 90–95% of views and high-intent buyer inquiries arrive within the first 72 to 120 hours.
* **Bounded Ingestion Lifecycle (Max 11 lifetime polls per video):**
  * **Phase 1: Velocity Phase (Hours 0–24 post-publish):** 3 polls (T+4h, T+12h, T+24h) to catch viral breakouts.
  * **Phase 2: Consolidation Phase (Hours 24–72 post-publish):** 2 polls daily (every 12h). T+48h snapshot permanently records benchmark for A/B scoring.
  * **Phase 3: Tail Phase (Hours 72–168 / Days 4–7):** 1 poll daily to capture lingering comments.
  * **Phase 4: Telemetry Freeze (> 168 hours / Day 7+):** `telemetry_status` transitions to `'FROZEN'`. Automated background polling terminates permanently.
  * **On-Demand Manual Refresh:** Enforced cooldown in Web CRM (max 1 manual poll every 6 hours per listing).
* **Circuit Breaker:** If 2 consecutive polls return HTTP 429 or CAPTCHA blocks, trip the breaker for 4 hours, defer active queue jobs, and dispatch an informational Telegram SRE alert.

### 3. Two-Tier Zero-Token Regex to Structured LLM Comment Ingestion
* **Cost & Token Economics:** Passing every comment directly to an LLM incurs unbounded token spend and high false-positive noise from emojis and friend tags.
* **Pipeline:**
  * **Tier 1 (Deterministic Zero-Token Heuristic Filter):** Discard comments < 3 characters or emoji-only. Match Azerbaijani property inquiry markers (`qiymət`, `neçəyə`, `hardadır`, `ünvan`, `kredit`, `ipoteka`, `nömrə`, `əlaqə`, `wp`, `whatsapp`, `050`, `055`, `070`, `071`, `077`, `099`, `010`). Rejects 85–90% of noise at $0 cost and < 1ms.
  * **Tier 2 (Targeted Gemini Flash Structured Extraction):** Only Tier-1 matches pass to `gemini-2.5-flash` with a strict JSON schema (`intent_category`, `confidence_score`, `suggested_dm_reply_az`).
  * **Idempotency:** Track processed comments in `public.social_comments (publication_id, platform_comment_id UNIQUE)`.

### 4. 1-Tap Universal DM Deep-Link & Telegram Lead Alert
* **Preliminary Action (TRIZ #3):** Comments lack phone numbers (handles only, e.g. `@aygun_m`). Telegram card delivers:
  * Inquiry context (listing bina_id, location, price, comment text).
  * Pre-composed Azerbaijani direct response.
  * Direct action link: `https://ig.me/m/{commenter_handle}` (or native `instagram://direct_v2?username={commenter_handle}`).
  * Single tap opens Instagram DM with the commenter; operator pastes and sends in 2 seconds.
  * Lead immediately registers in `public.buyer_leads (source_channel='IG_DM')` linked to `listings` via `lead_listings`, with a 30-minute high-priority `follow_up_tasks` item.

### 5. Conversion Density Normalization (A/B Learning Loop)
* **Statistical Rigor:** On low-frequency posting schedules (1–5 posts/day), raw view counts are dominated by algorithmic timing noise (e.g. Sunday evening vs Tuesday morning).
* **Formula:** Prompt generation weights are tuned based on Normalized Engagement Ratio (NER) rather than absolute views:
  $$\text{NER} = \left(\frac{\text{Views}_{48h}}{\text{Median Views}_{\text{archetype}}}\right) \times 0.6 + \left(\frac{\text{Qualified Buyer Leads}_{48h}}{\max(1, \text{Comments}_{48h})}\right) \times 0.4$$
* **Variables Tested:** Hook archetype (`PRICE_FIRST` vs `LOCATION_FIRST`) and Duration bucket (`SHORT_25_30` vs `LONG_40_50`), tagged directly on `render_versions`.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Clean UI separation in Web CRM (`/listings` tabs: All, Ready Drafts, Live Published).
  * Telegram `/published <bina_id> <url>` command and interactive publish callback.
  * Public post telemetry ingestion with 4-phase decay lifecycle and circuit breaker.
  * Two-tier regex + LLM comment-to-lead pipeline populating `buyer_leads` and `follow_up_tasks`.
  * Dedicated `/analytics` dashboard in Web CRM and `AppShell.tsx` navigation.
  * Dual-axis A/B metadata tracking on `render_versions`.
* **Out-of-Scope Non-Goals:**
  * Automated headless posting directly to Instagram/TikTok without human-in-the-loop (rejected to preserve organic reach and avoid account bans).
  * Automated outgoing bot DMs directly inside Instagram (violates Meta Terms of Service).
  * Complex multi-platform paid ad spend tracking.

## Alternatives Weighed

* **Using Operator's Personal Session Cookies for Scraping:**
  * *Rejected by egm-design & egm-inventive-catalyst:* Triggers Meta account checkpoints, shadowbans Reels organic distribution, and contaminates the operator's home IP.
* **Indefinite 2-3x Daily Polling:**
  * *Rejected by egm-zoom-out & egm-design:* Causes unbounded scrape job accumulation (300–900 jobs/day within months). Replaced by a 7-day hard freeze (11 total lifetime scrapes per post).
* **Creating a Separate `social_leads` Table:**
  * *Rejected by egm-codebase-details:* The existing `buyer_leads` schema natively supports `source_channel='IG_DM'`, `social_handle`, and `lead_listings`. Reusing existing tables avoids architectural duplication.

## Key Decisions & Staging for Next Steps

1. **Database Migration (`202611190001_social_lifecycle.sql`):**
   * Add telemetry columns (`views_count`, `likes_count`, `comments_count`, `telemetry_status`, `last_scraped_at`) to `public.publications`.
   * Add `hook_type`, `duration_bucket`, `ab_metadata` to `public.render_versions`.
   * Create `public.social_comments` and `public.publication_telemetry_snapshots` tables.
2. **Telegram & Queue Ingestion:**
   * Implement `/published` command and `ask_puburl` callback in `telegram-webhook/index.ts`.
   * Add `SYNC_SOCIAL_METRICS` job handler to `local_worker.py` with 4-hour circuit breaker.
3. **Web CRM Updates:**
   * Add segmented tabs to `/listings` (`[Bütün Elanlar]`, `[Qaralamalar]`, `[Paylaşılanlar]`).
   * Create `/analytics` page and link in `AppShell.tsx`.
