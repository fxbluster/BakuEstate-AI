# Floating Draggable Window Cards & Truthful Telemetry Architecture

*   **Author:** fxbluster
*   **Status:** Approved / Implementing
*   **Date:** 2026-11-24

--------------------------------------------------------------------------------

## Overview

This design refactors BakuEstate-AI's stage card presentation from a rigid, full-height docked left sidebar into an **Autonomous Floating Window Card System**. Instead of locking cards into an artificial full-viewport pane with static preset width buttons (`560px`, `860px`), cards float independently across the canvas. Operators can drag cards anywhere across the screen by their header, freely resize them from corners/edges, stack them with automatic z-index elevation on click, and dismiss them cleanly.

Additionally, this design addresses the specific visual and runtime defects identified in live operations:
1. Decouples stage cards from the AI chat drawer lifecycle, mounting them as a top-level viewport portal so cards remain visible and unclipped regardless of drawer state.
2. Re-engineers `VideoPipelineCard` into an adaptive content-hugged geometry: a compact 2-column horizontal layout for rendered 9:16 videos, and a stacked layout for unrendered 16:9 photo galleries, eliminating excessive vertical whitespace.
3. Centralizes runtime error parsing into a shared utility (`web/lib/errors.ts`) that safely extracts message, details, and hints from PostgREST/Supabase objects, preventing `[object Object]` and raw JSON leaks.
4. Eliminates all synthetic demo metrics in `AnalyticsTelemetryCard`, replacing them with an authentic pre-publish dossier powered by dynamic district benchmarks (`web/lib/market-benchmarks.ts`) and filtered CRM leads, while gating historical curves strictly behind verified Supabase snapshots.
5. Resolves badge overlap collisions on listing card headers in `ListingsClient.tsx` using a structured two-row layout.
6. Refactors `PreflightModal.tsx` error categorization so that cloud IP blocks (`SCRAPE_ERROR`) transition into an actionable amber `SCRAPE_FALLBACK_PROMPT` state rather than a dead-end red error box, utilizing the existing database price fallback path.

--------------------------------------------------------------------------------

## The Problem

1. **Rigid Docked Sidebar vs. Floating Cards**: The current `LeftCanvasStage` mounts inside `AgentHubDrawer.tsx`. Because the drawer root container enforces `${isOpen ? "visible opacity-100" : "invisible opacity-0"}`, closing the AI chat drawer instantly hides all open stage cards. Furthermore, the stage container has `flex-1 min-w-0 h-full overflow-hidden`, which clips any card dragged towards the center/right of the screen at the 620px drawer boundary.
2. **Artificial Sizing vs. Drag-to-Resize**: Previous preset buttons (`560px`, `860px`) fail to provide authentic window management. Operators expect standard desktop-grade floating cards that can be dragged freely and resized smoothly via edge/corner handles, with boundary clamping that survives window resize and mobile viewports.
3. **Card Layout & Empty Space**: In `VideoPipelineCard`, the 9:16 video player is isolated next to a sparse specs column that stretches to fill the viewport, resulting in awkward vertical dead zones between specs and action buttons. Furthermore, unrendered cards rendering 16:9 landscape photo galleries require a different geometry than 9:16 portrait players.
4. **`[object Object]` Rendering Defect**: When the video render queue API or client fetch encounters an object-shaped error or non-Error exception, string coercion evaluates to `"[object Object]"` instead of extracting `.message`, `.details`, or `.hint`.
5. **Synthetic Demo Telemetry & Hardcoded Corridors**: `AnalyticsTelemetryCard` renders fabricated historical dates (e.g. November 10–23) and synthetic view counts (22,400) even when an elan has never been published to social media. It also hardcodes Yasamal normative corridors (2,200–2,800 AZN/m²) for all listings regardless of district, and queries unfiltered buyer leads.
6. **Card Header Badge Collision**: On listing cards in `ListingsClient.tsx`, 5 badges (`#id`, `@handle`, archetype, `Kupça`, and `v3 • Hazır`) are crammed into a single top row, causing `v3 • Hazır` to visually collide with and overlap adjacent badges on standard desktop resolutions.
7. **Preflight Scrape UX Categorization**: When `bina.az` blocks direct HTTP requests from cloud serverless functions (Vercel IP geoblock), the API returns status 502 with `reason: "SCRAPE_ERROR"`. `PreflightModal.tsx` categorizes this as a fatal red error (`statusState = "ERROR"`), obscuring the existing database price fallback button and confusing operators.

