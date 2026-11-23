# Goldfish Annotated Review Report

**Target:** `docs/designs/native_dual_voice_and_cinematic_compositor_v2.md` (`Lines 1-337`)  
**Status:** resolved (9 fixes accepted and applied)

## Prioritized Findings & AI Suggestions

### 1. Non-Existent Method Call `VideoCompositor.compose_reel_video` [`egm-design`, `egm-implementation-readiness`, `egm-codebase-details`] - Severity: Blocker
*   **Affected Scope:** [Lines 212–215](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L212-L215) & [Line 309](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L309)
*   **Discrepancy Description:** The design states `scripts/rerender_degraded_batch.py` calls `VideoCompositor.compose_reel_video`. `VideoCompositor` has no such method; the production method is `build_cinematic_video()`.
*   **Rationale:** Runtime `AttributeError` halts the re-render script immediately upon execution.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Standardize the batch re-render script to call `BakuEstatePipeline.process_listing_video_and_dispatch()` (which uses `build_cinematic_video` internally and handles storage uploads and versioning).
*   ***Proposed Edit:***
    *   Location: Subsystem C (Lines 212–215) and Target File 6 (Lines 305–312).
    *   Change: Replace manual compositing calls with `BakuEstatePipeline.process_listing_video_and_dispatch(listing, voice_id=voice_id, trigger_reason="MANUAL_RERENDER", skip_telegram_dispatch=True)`.

---

### 2. Missing Subsystem Files in Implementation Plan (`glass_badge.py`, `kinetic_subtitles.py`, `motion_engine.py`) [`egm-design`, `egm-implementation-readiness`, `egm-codebase-details`] - Severity: Blocker
*   **Affected Scope:** [Lines 257–320](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L257-L320)
*   **Discrepancy Description:** The Detailed Implementation Plan only lists `ffmpeg_compositor.py`. However, production cinematic video delegates subtitle styling/jumping to `kinetic_subtitles.py`, badges and watermark to `glass_badge.py`, and scene pacing to `motion_engine.py`.
*   **Rationale:** An engineer editing only `ffmpeg_compositor.py` leaves production kinetic subtitles (`font_size=64`, jumping `margin_v_cta=660`) and badge dimensions untouched.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Add `src/media/kinetic_subtitles.py`, `src/media/glass_badge.py`, and `src/media/motion_engine.py` to the target files enumeration with concrete change descriptions.
*   ***Proposed Edit:***
    *   Location: Target Files to Modify (after line 304).
    *   Change: Add entries for `src/media/kinetic_subtitles.py` (`margin_v=540`, disable `margin_v_cta` vertical jumping, `font_size=52`), `src/media/glass_badge.py` (`create_logo_watermark` scale 180x40, hero badge timing), and `src/media/motion_engine.py`.

---

### 3. Non-Existent Test Path `tests/test_account_router.py` & Test Assertion Breakage [`egm-implementation-readiness`, `egm-codebase-details`] - Severity: Blocker
*   **Affected Scope:** [Lines 313–319](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L313-L319) & [Line 325](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L325)
*   **Discrepancy Description:** `tests/test_account_router.py` does not exist (router tests live in `tests/test_tts.py:450-520`). Furthermore, `tests/test_tts.py:282-285` hardcodes assertions for old stability=0.52, similarity=0.82, style=0.28, which will fail when defaults are updated.
*   **Rationale:** Running the test command will fail with file not found, and unit tests will fail on updated ElevenLabs parameters.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Target `tests/test_tts.py` directly, update router test assertions for Arif/Ayan, and update `test_elevenlabs_speed_parameter_serialized` to assert 0.50/0.85/0.20.
*   ***Proposed Edit:***
    *   Location: Target File 7 and Verification Plan.
    *   Change: Set target to `tests/test_tts.py (Modify)` and verification command to `pytest tests/test_tts.py -v`.

---

### 4. Watermark Geometric Clipping at Canvas Border (`840 + 330 = 1170px > 1080px`) [`egm-design`, `egm-implementation-readiness`, `egm-codebase-details`] - Severity: Major
*   **Affected Scope:** [Lines 179–181](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L179-L181) & [Line 300](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L300)
*   **Discrepancy Description:** `create_logo_watermark` produces an image of `330x74` px. Placing it at `x=840` overflows the 1080px canvas by 90 pixels, cutting off the watermark.
*   **Rationale:** Visual defect on all rendered videos.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Scale watermark to compact pill dimensions (`180x40` px) in `glass_badge.py` or scale in FFmpeg filtergraph, and place at `x=860, y=24` (yielding `860 + 180 = 1040 < 1080px`, a clean 40px margin).
*   ***Proposed Edit:***
    *   Location: Subsystem B.1 (Line 181) and Target File 5.
    *   Change: Specify watermark dimensions `180x40` and fixed position `x=860, y=24`.

