# Goldfish Annotated Review Report

**Target:** `docs/designs/floating_window_cards_and_truthful_telemetry.md` (Lines 1–249)  
**Round:** 1  
**Status:** Resolved (All 10 Fixes Applied)  
**Accepted Fixes:** 10 | **Contested:** 0 | **Escalated:** 0 | **Declined:** 0  

---

## Prioritized Findings & AI Categorization

### 1. [Stage Window Host Coupling & Viewport Clipping] [`egm-design`, `egm-codebase-details`, `egm-implementation-readiness`] - Severity: 🔴 Blocker
*   **Affected Scope:** Lines 97–118, 223–225, 237–238 (`Technical Plan §1` & `Detailed Implementation Plan §6`)
*   **Discrepancy Description:** In `AgentHubDrawer.tsx`, the root container sets `${isOpen ? "visible opacity-100" : "invisible opacity-0"}`. Mounting `FloatingCardStage` inside `AgentHubDrawer` means closing the right-hand AI chat drawer instantly hides all floating cards. Furthermore, the stage container has `flex-1 min-w-0 h-full overflow-hidden`, which strictly clips any card dragged towards the center or right of the screen at the 620px drawer boundary.
*   **Rationale:** Floating cards must be free to roam the entire screen and remain open even when the AI chat drawer is collapsed.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Decouple `FloatingCardStage` from `AgentHubDrawer.tsx`. Mount it at the root dashboard level in `web/components/AppShell.tsx` as a full-viewport portal (`fixed inset-0 pointer-events-none z-40 overflow-hidden`), subscribing to `stageCards` from `useCopilot()` independently of drawer `isOpen`.
*   ***Proposed Edit:*** Update Section 5.1 and Section 7.3 & 7.6 to mount `FloatingCardStage` in `AppShell.tsx` rather than inside `AgentHubDrawer.tsx`.

---

### 2. [Preflight Fallback State Categorization & Existing Button] [`egm-codebase-details`, `egm-design`, `egm-implementation-readiness`] - Severity: 🔴 Blocker
*   **Scope:** Lines 30, 84–91, 185–190, 243–245 (`Problem §7`, `CUJ 4`, `Plan §6 & §8`)
*   **Discrepancy Description:** The design asserts that `PreflightModal.tsx` has no fallback path. In reality, `PreflightModal.tsx` already has a baseline button `🛡️ Baza Qiyməti ilə Göndər ({formatAzn(price)})`, and `/api/listings/[bina_id]/preflight` already supports `bypass_live_check: true`. The real runtime defect is that on HTTP 502 with `reason: "SCRAPE_ERROR"`, `PreflightModal.tsx` enters `else: setStatusState("ERROR")`, displaying a red fatal error box (`Pre-Flight Xətası`) that obscures the fallback path. Additionally, `PreflightResponseData` lacks `can_fallback_to_db` and `db_price` types.
*   **Rationale:** Inaccurate assertions about existing code lead to redundant rewrites and fail to fix the root UX categorization bug.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Acknowledge existing backend support; update `PreflightResponseData` type definition; promote `reason: "SCRAPE_ERROR"` into a dedicated amber `SCRAPE_FALLBACK_PROMPT` state with clear confirmation text and active `[ 🛡️ Bazadakı Qiymətlə Göndər ]` action.
*   ***Proposed Edit:*** Refine Section 2.7, Section 5.6, and Section 7.8 with the exact `PreflightResponseData` interface and amber state handling.

---

### 3. [Missing `Verification Plan` and Structural File Grouping] [`egm-structural`, `egm-implementation-readiness`] - Severity: 🔴 Blocker
*   **Scope:** Lines 207–249 (`## Detailed Implementation Plan`)
*   **Discrepancy Description:** The design completely omits the mandatory `### Verification Plan` subsection (violating EGM standards) and lists files directly as H3s without the standard `### Target Files to Create/Modify` container or automated Vitest test suites.
*   **Rationale:** Without an explicit verification plan (build, lint, Vitest unit tests, manual checks), implementation lacks objective completion gates.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Introduce `### Target Files to Create/Modify` with H4 file entries, add 3 dedicated Vitest test files (`useFloatingWindow.test.ts`, `FloatingCardStage.test.tsx`, `extractErrorMessage.test.ts`), and append `### Verification Plan`.
*   ***Proposed Edit:*** Restructure Section 7 to include `### Target Files to Create/Modify`, 3 test files, and `### Verification Plan`.

---

### 4. [Double Header Bar Collision in Stage Cards] [`egm-codebase-details`, `egm-implementation-readiness`] - Severity: 🟡 Major
*   **Scope:** Lines 216–236 (`FloatingCardWindow.tsx`, `VideoPipelineCard.tsx`, `AnalyticsTelemetryCard.tsx`)
*   **Discrepancy Description:** `FloatingCardWindow.tsx` provides an outer draggable chrome with header, title, badges, and controls. However, existing cards (`VideoPipelineCard`, `AnalyticsTelemetryCard`, `CrmNegotiationCard`) already render their own built-in header bars. Wrapping them produces two stacked headers consuming ~100px of vertical space.
*   **Rationale:** Wastes card space and duplicates buttons.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** `FloatingCardWindow` becomes the single owner of window chrome. Stage cards strip their internal headers or accept a `hideHeader?: boolean` prop.
*   ***Proposed Edit:*** Specify in Section 7.2, 7.4, 7.5 that internal header bars are removed from stage cards when wrapped in `FloatingCardWindow`.

