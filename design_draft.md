# Floating Draggable Window Cards & Truthful Telemetry Architecture

*   **Author:** fxbluster
*   **Status:** Draft
*   **Date:** 2026-11-24

--------------------------------------------------------------------------------

## Overview

This design refactors BakuEstate-AI's stage card presentation from a rigid, full-height docked left sidebar into an **Autonomous Floating Window Card System**. Instead of locking cards into an artificial full-viewport pane with static preset width buttons (`560px`, `860px`), cards float independently across the canvas. Operators can drag cards anywhere across the screen by their header, freely resize them from corners/edges, stack them with automatic z-index elevation on click, and dismiss them cleanly.

Additionally, this design addresses the specific visual and runtime defects identified in live operations:
1. Re-engineers `VideoPipelineCard` geometry into a content-hugged, compact layout that eliminates excessive vertical whitespace and dead zones.
2. Sanitizes runtime error parsing so API errors never surface as `[object Object]`.
3. Eliminates all synthetic demo metrics (e.g. fabricated 22,400 views, fake Nov 10–23 sparklines) in `AnalyticsTelemetryCard`, replacing them with an authentic pre-publish dossier and gating historical curves strictly behind verified Supabase snapshots.
4. Resolves badge overlap collisions on listing card headers in `ListingsClient.tsx`.
5. Enhances `PreflightModal.tsx` to allow operator confirmation with verified database prices when external portal scraping is blocked by datacenter IP filters.

--------------------------------------------------------------------------------

## The Problem

1. **Rigid Docked Sidebar vs. Floating Cards**: The current `LeftCanvasStage` mounts as a fixed, 100% viewport-height vertical column on the left side of the screen. This forces cards into an unnatural stretched layout with massive empty black space beneath the content, prevents free placement across the dashboard, and creates visual collisions with underlying dashboard elements.
2. **Artificial Sizing vs. Drag-to-Resize**: Previous preset buttons (`560px`, `860px`) fail to provide authentic window management. Operators expect standard desktop-grade floating cards that can be dragged freely and resized smoothly via edge/corner handles.
3. **Card Layout & Empty Space**: In `VideoPipelineCard`, the 9:16 video player is isolated next to a sparse specs column that stretches to fill the viewport, resulting in awkward vertical dead zones between specs and action buttons.
4. **`[object Object]` Rendering Defect**: When the video render queue API or client fetch encounters an object-shaped error or non-Error exception, string coercion evaluates to `"[object Object]"` instead of extracting `.message`, `.error`, or JSON-serializing the payload.
5. **Synthetic Demo Telemetry**: `AnalyticsTelemetryCard` renders fabricated historical dates (e.g. November 10–23) and synthetic view counts (22,400) even when an elan has never been published to social media. This obscures real operational status and misleads the operator.
6. **Card Header Badge Collision**: On listing cards in `ListingsClient.tsx`, 5 badges (`#id`, `@handle`, archetype, `Kupça`, and `v3 • Hazır`) are crammed into a single top row, causing `v3 • Hazır` to visually collide with and overlap adjacent badges on standard desktop resolutions.
7. **Preflight Scrape Blocking**: When `bina.az` blocks direct HTTP requests from cloud serverless functions (Vercel IP geoblock), `PreflightModal.tsx` displays a blocking error modal with no fallback path, preventing the operator from proceeding even though verified property data exists in the database.

--------------------------------------------------------------------------------

## Goals

*   **Floating Window Architecture**: Independent cards float over the dashboard with draggable header bars, freely resizable corner/edge handles, and active z-index management.
*   **Content-Hugged Geometry**: Cards size tightly to their actual content without stretching to 100% viewport height, eliminating all dead space.
*   **Compact & Balanced Video Card**: A cohesive, well-proportioned layout where the 9:16 player, listing specs, audio model details, and Telegram dispatch button form a single compact floating window.
*   **Robust Error Telemetry**: Safe stringification of all error objects to prevent `[object Object]` from ever displaying in the UI.
*   **Truthful Telemetry**: Complete elimination of simulated curves for unpublished listings. Clear "Yayından Qabaq / Sosial Dərc Gözləyir" status showing real listing economics, Yasamal/Nasimi normatives, and CRM lead interest, transitioning to historical curves only when verified publication snapshots exist in Supabase.
*   **Collision-Free Badges**: Clean badge layout on listing cards with zero overlapping.
*   **Frictionless Pre-Flight Fallback**: Allow operator-confirmed fallback to database price when external bina.az scraping is blocked by datacenter IP filters.
*   **Multi-Card Stacking**: Multiple cards (Video, Telemetry, WhatsApp CRM) can be open simultaneously at distinct screen positions without forced side-by-side splitting or mutual eviction.

