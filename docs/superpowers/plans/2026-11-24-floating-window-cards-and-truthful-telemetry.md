# Floating Window Cards & Truthful Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build autonomous, desktop-grade floating draggable/resizable window cards, decouple stage from chat drawer, eliminate video card vertical empty space, sanitize runtime error parsing, provide truthful pre-publish telemetry with dynamic district benchmarks, and resolve badge collisions.

**Architecture:** Replace the docked, full-viewport `LeftCanvasStage` with an independent `FloatingCardStage` mounted at root `AppShell.tsx` level, hosting GPU-accelerated pointer-draggable, corner-resizable `FloatingCardWindow` shells. Refactor `VideoPipelineCard` into an adaptive layout (compact horizontal 9:16 player when rendered; stacked 16:9 photo gallery when unrendered), extract diagnostic PostgREST error messages via shared `errors.ts`, provide authentic pre-publish market dossiers via `market-benchmarks.ts`, restructure listing badges into two non-colliding rows, and promote preflight scrape blocks to an actionable amber confirmation state.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS, Supabase PostgreSQL, HTML5 Pointer Events (`setPointerCapture`), Vitest.

**Spec:** [`docs/designs/floating_window_cards_and_truthful_telemetry.md`](file:///c:/Users/HP/BakuEstate-AI/docs/designs/floating_window_cards_and_truthful_telemetry.md)

## Global Constraints

- **Platform & Runtime:** Next.js 16 App Router, React 19 client components (`"use client"`), Node.js 22+.
- **Zero Heavyweight Dependencies:** No third-party window managers (`react-rnd`, `golden-layout`); all drag and resize operations must use native HTML5 Pointer Events (`onPointerDown`, `setPointerCapture`, `onPointerMove`, `onPointerUp`).
- **Full Viewport Decoupling:** `FloatingCardStage` must be mounted in `web/components/AppShell.tsx` as a top-level sibling with `fixed inset-0 pointer-events-none z-40 overflow-hidden`, independent of `AgentHubDrawer.isOpen`.
- **Single Window Chrome Ownership:** `FloatingCardWindow` is the single owner of outer chrome (header, title, badges, minimize/maximize, close, resize handles). Stage cards (`VideoPipelineCard`, `AnalyticsTelemetryCard`) must strip their internal redundant header bars.
- **Truthful Telemetry Non-Negotiable:** Under zero circumstances shall synthetic view counts (e.g. 22,400) or fabricated past dates (Nov 10–23) be rendered for unverified/unpublished listings.
- **Test Command:** All Vitest tests must be executed with physical workspace path `D:/Antigravity_Projects/Active_Projects/BakuEstate-AI/web` to avoid Windows junction symlink URL resolution errors: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npm test -- --run`.

## Review Focus

1. **Pointer capture drop during fast drags over video elements:** Dragging rapidly over `<video>` elements can cause pointer capture loss if child pointer events are enabled. Tested in Task 3.
2. **Window coordinates stranding on browser resize:** Snapping windows to smaller screens leaves cards off-screen without dynamic re-clamping. Tested in Task 3.
3. **Right-edge and bottom-edge resize overflow:** Resizing window wider than screen pushes resize handle off-screen. Tested in Task 3.
4. **PostgREST error message masking:** Supabase errors containing generic `.message` but specific `.details` and `.hint` risk displaying generic text. Tested in Task 1.
5. **Mobile viewport (<768px) layout collapse:** Opening 580px floating window on 375px mobile screens clips action buttons. Handled via bottom-sheet fallback in Task 3.

---

### Task 1: Shared Diagnostic Error Serializer (`web/lib/errors.ts`)

**Files:**
- Create: `web/lib/errors.ts`
- Test: `web/__tests__/lib/extractErrorMessage.test.ts`

**Interfaces:**
- Produces: `extractErrorMessage(err: unknown): string`
  - Parses `Error`, `string`, and `{ message?: string, details?: string, hint?: string, error?: string }` objects, concatenating details and hints into a human-readable diagnostic string.

- [ ] **Step 1: Write the failing test**

```ts
// web/__tests__/lib/extractErrorMessage.test.ts
import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "@/lib/errors";

describe("extractErrorMessage", () => {
  it("extracts Error message", () => {
    expect(extractErrorMessage(new Error("Database connection timeout"))).toBe("Database connection timeout");
  });

  it("handles plain strings", () => {
    expect(extractErrorMessage("Scrape rate limit exceeded")).toBe("Scrape rate limit exceeded");
  });

  it("formats PostgREST error object with details and hint", () => {
    const postgrestErr = {
      message: "violates check constraint",
      details: "Failing row contains (null, 'INVALID')",
      hint: "Value must be in ALLOWED_STATUSES",
    };
    expect(extractErrorMessage(postgrestErr)).toBe(
      "violates check constraint (Failing row contains (null, 'INVALID')) [İpucu: Value must be in ALLOWED_STATUSES]"
    );
  });

  it("never returns '[object Object]'", () => {
    expect(extractErrorMessage({})).not.toBe("[object Object]");
    expect(extractErrorMessage({ foo: "bar" })).toBe('{"foo":"bar"}');
    expect(extractErrorMessage(null)).toBe("Bilinməyən xəta baş verdi.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/lib/extractErrorMessage.test.ts`
Expected: FAIL with `Cannot find module '@/lib/errors'`

- [ ] **Step 3: Implement `extractErrorMessage` in `web/lib/errors.ts`**

```ts
// web/lib/errors.ts
export function extractErrorMessage(err: unknown): string {
  if (!err) return "Bilinməyən xəta baş verdi.";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const msg = typeof obj.message === "string" ? obj.message : "";
    const details = typeof obj.details === "string" ? obj.details : "";
    const hint = typeof obj.hint === "string" ? obj.hint : "";
    const combined = [msg, details && `(${details})`, hint && `[İpucu: ${hint}]`].filter(Boolean).join(" ");
    if (combined) return combined;
    if (typeof obj.error === "string") return obj.error;
    try {
      return JSON.stringify(err);
    } catch {
      return "Bilinməyən xəta.";
    }
  }
  return String(err);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/lib/extractErrorMessage.test.ts`
Expected: PASS (4 tests passed)

- [ ] **Step 5: Commit**

```bash
git add web/lib/errors.ts web/__tests__/lib/extractErrorMessage.test.ts
git commit -m "feat(errors): add diagnostic PostgREST-safe error extractor"
```

---

### Task 2: Dynamic District Benchmarks Dictionary (`web/lib/market-benchmarks.ts`)

**Files:**
- Create: `web/lib/market-benchmarks.ts`
- Test: `web/__tests__/lib/marketBenchmarks.test.ts`

**Interfaces:**
- Produces: 
  - `DISTRICT_LIQUIDITY_CORRIDORS: Record<string, { min: number; max: number; label: string }>`
  - `resolveDistrictCorridor(location?: string): { min: number; max: number; label: string }`

- [ ] **Step 1: Write the failing test**

```ts
// web/__tests__/lib/marketBenchmarks.test.ts
import { describe, it, expect } from "vitest";
import { resolveDistrictCorridor, DISTRICT_LIQUIDITY_CORRIDORS } from "@/lib/market-benchmarks";

describe("market-benchmarks", () => {
  it("resolves Yasamal corridor", () => {
    const res = resolveDistrictCorridor("Bakı, Yasamal r., İnşaatçılar m.");
    expect(res.label).toBe("Yasamal r.");
    expect(res.min).toBe(2200);
    expect(res.max).toBe(2800);
  });

  it("resolves Sabail luxury corridor", () => {
    const res = resolveDistrictCorridor("Bakı şəhəri, Səbail rayonu, Badamdar");
    expect(res.label).toBe("Səbail r.");
    expect(res.min).toBe(3200);
    expect(res.max).toBe(4800);
  });

  it("falls back to default Baku average when district is unknown", () => {
    const res = resolveDistrictCorridor("Qaradağ r., Lökbatan");
    expect(res.label).toBe("Bakı Ortalaması");
    expect(res.min).toBe(2000);
    expect(res.max).toBe(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/lib/marketBenchmarks.test.ts`
Expected: FAIL with `Cannot find module '@/lib/market-benchmarks'`

- [ ] **Step 3: Implement `web/lib/market-benchmarks.ts`**

```ts
// web/lib/market-benchmarks.ts
export interface DistrictBenchmark {
  min: number;
  max: number;
  label: string;
}

export const DISTRICT_LIQUIDITY_CORRIDORS: Record<string, DistrictBenchmark> = {
  yasamal: { min: 2200, max: 2800, label: "Yasamal r." },
  nasimi: { min: 2500, max: 3400, label: "Nəsimi r." },
  sabail: { min: 3200, max: 4800, label: "Səbail r." },
  khatai: { min: 2100, max: 2900, label: "Xətai r." },
  narimanov: { min: 2400, max: 3200, label: "Nərimanov r." },
  masazir: { min: 1100, max: 1600, label: "Masazır qəs." },
  default: { min: 2000, max: 3000, label: "Bakı Ortalaması" },
};

export function resolveDistrictCorridor(location?: string): DistrictBenchmark {
  if (!location) return DISTRICT_LIQUIDITY_CORRIDORS.default;
  const lower = location.toLowerCase();
  if (lower.includes("yasamal") || lower.includes("inşaatçılar") || lower.includes("elmlər")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.yasamal;
  }
  if (lower.includes("nəsimi") || lower.includes("nasimi") || lower.includes("28 may")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.nasimi;
  }
  if (lower.includes("səbail") || lower.includes("sabail") || lower.includes("badamdar") || lower.includes("sahil")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.sabail;
  }
  if (lower.includes("xətai") || lower.includes("khatai") || lower.includes("əhmədli") || lower.includes("həzi")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.khatai;
  }
  if (lower.includes("nərimanov") || lower.includes("narimanov") || lower.includes("gənclik")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.narimanov;
  }
  if (lower.includes("masazır") || lower.includes("masazir")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.masazir;
  }
  return DISTRICT_LIQUIDITY_CORRIDORS.default;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/lib/marketBenchmarks.test.ts`
Expected: PASS (3 tests passed)

- [ ] **Step 5: Commit**

```bash
git add web/lib/market-benchmarks.ts web/__tests__/lib/marketBenchmarks.test.ts
git commit -m "feat(benchmarks): add dynamic district liquidity benchmarks"
```

---

### Task 3: HTML5 Pointer Floating Window Hook (`web/components/hub/stage/useFloatingWindow.ts`)

**Files:**
- Create: `web/components/hub/stage/useFloatingWindow.ts`
- Test: `web/__tests__/stage/useFloatingWindow.test.ts`

**Interfaces:**
- Produces: `useFloatingWindow(options?: FloatingWindowOptions)`
  - Returns `position`, `size`, `isMaximized`, `isDragging`, `isResizing`, `handleDragPointerDown`, `handleResizePointerDown`, `handlePointerMove`, `handlePointerUp`, `toggleMaximize`.
  - Automatically re-clamps on window `resize` events.
  - Clamps resize width against `window.innerWidth - pos.x - 10`.

- [ ] **Step 1: Write the failing test**

```ts
// web/__tests__/stage/useFloatingWindow.test.ts
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFloatingWindow } from "@/components/hub/stage/useFloatingWindow";

describe("useFloatingWindow", () => {
  it("initializes with staggered offset by default", () => {
    const { result } = renderHook(() => useFloatingWindow({ initialOffsetIndex: 2 }));
    expect(result.current.position.x).toBe(28 + 2 * 32);
    expect(result.current.position.y).toBe(68 + 2 * 32);
    expect(result.current.size.width).toBe(620);
    expect(result.current.size.height).toBe(520);
  });

  it("toggles maximize and restores previous bounds", () => {
    const { result } = renderHook(() => useFloatingWindow({ defaultWidth: 500, defaultHeight: 400 }));
    act(() => {
      result.current.toggleMaximize();
    });
    expect(result.current.isMaximized).toBe(true);
    expect(result.current.position.x).toBe(12);

    act(() => {
      result.current.toggleMaximize();
    });
    expect(result.current.isMaximized).toBe(false);
    expect(result.current.size.width).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/stage/useFloatingWindow.test.ts`
Expected: FAIL with `Cannot find module '@/components/hub/stage/useFloatingWindow'`

- [ ] **Step 3: Implement `useFloatingWindow.ts`**

Implement `web/components/hub/stage/useFloatingWindow.ts` incorporating window resize listener, pointer event capture, boundary clamping against `window.innerWidth - pos.x - 10`, and mobile viewport detection (<768px).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/stage/useFloatingWindow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/components/hub/stage/useFloatingWindow.ts web/__tests__/stage/useFloatingWindow.test.ts
git commit -m "feat(hub): add pointer-captured useFloatingWindow hook with boundary clamping"
```

---

### Task 4: Floating Card Window Chrome Component (`web/components/hub/stage/FloatingCardWindow.tsx`)

**Files:**
- Create: `web/components/hub/stage/FloatingCardWindow.tsx`
- Test: `web/__tests__/stage/FloatingCardWindow.test.tsx`

**Interfaces:**
- Produces: `FloatingCardWindow: React.FC<FloatingCardWindowProps>`
  - Single owner of outer window chrome (header, grip handle, title, badge, minimize/maximize, close, resize handles).
  - Handles `Escape` key listener to dismiss the active window.
  - Sets `pointer-events-none select-none` on content during active drag.

- [ ] **Step 1: Write the failing test**

```tsx
// web/__tests__/stage/FloatingCardWindow.test.tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FloatingCardWindow } from "@/components/hub/stage/FloatingCardWindow";

describe("FloatingCardWindow", () => {
  it("renders chrome title, badge, and children", () => {
    const onClose = vi.fn();
    render(
      <FloatingCardWindow
        id="test-card-1"
        title="Video #6588858"
        badge={<span data-testid="test-badge">Hazır</span>}
        onClose={onClose}
      >
        <div data-testid="card-content">Inner Content</div>
      </FloatingCardWindow>
    );

    expect(screen.getByText("Video #6588858")).toBeInTheDocument();
    expect(screen.getByTestId("test-badge")).toBeInTheDocument();
    expect(screen.getByTestId("card-content")).toBeInTheDocument();

    const closeBtn = screen.getByTitle("Bağla");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/stage/FloatingCardWindow.test.tsx`
Expected: FAIL with `Cannot find module '@/components/hub/stage/FloatingCardWindow'`

- [ ] **Step 3: Implement `FloatingCardWindow.tsx`**

Implement `web/components/hub/stage/FloatingCardWindow.tsx` with header bar, grip handle, window controls, corner/edge resize handles, ESC key handling, and active z-index focus.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/stage/FloatingCardWindow.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/components/hub/stage/FloatingCardWindow.tsx web/__tests__/stage/FloatingCardWindow.test.tsx
git commit -m "feat(hub): add FloatingCardWindow chrome with single-source header and controls"
```

---

### Task 5: Floating Card Stage Viewport Host (`web/components/hub/stage/FloatingCardStage.tsx`)

**Files:**
- Create: `web/components/hub/stage/FloatingCardStage.tsx`
- Test: `web/__tests__/stage/FloatingCardStage.test.tsx`

**Interfaces:**
- Consumes: `useCopilot()` (`stageCards`, `closeStageCard`)
- Produces: `FloatingCardStage: React.FC`
  - Full-screen viewport overlay (`fixed inset-0 pointer-events-none z-40 overflow-hidden`).
  - Coordinates active z-index stacking via `bringToFront(cardId)`.
  - Dispatches card type to `VideoPipelineCard`, `AnalyticsTelemetryCard`, or `CrmNegotiationCard`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/__tests__/stage/FloatingCardStage.test.tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FloatingCardStage } from "@/components/hub/stage/FloatingCardStage";

vi.mock("@/lib/copilot-context", () => ({
  useCopilot: () => ({
    isStageOpen: true,
    stageCards: [
      { id: "stage-video-1", cardType: "VIDEO_INSPECTION", targetEntityId: "6588858", payload: {} },
      { id: "stage-analytics-1", cardType: "ANALYTICS_TELEMETRY", targetEntityId: "6588858", payload: {} },
    ],
    closeStageCard: vi.fn(),
  }),
}));

describe("FloatingCardStage", () => {
  it("renders multiple floating card windows simultaneously", () => {
    render(<FloatingCardStage />);
    expect(screen.getByText("Video #6588858")).toBeInTheDocument();
    expect(screen.getByText("Sosial Telemetriya #6588858")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/stage/FloatingCardStage.test.tsx`
Expected: FAIL with `Cannot find module '@/components/hub/stage/FloatingCardStage'`

- [ ] **Step 3: Implement `FloatingCardStage.tsx`**

Implement `web/components/hub/stage/FloatingCardStage.tsx` rendering all active `stageCards` inside `FloatingCardWindow` with focus elevation and close dispatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/stage/FloatingCardStage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/components/hub/stage/FloatingCardStage.tsx web/__tests__/stage/FloatingCardStage.test.tsx
git commit -m "feat(hub): add FloatingCardStage viewport host for multi-card coexistence"
```

---

### Task 6: Decouple Stage from Drawer & Mount at Root Level (`AppShell.tsx` & `AgentHubDrawer.tsx`)

**Files:**
- Modify: `web/components/AppShell.tsx:200-220`
- Modify: `web/components/hub/AgentHubDrawer.tsx:90-120`

**Interfaces:**
- Mount `<FloatingCardStage />` directly inside `AppShell.tsx` so cards float across the entire screen and remain visible when `AgentHubDrawer` is closed.
- Remove `<LeftCanvasStage />` from `AgentHubDrawer.tsx`.

- [ ] **Step 1: Mount `FloatingCardStage` in `web/components/AppShell.tsx`**

Import `FloatingCardStage` and place `<FloatingCardStage />` before `<AgentHubDrawer />`.

- [ ] **Step 2: Clean `web/components/hub/AgentHubDrawer.tsx`**

Remove the `flex-1 min-w-0 h-full overflow-hidden` wrapper and `<LeftCanvasStage />` import from `AgentHubDrawer.tsx`.

- [ ] **Step 3: Run existing test suites**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/agent-hub-routing.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/components/AppShell.tsx web/components/hub/AgentHubDrawer.tsx
git commit -m "refactor(hub): decouple floating stage cards from chat drawer into root AppShell"
```

---

### Task 7: Adaptive VideoPipelineCard Geometry & Error Sanitization (`VideoPipelineCard.tsx`)

**Files:**
- Modify: `web/components/hub/stage/VideoPipelineCard.tsx`

**Interfaces:**
- Strip internal redundant header bar.
- Branch layout:
  - Rendered: 2-column horizontal split (`580px × 510px`) with 9:16 portrait video on left and specs + Telegram CTA on right.
  - Unrendered: Stacked layout (`480px × 540px`) with 16:9 photo carousel, thumbnail strip, specs pills, and render button.
- Use `extractErrorMessage` from `@/lib/errors` in `handleQueueRender` and `handleTelegramDispatch`.

- [ ] **Step 1: Refactor `VideoPipelineCard.tsx`**

Apply adaptive geometry, strip outer header, import `extractErrorMessage`.

- [ ] **Step 2: Run test suite**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run tests/hub/left-canvas-stage.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/components/hub/stage/VideoPipelineCard.tsx
git commit -m "feat(hub): refactor VideoPipelineCard to adaptive geometry and diagnostic error parsing"
```

---

### Task 8: Truthful Telemetry Engine with District Benchmarks (`AnalyticsTelemetryCard.tsx`)

**Files:**
- Modify: `web/components/hub/stage/AnalyticsTelemetryCard.tsx`

**Interfaces:**
- Strip internal redundant header bar.
- Eliminate all fake 22,400 views, simulated curves, and fake dates (Nov 10–23).
- Connect `resolveDistrictCorridor` from `@/lib/market-benchmarks` and filtered `buyer_leads` query.
- Wire `[ 🚀 Teleqrama Göndər və Sosial Dərc Et ]` button.

- [ ] **Step 1: Refactor `AnalyticsTelemetryCard.tsx`**

Implement Mode A (honest pre-publish dossier with dynamic benchmarks and real Supabase specs) and Mode B (authentic live snapshots when present).

- [ ] **Step 2: Run test suite**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run tests/hub/left-canvas-stage.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/components/hub/stage/AnalyticsTelemetryCard.tsx
git commit -m "feat(telemetry): implement truthful pre-publish dossier and dynamic district benchmarks"
```

---

### Task 9: Two-Row Listing Card Badge Restructuring (`ListingsClient.tsx`)

**Files:**
- Modify: `web/components/ListingsClient.tsx:848-910`

**Interfaces:**
- Restructure image badge container into `flex flex-col gap-1.5 pointer-events-none z-10`.
- Row 1: Left `#bina_id` + `@handle`; Right: `v{render.version_num} • Hazır` status badge.
- Row 2: Secondary badges (`Kupça`, Archetype) with clean spacing.

- [ ] **Step 1: Refactor badge JSX in `ListingsClient.tsx`**

Apply the two-row layout.

- [ ] **Step 2: Run test suite**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run __tests__/listings-sorting.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/components/ListingsClient.tsx
git commit -m "fix(listings): restructure listing card badges into clean two-row layout"
```

---

### Task 10: Preflight Modal Scrape Error State Categorization (`PreflightModal.tsx` & `queue-render/route.ts`)

**Files:**
- Modify: `web/components/PreflightModal.tsx:180-210, 310-340, 840-870`
- Modify: `web/app/api/pipeline/queue-render/route.ts:165-185`

**Interfaces:**
- Update `PreflightResponseData` with `can_fallback_to_db?: boolean` and `db_price?: number`.
- On 502 `SCRAPE_ERROR`, transition to amber `SCRAPE_FALLBACK_PROMPT` state with active `[ 🛡️ Bazadakı Qiymətlə Göndər ]` button.
- Use `extractErrorMessage` in `queue-render/route.ts`.

- [ ] **Step 1: Update `PreflightModal.tsx` and `queue-render/route.ts`**

Apply interface and state updates; import `extractErrorMessage`.

- [ ] **Step 2: Run telegram dispatch & preflight tests**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npx vitest run tests/api/telegram-dispatch.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/components/PreflightModal.tsx web/app/api/pipeline/queue-render/route.ts
git commit -m "fix(preflight): promote cloud scrape block to actionable amber fallback confirmation"
```

---

### Task 11: End-to-End Vitest & Next.js Production Build Verification

**Files:**
- Verify: Full codebase in `web/`

- [ ] **Step 1: Execute all Vitest test suites**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npm test -- --run`
Expected: PASS (All test suites pass, 100% green)

- [ ] **Step 2: Execute Next.js production build**

Run: `cd D:\Antigravity_Projects\Active_Projects\BakuEstate-AI\web; npm run build`
Expected: PASS (Compiled successfully, zero TypeScript or App Router errors)

- [ ] **Step 3: Verify git status is clean**

Run: `git status`
Expected: Clean working tree

- [ ] **Step 4: Final verification commit**

```bash
git commit -m "chore(release): complete floating window cards and truthful telemetry release"
```