---

### 5. Audio Filtergraph Distortion & Muffling in Mix Chain [`egm-design`] - Severity: Major
*   **Affected Scope:** [Lines 192–199](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L192-L199)
*   **Discrepancy Description:** Summing voice (1.0), ducked music (0.15–0.25), and SFX (0.35) in `amix` without a limiter peaks up to +3.5 dBFS causing digital clipping. Static `lowpass=f=3500` on background track permanently muffles music during speech pauses.
*   **Rationale:** Degrades audio fidelity on mobile devices.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Add peak limiter `alimiter=limit=0.95:attack=5:release=50` to the mixed audio output and replace static lowpass with gentle high-shelf attenuation or calibrate ducking sidechain parameters cleanly.
*   ***Proposed Edit:***
    *   Location: Subsystem B.2 (Lines 193–199).
    *   Change: Append `alimiter=limit=0.95:attack=5:release=50` to audio mix chain and set ducking sidechain `threshold=0.06:ratio=4:attack=25:release=300`.

---

### 6. Fallback Chain Leaking OpenAI English & Mismapping Ayan to Male [`egm-design`, `egm-codebase-details`] - Severity: Major
*   **Affected Scope:** [Lines 272–279](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L272-L279) & [Lines 289–296](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L289-L296)
*   **Discrepancy Description:**
    1. `account_router.py:26` still has `EXAVITQu4vr4xnSDxMaL` in `except ImportError`.
    2. `tts_service.py:607` has `eleven_voice_id = voice_id or "EXAVITQu4vr4xnSDxMaL"`.
    3. `tts_service.py:766` does not map `DZaip8UahF0Qri1FxU8M` or `"ayan"` to `az-AZ-BanuNeural` (falling back to male Babek).
    4. `tts_service.py:732` falls back to OpenAI TTS (`tts-1`) on ElevenLabs error, which outputs English.
*   **Rationale:** Violates "Zero Foreign Voice Leakage" requirement.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Purge `EXAVITQu4vr4xnSDxMaL` completely from all files, add `DZaip8UahF0Qri1FxU8M` and `ayan` to `az-AZ-BanuNeural` check, and bypass OpenAI TTS fallback directly to Edge-TTS.
*   ***Proposed Edit:***
    *   Location: Subsystem A & Target Files 2 & 4.
    *   Change: Update fallback mappings in `account_router.py` and `tts_service.py`.

---

### 7. Subtitle Baseline and ASS Coordinate Math [`egm-design`, `egm-codebase-details`] - Severity: Major
*   **Affected Scope:** [Lines 183–187](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L183-L187)
*   **Discrepancy Description:** In ASS (height 1920), baseline `y=1380px` requires `MarginV = 1920 - 1380 = 540`, whereas the doc said `MarginV=500` (which is `y=1420`). Also, the CTA badge in `glass_badge.py` is at `y=1380`. Subtitles and CTA badge must not overlap.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Correct ASS math: baseline `y=1340px` with `MarginV=580` or `MarginV=540`, and ensure CTA badge sits at `y=1480-1600` or subtitles safe-shift is cleanly coordinated without erratic jumping.
*   ***Proposed Edit:***
    *   Location: Subsystem B.1.
    *   Change: Set `MarginV=540` (`y=1380px`), set CTA badge `y=1540`, enforce agency phone `AGENCY_WHATSAPP_PHONE` on CTA card.

---

### 8. Formal Resolution of Open Questions [`egm-design`, `egm-implementation-readiness`] - Severity: Nit
*   **Affected Scope:** [Lines 68–74](file:///c:/Users/HP/BakuEstate-AI/docs/designs/native_dual_voice_and_cinematic_compositor_v2.md#L68-L74)
*   **Discrepancy Description:** Open Questions 1 & 2 are listed with multiple options in an Approved spec.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Justification:** Record definitive resolutions: Question 1 -> Option B (Deterministic per-channel routing in `account_router.py` with Arif/Ayan); Question 2 -> Incremental versioning (`v2`/`v3`) via `get_next_render_version_num()`.
*   ***Proposed Edit:***
    *   Location: Open Questions (Lines 68–74).
    *   Change: Convert to "Resolved Design Decisions".

---

### 9. Duplicate Return in `src/media/tts_service.py` [`egm-codebase-details`] - Severity: Nit
*   **Affected Scope:** `src/media/tts_service.py` Lines 471-473
*   **Discrepancy Description:** `return " ".join(parts)` duplicated consecutively.
*   ***AI Suggestion:*** `PROPOSE FIX`
*   ***Proposed Edit:*** Remove line 473.
