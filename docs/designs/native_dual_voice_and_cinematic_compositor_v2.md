# BakuEstate Video Pipeline Audio & Montage Elevation: Native ElevenLabs Dual-Voice Engine & Cinematic Video Compositor V2

*   **Author:** Elvin Ismailov (fxbluster)
*   **Status:** Implemented (In Production)
*   **Date:** 2026-11-23

--------------------------------------------------------------------------------

## Overview

BakuEstate-AI operates an autonomous video production and real estate intelligence pipeline that converts Bina.az property listings into vertical 9:16 promotional reels for social distribution across Instagram, TikTok, and Telegram CRM.

Following recent worker and video pipeline updates, quality regression occurred across six newly generated property videos (#6343052, #6304638, #5867067, #6567513, #6560444, #6589921). Two critical flaws degraded output:
1. **Unnatural Foreign Voice Narration**: Listings routed to affordable channels or female voice profiles used an English ElevenLabs voice ID (`EXAVITQu4vr4xnSDxMaL` / Sarah), producing jarring, accent-broken Azerbaijani speech instead of native speech.
2. **Degraded Video Montage Composition**: Recent changes to FFmpeg filtergraphs, badge timings, watermark overlay positioning, and kinetic subtitle safe zones cluttered the visual hierarchy, causing visual collisions with listing metadata cards and awkward scene pacing compared to the original 17 benchmark videos.

This design document establishes the architecture to elevate voice narration and video compositing:
- Migrating fully to an authenticated, verified dual-voice ElevenLabs engine using native Azerbaijani voices:
  - **Arif (Male Narrator)**: `ZQJv3hwvRAIC7fvWZ1Qr` (the benchmark voice from the original 17 videos)
  - **Ayan (Female Narrator)**: `DZaip8UahF0Qri1FxU8M` (new native Azerbaijani female voice)
- Eliminating all foreign or robotic voice IDs across configurations and routing layers.
- Leveraging the available **33,030,627 ElevenLabs character quota** with production stability and expressiveness parameters (`stability: 0.50`, `similarity_boost: 0.85`, `style: 0.20`).
- Overhauling the FFmpeg compositing pipeline to restore and refine clean visual layering, safe-zone typography, natural scene pacing, and balanced audio ducking with peak limiting.
- Executing an automated re-render of the six degraded videos.

--------------------------------------------------------------------------------

## The Problem

1. **Foreign English Voice Allocation in Azerbaijani Content**:
   Inspection of `config/settings.py`, `src/worker/account_router.py`, and `src/media/tts_service.py` reveals that `ELEVENLABS_VOICE_BANU` defaulted to `EXAVITQu4vr4xnSDxMaL` (Sarah, an English ElevenLabs voice). When listings routed to affordable channels (`@baku.serfeli.evler`) or female profiles, ElevenLabs Multilingual V2 synthesized Azerbaijani scripts using an English vocal base. This produced an unnatural, heavily accented narration unacceptable for local property marketing. Furthermore, fallback chains incorrectly fell back to OpenAI TTS (`tts-1`), which produces English gibberish on Azerbaijani text.

2. **Visual Hierarchy Clutter and Filtergraph Regression**:
   Recent modifications in `src/media/ffmpeg_compositor.py` and `src/media/kinetic_subtitles.py` altered subtitle positioning (`margin_v=580`), introduced aggressive CTA safe-shifting (`margin_v_cta=660`) that produced visual jumping, placed an oversized `330x74` watermark at `x=840` that clipped off the canvas right border by 90px, and cut hero badge duration to under 2.5 seconds. The resulting reels felt cluttered and disjointed compared to the clean visual balance of earlier versions.

3. **Inconsistent Audio Ducking, Muffling & Volume Distortion**:
   Background lounge beats and sound effects frequently overwhelmed voice narration or ducked abruptly. Applying a static 3.5kHz lowpass filter permanently muffled background music sparkle even during non-speech pauses, and summing audio streams in `amix` without a peak limiter created digital clipping (+3.5 dBFS).

4. **Staged Video Quality Inconsistency**:
   Six active listings (#6343052, #6304638, #5867067, #6567513, #6560444, #6589921) currently host degraded render versions in Supabase Storage and CRM views, misrepresenting system capabilities to operators and brokers.

--------------------------------------------------------------------------------

## Goals

*   **Goal 1 (Native Dual-Voice Engine)**: Standardize all ElevenLabs speech synthesis strictly on two verified native Azerbaijani voice IDs:
    *   Male Narrator (Arif): `ZQJv3hwvRAIC7fvWZ1Qr`
    *   Female Narrator (Ayan): `DZaip8UahF0Qri1FxU8M`
*   **Goal 2 (Zero Foreign Voice Leakage & Safe Fallback)**: Purge `EXAVITQu4vr4xnSDxMaL` and any other unverified foreign voice IDs from settings, router heuristics, and fallback chains. Ensure ElevenLabs failover bypasses OpenAI TTS and maps directly to Edge-TTS Azerbaijani voices (`az-AZ-BabekNeural` for male, `az-AZ-BanuNeural` for female).
*   **Goal 3 (Cinematic Montage Overhaul)**: Refactor `src/media/ffmpeg_compositor.py`, `src/media/kinetic_subtitles.py`, and `src/media/glass_badge.py` to restore:
    *   Clean 3-tier visual hierarchy: top glassmorphic luxury card (`y=70`), unobstructed central room walkthrough, and bottom verified safe-zone call-to-action.
    *   Subtitles locked to mobile social safe zones (`MarginV=540`, baseline `y=1380px`) without vertical jumping during CTA transitions.
    *   Compact, proportional watermark (`180x40` px) positioned at `x=860, y=24` (clean 40px margin from canvas edge).
    *   Smooth Ken Burns motion transitions with hero badge display maintained for minimum 3.2 seconds.
*   **Goal 4 (Acoustic Clarity, Ducking & Peak Limiting)**: Calibrate FFmpeg sidechain compression so background music sits at an ambient -18dB during narration and cleanly swells only during intro/outro pauses, with `alimiter` preventing clipping distortion.
*   **Goal 5 (Automated Re-render of Degraded Batch)**: Queue and re-render the six target listings (#6343052, #6304638, #5867067, #6567513, #6560444, #6589921) via `BakuEstatePipeline.process_listing_video_and_dispatch()`, committing upgraded v2/v3 renders to Supabase Storage and updating CRM metadata.

--------------------------------------------------------------------------------

## Non-Goals

*   **Non-Goal 1**: Replacing the underlying FFmpeg compositing engine with cloud-based GPU render SaaS (e.g. Creatomate or Shotstack). Local hardware-accelerated FFmpeg provides zero-marginal-cost rendering.
*   **Non-Goal 2**: Introducing AI avatar or face generation (e.g. HeyGen or D-ID). The platform focuses strictly on authentic architectural photography with voiceover narration.
*   **Non-Goal 3**: Altering Next.js CRM frontend architecture or database schema. Existing `render_versions` and `pipeline_jobs` tables fully support versioned re-renders.

--------------------------------------------------------------------------------

## Resolved Design Decisions

*   **Decision 1 (Voice Assignment Strategy)**: Deterministic per-channel routing in `account_router.py`:
    *   `ACCOUNT_LUXURY` (`@bakuestate.premium`) & `ACCOUNT_GENERAL` (`@bakuestate.official`) -> Arif (`ZQJv3hwvRAIC7fvWZ1Qr`).
    *   `ACCOUNT_AFFORDABLE` (`@baku.serfeli.evler`) & `ACCOUNT_TIKTOK` (`@baku_emlak_ai`) -> Ayan (`DZaip8UahF0Qri1FxU8M`).
    *   Manual override supported in CRM Left-Canvas Stage via explicit `voice_id` parameter.
*   **Decision 2 (Version Incrementation & Auditability)**: Incremental version generation (`v2` or `v3`) via `get_next_render_version_num()`, marking previous render records as `SUPERSEDED` to maintain full historical audit trails in Supabase.
*   **Decision 3 (Public Reel Contact Number)**: CTA badge on public reels displays `AGENCY_WHATSAPP_PHONE` exclusively, protecting direct owner privacy and ensuring commercial lead capture.

--------------------------------------------------------------------------------

## Critical User Journeys (CUJs)

### CUJ 1: Autonomous Ingestion & High-Fidelity Reel Synthesis

*   **Given**: A newly scraped property listing in Baku (e.g. 3-room renovated apartment in Yasamal).
*   **When**: `local_worker.py` picks up the `RENDER_INITIAL` job.
*   **Then**:
    1. System selects appropriate native voice (Arif `ZQJv3hwvRAIC7fvWZ1Qr` or Ayan `DZaip8UahF0Qri1FxU8M`).
    2. ElevenLabs synthesizes studio-grade Azerbaijani audio using `eleven_multilingual_v2` with frame-accurate word timestamps.
    3. Compositor builds 9:16 vertical video with smooth motion, safe-zone kinetic subtitles, and balanced background audio ducking.
    4. Render completes and uploads to Supabase Storage; listing badge in web CRM reflects `DRAFT_READY` with pristine audio and visual quality.

### CUJ 2: 1-Click Rerender with Voice Switch from Web CRM

*   **Given**: An operator views a listing card in the web CRM Left-Canvas Stage.
*   **When**: The operator selects "Ayan (Qadın)" or "Arif (Kişi)" from the voice dropdown and clicks `[ 🔄 Yenidən Montaj Et ]`.
*   **Then**:
    1. Serverless gateway enqueues `RERENDER` job with `voice_id` payload.
    2. Worker renders new version with requested voice and updated montage.
    3. New video appears in CRM video player without page reload.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. High-Level Media Pipeline & Dual-Voice Flow

```mermaid
flowchart TD
    subgraph Ingestion ["Listing Metadata & Archetype"]
        L["Property Listing (bina_id, photos, price, location)"] --> AR["src/worker/account_router.py"]
    end

    subgraph VoiceRouting ["Native Dual-Voice Decision"]
        AR -->|Elite / Luxury (>=250k AZN) or General| V_MALE["Arif (ZQJv3hwvRAIC7fvWZ1Qr)"]
        AR -->|Suburban / Affordable (<=120k AZN) or TikTok| V_FEMALE["Ayan (DZaip8UahF0Qri1FxU8M)"]
        CRM_VOICE["CRM Manual Voice Override"] -.->|Explicit voice_id| TTS_S["src/media/tts_service.py"]
        V_MALE --> TTS_S
        V_FEMALE --> TTS_S
    end

    subgraph ElevenLabsEngine ["ElevenLabs SOTA Synthesis (33M Quota)"]
        TTS_S --> EL["src/media/elevenlabs_tts.py"]
        EL -->|model: eleven_multilingual_v2\nstability: 0.50, similarity: 0.85, style: 0.20| EL_API["ElevenLabs /with-timestamps API"]
        EL_API --> AUDIO["voice_{id}_v{n}.mp3 (44.1kHz 128kbps)"]
        EL_API --> SRT["subs_{id}_v{n}.srt (Word-Level Karaoke Timestamps)"]
    end

    subgraph CompositorV2 ["Cinematic Video Compositor V2 (FFmpeg)"]
        PHOTOS["Downloaded High-Res Photos"] --> ME["src/media/motion_engine.py (Ken Burns Pan/Zoom)"]
        ME --> RAW_VIDEO["walkthrough_raw.mp4 (1080x1920 30fps)"]
        RAW_VIDEO --> COMP["src/media/ffmpeg_compositor.py (build_cinematic_video)"]
        AUDIO --> COMP
        SRT --> KS["src/media/kinetic_subtitles.py\nMarginV=540, font_size=52, static baseline"]
        KS --> COMP
        MUSIC["assets/music/{niche_track}.mp3"] --> COMP
        GB["src/media/glass_badge.py\nWatermark 180x40 at x=860, y=24\nHero badge 3.2s at y=186\nCTA badge at y=1540"] --> COMP
    end

    subgraph Output ["Cloud Storage & CRM Dispatch"]
        COMP --> OUT_MP4["Supabase Storage: videos/{bina_id}/v{n}.mp4"]
        OUT_MP4 --> DB_VERSIONS["render_versions (status: COMPLETED)"]
        DB_VERSIONS --> CRM_VIEW["Web CRM Dashboard / Video Player"]
    end
```

---

### 2. Subsystem Specifications

#### Subsystem A: Native Dual-Voice Engine (`config/settings.py`, `src/media/elevenlabs_tts.py`, `src/worker/account_router.py`, `src/media/tts_service.py`)

1. **Voice Configuration Standard**:
   - `ELEVENLABS_VOICE_ARIF`: Strictly `ZQJv3hwvRAIC7fvWZ1Qr` (Male Narrator).
   - `ELEVENLABS_VOICE_AYAN`: Strictly `DZaip8UahF0Qri1FxU8M` (Female Narrator).
   - Deprecate and completely purge `EXAVITQu4vr4xnSDxMaL` (Sarah - English) from all files (including `except ImportError` fallback blocks in `account_router.py` and `tts_service.py`).
   - Default fallback voice: `ELEVENLABS_VOICE_ARIF`.

2. **Synthesis Parameter Tuning (ElevenLabs Multilingual V2)**:
   - `stability`: `0.50` (natural vocal cadence and breathing).
   - `similarity_boost`: `0.85` (vocal clarity and distinction).
   - `style`: `0.20` (subtle stylistic expressiveness).
   - `use_speaker_boost`: `True` (low-end warmth and broadcast presence).
   - `concurrency_retry`: Exponential backoff on HTTP 429 / 503 (3 attempts: 1.5s, 3.0s delay).

3. **Deterministic Channel Routing & Failover Sanitation**:
   - `ACCOUNT_LUXURY` (`@bakuestate.premium`) & `ACCOUNT_GENERAL` (`@bakuestate.official`): Assigned to **Arif** (`ZQJv3hwvRAIC7fvWZ1Qr`).
   - `ACCOUNT_AFFORDABLE` (`@baku.serfeli.evler`) & `ACCOUNT_TIKTOK` (`@baku_emlak_ai`): Assigned to **Ayan** (`DZaip8UahF0Qri1FxU8M`).
   - On ElevenLabs failure: Bypass OpenAI TTS completely. Fallback directly to Edge-TTS:
     - Male profiles -> `az-AZ-BabekNeural`.
     - Female profiles (`"dzaip8uahf0qri1fxu8m"`, `"ayan"`, `"female"`, `"eleven_female"`) -> `az-AZ-BanuNeural`.

---

#### Subsystem B: Cinematic Video Compositor V2 (`src/media/ffmpeg_compositor.py`, `src/media/glass_badge.py`, `src/media/kinetic_subtitles.py`)

1. **1080x1920 Vertical Visual Hierarchy**:
   - **Watermark Badge** (`src/media/glass_badge.py`):
     - Output dimensions resized from `330x74` to compact pill: `width=180, height=40`.
     - Placed at `x=860, y=24` (40px margin from canvas edge, 0px overlap with header card).
   - **Hero Badge Display**:
     - Maintained for `min 3.2s` (`hero_end_time = min(3.2, max(1.5, total_duration - 1.5))`).
   - **Kinetic Subtitles** (`src/media/kinetic_subtitles.py`):
     - Baseline: `MarginV=540` (`y = 1920 - 540 = 1380px`).
     - Subtitle font size: `52px` (Segoe UI Bold, TikTok yellow `&H0000FFFF`, black outline `3.5px`, soft shadow `1.5px`).
     - Disable vertical jumping: `margin_v_cta = margin_v = 540` (subtitles remain stationary in safe zone).
   - **Bottom Contact / CTA Card** (`src/media/glass_badge.py`):
     - Positioned at `y=1540` (`height=140px`, clear of TikTok UI marquee and above footer buttons).
     - Contact number resolved strictly from `AGENCY_WHATSAPP_PHONE` (never raw scraped owner phone).

2. **Acoustic Audio Ducking & Peak Limiting Filtergraph**:
   - Voice narration: `volume=1.0`.
   - Background music:
     - Pre-volume: `0.25` (-12 dBFS).
     - Sidechain compression: `sidechaincompress=threshold=0.06:ratio=4:attack=25:release=300`.
     - Static 3.5kHz lowpass cut removed to preserve acoustic sparkle during speech pauses.
   - Master audio peak limiter:
     - Appended to `amix` chain: `[amixed]alimiter=limit=0.95:attack=5:release=50[a_out]`, eliminating digital clipping distortion.

---

#### Subsystem C: Batch Re-render Execution (`scripts/rerender_degraded_batch.py`)

1. **Target Listings Scope**:
   - `#6343052` (25,000 AZN, @baku.serfeli.evler) -> Re-render with Ayan female voice (`DZaip8UahF0Qri1FxU8M`).
   - `#6304638` (209,000 AZN, @bakuestate.official) -> Re-render with Arif male voice (`ZQJv3hwvRAIC7fvWZ1Qr`).
   - `#5867067` (812,900 AZN, @bakuestate.premium) -> Re-render with Arif male voice (`ZQJv3hwvRAIC7fvWZ1Qr`).
   - `#6567513` (4,650,000 AZN, @bakuestate.premium) -> Re-render with Arif male voice (`ZQJv3hwvRAIC7fvWZ1Qr`).
   - `#6560444` (138,000 AZN, @baku.serfeli.evler) -> Re-render with Ayan female voice (`DZaip8UahF0Qri1FxU8M`).
   - `#6589921` (279,000 AZN, @bakuestate.premium) -> Re-render with Arif male voice (`ZQJv3hwvRAIC7fvWZ1Qr`).

2. **Execution Flow (Pipeline Reuse)**:
   - Script instantiates `BakuEstatePipeline(enable_supabase=True)`.
   - Iterates through the 6 listings sequentially (with 1.5s delay to avoid ElevenLabs concurrency throttling).
   - Calls `pipeline.process_listing_video_and_dispatch(listing, voice_id=designated_voice, trigger_reason="MANUAL_RERENDER", skip_telegram_dispatch=True)`.
   - Automatically handles photo downloads, incremental version numbering (`v2`/`v3`), Supabase Storage asset upload, and updating `render_versions` to `COMPLETED` and `listings.pipeline_status = 'DRAFT_READY'`.

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Edge-TTS Fallback for Affordable / Budget Listings

*   **Pros**: Zero marginal token or API cost; no dependency on ElevenLabs network availability.
*   **Cons**: Microsoft Edge-TTS voices (`az-AZ-BabekNeural`, `az-AZ-BanuNeural`) exhibit flat, robotic cadence, unnatural vowel elongation on numbers, and lack the emotional nuance and conversational breathing necessary for high-converting social media reels.
*   **Reason for Rejection**: *Rejected by author*: With over 33,000,000 ElevenLabs characters available in the active account, economizing on voice quality is technically and commercially unjustified. Native studio-grade ElevenLabs synthesis must be standard across all tiers.

### Alternative B: Cloud-Based Headless Video Rendering (Creatomate / Remotion Cloud / Shotstack)

*   **Pros**: Offloads video compositing from the local workstation; enables horizontal auto-scaling during large scrape bursts.
*   **Cons**: Incurs recurring monthly SaaS subscription fees or per-render usage charges ($0.15–$0.40 per video); introduces latency transferring raw high-resolution listing photos across external APIs; requires complex third-party webhook handlers.
*   **Reason for Rejection**: *Rejected by author*: The local Windows workstation provides dedicated hardware acceleration and zero marginal rendering cost. The tuned FFmpeg compositing pipeline renders a 35-second vertical reel in 8–12 seconds locally without external network dependencies.

### Alternative C: Single Universal Voice (Arif Male Narrator Only)

*   **Pros**: Simplifies routing logic and eliminates voice mapping configuration.
*   **Cons**: Homogenizes video production across all channels. Market audience telemetry shows that fast-paced TikTok formats and affordable suburban family homes benefit from a warm, dynamic female voice (Ayan), whereas luxury penthouses and investment properties align with Arif's authoritative, grounded tone.
*   **Reason for Rejection**: *Rejected by author*: Deploying a dual-voice strategy (Arif + Ayan) preserves channel identity, audience targeting, and A/B learning opportunities without adding operational overhead.

--------------------------------------------------------------------------------

## Non-Functional Requirements

### 1. Security & Secrets Management
*   `ELEVENLABS_API_KEY` remains strictly confined to `C:\Users\HP\BakuEstate-AI\.env` and `web/.env.local`.
*   Both environment files are explicitly tracked in `.gitignore` and must never appear in console logs, commit messages, or database records.

### 2. Performance & Latency Budgets
*   **TTS Synthesis Latency**: Under 3.5 seconds per 45-word Azerbaijani script via ElevenLabs with-timestamps REST API endpoint (with 15.0s network timeout safety cushion).
*   **Video Compositing Speed**: Under 15 seconds per 1080x1920 30fps reel using local FFmpeg multicore execution.
*   **Total End-to-End Re-render Time**: Under 25 seconds per listing from trigger to Supabase Storage upload.

### 3. Rollout & Rollback
*   **Rollout**: Immediate local configuration update in `config/settings.py` and `account_router.py`, followed by execution of `scripts/rerender_degraded_batch.py` to upgrade the six degraded listings.
*   **Rollback**: If ElevenLabs experiences an upstream API outage, the pipeline retains the existing Edge-TTS fallback circuit breaker (`synthesize_speech_async`) without crashing the worker.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `config/settings.py` (Modify)
*   **Type / Scope**: Global Application & Environment Configuration.
*   **Proposed Changes**:
    *   Define `ELEVENLABS_VOICE_ARIF = os.getenv("ELEVENLABS_VOICE_ARIF", "ZQJv3hwvRAIC7fvWZ1Qr")`.
    *   Define `ELEVENLABS_VOICE_AYAN = os.getenv("ELEVENLABS_VOICE_AYAN", "DZaip8UahF0Qri1FxU8M")`.
    *   Set `ELEVENLABS_VOICE_BANU = ELEVENLABS_VOICE_AYAN` for backward compatibility.
    *   Set `ELEVENLABS_VOICE_ID = ELEVENLABS_VOICE_ARIF`.
    *   Remove all references and fallback occurrences of the English voice ID `EXAVITQu4vr4xnSDxMaL`.

#### 2. `src/worker/account_router.py` (Modify)
*   **Type / Scope**: Multi-Account Channel Routing Engine.
*   **Proposed Changes**:
    *   Import `ELEVENLABS_VOICE_ARIF` and `ELEVENLABS_VOICE_AYAN` from `config.settings`.
    *   Update `except ImportError` fallback to define `ELEVENLABS_VOICE_AYAN = "DZaip8UahF0Qri1FxU8M"`.
    *   Update `route_listing_to_channel`:
        *   Affordable (`ACCOUNT_AFFORDABLE` / `@baku.serfeli.evler`) -> `voice_id: ELEVENLABS_VOICE_AYAN` (`DZaip8UahF0Qri1FxU8M`), `voice_speed: 1.0`.
        *   TikTok (`ACCOUNT_TIKTOK` / `@baku_emlak_ai`) -> `voice_id: ELEVENLABS_VOICE_AYAN` (`DZaip8UahF0Qri1FxU8M`), `voice_speed: 1.15`.
        *   Luxury (`ACCOUNT_LUXURY` / `@bakuestate.premium`) -> `voice_id: ELEVENLABS_VOICE_ARIF` (`ZQJv3hwvRAIC7fvWZ1Qr`), `voice_speed: 1.0`.
        *   General (`ACCOUNT_GENERAL` / `@bakuestate.official`) -> `voice_id: ELEVENLABS_VOICE_ARIF` (`ZQJv3hwvRAIC7fvWZ1Qr`), `voice_speed: 1.0`.

#### 3. `src/media/elevenlabs_tts.py` (Modify)
*   **Type / Scope**: ElevenLabs Studio Voice Synthesis Service.
*   **Proposed Changes**:
    *   Update `ELEVENLABS_VOICE_ALIASES`:
        *   `"arif"`, `"male"`, `"eleven_male"` -> `ELEVENLABS_VOICE_ARIF` (`ZQJv3hwvRAIC7fvWZ1Qr`).
        *   `"ayan"`, `"female"`, `"banu"`, `"eleven_female"` -> `ELEVENLABS_VOICE_AYAN` (`DZaip8UahF0Qri1FxU8M`).
    *   Tune default voice synthesis parameters:
        *   `stability: 0.50`, `similarity_boost: 0.85`, `style: 0.20`, `use_speaker_boost: True`.
    *   Add exponential backoff retry loop on HTTP 429 / 503 (3 attempts: 1.5s, 3.0s delay).

#### 4. `src/media/tts_service.py` (Modify)
*   **Type / Scope**: Unified TTS Service & Edge-TTS Fallback.
*   **Proposed Changes**:
    *   Update `_resolve_tts_routing`:
        *   Resolve `eleven_female` and `ayan` to `DZaip8UahF0Qri1FxU8M`.
        *   Resolve `eleven_male` and `arif` to `ZQJv3hwvRAIC7fvWZ1Qr`.
        *   Purge `EXAVITQu4vr4xnSDxMaL` on line 607.
    *   Update failover: Bypass OpenAI TTS on ElevenLabs error; fall back directly to Edge-TTS.
    *   In Edge-TTS fallback check (line 766): Include `"dzaip8uahf0qri1fxu8m"` and `"ayan"` in `az-AZ-BanuNeural` routing.
    *   Remove duplicate return statement on line 473.

#### 5. `src/media/glass_badge.py` (Modify)
*   **Type / Scope**: Glassmorphic Badge & Watermark Generator.
*   **Proposed Changes**:
    *   Resize `create_logo_watermark` output to `width=180, height=40`.
    *   Ensure CTA contact badge at `y=1540` displays `AGENCY_WHATSAPP_PHONE` exclusively.

#### 6. `src/media/kinetic_subtitles.py` (Modify)
*   **Type / Scope**: Kinetic ASS Subtitle Burner.
*   **Proposed Changes**:
    *   Set default subtitle baseline `margin_v=540` (`y=1380px`).
    *   Disable vertical jumping by setting `margin_v_cta = margin_v = 540`.
    *   Set subtitle `font_size=52`.

#### 7. `src/media/ffmpeg_compositor.py` (Modify)
*   **Type / Scope**: FFmpeg Video Compositing & Filtergraph Engine.
*   **Proposed Changes**:
    *   In `build_cinematic_video()`:
        *   Overlay scaled watermark at `x=860, y=24`.
        *   Maintain hero badge display for `min 3.2s` (`hero_end_time = min(3.2, max(1.5, total_duration - 1.5))`).
        *   Overlay CTA badge at `y=1540`.
        *   Configure audio mixing: `sidechaincompress=threshold=0.06:ratio=4:attack=25:release=300` and append peak limiter `alimiter=limit=0.95:attack=5:release=50` to `amix` output.

#### 8. `scripts/rerender_degraded_batch.py` (Create)
*   **Type / Scope**: Batch Pipeline Execution Utility.
*   **Proposed Changes**:
    *   Instantiates `BakuEstatePipeline(enable_supabase=True)`.
    *   Iterates through target listings `['6343052', '6304638', '5867067', '6567513', '6560444', '6589921']`.
    *   Invokes `pipeline.process_listing_video_and_dispatch(listing, voice_id=designated_voice, trigger_reason="MANUAL_RERENDER", skip_telegram_dispatch=True)`.
    *   Supports `--listing-id` for targeted single re-renders, `--exclude` to skip already rendered listings, and `--dry-run` for preflight verification.
    *   Includes 1.5s inter-job sleep to preserve ElevenLabs concurrency headroom.

#### 9. `tests/test_tts.py` (Modify)
*   **Type / Scope**: Automated Python Test Suite.
*   **Proposed Changes**:
    *   Add tests asserting voice resolution for Arif (`ZQJv3hwvRAIC7fvWZ1Qr`) and Ayan (`DZaip8UahF0Qri1FxU8M`).
    *   Update `test_elevenlabs_speed_parameter_serialized` to assert new defaults: `stability=0.50`, `similarity_boost=0.85`, `style=0.20`.
    *   Update `TestAccountRouterVoiceAndDistrict` tests to assert `DZaip8UahF0Qri1FxU8M` for Affordable/TikTok and `ZQJv3hwvRAIC7fvWZ1Qr` for Luxury/General.

---

### Verification Plan

*   **Static Code Audit**:
    ```bash
    git grep -n "EXAVITQu4vr4xnSDxMaL"
    ```
    *Must return 0 occurrences.*
*   **Unit Tests**:
    ```bash
    pytest tests/test_tts.py -v
    ```
    *Must pass 100% (all TTS and routing test cases).*
*   **Dual-Voice Synthesis Verification**:
    ```bash
    python -c "from src.media.elevenlabs_tts import synthesize_elevenlabs_speech; from pathlib import Path; synthesize_elevenlabs_speech('Test Arif', Path('data/output/test_arif.mp3'), Path('data/output/test_arif.srt'), voice_id='ZQJv3hwvRAIC7fvWZ1Qr'); synthesize_elevenlabs_speech('Test Ayan', Path('data/output/test_ayan.mp3'), Path('data/output/test_ayan.srt'), voice_id='DZaip8UahF0Qri1FxU8M')"
    ```
    *Must output valid MP3 and SRT for both voices.*
*   **Batch Re-render Execution**:
    ```bash
    python scripts/rerender_degraded_batch.py
    ```
    *All 6 listings upgraded in Supabase Storage with new audio and cinematic compositing.*

--------------------------------------------------------------------------------

*Drafted with EGM*