--------------------------------------------------------------------------------

## Goals

*   **Decoupled Floating Window Architecture**: Independent cards float over the entire dashboard with draggable header bars, freely resizable corner/edge handles, and active z-index management, mounted at the root dashboard level independently of the AI chat drawer.
*   **Adaptive Content-Hugged Geometry**: Cards size tightly to their actual content without stretching to 100% viewport height, adapting between rendered 9:16 video playback and unrendered 16:9 photo ingestion.
*   **Single-Owner Window Chrome**: `FloatingCardWindow` serves as the sole chrome owner; internal redundant headers in stage cards are stripped out.
*   **Robust Diagnostic Error Telemetry**: Safe extraction of `.message`, `.details`, and `.hint` via a shared `extractErrorMessage` utility, preventing `[object Object]` and raw JSON dumps.
*   **Truthful Telemetry with Dynamic District Benchmarks**: Complete elimination of simulated curves for unpublished listings. Clear "Sosial Yayım Gözləyir" status showing real listing economics, dynamic district corridors (`web/lib/market-benchmarks.ts`), and filtered CRM buyer demand, transitioning to historical curves only when verified publication snapshots exist in Supabase.
*   **Collision-Free Badges**: Clean two-row badge layout on listing cards with zero overlapping.
*   **Actionable Pre-Flight Fallback State**: Promote cloud scrape errors to a dedicated amber `SCRAPE_FALLBACK_PROMPT` state with active `[ 🛡️ Bazadakı Qiymətlə Göndər ]` confirmation.
*   **Multi-Card Stacking & Coordination**: Multiple cards can be open simultaneously at distinct screen positions without forced splitting or mutual eviction.
*   **Deterministic Test Suite**: Vitest unit test coverage for window drag/resize mechanics, boundary clamping, and error string extraction.

--------------------------------------------------------------------------------

## Non-Goals

*   Replacing the right-hand side `AI İcraçı Qərargahı` drawer (the chat console remains docked on the right).
*   Adding heavyweight external desktop windowing dependencies that increase bundle size.
*   Fabricating placeholder engagement data when third-party social APIs have not yet recorded views.

--------------------------------------------------------------------------------

## Critical User Journeys (CUJs)

### CUJ 1: Operator Opens & Positions Multiple Independent Floating Cards

*   **Given**: The operator is on `/listings` with the AI Cockpit open on the right.
*   **When**: The operator clicks `[🎬 Videoya Bax]` (from chat or card quick action) for Elan #6588858 and subsequently clicks `[📊 Analitikaya Bax]` for the same elan.
*   **Then**: 
    1. A floating Video window opens at an initial offset (`x: 48px, y: 72px`).
    2. A floating Telemetry window opens slightly offset (`x: 88px, y: 112px`).
    3. Both cards float freely above the listing grid; neither card occupies 100% screen height.
    4. Closing the right-hand AI Cockpit drawer does not hide or close the floating cards.
    5. The operator clicks and drags either card's header bar to place it anywhere on screen.
    6. Clicking a card brings it to the top (`z-index: 60`).

### CUJ 2: Freeform Corner Drag-to-Resize on Video Window

*   **Given**: A floating Video window is open with initial size `580px × 510px`.
*   **When**: The operator hovers over the bottom-right corner resize handle and drags outward to expand.
*   **Then**: The window expands smoothly; width clamps against `window.innerWidth - pos.x - 10`; the 9:16 player scales proportionally up to `340px × 604px`, and the specs column expands without jitter or dead space.

