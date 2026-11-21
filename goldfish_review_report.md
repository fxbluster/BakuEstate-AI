# Goldfish Annotated Review Report

**Target:** `docs/designs/standalone_web_ai_engine.md` (`Lines 1-331`, `full file`)
**Status:** resolved (Round 1 Completed - 19 Fixes Accepted & Applied, 1 Item Contested)

## Prioritized Findings & AI Suggestions

### Issue 1: Conflation of `start_mcp_server.bat` with Desktop Bridge & Breaking Video Script MCP Server [`egm-zoom-out` & `egm-codebase-details`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 27-28](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L27-L28), [Lines 295-298](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L295-L298) (Phase 3, Item 9)
*   **Discrepancy Description:** The design prescribes deleting `start_mcp_server.bat` assuming it only launches the CRM squad bridge (`baku_estate_mcp_server.py`). In reality, `start_mcp_server.bat` launches `src/mcp_server.py`, the active Google AI Pro Gemini pool and real estate video script generator.
*   **Rationale:** Deleting `start_mcp_server.bat` destroys the launcher for the core video generation MCP server.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Retain `start_mcp_server.bat` and `src/mcp_server.py`. Only delete `src/mcp/baku_estate_mcp_server.py`.
*   ***Proposed Edit:***
    *   Location: Phase 3, Item 9 (Line 295)
    *   Change: Update Item 9 to delete strictly `src/mcp/baku_estate_mcp_server.py`, explicitly noting that `start_mcp_server.bat` and `src/mcp_server.py` are preserved for video pipeline tooling.

### Issue 2: Broken Runtime Import in `src/ai/squad_orchestrator.py` After MCP Deletion [`egm-codebase-details`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 295-298](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L295-L298) (Phase 3)
*   **Discrepancy Description:** `src/ai/squad_orchestrator.py` (lines 598–612) directly imports `baku_estate_queue_cockpit_card` and `baku_estate_append_timeline` from `src.mcp.baku_estate_mcp_server`. Deleting the MCP file without modifying `squad_orchestrator.py` causes immediate `ModuleNotFoundError` during worker execution.
*   **Rationale:** Dangling imports break Python background workers and call debrief routines.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Add `src/ai/squad_orchestrator.py (Modify)` to Phase 3, refactoring it to use `SupabaseRepo` methods directly.
*   ***Proposed Edit:***
    *   Location: Phase 3 (after Item 9)
    *   Change: Add `#### 10. src/ai/squad_orchestrator.py (Modify)` to replace MCP imports with direct `SupabaseRepo.queue_cockpit_card` and `SupabaseRepo.append_lead_timeline_event`.

### Issue 3: Non-Existent Python Test File `tests/test_squad_orchestrator.py` Designated as `(Modify)` [`egm-codebase-details` & `egm-implementation-readiness`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 300-304](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L300-L304) (Phase 3, Item 10), [Line 27](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L27), [Line 317](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L317)
*   **Discrepancy Description:** `tests/test_squad_orchestrator.py` does not exist in the repository, making `(Modify)` impossible to execute.
*   **Rationale:** Referencing non-existent files violates implementation readiness.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Designate as `(Create)`: `tests/test_squad_orchestrator.py (Create)` to provide dedicated isolated unit tests for `SentinelPersona`, `ScribePersona`, `StrategistPersona`, and `JanitorPersona`.
*   ***Proposed Edit:***
    *   Location: Phase 3, Item 10
    *   Change: Change to `tests/test_squad_orchestrator.py (Create)` and specify unit test cases verifying squad personas decoupled from MCP.

### Issue 4: Database Table Name Mismatch (`public.lead_timeline` vs `public.lead_timeline_events`) [`egm-codebase-details` & `egm-implementation-readiness`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 93, 118, 165](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L93)
*   **Discrepancy Description:** The design refers to `public.lead_timeline`, whereas the canonical table in Supabase and `web/lib/types.ts` is `public.lead_timeline_events`.
*   **Rationale:** PostgREST queries against `lead_timeline` return HTTP 404 relation not found.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Correct all occurrences to `public.lead_timeline_events`.
*   ***Proposed Edit:***
    *   Location: Mermaid architecture diagram, data flows, and route specifications.
    *   Change: Replace `lead_timeline` with `lead_timeline_events`.

