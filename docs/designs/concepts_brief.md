# BakuEstate-AI: Left-Canvas Interactive Action Stage & Tri-Persona Cognitive Copilot

* **Author:** Dəniz & Antigravity (EGM Architecture & Ideation Squad)
* **Date:** 2026-11-22
* **Status:** Synthesized Concept Brief (Goldfish Multi-Lens Audit Complete)

---

## Overview

The Executive Agent Hub is being re-architected from a passive, text-heavy chat drawer into an active **Operational Co-Pilot and Action Cockpit**.

Instead of generating synthetic busywork (such as an AI persona pretending to draft video scripts when the backend Python FFmpeg pipeline already scrapes, synthesizes ElevenLabs neural audio, and renders ready MP4 videos automatically), the AI Hub directly orchestrates operational decisions across existing platform primitives.

This architecture introduces two primary shifts:
1. **Left-Canvas Action Stage (Split-View Cockpit):**
   When the AI Drawer opens on the right side of the screen (`max-w-xl` to `max-w-2xl`, ~560–640px), the wide viewport on the left transforms into an active, interactive **Action Stage** (`LeftCanvasStage.tsx`). The layout transitions to a unified `fixed inset-0 z-50 flex` container, eliminating backdrop click interception. Contextual operational cards render directly on the left canvas without page reloads or context loss:
   - **Video Inspection & Pipeline Card:** Plays the rendered MP4 video, displays listing specs and niche badges, and features a 1-click `[ ✈️ Teleqramıma Göndər ]` trigger. For unrendered listings, it displays scraped property photos and metadata with a 1-click `[ 🚀 Montaj Boru Xəttinə Göndər ]` trigger inserting directly into `pipeline_jobs`.
   - **Niche & Account Analytics Card:** Renders 14-day view trajectories, ER% vs niche median, and cross-channel performance for `@bakuestate.premium`, `@baku.serfeli.evler`, `@bakuestate.official`, and `@baku_emlak_ai`.
   - **Müştəri Danışıqları & Baku Realism Card:** Displays WhatsApp inquiry history, autonomously extracts objection patterns into staged confirmation pills, and drafts authentic Azerbaijani responses with a 1-click `[ 💬 WhatsApp-da Aç ]` launcher.
2. **Tri-Persona Cognitive Specialization (Zero Memory Contamination):**
   Consolidates previous council personas (`mudir`, `farabi`, `usta`, `teymur`) into three strictly separated cognitive domains to prevent prompt bloat and memory confusion:
   - **Müdir (Chief of Staff & Brifinq):** Daily operational triage ("Vəziyyət necədir?"), video backlog status, listing recommendations, macro broker relationship guidance.
   - **Analitika & Sosial Media (Account & Video Performance):** Deep statistical analysis of view counts, retention curves, viral hooks, and multi-account performance.
   - **Müştəri & Danışıq Psixologiyası (Baku CRM Realism & Lead Memory):** Dedicated to decoding Baku buyer psychology, objection learning (why leads ghost, refuse deposits, or distrust brokers), and formulating warm, natural Azerbaijani negotiations without corporate stiffness.

---

## Analysis

### 1. Contrarian / YAGNI & Codebase Reality Check
* **Elimination of Synthetic Scriptwriting:**
  In BakuEstate-AI, video scripts, ElevenLabs neural voiceover, and kinetic subtitles are compiled deterministically by `src/media/script_generator.py` and `src/media/ffmpeg_compositor.py`. Frontend scriptwriting personas are redundant. The AI serves as an operational inspector, evaluator, and dispatcher.