### CUJ 3: Truthful Pre-Publish Telemetry Inspection

*   **Given**: Elan #6588858 has been rendered (`v4`) but has not yet been published to Instagram or TikTok.
*   **When**: The operator opens the Telemetry window for Elan #6588858.
*   **Then**: 
    1. The window displays an explicit badge: `Sosial Yayım Gözləyir (Dərc Edilməyib)`.
    2. Zero fake views or fabricated past dates are shown.
    3. The card displays verified property fundamentals: real price (`226,000 AZN`), normalized m² rate (`2,379 AZN/m²`), dynamic Yasamal market benchmark (`2,200 - 2,800 AZN/m²`), targeted social account (`@baku.serfeli.evler`), and filtered CRM lead count.
    4. An action button `[ 🚀 Teleqrama Göndər və Dərc Et ]` enables immediate transition into publication.

### CUJ 4: Preflight Scrape Fallback Handling

*   **Given**: The operator clicks `Yoxla və Göndər` on Elan #6560444, and bina.az blocks direct Vercel datacenter HTTP requests (HTTP 502).
*   **When**: Preflight check returns `SCRAPE_ERROR` with `can_fallback_to_db: true`.
*   **Then**: 
    1. The modal does not dead-end in a generic red error box.
    2. It presents a dedicated amber prompt: `Bina.az portalı bulud IP-sini blokladı. Bazadakı təsdiqlənmiş qiymətlə (138,000 ₼) davam etmək istəyirsiniz?`.
    3. The operator clicks `[ 🛡️ Bazadakı Qiymətlə Göndər ]` to proceed directly to Telegram dispatch.

### CUJ 5: Sanitized Error Telemetry Display

*   **Given**: The operator triggers video rendering and the backend API returns an error object (e.g. PostgREST check constraint violation).
*   **When**: The error surfaces in `VideoPipelineCard`.
*   **Then**: The UI extracts `.message`, `.details`, and `.hint` into human-readable text; `[object Object]` or raw JSON strings never render.

### CUJ 6: Card Header Badge Layout on Compact Resolutions

*   **Given**: The operator views listing cards on a standard 1080p display with open sidebar.
*   **When**: An elan has all 5 status badges active (`#id`, `@handle`, `v3 • Hazır`, `Kupça`, Archetype).
*   **Then**: Badges render in a clean two-row flex container with zero overlapping, clipping, or thumbnail overflow.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. Window Host Architecture (`FloatingCardStage` & `FloatingCardWindow`)

`FloatingCardStage` is completely decoupled from `AgentHubDrawer.tsx`. It is mounted at the root dashboard level in `web/components/AppShell.tsx` as an independent full-viewport portal (`fixed inset-0 pointer-events-none z-40 overflow-hidden`), ensuring cards remain visible when the AI drawer is closed and are never clipped by sidebars.

```text
+------------------------------------------------------------------------------------+
|  Navbar / Header                                                                   |
+------------------------------------------------------------------------------------+
|                                                 |                                  |
|   +-----------------------+                     |                                  |
|   | Floating Video Window | (Draggable Header)  |                                  |
|   | [Video]  [Specs + CTA]| (Corner Resizable)  |   AI ICRAÇI QƏRARGHI (Docked)    |
|   +-----------------------+                     |                                  |
|                                                 |   - Chat Stream                  |
|          +----------------------------+         |   - Executive Council            |
|          | Floating Telemetry Window  |         |   - Action Buttons               |
|          | [Real Specs] [Pre-Publish] |         |                                  |
|          +----------------------------+         |                                  |
|                                                 |                                  |
|   (Underlying /listings grid fully visible)     |                                  |
+------------------------------------------------------------------------------------+
```

### 2. Standalone Pointer Draggable & Resizable Primitive (`useFloatingWindow`)

