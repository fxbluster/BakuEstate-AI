# Baku Estate AI — Cari İcraat Vəziyyəti (Task State)

- **Son Yenilənmə:** 2026-11-11 20:10 (UTC+4 Baku)
- **Aktiv Məqsəd:** Google AI Pro (Gemini Advanced 4) 6-hesablı hovuzunun izolyasiya olunmuş brauzer konteksti ilə tam işə salınması, `taskkill` və CDP port xətalarının ləğvi, yerli MCP serverin (`src/mcp_server.py`) inteqrasiyası və canlı ssenari generasiyası.
- **Git Checkpoint:** `master`

---

## 1. Tamamlananlar və Faktiki Sübutlar (Verified & Proven)

- [x] **Google AI Pro (Gemini Advanced 4) Canlı Hovuz İnteqrasiyası (`src/google_pool/brave_gemini_client.py`)**:
  - Şəxsi Brave brauzerini öldürən `taskkill /F /IM brave.exe` və kövrək CDP 9222 port kodu birdəfəlik ləğv edildi.
  - `GooglePoolManager.persistent_playwright_context` vasitəsilə 6 izolyasiya olunmuş profil (`data/profiles/acc_1` .. `acc_6`) birbaşa fonda (headless) işə salınır.
  - İstifadəçinin açıq Brave brauzerinə qətiyyən toxunulmur, heç bir port və ya proses konflikti yaranmır.
  - `gemini.google.com/app` üçün ən müasir dinamik DOM selektorları (`div[contenteditable="true"]`, `rich-textarea`), streaming generasiyanın bitməsini gözləyən həll və kvota/cooldown idarəetməsi quruldu.
  - Avtomatik profil rotasiyası: 1-ci hesab kvotaya çatdıqda və ya fasilədə olduqda növbəti aktiv hesaba (`acc_2` .. `acc_6`) keçir.

- [x] **Yerli MCP (Model Context Protocol) Server İnteqrasiyası (`src/mcp_server.py` & `start_mcp_server.bat`)**:
  - Standart JSON-RPC 2.0 stdio protokolu ilə işləyən yerli MCP Server yaradıldı (0 xarici asılılıq).
  - Təqdim olunan rəsmi MCP alətləri:
    - `generate_real_estate_script`: İstənilən elan parametrlərini qəbul edir, Google AI Pro hovuzundan real-vaxt viral ssenari generasiya edir.
    - `get_gemini_pool_status`: 6 hesabın sessiya, kvota və soyuma vəziyyətini qaytarır.
    - `rotate_gemini_account`: Hesabı növbəti profilə keçirir.
  - MCP server üçün xüsusi vahid testləri (`tests/test_mcp_server.py`) yazıldı və 100% keçdi.

- [x] **Canlı Real Əmlak Ssenari Testi (Faktiki Sübut)**:
  - `scripts/live_script_test.py` vasitəsilə Nərimanov rayonu 166 000 AZN-lik mənzil üçün canlı test icra edildi.
  - Sistem avtomatik `acc_2` profilini hovuzdan götürdü, Playwright ilə Gemini Advanced-ə sorğu göndərdi və 22 saniyəyə real ssenari hasil etdi:
    > *"Dayanın! Zarafat deyil! Bu qiymətə Kupçalı ev?! Heydər Əliyev Mərkəzinin yanında, tam mərkəzdə! Gözlərinizə inanmayacaqsınız — 65 kvadratmetr, əla təmirli 2 otaqlı mənzil! Mərtəbə 16 mərtəbəli binanın 7-ci mərtəbəsində, qaz, su, işıq daimi! Sənəd birbaşa Dövlət Çıxarışı — kupça! İpotekaya tam yararlı! Dərhal köç, yaşa, vaxt itirmə! Və diqqət! Bütün bu üstünlüklər cəmi 166 min manat! Fürsət qaçır! Dərhal zəng et və ya WhatsApp-a yaz, bu ev sənin olsun!"*
  - Hesabın kvotası və 600 saniyəlik soyuma vaxtı bazada (`google_accounts`) qeydə alındı.

- [x] **Tam Avtomatlaşdırılmış Testlər (Zero Failures)**:
  - Bütün 74 unit və inteqrasiya testləri 100% uğurla keçdi (`Ran 74 tests in 18.351s -> OK`, 0 xəta).

- [x] **OpenAI Studio HD Səsləndirmə İnteqrasiyası (`src/media/openai_tts.py`)**:
  - `tts-1-hd` modeli və `nova` qadın səsi inteqrasiya edildi.
  - Avtomatik `az-AZ-BanuNeural` (Edge-TTS) fallback mexanizmi quruldu.
  - Azərbaycan dili üçün fonetik tənzimləmə funksiyası (`normalize_azerbaijani_phonetics`) təkmilləşdirildi.

- [x] **Vizual Dizayn və Tipoqrafiyanın Əsaslı Təkmilləşdirilməsi (`src/media/ffmpeg_compositor.py`)**:
  - Windows native `Segoe UI Bold` və `Arial Bold` tətbiq edildi.
  - Vahid Lüks Kart (`#0F172A`), qızılı haşiyə, qırmızı təcili satış və yaşıl kupça nişanları.
  - ASS Subtitrlər: Sarı (`&H0000FFFF`) şriftlə aşağı təhlükəsiz zonada (`MarginV=420`).
  - Aşağı Əlaqə / CTA Kartı: Birbaşa sahibinin nömrəsi və WhatsApp linki.

- [x] **Telegram CRM və Sosial Media Mətninin Məntiqi Ayrılması (`src/dispatcher/telegram_crm.py`)**:
  - Message 1: Video + Daxili CRM kartı (kopyalanan nömrə, whatsapp linki, bina.az linki).
  - Message 2: Standalone təmiz 1-tap kopyalanacaq mətn (maksimum 5 hədəfli heştəq, mülkiyyətçi nömrəsi sızmadan).

---

## 2. Növbəti Addımlar

- [ ] İstifadəçiyə tamamlanmış arxitektura və canlı nəticə hesabatını təqdim etmək.
- [ ] Qalan 4 hesabın (`acc_3` .. `acc_6`) login sessiyasını 1 dəfəlik brauzerdə tamamlamaq.
