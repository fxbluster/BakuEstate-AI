# BakuEstate Video Pipeline Audio & Montage Elevation: Native ElevenLabs Dual-Voice Engine & Cinematic Video Compositor V2

*   **Author:** Elvin Ismailov (fxbluster)
*   **Status:** Draft
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
- Leveraging the available **33,030,627 ElevenLabs character quota** with production stability and expressiveness parameters.
- Overhauling the FFmpeg compositing pipeline to restore and refine clean visual layering, safe-zone typography, natural scene pacing, and balanced audio ducking.
- Executing an automated re-render of the six degraded videos.

--------------------------------------------------------------------------------

## The Problem

1. **Foreign English Voice Allocation in Azerbaijani Content**:
   Inspection of `config/settings.py` and `src/worker/account_router.py` reveals that `ELEVENLABS_VOICE_BANU` defaulted to `EXAVITQu4vr4xnSDxMaL` (Sarah, an English ElevenLabs voice). When listings routed to affordable channels (`@baku.serfeli.evler`) or female profiles, ElevenLabs Multilingual V2 synthesized Azerbaijani scripts using an English vocal base. This produced an unnatural, heavily accented narration unacceptable for local property marketing.

2. **Visual Hierarchy Clutter and Filtergraph Regression**:
   Recent modifications in `src/media/ffmpeg_compositor.py` altered subtitle positioning (`MarginV=580`), reduced hero badge duration to under 2.5 seconds, introduced an opaque brand watermark overlay (`x=714, y=86`) that collided with header price cards, and applied aggressive subtitle scaling (`font_size=64`, `margin_v_cta=660`) that produced visual jumping on call-to-action transitions. The resulting reels felt cluttered and disjointed compared to the clean visual balance of earlier versions.

3. **Inconsistent Audio Ducking & Volume Balancing**:
   Background lounge beats and sound effects frequently overwhelmed voice narration or ducked abruptly, reducing speech intelligibility on mobile device speakers.