To avoid bloating bundle size or introducing flaky third-party libraries, we implement a battle-tested, high-performance HTML5 Pointer hook (`useFloatingWindow`):

*   **Dragging**:
    - Pointer listener on the header grab handle (`cursor-grab` / `active:cursor-grabbing`).
    - Uses `onPointerDown` with `element.setPointerCapture(e.pointerId)`.
    - Coordinates update in state: `pos = { x: clamp(x, 10, windowWidth - width - 10), y: clamp(y, 10, windowHeight - height - 10) }`.
    - Rendered via GPU-accelerated `transform: translate3d(${x}px, ${y}px, 0)`.
    - Sets `pointer-events-none select-none` on inner video/iframe elements during active drag to prevent event hijacking.
*   **Resizing**:
    - Dedicated resize handle on the bottom-right corner (`cursor-se-resize`) plus bottom/right edges.
    - Clamps width against `[minW, Math.min(maxW, windowWidth - posX - 10)]` and height against `[minH, Math.min(maxH, windowHeight - posY - 10)]`.
*   **Window Resize Re-Clamping & Mobile Viewport (<768px)**:
    - Registers a debounced `window.addEventListener("resize", ...)` that re-clamps active positions within updated viewport bounds.
    - If `windowWidth < 768px`, switches to mobile bottom-sheet mode (`fixed bottom-0 inset-x-2.5 max-h-[85vh] rounded-t-2xl z-50`).
*   **Z-Index Elevation & Dismissal**:
    - Centralized active window tracking via `CopilotContext` / `FloatingCardStage` (`focusedCardId === card.id ? 60 : 40 + index`).
    - Global `Escape` key listener dismisses the currently focused floating window.

### 3. Adaptive VideoPipelineCard Geometry & Shared Error Extraction

*   **Single Chrome Owner**: `FloatingCardWindow` owns all outer window chrome (title, badges, minimize/maximize, close, resize handles). `VideoPipelineCard` strips its internal redundant header.
*   **Adaptive Geometry**:
    - **Rendered State (`isRendered: true`)**: Compact 2-column horizontal split (`580px × 510px`, min `520px × 460px`). Left column hosts 9:16 video player (`aspect-[9/16] h-full max-h-[440px]`). Right column hosts specs grid, audio model pill, target profile pill, and `[ ✈️ Telegramıma Göndər ]` button directly anchored below. Zero vertical dead space.
    - **Unrendered State (`isRendered: false`)**: Compact stacked layout (`480px × 540px`). Top warning badge -> 16:9 photo carousel with navigation -> compact specs pills -> `[ 🚀 Montaj Boru Xəttinə Göndər ]` button.
*   **Shared Error Serializer (`web/lib/errors.ts`)**:
    ```ts
    export function extractErrorMessage(err: unknown): string {
      if (!err) return "Bilinməyən xəta baş verdi.";
      if (err instanceof Error) return err.message;
      if (typeof err === "string") return err;
      if (typeof err === "object") {
        const obj = err as Record<string, unknown>;
        const msg = typeof obj.message === "string" ? obj.message : "";
        const details = typeof obj.details === "string" ? obj.details : "";
        const hint = typeof obj.hint === "string" ? obj.hint : "";
        const candidate = [msg, details && `(${details})`, hint && `[İpucu: ${hint}]`].filter(Boolean).join(" ");
        if (candidate) return candidate;
        if (typeof obj.error === "string") return obj.error;
        try { return JSON.stringify(err); } catch { return "Bilinməyən xəta."; }
      }
      return String(err);
    }
    ```

### 4. Truthful Telemetry Engine with Dynamic Benchmarks (`AnalyticsTelemetryCard`)