--------------------------------------------------------------------------------

## Non-Goals

*   Replacing the right-hand side `AI İcraçı Qərargahı` drawer (the chat console remains docked on the right).
*   Adding heavyweight external desktop windowing dependencies that increase bundle size.
*   Fabricating placeholder engagement data when third-party social APIs have not yet recorded views.

--------------------------------------------------------------------------------

## Critical User Journeys (CUJs)

### CUJ 1: Operator Opens & Positions Multiple Independent Floating Cards

*   **Given**: The operator is on `/listings` with the AI Cockpit open on the right.
*   **When**: The operator clicks `[🎬 Videoya Bax]` for Elan #6588858 and subsequently clicks `[📊 Analitikaya Bax]` for the same elan.
*   **Then**: 
    1. A floating Video window opens at an initial offset (`x: 48px, y: 72px`).
    2. A floating Telemetry window opens slightly offset (`x: 88px, y: 112px`).
    3. Both cards float freely above the listing grid; neither card occupies 100% screen height.
    4. The operator clicks and drags either card's header bar to place it anywhere on screen.
    5. Clicking a card brings it to the top (`z-index: 60`).

### CUJ 2: Freeform Corner Drag-to-Resize on Video Window

*   **Given**: A floating Video window is open with initial size `580px × 510px`.
*   **When**: The operator hovers over the bottom-right corner resize handle and drags outward to expand.
*   **Then**: The window expands smoothly; the 9:16 player scales proportionally up to `340px × 604px`, and the specs column expands without jitter or dead space.

### CUJ 3: Truthful Pre-Publish Telemetry Inspection

*   **Given**: Elan #6588858 has been rendered (`v4`) but has not yet been published to Instagram or TikTok.
*   **When**: The operator opens the Telemetry window for Elan #6588858.
*   **Then**: 
    1. The window displays an explicit badge: `Sosial Yayım Gözləyir (Dərc Edilməyib)`.
    2. Zero fake views or fabricated past dates are shown.
    3. The card displays verified property fundamentals: real price (`226,000 AZN`), normalized m² rate (`2,379 AZN/m²`), Yasamal market benchmark (`2,200 - 2,800 AZN/m²`), targeted social account (`@baku.serfeli.evler`), and CRM lead count.
    4. An action button `[ 🚀 Teleqrama Göndər və Dərc Et ]` enables immediate transition into publication.

### CUJ 4: Preflight Scrape Fallback Handling

*   **Given**: The operator clicks `Yoxla və Göndər` on Elan #6560444, and bina.az blocks direct Vercel datacenter HTTP requests.
*   **When**: Preflight check returns `SCRAPE_ERROR` with `can_fallback_to_db: true`.
*   **Then**: 
    1. The modal does not dead-end in a generic error box.
    2. It presents an actionable prompt: `Bina.az portalı bulud IP-sini blokladı. Bazadakı təsdiqlənmiş qiymətlə (138,000 ₼) davam etmək istəyirsiniz?`.
    3. The operator clicks `[ Bazadakı Qiymətlə Göndər ]` to proceed directly to Telegram dispatch.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. Window Host Architecture (`FloatingCardStage` & `FloatingCardWindow`)

Instead of rendering a fixed left sidebar column, `LeftCanvasStage` is replaced by `FloatingCardStage`, which renders a lightweight viewport container with `pointer-events-none` that hosts independent `FloatingCardWindow` elements with `pointer-events-auto`.

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
*   **Resizing**:
    - Dedicated resize handle on the bottom-right corner (`cursor-se-resize`) plus bottom/right edges.
    - Updates `size = { width: clamp(w, minW, maxW), height: clamp(h, minH, maxH) }`.
