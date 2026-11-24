# Left Canvas Stage Cards, Sizing & Real Analytics Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Left Canvas Stage card switching so clicking "Analitikaya Bax" opens the telemetry card while Video is active, add draggable/selectable canvas sizing controls ("boyunu ayarlamaq / sürüşdürmək") with backdrop isolation against Cockpit HUD bleed, fix VideoPipelineCard layout proportions, and replace hardcoded demo telemetry with live Supabase data and real property metrics.

**Architecture:** Update `copilot-context.tsx` stage card deduplication to distinguish card types; add backdrop panel and width presets/resize controls to `LeftCanvasStage.tsx`; fix layout and maximize scaling in `VideoPipelineCard.tsx`; wire `AnalyticsTelemetryCard.tsx` to live Supabase tables (`listings`, `publications`, `publication_telemetry_snapshots`, `buyer_leads`) with pre-publication market telemetry for newly rendered listings.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, Lucide React, Supabase Client (`@supabase/ssr`), Vitest, Testing Library.

**Spec:** User feedback on card switching collision, card resizing limitations, background Cockpit HUD bleed, and demo-only analytics data.

## Global Constraints
- Primary Model: `gemini-3.8-flash-high`.
- Zero-Glazing: Every fix must be verified with real command outputs and test runs before asserting completion.
- Backward Compatibility: Maintain compatibility with all existing Vitest tests in `web/tests/hub/left-canvas-stage.test.tsx`.
- Dark Mode Obsidian Aesthetic: Maintain obsidian-950/900 palette with gold/amber/slate styling.

## Review Focus
1. Opening `ANALYTICS_TELEMETRY` when `VIDEO_INSPECTION` is active for the same listing ID must create/switch to the analytics card and show its tab without replacing or dropping the video card.
2. Clicking `Böyüt` or switching width presets must dynamically adjust the card container and scale the video and SVG chart rather than remaining fixed at 460px/260px.
3. Background page text (such as `CockpitCardHUD`) must not bleed through the Left Canvas Stage tab header.
4. When a listing has no publication logs yet (e.g., Elan #6588858 freshly rendered), `AnalyticsTelemetryCard` must display real listing specs, Yasamal market benchmark, targeted channel, and pre-publish forecast rather than static fake November numbers.
5. All 87+ Vitest tests must pass and `npm run build` must succeed with zero TypeScript errors.

---

### Task 1: Fix Stage Card Deduplication and Action Pill Routing in Copilot Context

**Files:**
- Modify: `web/lib/copilot-context.tsx`
- Modify: `web/components/hub/ChatMessageItem.tsx`
- Test: `web/tests/hub/left-canvas-stage.test.tsx`

**Interfaces:**
- Consumes: `openStageCard(cardInput: OpenStageCardInput)`
- Produces: Type-safe multi-card stage state where distinct `cardType`s for the same entity exist as separate tabs.

- [ ] **Step 1: Write failing test in `left-canvas-stage.test.tsx` verifying Video and Analytics cards co-exist for same entity**
- [ ] **Step 2: Run Vitest to verify test failure**
- [ ] **Step 3: Update `openStageCard` in `copilot-context.tsx` so deduplication matches on `id` or `(c.cardType === cardInput.cardType && c.targetEntityId === targetEntityId)`**
- [ ] **Step 4: Update `ChatMessageItem.tsx` so `handleOpenStage` passes `listingId` for `ANALYTICS_TELEMETRY` cards**
- [ ] **Step 5: Run Vitest to verify the test passes**
- [ ] **Step 6: Commit changes**

---

### Task 2: LeftCanvasStage Backdrop Isolation, Responsive Layout & Sizing Controls

**Files:**
- Modify: `web/components/hub/LeftCanvasStage.tsx`
- Modify: `web/components/hub/stage/VideoPipelineCard.tsx`
- Test: `web/tests/hub/left-canvas-stage.test.tsx`

**Interfaces:**
- Consumes: `stageViewMode`, `stageCards`, `activeStageCardId`
- Produces: Width presets (`Kompakt`, `Standart`, `Geniş`, `Tam Ekran`), backdrop overlay preventing HUD text bleed, and balanced card layout.

- [ ] **Step 1: Add backdrop styling (`bg-obsidian-950/85 backdrop-blur-md border-r border-slate-800/80 shadow-2xl`) to `LeftCanvasStage`**
- [ ] **Step 2: Add width preset selector in `LeftCanvasStage` header (520px, 840px, 100%) and responsive layout logic for single-card vs dual-card view**
- [ ] **Step 3: Update `VideoPipelineCard.tsx` to respect `isMaximized` and scale video player up to 600px when maximized**
- [ ] **Step 4: Run Vitest to verify LeftCanvasStage tests pass**
- [ ] **Step 5: Commit changes**

---

### Task 3: Replace Demo Analytics with Live Supabase Data and Real Market Benchmarks

**Files:**
- Modify: `web/components/hub/stage/AnalyticsTelemetryCard.tsx`
- Test: `web/tests/hub/left-canvas-stage.test.tsx`

**Interfaces:**
- Consumes: Supabase `listings`, `publications`, `publication_telemetry_snapshots`, `buyer_leads`
- Produces: Live property metrics, pre-publish benchmark forecast for new renders, responsive SVG sparkline, and real channel targeting.

- [ ] **Step 1: Add Supabase client data fetcher in `AnalyticsTelemetryCard.tsx` for `targetEntityId` / `listingId`**
- [ ] **Step 2: Build Pre-Publish / Live Telemetry view using real listing pricing, m² normalization, and Yasamal/Nasimi market norms**
- [ ] **Step 3: Make the SVG Sparkline chart responsive (`viewBox="0 0 500 150"` and scaling) instead of fixed 460x140**
- [ ] **Step 4: Run Vitest to verify AnalyticsTelemetryCard mounts and displays real listing data**
- [ ] **Step 5: Commit changes**

---

### Task 4: Full Verification, Production Build & Vercel Deployment

**Files:**
- All modified files above

- [ ] **Step 1: Run full Vitest test suite (`npm test` in `web/`)**
- [ ] **Step 2: Run Next.js production build (`npm run build` in `web/`)**
- [ ] **Step 3: Deploy to Vercel production (`npx vercel --prod --yes`)**
- [ ] **Step 4: Verify deployment with `curl.exe -I https://bakuestate-ai.vercel.app/listings`**