*   **Single Chrome Owner**: Internal header bar removed; managed by `FloatingCardWindow`.
*   **Dynamic District Benchmarks (`web/lib/market-benchmarks.ts`)**:
    ```ts
    export const DISTRICT_LIQUIDITY_CORRIDORS: Record<string, { min: number; max: number; label: string }> = {
      yasamal: { min: 2200, max: 2800, label: "Yasamal r." },
      nasimi: { min: 2500, max: 3400, label: "Nəsimi r." },
      sabail: { min: 3200, max: 4800, label: "Səbail r." },
      khatai: { min: 2100, max: 2900, label: "Xətai r." },
      default: { min: 2000, max: 3000, label: "Bakı Ortalaması" },
    };
    ```
*   **Mode A (Unpublished / Pre-Flight)**:
    - Renders authentic pre-publish dossier: real price, normalized m² rate, matching district liquidity corridor, filtered CRM buyer demand (`supabase.from("buyer_leads").select("id", { count: "exact", head: true }).ilike("preferred_districts", `%${district}%`)`), target account routing (`@baku.serfeli.evler` or `@bakuestate.premium`).
    - CTA button `[ 🚀 Teleqrama Göndər və Sosial Dərc Et ]` triggers the standard preflight modal flow.
    - **Strict rule**: NO fake views, NO fabricated past dates (Nov 10–23).
*   **Mode B (Live Social Telemetry)**:
    - Active when `publication_telemetry_snapshots` rows exist for the listing's publications. Renders verified live views, likes, comments, and real snapshot curves.

### 5. Listing Card Badge Collision Resolution (`ListingsClient.tsx`)

*   Restructure top image badge container in `ListingsClient.tsx`:
    ```tsx
    <div className="absolute top-3 left-3 right-3 flex flex-col gap-1.5 pointer-events-none z-10">
      <div className="flex items-center justify-between gap-2 pointer-events-auto">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="rounded-lg bg-obsidian-950/85 px-2 py-0.5 font-mono text-xs font-semibold text-gold-300 border border-gold-500/30">
            #{item.bina_id}
          </span>
          <span className="...">{nicheInfo.handle}</span>
        </div>
        <div className="shrink-0">{renderBadge}</div>
      </div>
      {(item.has_bill_of_sale || item.archetype) && (
        <div className="flex items-center gap-1.5 pointer-events-auto">
          <StatusBadge label={ARCHETYPE_LABELS[item.archetype]} tone="neutral" />
          {item.has_bill_of_sale && <KupcaBadge />}
        </div>
      )}
    </div>
    ```

### 6. Preflight Scrape Fallback Handling (`PreflightModal.tsx`)

*   Update `PreflightResponseData` interface:
    ```ts
    export interface PreflightResponseData {
      ok: boolean;
      reason?: string;
      message?: string;
      can_fallback_to_db?: boolean;
      db_price?: number;
      new_price?: number;
      old_price?: number;
      response_time_ms?: number;
    }
    ```
*   When `res.status === 502` and `data.reason === "SCRAPE_ERROR"`:
    - Set `statusState = "SCRAPE_FALLBACK_PROMPT"`.
    - Render an amber advisory banner: `⚠️ Diqqət: bina.az portalı bulud IP-sini blokladığı üçün canlı qiymət oxuna bilmədi. Bazadakı təsdiqlənmiş qiymətlə (${formatAzn(data.db_price || listing.price_azn_normalized)}) göndərməyi təsdiqləyirsiniz?`
    - Render prominent action button: `[ 🛡️ Bazadakı Qiymətlə Göndər ]` calling `handleDispatchToTelegram(true)` with `bypass_live_check: true`.

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative 1: Fixed Docked Multi-Column Sidebar (`LeftCanvasStage` with flex-wrap)
*   **Pros**: Simple CSS flex-wrap layout; avoids custom pointer dragging or window coordinates.
*   **Cons**: Steals horizontal screen real estate from listing grid; enforces 100% viewport height stretching and dead space.
*   **Reason for Rejection**: Rejected by author. Rigid docked panes prevent operators from freely organizing their workspace and cause visual empty voids in compact cards.