*   **Z-Index Focus**:
    - An active window elevation counter: clicking any window increments a shared `topZIndex` and assigns it to that window.

### 3. VideoPipelineCard Content-Hugged Geometry & Error Sanitization

*   Removes `h-full` and full-viewport vertical stretching.
*   Container uses `w-full h-full flex flex-row gap-3 p-3.5` with initial dimensions `580px × 510px` and minimum `520px × 460px`.
*   **Left Column (Video)**:
    - 9:16 Aspect ratio container: `aspect-[9/16] h-full max-h-[460px] w-auto rounded-xl`.
    - Responsive play/pause overlay, duration badge, audio waveform indicator.
*   **Right Column (Specs & Action)**:
    - Sits directly beside the player, exactly matching its vertical height.
    - Stack: Price header -> Area / Rooms / Location grid -> ElevenLabs Arif (AZE) voice pill -> Target profile pill -> Full-width `[ 🚀 Teleqrama Göndər ]` button directly anchored at the bottom.
    - Zero empty vertical dead zones.
*   **Error Parsing Fix**:
    - In `VideoPipelineCard.tsx` and `/api/pipeline/queue-render/route.ts`:
    ```ts
    function extractErrorMessage(err: unknown): string {
      if (err instanceof Error) return err.message;
      if (typeof err === "string") return err;
      if (err && typeof err === "object") {
        const obj = err as Record<string, unknown>;
        const candidate = obj.message || obj.error || obj.details;
        if (typeof candidate === "string") return candidate;
        if (candidate && typeof candidate === "object") return JSON.stringify(candidate);
        return JSON.stringify(err);
      }
      return "Bilinməyən xəta baş verdi.";
    }
    ```

### 4. Truthful Telemetry Engine (`AnalyticsTelemetryCard`)

*   Fetches live listing (`listings`), publications (`publications`), snapshots (`publication_telemetry_snapshots`), and leads (`buyer_leads`).
*   **Dual Mode Rendering**:
    - **Mode A (Unpublished / Pre-Flight)**:
      - Renders an authentic pre-publish dossier:
        - Real price (`226,000 AZN`) and normalized m² (`2,379 AZN/m²`).
        - Yasamal liquidity corridor: `2,200 - 2,800 AZN/m²` (Status: `Optimal Bazar Normativi`).
        - Active CRM Buyer Leads: count of active buyers in Yasamal / 3-room segment from `buyer_leads`.
        - Target channel routing: `@baku.serfeli.evler` (Budget) or `@bakuestate.premium` (Luxury).
      - Prompts operator to trigger publication: `[ 🚀 Teleqrama Göndər və Sosial Dərc Et ]`.
      - **Strict rule**: NO fake views, NO fabricated past dates.
    - **Mode B (Live Social Telemetry)**:
      - Active when `publication_telemetry_snapshots` rows exist for the listing's publications.
      - Renders verified live views, likes, comments, and real snapshot curves.

### 5. Listing Card Badge Collision Resolution (`ListingsClient.tsx`)

*   Restructure top image badge container:
    - Row 1: Left `#bina_id` + `@handle` pill; Right: `v{render.version_num} • Hazır` (or `Video yoxdur`).
    - Row 2 (if present): `Kupça` and Archetype badges rendered neatly on a second line with clean spacing, preventing overlap regardless of card width.

### 6. Preflight Scrape Fallback Handling (`PreflightModal.tsx`)

*   When `data.can_fallback_to_db` is true:
    - Display explanatory alert: `bina.az portalı bulud IP-sini blokladı. Bazadakı təsdiqlənmiş qiymətlə (${formatAzn(data.db_price)}) davam etmək istəyirsiniz?`
    - Render a direct button: `[ 🛡️ Bazadakı Qiymətlə Göndər ]` allowing immediate progression to Telegram dispatch without false failures.

--------------------------------------------------------------------------------