---

### 5. [Adaptive Geometry for Unrendered Cards & Viewport Resize Clamping] [`egm-design`] - Severity: 🟡 Major
*   **Scope:** Lines 120–145 (`Technical Plan §2 & §3`)
*   **Discrepancy Description:**
    1. Locking `VideoPipelineCard` to a 2-column horizontal layout based on a 9:16 portrait video player breaks when `isRendered === false`, where 16:9 landscape photo carousels are rendered.
    2. `useFloatingWindow` only clamps on drag; resizing the browser window leaves cards stranded off-screen. Fixed 520px min-width breaks mobile (<768px).
*   **Rationale:** Cards must adapt between unrendered (photo gallery) and rendered (9:16 player) states, and must remain accessible on window resize and mobile viewports.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Add adaptive layout branching in `VideoPipelineCard` (horizontal for rendered 9:16; vertical stacked for unrendered 16:9 gallery); add debounced window resize listener and mobile bottom-sheet fallback (<768px).
*   ***Proposed Edit:*** Update Section 5.2 and Section 5.3 with adaptive geometry and resize listeners.

---

### 6. [Hardcoded Regional Normatives & Unfiltered CRM Leads in Telemetry] [`egm-design`, `egm-implementation-readiness`] - Severity: 🟡 Major
*   **Scope:** Lines 163–178 (`Technical Plan §4: Truthful Telemetry Engine`)
*   **Discrepancy Description:** Hardcoding Yasamal liquidity corridors (2,200–2,800 AZN/m²) for all listings misrepresents properties in Səbail, Bilgəh, or Masazır. Querying `buyer_leads` with `limit(100)` and no filter fabricates local interest.
*   **Rationale:** Truthful telemetry must not display false valuation benchmarks or arbitrary lead counts.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Define a district normative dictionary (`DISTRICT_BENCHMARKS`) with dynamic lookup by listing district, and parameterize `buyer_leads` query by district/rooms.
*   ***Proposed Edit:*** Update Section 5.4 and Section 7.5 to include `DISTRICT_BENCHMARKS` and filtered lead counts.

---

### 7. [JSX Restructuring for Listing Card Header Badges] [`egm-codebase-details`, `egm-implementation-readiness`] - Severity: 🟡 Major
*   **Scope:** Lines 179–184, 240–242 (`ListingsClient.tsx`)
*   **Discrepancy Description:** Simply splitting badges into two rows without changing the parent wrapper to `flex flex-col gap-1.5` will cause Row 2 to align beside the video version badge, breaking card geometry on the `h-44` image.
*   **Rationale:** Badges will collide or obscure the property thumbnail without explicit container styling.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Provide exact JSX container structure: `flex flex-col gap-1.5 pointer-events-none z-10`, with Row 1 (`flex items-center justify-between`) and conditional Row 2 (`flex items-center gap-1.5`).
*   ***Proposed Edit:*** Update Section 5.5 and Section 7.7 with the exact JSX hierarchy.

---

### 8. [Standardized Alternatives Formatting & EGM Template Schema] [`egm-structural`] - Severity: 🟡 Major
*   **Scope:** Lines 193–205 (`## Alternatives Considered`)
*   **Discrepancy Description:** Alternatives are formatted as an inline numbered list rather than standard H3 headers (`### Alternative 1: ...`), omitting explicit `* **Pros**:` and `* **Cons**:`.
*   **Rationale:** Standard EGM design docs require structured pros/cons analysis.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Convert alternatives into H3 subsections with explicit Pros, Cons, and Author Rejection rationale.
*   ***Proposed Edit:*** Update Section 6 to follow standard H3, Pros, Cons, and Reason for Rejection.

---

### 9. [Diagnostic Details Concatenation in `extractErrorMessage`] [`egm-codebase-details`, `egm-design`] - Severity: 🟢 Nit
*   **Scope:** Lines 149–160 (`extractErrorMessage`)
*   **Discrepancy Description:** Evaluates `obj.message` first. In Supabase/Postgrest errors, `error.message` is generic, while diagnostic detail is in `error.details` and remediation is in `error.hint`.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Proposed Edit:*** Move `extractErrorMessage` to shared `web/lib/errors.ts` and concatenate `details` and `hint` when present.

---

### 10. [CUJ 1 Entry Points & Missing CUJs 5 & 6] [`egm-codebase-details`, `egm-structural`] - Severity: 🟢 Nit
*   **Scope:** Lines 55–92 (`Critical User Journeys`)
*   **Discrepancy Description:** CUJ 1 refers to `[🎬 Videoya Bax]` and `[📊 Analitikaya Bax]` buttons on listing cards, which are currently only in AI chat messages. Also, goals 4 (error telemetry) and 6 (badge collision) lack explicit CUJs.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Proposed Edit:*** Add quick action buttons to listing cards or clarify chat entry points, and add CUJ 5 (Sanitized Error Display) and CUJ 6 (Card Header Badges).