### Alternative 2: Third-Party Window Manager Library (`react-rnd` or `golden-layout`)
*   **Pros**: Out-of-the-box window dragging, boundary constraints, and resize handlers.
*   **Cons**: Adds 40–100 KB bundle weight; potential SSR hydration mismatches in Next.js 16 / React 19.
*   **Reason for Rejection**: Rejected by author. HTML5 Pointer Events (`setPointerCapture`) achieve identical behavior in ~120 lines of zero-dependency code.

### Alternative 3: Fabricated Static Curves for Unpublished Listings
*   **Pros**: Populates telemetry charts with visually complete curves immediately upon listing creation.
*   **Cons**: Misleads operators into believing unpublished listings have live audience engagement.
*   **Reason for Rejection**: Rejected by author. Violates truthful telemetry principles.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `web/lib/errors.ts` (Create)
*   **Type / Scope**: Shared TypeScript Utility Module
*   **Proposed Changes**:
    - Implement `extractErrorMessage(err: unknown): string`.
    - Parse Error instances, strings, and PostgREST error shapes concatenating `.message`, `.details`, and `.hint`.

#### 2. `web/lib/market-benchmarks.ts` (Create)
*   **Type / Scope**: Shared TypeScript Benchmark Dictionary
*   **Proposed Changes**:
    - Define `DISTRICT_LIQUIDITY_CORRIDORS` covering Yasamal, Nəsimi, Səbail, Xətai, Nərimanov, Masazır, and default Baku averages.
    - Export `resolveDistrictCorridor(location?: string)` utility.

#### 3. `web/components/hub/stage/useFloatingWindow.ts` (Create)
*   **Type / Scope**: Custom React Hook (HTML5 Pointer Window Management)
*   **Proposed Changes**:
    - Manage `position: { x, y }`, `size: { width, height }`, and `isMaximized`.
    - Provide `handlePointerDown(e, action: "drag" | "resize-se" | "resize-e" | "resize-s")`.
    - Register debounced `resize` listener for viewport re-clamping.
    - Set `pointer-events-none` on inner elements during drag.
    - Support mobile bottom-sheet fallback when viewport width is below 768px.

#### 4. `web/components/hub/stage/FloatingCardWindow.tsx` (Create)
*   **Type / Scope**: React Client Window Chrome Component
*   **Proposed Changes**:
    - Render draggable header bar with grip handle, title, badges, minimize/maximize button, and close button.
    - Render corner and edge resize handles with boundary clamping.
    - Listen for `Escape` key to dismiss window.
    - Provide single-source chrome for stage cards.

#### 5. `web/components/hub/stage/FloatingCardStage.tsx` (Create)
*   **Type / Scope**: React Client Viewport Host Component
*   **Proposed Changes**:
    - Replaces `LeftCanvasStage.tsx`.
    - Mounts full-screen overlay (`fixed inset-0 pointer-events-none z-40 overflow-hidden`).
    - Maps `stageCards` to `FloatingCardWindow` instances with centralized z-index focus tracking (`bringToFront`).

#### 6. `web/components/AppShell.tsx` (Modify)
*   **Type / Scope**: Root Layout Shell Component
*   **Proposed Changes**:
    - Import and mount `<FloatingCardStage />` as a top-level sibling to the main content and AI drawer, decoupled from `AgentHubDrawer.isOpen`.

#### 7. `web/components/hub/AgentHubDrawer.tsx` (Modify)
*   **Type / Scope**: React Client Slide-Over Drawer
*   **Proposed Changes**:
    - Remove `<LeftCanvasStage />` and the `flex-1 min-w-0 overflow-hidden` stage wrapper.
    - Focus strictly on hosting the right-hand docked AI chat console.

#### 8. `web/components/hub/stage/VideoPipelineCard.tsx` (Modify)
*   **Type / Scope**: React Client Stage Card Component
*   **Proposed Changes**:
    - Strip internal redundant header bar (handled by `FloatingCardWindow`).
    - Implement adaptive geometry: compact 2-column horizontal layout for rendered 9:16 videos, and stacked layout for unrendered 16:9 photo carousels.
    - Import and use `extractErrorMessage` from `@/lib/errors`.