4. **Staged Video Quality Inconsistency**:
   Six active listings (#6343052, #6304638, #5867067, #6567513, #6560444, #6589921) currently host degraded render versions in Supabase Storage and CRM views, misrepresenting system capabilities to operators and brokers.

--------------------------------------------------------------------------------

## Goals

*   **Goal 1 (Native Dual-Voice Engine)**: Standardize all ElevenLabs speech synthesis strictly on two verified native Azerbaijani voice IDs:
    *   Male Narrator (Arif): `ZQJv3hwvRAIC7fvWZ1Qr`
    *   Female Narrator (Ayan): `DZaip8UahF0Qri1FxU8M`
*   **Goal 2 (Zero Foreign Voice Leakage)**: Purge `EXAVITQu4vr4xnSDxMaL` and any other unverified foreign voice IDs from settings, router heuristics, and fallback chains.
*   **Goal 3 (Cinematic Montage Overhaul)**: Refactor `src/media/ffmpeg_compositor.py` and `src/media/motion_engine.py` to restore:
    *   Clean 3-tier visual hierarchy: top glassmorphic luxury card, unobstructed central room walkthrough, and bottom verified safe-zone call-to-action.
    *   Subtitles locked to mobile social safe zones without card collisions or erratic vertical jumping.
    *   Harmonious watermark integration that never obscures property specifications or pricing.
    *   Smooth Ken Burns motion transitions with generous hero scene display (min 3.2s).
*   **Goal 4 (Acoustic Clarity & Ducking)**: Calibrate FFmpeg sidechain compression so background music sits at an ambient -18dB during narration and cleanly swells only during intro/outro pauses.
*   **Goal 5 (Automated Re-render of Degraded Batch)**: Queue and re-render the six target listings (#6343052, #6304638, #5867067, #6567513, #6560444, #6589921), committing upgraded v2/v3 renders to Supabase Storage and updating CRM metadata.

--------------------------------------------------------------------------------

## Non-Goals

*   **Non-Goal 1**: Replacing the underlying FFmpeg compositing engine with cloud-based GPU render SaaS (e.g. Creatomate or Shotstack). Local hardware-accelerated FFmpeg provides zero-marginal-cost rendering.
*   **Non-Goal 2**: Introducing AI avatar or face generation (e.g. HeyGen or D-ID). The platform focuses strictly on authentic architectural photography with voiceover narration.
*   **Non-Goal 3**: Altering Next.js CRM frontend architecture or database schema. Existing `render_versions` and `pipeline_jobs` tables fully support versioned re-renders.

--------------------------------------------------------------------------------

## Open Questions

*   **Question 1**: How should the system assign voices across property types?
    *   Option A: Fixed persona assignment (e.g. Luxury = Arif male, Affordable/Budget = Ayan female).
    *   Option B: Configurable per-channel routing with manual override in CRM Left-Canvas Stage.
*   **Question 2**: For re-rendering the six listings, should the system overwrite `v1` in-place or generate `v2` records in `render_versions` to maintain historical audit trails?

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
        EL -->|model: eleven_multilingual_v2\nstability: 0.50, similarity: 0.85| EL_API["ElevenLabs /with-timestamps API"]
        EL_API --> AUDIO["voice_{id}_v{n}.mp3 (44.1kHz 128kbps)"]
        EL_API --> SRT["subs_{id}_v{n}.srt (Word-Level Karaoke Timestamps)"]
    end

    subgraph CompositorV2 ["Cinematic Video Compositor V2 (FFmpeg)"]
        PHOTOS["Downloaded High-Res Photos"] --> ME["src/media/motion_engine.py (Ken Burns Pan/Zoom)"]
        ME --> RAW_VIDEO["walkthrough_raw.mp4 (1080x1920 30fps)"]
        RAW_VIDEO --> COMP["src/media/ffmpeg_compositor.py"]
        AUDIO --> COMP
        SRT -->|ASS Safe-Zone Filter\nMarginV=500, font 52px| COMP
        MUSIC["assets/music/{niche_track}.mp3"] -->|Sidechain Ducking (-18dB)\nLowpass 3500Hz| COMP
        HDR["Top Glassmorphic Luxury Card (y=70, h=250)"] --> COMP
        CTA["Bottom Glassmorphic Contact Card (y=1680, h=130)"] --> COMP
        WM["Repositioned Subtle Watermark (x=830, y=26)"] --> COMP
    end

    subgraph Output ["Cloud Storage & CRM Dispatch"]
        COMP --> OUT_MP4["Supabase Storage: videos/{bina_id}/v{n}.mp4"]
        OUT_MP4 --> DB_VERSIONS["render_versions (status: COMPLETED)"]
        DB_VERSIONS --> CRM_VIEW["Web CRM Dashboard / Video Player"]
    end
```

---

### 2. Subsystem Specifications

#### Subsystem A: Native Dual-Voice Engine (`config/settings.py`, `src/media/elevenlabs_tts.py`, `src/worker/account_router.py`)

1. **Voice Configuration Standard**:
   - `ELEVENLABS_VOICE_ARIF`: Strictly `ZQJv3hwvRAIC7fvWZ1Qr` (Male Narrator).
   - `ELEVENLABS_VOICE_AYAN`: Strictly `DZaip8UahF0Qri1FxU8M` (Female Narrator).
   - Deprecate and completely purge `EXAVITQu4vr4xnSDxMaL` (Sarah - English) from all files.
   - Default fallback voice: `ELEVENLABS_VOICE_ARIF`.

2. **Synthesis Parameter Tuning (ElevenLabs Multilingual V2)**:
   - `stability`: `0.50` (lowered from 0.52 for more natural human vocal melody and cadence).
   - `similarity_boost`: `0.85` (ensures strong vocal identity and eliminates flat robotic delivery).
   - `style`: `0.20` (subtle stylistic expressiveness without distortion).
   - `use_speaker_boost`: `True` (enhances low-end presence and warmth).
   - Output format: `mp3_44100_128` (clean, broadcast-grade audio).

3. **Deterministic Channel Routing**:
   - `ACCOUNT_LUXURY` (`@bakuestate.premium`) & `ACCOUNT_GENERAL` (`@bakuestate.official`): Assigned to **Arif** (`ZQJv3hwvRAIC7fvWZ1Qr`).
   - `ACCOUNT_AFFORDABLE` (`@baku.serfeli.evler`) & `ACCOUNT_TIKTOK` (`@baku_emlak_ai`): Assigned to **Ayan** (`DZaip8UahF0Qri1FxU8M`).
   - Both male and female voices are native Azerbaijani speakers, eliminating any foreign accent.

---

#### Subsystem B: Cinematic Video Compositor V2 (`src/media/ffmpeg_compositor.py` & `src/media/motion_engine.py`)

1. **1080x1920 Vertical Visual Hierarchy**:
   - **Top Luxury Header Card** (`x=50, y=70, w=980, h=250`):
     - Background: `0x0F172A@0.88` (deep slate glass).
     - Border: `0x10B981@0.40` (emerald 2px accent).
     - Location: `font_size=36`, `y=115`, color `#E2E8F0`.
     - Price Badge: `font_size=48`, `y=175`, color `#10B981` (emerald gold highlight), bold.
     - Specs line: `font_size=30`, `y=230`, color `#CBD5E1`.
   - **Watermark Repositioning**:
     - Previous placement (`x=714, y=86`) overlapped the price text inside the header card.
     - New placement: Shifted to top edge above card (`x=840, y=24`) or top-left corner (`x=60, y=24`) with `scale=160:36` and subtle alpha (`0.75`), completely clearing listing card borders.
   - **Subtitles (ASS Safe Zone)**:
     - Baseline: `y=1380px` (`MarginV=500` in 1080x1920 coordinate space).
     - Subtitles remain strictly within `y in [1280, 1460]` px, leaving `y > 1650px` clear for the CTA contact card and TikTok/Reels UI buttons.
     - Font: `Segoe UI Bold`, `font_size=52`, primary color TikTok viral yellow (`&H0000FFFF`), outline black (`3.5px`), shadow (`1.5px`), zero opaque bounding box.
     - Timing: Word-level chunks (2-3 words per chunk) synchronized with ElevenLabs character timestamps. Subtitles do not jump vertically when CTA appears.
   - **Bottom Contact / CTA Card** (`x=80, y=1680, w=920, h=130`):
     - Appears at `total_duration - 5.5s` and stays until end.
     - Line 1: `BİRBAŞA SAHİBİNDƏN • KOMİSSİYASIZ` (`fontsize=24`, amber `#F59E0B`).
     - Line 2: `ƏLAQƏ / WHATSAPP: [NÖMRƏ]` (`fontsize=34`, white `#FFFFFF`).

2. **Acoustic Audio Ducking & Filtergraph Calibration**:
   - Voice narration volume: `1.0` (unaltered, full dynamic range).
   - Background music track:
     - Pre-volume: `0.15` (ambient level).
     - Sidechain compression: `sidechaincompress=threshold=0.06:ratio=6:attack=25:release=320`.
     - Lowpass filter: `lowpass=f=3500` applied to background music during narration so high-hats and synthesizer frequencies do not clash with human sibilance and consonants.
   - Sound effects (whoosh on scene transitions, chime on price reveal): Volume `0.30`, synchronized to visual transition timestamps.

---

#### Subsystem C: Batch Re-render Execution (`scripts/rerender_degraded_batch.py`)

1. **Target Listings Scope**:
   - `#6343052` (25,000 AZN, @baku.serfeli.evler) -> Re-render with Ayan female voice (`DZaip8UahF0Qri1FxU8M`).
   - `#6304638` (209,000 AZN, @bakuestate.official) -> Re-render with Arif male voice (`ZQJv3hwvRAIC7fvWZ1Qr`).
   - `#5867067` (812,900 AZN, @bakuestate.premium) -> Re-render with Arif male voice (`ZQJv3hwvRAIC7fvWZ1Qr`).
   - `#6567513` (4,650,000 AZN, @bakuestate.premium) -> Re-render with Arif male voice (`ZQJv3hwvRAIC7fvWZ1Qr`).
   - `#6560444` (138,000 AZN, @baku.serfeli.evler) -> Re-render with Ayan female voice (`DZaip8UahF0Qri1FxU8M`).
   - `#6589921` (279,000 AZN, @bakuestate.premium) -> Re-render with Arif male voice (`ZQJv3hwvRAIC7fvWZ1Qr`).

2. **Execution Flow**:
   - The script iterates through the 6 listings, invokes `generate_tts_for_listing` with the designated native `voice_id` and ElevenLabs Multilingual V2, runs `VideoCompositor.compose_reel_video`, uploads the resulting MP4 and SRT to Supabase Storage, and updates `render_versions` with `status='COMPLETED'`.
   - Bypasses daily auto-render throttle via manual trigger source (`WEB_UI`).


--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Edge-TTS Fallback for Affordable / Budget Listings

*   **Pros**: Zero marginal token or API cost; no dependency on ElevenLabs network availability.
*   **Cons**: Microsoft Edge-TTS voices (`az-AZ-BabekNeural`, `az-AZ-BanuNeural`) exhibit flat, robotic cadence, unnatural vowel elongation on numbers, and lack the emotional nuance and conversational breathing necessary for high-converting social media reels.
*   **Reason for Rejection**: *Rejected by author*: With over 33,000,000 ElevenLabs characters available in the active account (capable of producing over 30,000 full-length video voiceovers), economizing on voice quality is technically and commercially unjustified. Native studio-grade ElevenLabs synthesis must be standard across all tiers.

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

#### 4. `src/media/tts_service.py` (Modify)
*   **Type / Scope**: Unified TTS Service & Edge-TTS Fallback.
*   **Proposed Changes**:
    *   Update `_resolve_tts_routing`:
        *   Resolve `eleven_female` and `ayan` to `DZaip8UahF0Qri1FxU8M`.
        *   Resolve `eleven_male` and `arif` to `ZQJv3hwvRAIC7fvWZ1Qr`.
    *   Ensure fallback logic detects `DZaip8UahF0Qri1FxU8M` and correctly routes to Edge-TTS `az-AZ-BanuNeural` only under hard network failure.

#### 5. `src/media/ffmpeg_compositor.py` (Modify)
*   **Type / Scope**: FFmpeg Video Compositing & Filtergraph Engine.
*   **Proposed Changes**:
    *   **Watermark Relocation**: Move brand watermark from `x=714, y=86` to top safe margin `x=840, y=24` (or embedded cleanly without card intersection).
    *   **Subtitle Safe Zone Stabilization**: Set ASS `MarginV=500` (`baseline y=1380px`), `font_size=52`, Segoe UI Bold, TikTok yellow font (`&H0000FFFF`), black outline `3.5px`, soft shadow `1.5px`. Remove aggressive `margin_v_cta=660` jumping.
    *   **Scene Pacing**: Maintain initial hero scene for minimum 3.2 seconds.
    *   **Audio Ducking**: Configure `sidechaincompress=threshold=0.06:ratio=6:attack=25:release=320` and `lowpass=f=3500` on background track during narration.

#### 6. `scripts/rerender_degraded_batch.py` (Create)
*   **Type / Scope**: Batch Pipeline Execution Utility.
*   **Proposed Changes**:
    *   Accepts target IDs: `['6343052', '6304638', '5867067', '6567513', '6560444', '6589921']`.
    *   Fetches current listing data, determines correct native voice ID, invokes `generate_tts_for_listing` and `compose_reel_video`.
    *   Uploads new video version (`v2` or `v3`) to Supabase Storage and records `COMPLETED` entry in `render_versions`.
    *   Updates `listings.video_url` and `listings.pipeline_status = 'DRAFT_READY'`.

#### 7. `tests/test_tts.py` & `tests/test_account_router.py` (Modify)
*   **Type / Scope**: Automated Python Test Suites.
*   **Proposed Changes**:
    *   Verify voice resolution for Arif and Ayan aliases.
    *   Assert `EXAVITQu4vr4xnSDxMaL` is completely absent.
    *   Assert account router assigns `DZaip8UahF0Qri1FxU8M` to Affordable/TikTok channels and `ZQJv3hwvRAIC7fvWZ1Qr` to Luxury/General channels.

---

### Verification Plan

*   **Unit Tests**:
    *   `pytest tests/test_tts.py tests/test_account_router.py -v` (Must pass 100%).
*   **Static Code Analysis**:
    *   Search codebase for `EXAVITQu4vr4xnSDxMaL` (Must return 0 occurrences).
*   **Audio Synthesis Verification**:
    *   Synthesize a test sentence with both `ZQJv3hwvRAIC7fvWZ1Qr` and `DZaip8UahF0Qri1FxU8M`; verify HTTP 200 from ElevenLabs with valid MP3 and SRT.
*   **Compositor Filtergraph Verification**:
    *   Execute dry-run render; verify no filtergraph syntax errors and verify output dimensions are 1080x1920.
*   **Batch Re-render Execution**:
    *   Run `python scripts/rerender_degraded_batch.py`; verify all 6 listings produce new valid videos in Supabase Storage with updated CRM badges.