## Alternatives Considered

1.  **Fixed Docked Multi-Column Sidebar (`LeftCanvasStage` with flex-wrap)**:
    - *Mechanism*: Keep cards inside a pinned left container that splits into multiple columns side-by-side as cards are opened.
    - *Why Rejected*: Rejected by author. Pinned sidebars steal substantial screen real estate from the listings grid, force rigid 100% viewport stretching, and create massive vertical empty voids inside content-bounded cards like `VideoPipelineCard`.
2.  **Third-Party Window Manager Library (e.g. `react-rnd` or `golden-layout`)**:
    - *Mechanism*: Import an external React windowing/docking library.
    - *Why Rejected*: Rejected by author. Adds 40–100 KB of third-party bundle weight, introduces React 19/Next.js 16 SSR compatibility issues, and adds unnecessary complexity when HTML5 Pointer Events (`setPointerCapture`) handle dragging and resizing in under 120 lines of vanilla code.
3.  **Fabricated Static Curves for Unpublished Listings**:
    - *Mechanism*: Generate a synthetic 14-day curve starting from listing creation date to simulate projected trajectory.
    - *Why Rejected*: Rejected by author. Fabricating metrics for elans with zero social publication is dishonest and confuses operators into believing videos are already live on Instagram/TikTok.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### 1. `web/components/hub/stage/useFloatingWindow.ts` (NEW)
*   **Rationale**: Zero-dependency custom hook providing pointer-captured dragging, multi-handle resizing, screen boundary clamping, and z-index elevation.
*   **Key Responsibilities**:
    - Track `position: { x, y }` and `size: { width, height }`.
    - Provide `handlePointerDown(e, "drag" | "resize-se" | "resize-e" | "resize-s")`.
    - Manage active z-index stacking.

### 2. `web/components/hub/stage/FloatingCardWindow.tsx` (NEW)
*   **Rationale**: Reusable desktop-grade floating window shell that wraps any stage card (`VideoPipelineCard`, `AnalyticsTelemetryCard`, etc.).
*   **Key Responsibilities**:
    - Floating chrome with drag handle header, title, badges, minimize/maximize/close buttons.
    - Corner resize handle (`bottom-right`) and edge resize handles.
    - Content container that hugs wrapped children without viewport stretching.

### 3. `web/components/hub/stage/FloatingCardStage.tsx` (NEW)
*   **Rationale**: Replaces `LeftCanvasStage.tsx`. Mounts an un-obscured floating card viewport that renders all active cards in `stageCards` as independent floating windows.

### 4. `web/components/hub/stage/VideoPipelineCard.tsx` (MODIFIED)
*   **Rationale**:
    - Eliminate `h-full` stretching and vertical dead zones.
    - Refactor 9:16 player and specs column into a compact, unified horizontal card.
    - Fix error extraction to eliminate `[object Object]` bug.

### 5. `web/components/hub/stage/AnalyticsTelemetryCard.tsx` (MODIFIED)
*   **Rationale**:
    - Remove all synthetic demo dates (Nov 10–23) and fake 22,400 view counts.
    - Implement Mode A (truthful pre-publish dossier with real price, m² rate, market corridor, and CRM buyer demand) and Mode B (authentic live telemetry when snapshots exist).

### 6. `web/components/hub/AgentHubDrawer.tsx` (MODIFIED)
*   **Rationale**: Replace imported `LeftCanvasStage` with `FloatingCardStage`.

### 7. `web/components/ListingsClient.tsx` (MODIFIED)
*   **Rationale**: Fix card header badge collision so `v3 • Hazır` never overlaps adjacent badges.

### 8. `web/components/PreflightModal.tsx` (MODIFIED)
*   **Rationale**: Handle `can_fallback_to_db: true` to provide a seamless "Bazadakı Qiymətlə Göndər" fallback path when bina.az IP blocks cloud scraping.

### 9. `web/app/api/pipeline/queue-render/route.ts` (MODIFIED)
*   **Rationale**: Sanitize error serialization so PostgrestError and runtime objects are always returned as readable strings.

--------------------------------------------------------------------------------