### Issue 5: Missing Test Runner Infrastructure in `web/package.json` [`egm-codebase-details` & `egm-implementation-readiness`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 305-309, 316](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L305-L309)
*   **Discrepancy Description:** Verification plan orders running `npm test in web/`, but `web/package.json` contains no `"test"` script and no test runner (`vitest`).
*   **Rationale:** Running `npm test` fails immediately.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Add `web/package.json (Modify)` to Phase 1, installing `vitest` and configuring `"test": "vitest run"`.
*   ***Proposed Edit:***
    *   Location: Phase 1 (Target Files)
    *   Change: Add `web/package.json (Modify)` to install `vitest` and `@google/genai`.

### Issue 6: Invalid Gemini Thinking Level Parameter for `gemini-3.8-flash` [`egm-design`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 29, 146-147, 212, 243](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L29)
*   **Discrepancy Description:** `gemini-3.8-flash` does not support `thinkingLevel: 'minimal'`. Upstream Google Gemini documentation allows `"low"`, `"medium"`, `"high"`. Submitting `"minimal"` returns HTTP 400 Bad Request.
*   **Rationale:** Breaking API calls in production.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Specify `generationConfig: { thinkingLevel: 'low' }` (or uppercase enum in `@google/genai`) for `gemini-3.8-flash`.
*   ***Proposed Edit:***
    *   Location: Lines 29, 146-147, 212, 243
    *   Change: Update `thinkingLevel: 'minimal'` to `thinkingLevel: 'low'`.

### Issue 7: iOS Safari Incompatibility with `audio/webm;codecs=opus` [`egm-design` & `egm-zoom-out`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 45, 81, 163, 271](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L45)
*   **Discrepancy Description:** iOS Safari does not support recording in `audio/webm;codecs=opus`. It defaults to `audio/mp4` / `audio/aac`. Instantiating WebM throws `NotSupportedError`.
*   **Rationale:** Field brokers on iPhones cannot record call debriefs.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Implement dynamic MIME negotiation in `CopilotDrawer.tsx` (`audio/webm;codecs=opus` if supported, fallback to `audio/mp4` or `audio/aac`), forward MIME type in Gemini inlineData, and cap audio at 45 seconds. Also emphasize native keyboard dictation as a zero-overhead alternative.
*   ***Proposed Edit:***
    *   Location: Section C.3 and Phase 2, Item 5
    *   Change: Add dynamic MIME detection snippet and 45s recording ceiling.

### Issue 8: Unsubstantiated "100% Offline Resilience" Claim Without Local Storage Layer [`egm-design`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Line 30, Lines 125-135](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L30)
*   **Discrepancy Description:** `CockpitCardHUD` fetches leads live from Supabase. Offline, `leads` is `[]`, so `computeTriagedRadar` produces zero cards.
*   **Rationale:** Promising 100% offline functionality without a cache layer is ungrounded.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Add a client-side localStorage/IndexedDB caching mechanism for active leads and cockpit cards, clarifying that offline mode allows viewing cached radar and regex sanitization, while AI elevation requires connectivity.
*   ***Proposed Edit:***
    *   Location: Section A.1 and Goal 4
    *   Change: Specify `bakuestate_cached_leads_v1` and graceful offline banner.

### Issue 9: Missing Mandatory Blueprint Section "Risks & Mitigations" [`egm-structural` & `egm-design`] - Severity: 🔴 Blocker
*   **Affected Scope:** Between Lines 200 and 221
*   **Discrepancy Description:** Blueprint completely omits the mandatory `Risks & Mitigations` section and risk assessment table required by `feature-spec-standard.md`.
*   **Rationale:** Fails standard document compliance.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Insert `## Risks & Mitigations` with a 4-row matrix (Netlify serverless timeouts, API outages, iOS Safari codecs, budget hard caps).
*   ***Proposed Edit:***
    *   Location: Before `## Detailed Implementation Plan`
    *   Change: Insert standard risk matrix table.

