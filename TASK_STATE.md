# 📌 Cari İcraat Vəziyyəti (TASK_STATE.md)
- **Son Yenilənmə:** 2026-11-22 22:30 (Baku UTC+4)
- **Aktiv Rejim:** İstehsalat Tamamlandı və Canlı Nəzarətdə (In Production)
- **Aktiv Məqsəd:** Multimodal Video Pipeline (GPT-4o Vision + ElevenLabs v2) & 24/7 Watchdog Supervisor

## 1. Tamamlananlar (Faktiki Sübutlu)
- [x] Web CRM Frictionless Auth aradan qaldırıldı və Netlify-a yerləşdirildi (200 OK)
- [x] Social Lifecycle & Audience Intelligence tam tətbiq olundu (204 test OK)
- [x] Pre-Flight Gate & Selective Publishing DDL miqrasiyası (`202611190002_preflight_and_selective_publish.sql`) tətbiq edildi
- [x] Səssiz qaralama rejimi (`local_worker.py`): video bitdikdə avtomatik Telegram göndərişi dayandırıldı
- [x] Pre-flight yoxlama API-si (`/api/listings/[bina_id]/preflight`) real-time bina.az liveness və qiymət yoxlanışı ilə yazıldı
- [x] Telegram-a 1 toxunuşla kopyalanan `<code>...</code>` formatlı başlıq/həştəq göndərişi təmin edildi
- [x] Web CRM `PreflightModal.tsx` və `ListingsClient.tsx` yeniləndi (`[ 🔍 Yoxla və Göndər ]` + WhatsApp keçidi)
- [x] 221/221 Python vahid və reqressiya testləri keçdi (`Ran 221 tests in 23.770s — OK`)
- [x] Netlify istehsalat yerləşdirməsi tamamlandı (`https://bakuestate-crm.netlify.app`, exit code 0)
- [x] Yenilənmiş worker daemon arxa planda işə salındı (`DESKTOP-6UBPFU0` Online)