* **Reuse Over Reinvention:**
  - **Pipeline Triggering:** Enqueueing render jobs does not require new backend APIs. It reuses the exact pattern in [ListingDetailClient.tsx](file:///C:/Users/HP/BakuEstate-AI/web/components/ListingDetailClient.tsx#L170-L192) by inserting directly into `public.pipeline_jobs` with `job_type: 'RENDER_INITIAL'`, picked up by `src/worker/local_worker.py`.
  - **Baku Realism Guardrails:** Linguistic guardrails already exist in [agent-personas.ts](file:///C:/Users/HP/BakuEstate-AI/web/lib/agent-personas.ts#L43-L70) (`ANTI_ROBOTIC_FORBIDDEN_PHRASES`, `checkForbiddenPhrases`). These will be strictly enforced in system prompts.

### 2. Spatial Ergonomics & DOM Architecture (Solving Backdrop Interception)
* **Root Layout Transition:**
  [AgentHubDrawer.tsx](file:///C:/Users/HP/BakuEstate-AI/web/components/hub/AgentHubDrawer.tsx) currently uses a full-screen overlay backdrop (`fixed inset-0 bg-black/70`) with `onClick={closeCopilot}`, which blocks and intercepts clicks on any left-side elements.
  *Fix:* Transition the drawer container to a root flex layout:
  ```tsx
  <div className="fixed inset-0 z-50 flex overflow-hidden">
    {/* Left Canvas Action Stage: flex-1 */}
    <div className="flex-1 min-w-0 h-full relative overflow-y-auto">
      <LeftCanvasStage cards={activeCards} onClose={dismissCard} />
    </div>
    {/* Right Control Room Drawer: fixed width */}
    <div className="w-full sm:w-[540px] lg:w-[620px] h-full flex flex-col bg-obsidian-950 border-l border-slate-800 shadow-2xl">
      {/* Persona Rooms & ChatStream */}
    </div>
  </div>
  ```
* **Responsive Viewport Matrix:**
  - **Desktop ($\ge 1440\text{px}$):** Supports up to 2 cards side-by-side or Stage-Maximized mode with `X` dismiss.
  - **Compact Laptops ($1024\text{px} - 1439\text{px}$):** Enforces Single-Card Focus Mode (`min-w-[480px]`) to prevent visual clipping.
  - **Mobile / Tablets ($< 1024\text{px}$):** Cards render as modal bottom sheets (`z-60`) or horizontal swipeable decks, preserving chat continuity without screen lock.

### 3. Telegram Transport Architecture & SRE Telemetry
* **Solving the 20MB/50MB Serverless Bottleneck (TRIZ Extraction):**
  Vertical 1080×1920 MP4 video files average 25MB–55MB. Streaming binary video through Next.js serverless route handlers causes 10s–15s timeouts, and Telegram Bot API limits direct URL dispatch (`sendVideo { video: url }`) to 20MB.
  *Architecture:*
  - If video size $\le 20\text{MB}$: Route `/api/telegram/dispatch-video` sends the Supabase Storage CDN URL directly to Telegram Bot API `sendVideo` (execution time $< 800\text{ms}$).
  - If video size $> 20\text{MB}$: The route enqueues a `TELEGRAM_DISPATCH` job into `pipeline_jobs`, where the background daemon (`src/dispatcher/telegram_crm.py`) uploads the file via multipart stream without serverless timeout constraints.
  - Returns cached `file_id` for instantaneous future dispatches.
* **Button Idempotency & Error Telemetry:**
  - Dispatch button enforces an instant client-side disabled state: `[ ✈️ Göndərilir... ]` with a 15-second cooldown.
  - Logs execution results to `public.listing_events` to provide SRE traceability during production incidents.

### 4. Database Schema Alignment & Constraint Migrations
* **Postgres CHECK Constraint Updates:**
  Live schema inspection proved that `public.agent_conversations` and `public.agent_learned_insights` restrict `agent_id` to `['mudir', 'farabi', 'teymur', 'usta']`.
  *Migration `202611220001_tri_persona_and_timeline_constraints.sql`:*
  1. Update `agent_id` CHECK constraint on both tables to include `'analitika'` and `'musteri_psixologiyasi'`.
  2. Map historical insights:
     - `farabi` + `usta` $\rightarrow$ `musteri_psixologiyasi`
     - `teymur` $\rightarrow$ `analitika`
  3. Fix `public.lead_timeline_events` check constraints: add `AI_HUB` / `STAGE_CHANGE` (currently failing silently in `ActionCardView.tsx:81`).

### 5. Autonomous Objection Learning with Human-in-the-Loop Safety
* **Eliminating Memory Contamination:**
  Autonomous LLM insertion directly into database tables inevitably causes hallucinated objections and dirty data.
  *Design Pattern:* **Optimistic Staged Extraction with 1-Click Commitment:**
  1. When an operator pastes or discusses buyer feedback in `Müştəri Psixologiyası`, Gemini autonomously extracts the objection category (e.g. `OBJECTION_PRICE_PER_M2`, `OBJECTION_LOCATION`, `OBJECTION_KUPCA`).
  2. The Left-Canvas CRM card renders an ephemeral badge: `[ 🏷️ Çıxarılmış İmtina: Qiymət Rezistansı ✕ ]`.
  3. The insight is only permanently committed to `agent_learned_insights` when the operator clicks `[ 💾 Təsdiqlə və Yaddaşa Yaz ]` (or proceeds to `[ 💬 WhatsApp-da Aç ]`). Tapping `✕` discards the entry.
* **Episodic Scope Partitioning:**
  All records in `agent_learned_insights` enforce strict domain tagging (`persona_scope: 'crm' | 'analytics' | 'general'`) so negotiation objections never bloat or contaminate the system prompts of `Analitika` or `Müdir`.

---

## Goals vs. Non-Goals

### In-Scope Goals
* **LeftCanvasStage Component:** Decoupled container in `web/components/hub/LeftCanvasStage.tsx` with responsive docked, side-by-side, and stage-maximized states.
* **Tri-Persona Engine:** Persona configuration in `agent-personas.ts` and `copilot/route.ts` for `mudir`, `analitika`, and `musteri_psixologiyasi`.
* **Database Migration:** SQL migration script updating `agent_id` CHECK constraints, mapping historical insights, and fixing `lead_timeline_events` constraints.
* **Telegram Video Dispatch Endpoint:** Next.js route `web/app/api/telegram/dispatch-video/route.ts` with file size routing ($\le 20\text{MB}$ via URL, $> 20\text{MB}$ via pipeline queue).
* **Unrendered Pipeline Trigger:** Direct insertion into `public.pipeline_jobs` (`job_type: 'RENDER_INITIAL'`) from the Left-Canvas card.
* **Baku Realism Prompt Engine:** System prompt grounding for `Müştəri Psixologiyası` enforcing authentic Baku terminology and suppressing corporate filler phrases.

### Out-of-Scope Non-Goals
* **Unattended Direct Publishing:** Direct unattended posting to Instagram/TikTok via automated API bots remains strictly out-of-scope to eliminate account suspension hazards.
* **Browser-Side Video Compositing:** All video rendering remains on the Python FFmpeg backend; the frontend card acts purely as an inspector and dispatcher.
* **Full CRM Overhaul:** Existing CRM tables (`buyer_leads`, `lead_timeline_events`, `agent_learned_insights`) are reused without disrupting current database schemas.

---

## Alternatives Weighed

1. **Reinventing a Complex Windowing OS on the Left Canvas:**
   - *Rejected by Zoom-Out Auditor & Author:* Attempting arbitrary window dragging and resizing creates high frontend fragility. A constrained 2-mode system (Single-Card Focus on $< 1440\text{px}$, Dual-Card Side-by-Side on $\ge 1440\text{px}$) delivers 100% of the operational value with zero windowing complexity.
2. **Uploading Raw MP4 Blobs Through Next.js Serverless Routes:**
   - *Rejected by Design & Inventive Auditors:* Multi-megabyte binary uploads cause 504 timeouts and exceed Vercel/Netlify payload limits. URL-based dispatch for files $\le 20\text{MB}$ and background worker queueing for files $> 20\text{MB}$ eliminates runtime memory bottlenecks.
3. **Unsupervised Background Database Insertion for Objections:**
   - *Rejected by All Auditors:* Fully unattended insertion pollutes episodic memory with conversational noise. Ephemeral staged cards with 1-click operator confirmation maintain 100% memory integrity.

---

## Key Decisions & Staging for Next Steps

* **Decision 1 (DOM & Spatial):** Root flex cockpit overlay (`fixed inset-0 flex`) with `LeftCanvasStage.tsx` on the left and responsive drawer ($540–620\text{px}$) on the right.
* **Decision 2 (Database Migration):** Run migration `202611220001_tri_persona_and_timeline_constraints.sql` before deploying frontend persona updates to prevent Postgres 23514 check errors.
* **Decision 3 (Telegram Pipeline):** Implement `POST /api/telegram/dispatch-video` with signed CDN URLs ($\le 20\text{MB}$) and `pipeline_jobs` queueing fallback ($> 20\text{MB}$).
* **Decision 4 (Autonomous Learning):** Ephemeral staged objection badges with 1-click confirmation (`[ 💾 Təsdiqlə və Yaddaşa Yaz ]`).
* **Staging:** Brainstorm phase complete. Proceed directly to `/egm-draft` to author the formal Technical Design Document.