### Issue 10: Undefined HTTP API Wire Contracts & Payload Schemas [`egm-implementation-readiness`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 234-246](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L234-L246)
*   **Discrepancy Description:** HTTP method, request schemas, and response envelopes for `/api/ai/copilot` are not formally defined.
*   **Rationale:** Violates Zero-Decision Rule.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Provide complete TypeScript discriminated union definitions for `CopilotActionPayload` and `CopilotApiResponse`.
*   ***Proposed Edit:***
    *   Location: Phase 1, Item 2
    *   Change: Insert TypeScript wire contracts.

### Issue 11: Missing Concrete TypeScript Interface Definitions in `web/lib/ai-client.ts` [`egm-implementation-readiness`] - Severity: 🔴 Blocker
*   **Affected Scope:** [Lines 247-253](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L247-L253)
*   **Discrepancy Description:** Interfaces `SentinelAuditResult`, `ScribeTemplateResult`, and `VoiceDebriefResult` are named without field declarations.
*   **Rationale:** Implementers must guess property names and casing.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Provide complete interface declarations and function signatures.
*   ***Proposed Edit:***
    *   Location: Phase 1, Item 3
    *   Change: Insert full TypeScript interfaces.

### Issue 12: Missing Blueprint Section Heading `### Target Files to Create/Modify` & Multi-File Header Congestion [`egm-structural`] - Severity: 🟡 Major
*   **Affected Scope:** [Lines 221-224, Line 295](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L221)
*   **Discrepancy Description:** Lacks `### Target Files to Create/Modify` header, and bundles two files into `#### 9`.
*   **Rationale:** Breaks automated AST parsers and file indexers.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Insert header and make each file header strictly 1:1.
*   ***Proposed Edit:***
    *   Location: Line 224 and Line 295
    *   Change: Add header and split file items.

### Issue 13: Heading Hierarchy Violation on `Verification Plan` [`egm-structural`] - Severity: 🟡 Major
*   **Affected Scope:** [Lines 310-313](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L310-L313)
*   **Discrepancy Description:** `Verification Plan` is an H2 header instead of H3 under `Detailed Implementation Plan`.
*   **Rationale:** Breaks document structural symmetry.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Change `## Verification Plan` to `### Verification Plan` and subheadings to H4.
*   ***Proposed Edit:***
    *   Location: Line 312
    *   Change: `### Verification Plan`.

### Issue 14: Mermaid Flowchart Syntax Defect [`egm-structural`] - Severity: 🟡 Major
*   **Affected Scope:** [Line 120](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L120)
*   **Discrepancy Description:** Edge targets subgraph container `Client` directly (`Route -->|...| Client`).
*   **Rationale:** Triggers Mermaid parsing warnings and layout misrenders.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Target concrete leaf node `HUD`: `Route -->|"SRE Headers: X-BakuEstate-Model-Served"| HUD`.
*   ***Proposed Edit:***
    *   Location: Line 120
    *   Change: Replace `Client` with `HUD`.

### Issue 15: Full Migration DDL and `public.check_copilot_budget()` Specification [`egm-implementation-readiness`] - Severity: 🟡 Major
*   **Affected Scope:** [Lines 225-233](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L225-L233)
*   **Discrepancy Description:** Function arguments, return type, and DDL table structure are not specified.
*   **Rationale:** Prevents deterministic database migration execution.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Provide complete SQL DDL for `ai_copilot_runs` and `check_copilot_budget()`.
*   ***Proposed Edit:***
    *   Location: Phase 1, Item 1
    *   Change: Insert full SQL code block.