## 2. Növbəti Addımlar
- [x] EGM Drift Report (`docs/designs/2026-11-19_DRIFT_REPORT.md`) tərtib edildi (3 əsas dizayn sənədi üzrə bütün kod fərqlilikləri sənədləşdirildi)
- [x] Swarm ilə bütün driftlər dizayn sənədlərində və SITEMAP-də kod bazası ilə 100% uzlaşdırıldı (221 test OK)
- [x] Təkrar `/egm-drift-report` auditi icra edildi: bütün dizaynlar üzrə rəsmi `No drift detected` təsdiqləndi
- [x] Yeni Memarlıq Dizaynı tərtib edildi: `docs/designs/multi_account_distribution_and_learning_engine.md` (Multi-Account, Safe-Zone Compositing, Citadel-pattern AI Advisor)
- [x] EGM Round 1 Multi-Agent Review Loop tamamlandı və bütün 26 düzəliş qəbul edilərək tətbiq olundu (`goldfish_review_report.md` resolved)
- [x] Swarm icraatı tamamlandı: Database (miqrasiya 202611190003), AccountRouter, Safe-Zone Video Compositor, Citadel MCP Bridge & Squad Orchestrator, Web CRM Cockpit HUD və 257/257 testlər (100% OK)
- [x] Target Indicators, 100% ElevenLabs Studio Standard & Niche Analytics Engine arxitekturası təsdiqləndi (`target_indicators_and_analytics_engine.md`)
- [x] Swarm icraatı 100% tamamlandı: 4 niş üzrə ElevenLabs Arif & Banu inteqrasiyası, coğrafi rayon marşrutlaşdırması, 330x74 su nişanı və animasiya toqquşmasının aradan qaldırılması, boru kəməri və Telegram hədəf göstəriciləri, Web CRM 4-pilləli analitika qıfı və 271/271 testlər (100% OK)
- [x] Veb dəyişikliklərinin Netlify istehsalatına yayılması və son istifadəçi yoxlanışı (https://bakuestate-crm.netlify.app, 200 OK)
- [x] Standalone Web CRM AI Engine Memarlıq Dizaynı tərtib edildi: `docs/designs/standalone_web_ai_engine.md` (Desktop MCP Decommissioning, Next.js Serverless Gemini Proxy, 0ms Staged Hydration, Voice Debrief)
- [x] EGM Round 1 Review Loop tamamlandı və 19 düzəliş sənədə tətbiq edildi (`goldfish_review_report.md` resolved, `start_mcp_server.bat` qorundu, `lead_timeline_events`, Vitest və iOS Safari audio düzəlişləri təsdiqləndi)
- [x] Swarm İcraatı Tamamlandı (6 Mühəndis, 100% Deterministik Sınaq):
  * Faza 1: Supabase miqrasiyası (`20261120160000_standalone_web_ai_copilot.sql`), `ai_copilot_runs` cədvəli və aylıq $10 büdcə funksiyası (`check_copilot_budget`) canlı tətbiq edildi
  * Faza 1: Next.js 15 Serverless AI Gateway (`/api/ai/copilot`), `@google/genai`, dual-tier model marşrutlaşdırması (`gemini-3.1-flash-lite` vs `gemini-3.8-flash` low thinking), SRE telemetriya başlıqları (`X-BakuEstate-Model-Served`, `X-BakuEstate-Run-Id`)
  * Faza 2: `copilot-core.ts` regex ünvan sızması skaneri (`[DƏQİQ ÜNVAN GİZLƏDİLDİ - BAXIŞDA VERİLƏCƏK]`), 50-100 AZN komissiya qoruyucusu, deterministik Top 5 Triage Radar və `CopilotContext`
  * Faza 2: Web CRM UI (`CopilotDrawer.tsx` 2-tablı iş axını: Qalxan + Səsli Görüş Qeydi, `CockpitCardHUD.tsx` 0ms localStorage keş hidrasiyası, `LeadsClient.tsx` Copilot düymələri, `AppShell.tsx` qlobal provayder)
  * Faza 3: `src/mcp/baku_estate_mcp_server.py` tam silindi, `squad_orchestrator.py` birbaşa `SupabaseRepo`-ya qoşuldu (`start_mcp_server.bat` və `src/mcp_server.py` qorundu)
  * Test & Build: Vitest (27/27 test keçdi, 100%), Python vahid testləri (283/283 test keçdi, 100%), Next.js 15.5.29 production build (0 xəta, 10 marşrut uğurla tərtib edildi)
  * QA Gatekeeper 100% deterministik sertifikasiya verdi.
  * Canlı Gemini API Key Aktivləşdirildi: `GEMINI_API_KEY` həm lokal (`web/.env.local`, `.env`), həm də Netlify mühitinə əlavə edildi.
  * Canlı İstehsalat Sınağı: `/api/ai/copilot` istehsalatda birbaşa yoxlanıldı:
    - Sürətli Pillə: `gemini-3.1-flash-lite` (HTTP 200, fallback_triggered: false)
    - Güclü Pillə: `gemini-3.8-flash` (HTTP 200, fallback_triggered: false, Bakı ləhcəsində canlı komissiya müdafiəsi və ünvan maskalanması).
- [x] Yeni Memarlıq Layihəsi Təsdiqləndi: `docs/designs/baku_estate_executive_agent_hub.md` (BakuEstate Autonomous Executive Agent Hub & Living Memory Architecture).
- [x] `/egm-review-loop` icra edildi: 5 paralel Goldfish auditoru tərəfindən sənəd yoxlanıldı, bütün ziddiyyətlər aradan qaldırıldı və sənəd `Approved` statusuna keçirildi.
- [x] Swarm İcraatı Tamamlandı (6 Mühəndis, 100% Deterministik Sınaq):
  * Supabase DDL miqrasiyası (`supabase/migrations/20261121170000_executive_agent_hub.sql`): `public.agent_conversations` və `public.agent_learned_insights` cədvəlləri canlı tətbiq edildi.
  * 4 İxtisaslaşmış Agent Personajı (`web/lib/agent-personas.ts`): Müdir (Omni-kordinator), Farabi (Beh, hüquq, komissiya qalxanı), Usta (Kupça və m² qiymətləndirmə), Teymur (SMM, Reels və cəlbetmə) Bakı daşınmaz əmlak ləhcəsi və qadağan olunmuş cümlə filtrləri ilə quruldu.
  * Serverless AI Gateway (`/api/ai/copilot`): `action: 'agent_chat'` sliding-window yaddaş, `@google/genai` low-thinking və deterministik Action Card payload generasiyası əlavə edildi.
  * Web CRM UI Komponentləri (`web/components/hub/`): `AgentHubDrawer`, `OmniChatRoom`, `SpecialistRoom`, `ChatStream`, `ChatMessageItem`, `ActionCardView`, `SpecialistRoomPills` yaradıldı və `AppShell`, `CockpitCardHUD`, `LeadsClient` ilə inteqrasiya olundu.
  * Test & Build: Vitest (51/51 test keçdi, 100%), ESLint (0 warning/error), Next.js 15.5.29 production build (0 xəta, 10 marşrut uğurla tərtib edildi).
  * Canlı İstehsalat Yerləşdirməsi: Netlify istehsalatına uğurla deploy edildi (`https://bakuestate-crm.netlify.app`, Deploy ID: `6b01a25e091df351b10225cc`).
  * Canlı İstehsalat Sınağı: Canlı `/api/ai/copilot` endpoint-i `action: 'agent_chat'` ilə həm Müdir, həm də Farabi üçün yoxlanıldı (HTTP 200, canlı söhbət Supabase `agent_conversations` cədvəlində saxlanıldı).
- [x] Multimodal Video Pipeline və 24/7 Watchdog Supervisor (100% Sübutlu İcraat):
  * Memarlıq Layihəsi Təsdiqləndi: `docs/designs/video_pipeline_multimodal_engine.md` və `/egm-review-loop` ilə tam audit olundu (`goldfish_review_report.md` resolved).
  * GPT-4o Multimodal Vision Analizatoru (`src/ai/vision_analyzer.py`): Cloudflare IP blokunu dəf etmək üçün lokal base64 JPEG formatında şəkillər göndərilir, təmir keyfiyyəti (`renovation_quality`) və Bakı ləhcəsində açılış cümləsi (`hook_sentence_az`) çıxarılır. 8/8 test keçdi (`tests/test_vision_analyzer.py`).
  * ElevenLabs SOTA TTS Model İnteqrasiyası (`src/media/elevenlabs_tts.py`): Mövcud olmayan `eleven_v4` modeli `eleven_multilingual_v2` ilə əvəzləndi, HTTP timeout 5s-dən 15s-ə qaldırıldı. 33M simvol hədiyyəsi ilə Arif (`ZQJv3hwvRAIC7fvWZ1Qr`) və Banu səsləri aktivləşdirildi.
  * TTS & Pipeline Əlaqələndirilməsi (`src/media/tts_service.py`, `run_pipeline.py`): `generate_tts_for_listing` və `generate_azerbaijani_script` funksiyalarına `visual_profile` parametri əlavə edildi, vizual xüsusiyyətlər birbaşa videonun ssenarisinə toxundu.
  * Watchdog Daemon & Zəhərli Həb Qoruyucusu (`src/worker/watchdog.py`): Worker prosesini nəzarətdə saxlayır, qəzaya uğradıqda eksponensial gözləmə ilə yenidən başladır. Eyni elan 2 dəfə qəzaya səbəb olduqda `POISON_PILL_ABORT` ilə zərərsizləşdirilir. 5/5 test keçdi (`tests/test_watchdog.py`).
  * Gözləyən Elanların Bərpası (`scripts/backfill_unrendered_jobs.py`): Videosu olmayan 6 elan aşkar edildi və `--commit` bayrağı ilə canlı Supabase `pipeline_jobs` növbəsinə yazıldı.
  * Windows 24/7 Xidmət İnteqrasiyası (`scripts/setup_worker_service.ps1`): NVENC/QuickSync GPU sürətləndirilməsini qorumaq üçün Windows User Startup qovluğuna (`BakuEstateWorkerService.bat`) qeyd edildi və arxa planda işə salındı.
  * Canlı İstehsalat Renderləri Təsdiqləndi:
    - Elan 6560444: GPT-4o Vision `needs_repair` deteksiya etdi, Banu səsi ilə 62.7s video render olundu, Supabase CDN-ə yükləndi (`https://ejsaccbeatmwqodwwzwu.supabase.co/storage/v1/object/public/baku-estate-media/videos/6560444/v1__at_baku.serfeli.evler.mp4`), `ab_metadata["visual_profile"]` yazıldı, status: `DRAFT_READY`.
    - Elan 6567513: GPT-4o Vision `needs_repair` deteksiya etdi ("Geniş pəncərələrlə işıqlı və ferah interyer!"), Arif səsi ilə 61.35s video render olundu, Supabase CDN-ə yükləndi (`https://ejsaccbeatmwqodwwzwu.supabase.co/storage/v1/object/public/baku-estate-media/videos/6567513/v1__at_bakuestate.premium.mp4`), `ab_metadata["visual_profile"]` yazıldı, status: `DRAFT_READY`.
    - Elan 5867067: Watchdog daemon tərəfindən arxa planda avtonom icra olunur.