#### 9. `web/components/hub/stage/AnalyticsTelemetryCard.tsx` (Modify)
*   **Type / Scope**: React Client Stage Card Component
*   **Proposed Changes**:
    - Strip internal redundant header bar.
    - Remove all synthetic dates and fake 22,400 view counts.
    - Connect `resolveDistrictCorridor` from `@/lib/market-benchmarks` and filtered `buyer_leads` count.
    - Wire `[ 🚀 Teleqrama Göndər və Sosial Dərc Et ]` button.

#### 10. `web/components/ListingsClient.tsx` (Modify)
*   **Type / Scope**: React Client Component (Listings Grid)
*   **Proposed Changes**:
    - Refactor card image header badges into `flex flex-col gap-1.5 pointer-events-none z-10`.
    - Row 1: Left `#bina_id` + `@handle`; Right: `v{render.version_num} • Hazır` status badge.
    - Row 2: Secondary badges (`Kupça`, Archetype) rendered below with clean spacing.

#### 11. `web/components/PreflightModal.tsx` (Modify)
*   **Type / Scope**: React Client Modal Component
*   **Proposed Changes**:
    - Update `PreflightResponseData` interface with `can_fallback_to_db` and `db_price`.
    - Promote `SCRAPE_ERROR` on HTTP 502 to dedicated amber `SCRAPE_FALLBACK_PROMPT` state with active `[ 🛡️ Bazadakı Qiymətlə Göndər ]` button.

#### 12. `web/app/api/pipeline/queue-render/route.ts` (Modify)
*   **Type / Scope**: Next.js App Router API Route Handler
*   **Proposed Changes**:
    - Import and use `extractErrorMessage` from `@/lib/errors` to ensure sanitized JSON error payloads.

#### 13. `web/__tests__/lib/extractErrorMessage.test.ts` (Create)
*   **Type / Scope**: Vitest Unit Test Suite
*   **Proposed Changes**:
    - Verify error parsing across Error instances, plain strings, PostgREST errors with details/hints, and nested objects.

#### 14. `web/__tests__/stage/useFloatingWindow.test.ts` (Create)
*   **Type / Scope**: Vitest Unit Test Suite
*   **Proposed Changes**:
    - Verify pointer down/move/up dragging, window resize clamping, and min/max dimension boundaries.

#### 15. `web/__tests__/stage/FloatingCardStage.test.tsx` (Create)
*   **Type / Scope**: Vitest Component Test Suite
*   **Proposed Changes**:
    - Verify multi-card rendering, z-index elevation on click, and card close removal from `stageCards`.

---

### Verification Plan

*   **TypeScript & Compilation**: Run `npm run build` in `web/` to guarantee zero TypeScript compilation or Next.js App Router build errors.
*   **Unit & Component Tests**: Run `npm test` in `web/` to execute all Vitest test suites, including the 3 new stage test suites (`extractErrorMessage.test.ts`, `useFloatingWindow.test.ts`, `FloatingCardStage.test.tsx`).
*   **Static Code Analysis & Linting**: Run `npm run lint` in `web/` to verify zero ESLint errors or React 19 hook dependency warnings.
*   **Manual & Visual Verification**:
    1. Navigate to `/listings`. Open a Video card and a Telemetry card simultaneously. Verify they float independently over the listings grid.
    2. Close the right-hand AI Cockpit drawer; verify that floating cards remain visible and interactive.
    3. Drag cards to the right side of the screen; verify no clipping occurs.
    4. Drag the bottom-right corner resize handle; verify smooth scaling.
    5. Inspect an unrendered listing; verify that `AnalyticsTelemetryCard` displays the honest "Sosial Yayım Gözləyir" dossier with zero synthetic curves or past dates.
    6. Verify that listing card badges on `/listings` render in two clean rows without overlapping.

--------------------------------------------------------------------------------

*Drafted with EGM*
