# Design vs. Code Drift Report (2026-11-23)

## followup_web_crm.md

* **Hosting Provider & Domain**: Document states Web CRM is hosted on Netlify at `https://bakuestate-crm.netlify.app`. The production deployment is hosted on Vercel at `https://bakuestate-ai.vercel.app`.
* **Document Status**: Document header specifies `Status: Implemented (In Review)`, whereas the architecture is fully active in production.

## social_lifecycle_and_audience_intelligence.md

No drift detected.

## preflight_and_selective_publishing.md

No drift detected.

## multi_account_distribution_and_learning_engine.md

* **Voice Engine Standard**: Section "Goal 3" specifies speech synthesis using Arif via ElevenLabs and Banu/Babek via Edge-TTS. Production now runs on the Native Dual-Voice ElevenLabs standard with Arif (`ZQJv3hwvRAIC7fvWZ1Qr`) and Ayan (`DZaip8UahF0Qri1FxU8M`).
* **Watermark Dimensions**: Section "CUJ 1" specifies a 330px watermark pill. The compositor now renders a compact 180x40 watermark pill at `(x=860, y=24)`.

## target_indicators_and_analytics_engine.md

* **Foreign Voice Allocation**: Sections "Problem 2", "G2", and configuration references specify `ELEVENLABS_VOICE_BANU = "EXAVITQu4vr4xnSDxMaL"` (Sarah - English voice). In code, `EXAVITQu4vr4xnSDxMaL` has been purged across all settings, router heuristics, dispatch maps, and webhook handlers; female narration is now mapped to Ayan (`DZaip8UahF0Qri1FxU8M`).
* **Watermark Overlay Dimensions**: Section "G1" states the upper-third watermark pill is 330px wide. In code (`src/media/glass_badge.py` and `src/media/ffmpeg_compositor.py`), the watermark is a compact 180x40 pill placed at `(x=860, y=24)`.

## standalone_web_ai_engine.md

* **Hosting Environment**: Document references Netlify serverless functions and `https://bakuestate-crm.netlify.app`. The live production site is deployed on Vercel (`https://bakuestate-ai.vercel.app`).
* **Document Status**: Document header lists `Status: Approved`, whereas the serverless copilot route is in production.

## baku_estate_executive_agent_hub.md

* **Council Persona Topology**: Document specifies a 4-agent council (`Müdir`, `Farabi`, `Usta`, `Teymur`). The architecture has been consolidated into 3 partitioned cognitive agents (`mudir`, `analitika`, and `musteri_psixologiyasi`) as defined in `left_canvas_action_stage_and_tri_persona_copilot.md`.
* **Framework Version**: Document references Next.js 15 App Router. The codebase is running on Next.js 16 (`web/package.json`).

## interactive_action_cards_and_telemetry_engine.md

No drift detected. (Superseded by `left_canvas_action_stage_and_tri_persona_copilot.md` architecture).

## left_canvas_action_stage_and_tri_persona_copilot.md

* **Document Status**: Document header states `Status: Approved (Ready for Implementation)`. The Left-Canvas Action Stage, responsive container, Telegram dispatch route, and 3-card operational layout are fully implemented and verified in production (`web/components/hub/LeftCanvasStage.tsx`).

## video_pipeline_multimodal_engine.md

* **Document Status**: Document header lists `Status: Approved (Ready for Implementation)`. The multimodal GPT-4o Vision analysis, worker watchdog, and automated rendering pipelines are fully implemented in production (`run_pipeline.py`).
* **Voice Narrator Scope**: Section "Goal 4" specifies single-narrator ElevenLabs production voiceover exclusively using Arif (`ZQJv3hwvRAIC7fvWZ1Qr`). The pipeline has been expanded to a dual-voice architecture including Ayan (`DZaip8UahF0Qri1FxU8M`) for Affordable and TikTok channels.

## native_dual_voice_and_cinematic_compositor_v2.md

* **Document & Sitemap Status**: Document header and `docs/designs/SITEMAP.md` list `Status: Approved (Ready for Implementation)`. All subsystems (`src/media/elevenlabs_tts.py`, `src/media/tts_service.py`, `src/worker/account_router.py`, `src/media/glass_badge.py`, `src/media/kinetic_subtitles.py`, `src/media/ffmpeg_compositor.py`, `src/dispatcher/telegram_bot_service.py`, `supabase/functions/telegram-webhook/index.ts`, `tests/test_tts.py`, `tests/test_multi_account_and_advisor.py`, `scripts/rerender_degraded_batch.py`) are fully implemented, verified via automated test suites, and deployed, with all 6 target listings re-rendered in production.
* **Batch Utility Arguments**: `scripts/rerender_degraded_batch.py` includes an `--exclude` argument to skip already rendered listings, which is not documented in the initial specification.