### Issue 16: Missing Client-Side State Context for `CopilotDrawer` [`egm-codebase-details` & `egm-implementation-readiness`] - Severity: 🟡 Major
*   **Affected Scope:** [Lines 286-292](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L286-L292)
*   **Discrepancy Description:** Project lacks a global state library; controlling `CopilotDrawer` from `LeadsClient` and `AppShell` requires a React Context.
*   **Rationale:** Architecture was unspecified.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Add `web/lib/copilot-context.tsx (Create)` providing `CopilotProvider` and `useCopilot()`.
*   ***Proposed Edit:***
    *   Location: Phase 2
    *   Change: Add `web/lib/copilot-context.tsx` to target files.

### Issue 17: User Workflow Alignment & Tab Consolidation in `CopilotDrawer` [`egm-zoom-out`] - Severity: 🟡 Major
*   **Affected Scope:** [Lines 31-34, 154-166, 265-272](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L31)
*   **Discrepancy Description:** Splitting Sentinel (audit) and Scribe (WhatsApp) into separate tabs forces redundant tab switching for a single incoming message.
*   **Rationale:** Mobile ergonomics demand unified point-of-action response.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Unify Tab 1 into "İsmarış və Danışıq Qalxanı" (Message & Negotiation Shield) executing Sentinel audit + 1-click WhatsApp copy in one view, alongside Tab 2 "Görüş Qeydi" (Showing Debrief).
*   ***Proposed Edit:***
    *   Location: Section C and Phase 2, Item 5
    *   Change: Consolidate drawer tabs into 2 streamlined broker workflows.

### Issue 18: Stale Radar Lockout & Cache Invalidation [`egm-zoom-out`] - Severity: 🟡 Major
*   **Affected Scope:** [Lines 129-132, 277-279](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L129)
*   **Discrepancy Description:** A blind 120-minute client timer blocks radar refresh even when listings drop in price or new leads arrive.
*   **Rationale:** Brokers need immediate updates during active negotiation cycles.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Add an explicit manual `[ 🔄 Yenilə ]` refresh button on `CockpitCardHUD` and invalidate cache on database lead mutations.
*   ***Proposed Edit:***
    *   Location: Section A.2 and Phase 2, Item 6
    *   Change: Add manual refresh trigger and Supabase Realtime debounce.

### Issue 19: Elimination of Redundant Phone Logic & Card Status Casing [`egm-zoom-out` & `egm-codebase-details`] - Severity: 🟢 Nit
*   **Affected Scope:** [Lines 169-171, 262](file:///C:/Users/HP/BakuEstate-AI/docs/designs/standalone_web_ai_engine.md#L169)
*   **Discrepancy Description:** Phone normalization is already implemented in `web/lib/format.ts` (`normalizePhoneInput`), and card status must be strictly uppercase `'PENDING'`.
*   **Rationale:** Codebase reuse and consistency with existing DB records.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Import and reuse `normalizePhoneInput` and `buildWhatsAppUrl` directly from `@/lib/format`, and enforce uppercase status enum.
*   ***Proposed Edit:***
    *   Location: Section D.2 and Phase 2, Item 4
    *   Change: Update imports to reuse `@/lib/format`.

### Issue 20: Proposal to Completely Drop `public.ai_copilot_runs` Table [`egm-zoom-out`] - Severity: 🟡 Major
*   **Affected Scope:** Lines 172-177, Phase 1, Item 1
*   **Discrepancy Description:** Reviewer suggests dropping `public.ai_copilot_runs` completely and relying solely on Google Cloud budget alerts.
*   ***AI Suggestion:*** CONTEST
*   ***Justification:** Citing evidence: Citadel and BakuEstate-AI require SRE telemetry headers (`X-BakuEstate-Run-Id`) and immediate in-app budget warning toasts ($8.00 warning, $10.00 stop) that Google Cloud billing alerts (which have a 12-24 hour propagation delay) cannot provide. However, we simplify the table structure to an indexed lightweight log with an atomic monthly counter to eliminate performance overhead.
