# Baku Estate AI — Cari İcraat Vəziyyəti (Task State)

- **Son Yenilənmə:** 2026-11-11 15:21 (UTC+4 Baku)
- **Aktiv Məqsəd:** Canlı sosial media (Instagram Reels / TikTok / Shorts) video istehsalında cansızlığın aradan qaldırılması, OpenAI Nova HD qadın səsi, fon musiqisi (Modern Trap Beat və Luxury Piano Lounge), ağıllı audio ducking və Telegram CRM avtomatik çatdırılması.
- **Git Checkpoint:** `5e70d70` (master)

---

## 1. Tamamlananlar və Faktiki Sübutlar (Verified & Proven)

- [x] **OpenAI Studio HD Səsləndirmə İnteqrasiyası (`src/media/openai_tts.py`)**:
  - `tts-1-hd` modeli və `nova` qadın səsi inteqrasiya edildi.
  - Avtomatik `az-AZ-BanuNeural` (Edge-TTS) fallback mexanizmi quruldu.
  - Azərbaycan dili üçün fonetik tənzimləmə funksiyası (`normalize_azerbaijani_phonetics`) təkmilləşdirildi: ("q." -> "qəsəbəsi", "m." -> "metrosu", "küç." -> "küçəsi", "pr." -> "prospekti").
  - FFmpeg ilə sözbəsöz dəqiq sinxron SRT və ASS subtitr generasiyası tamamlandı.

- [x] **Vizual Dizayn və Tipoqrafiyanın Əsaslı Təkmilləşdirilməsi (`src/media/ffmpeg_compositor.py`)**:
  - **Unicode Şrift Dəstəyi:** Windows native `Segoe UI Bold` və `Arial Bold` tətbiq edildi; "Ə" hərfinin qırılması (`QIYM[]T`) və emojilərin qutuya düşməsi 100% aradan qaldırıldı.
  - **Vahid Lüks Kart (Unified Header Card):** Üst-üstə yığılmış 4 lent əvəzinə zərif qaranlıq şüşə kart (`#0F172A`), qızılı haşiyə, qırmızı təcili satış və yaşıl kupça nişanları, böyük qızılı qiymət və təmiz ünvan xətti quruldu.
  - **ASS Təhlükəsiz Zolaq Subtitrləri:** Yuxarıdakı nəhəng qara qutular ləğv edildi; TikTok/Reels üçün sarı (`&H0000FFFF`) şriftlə aşağı təhlükəsiz zonada (`MarginV=420`) incə qara konturlu subtitrlər yerləşdirildi.
  - **Aşağı Əlaqə / CTA Kartı:** "Ölü zona" olan aşağı hissəyə birbaşa sahibinin nömrəsi və WhatsApp linki olan müasir əlaqə kartı əlavə edildi.
- [x] **Telegram CRM və Sosial Media Mətninin Məntiqi Ayrılması (`src/dispatcher/telegram_crm.py`)**:
  - **Daxili CRM Bloku:** Mülkiyyətçinin adı, bir toxunuşla kopyalanan nömrəsi (`<code>`), hazır pre-filled WhatsApp linki və birbaşa bina.az linki ayrıldı.
  - **İctimai Paylaşım Bloku (Kopyala-Paylaş):** Mülkiyyətçinin nömrəsi və ya bina.az linki ictimai mətndən tam təmizləndi; alıcıları birbaşa səhifəyə / agentə yönəldən güclü CTA (`📩 Ətraflı məlumat üçün Direktə yazın`) qoyuldu.
  - **Dəqiq Maksimum 5 Heştəq:** Alqoritmə zərər verən 15-20 spam heştəq və `#binaaz` ləğv edildi; əmlak tipinə uyğun dəqiq 5 hədəfli heştəq təyin olundu.
  - **Əmlak Tipinin Avtomatik Təyini:** Elanın təsvirinə görə avtomatik `HƏYƏT EVİ`, `MƏNZİL` və ya `VİLLA` başlığı seçilir.
  - **Format Düzəlişləri:** `100 m²` (.0 ləğv edildi) və `Mehdiabad qəsəbəsi` (qısaltmasız).
  - **Canlı Yoxlama:** Yeni strukturla Telegram botuna **Message ID: 8** uğurla çatdırıldı.

- [x] **Dinamik Audio Mikser və Ducking (`src/media/ffmpeg_compositor.py`)**:
  - `sidechaincompress` filtri ilə səs gələndə musiqinin avtomatik qısılması (ducking): `threshold=0.08:ratio=5:attack=30:release=350`.
  - Qızılı qiymət lövhəsi açılan anda zəng səsi effekti (chime SFX): `adelay=500|500`.
  - Həcm tənzimləməsi üçün `normalize=0` təyin edildi (diktor səsinin batmasının qarşısı alındı).

- [x] **TikTok/Reels Vizual Təkmilləşdirməsi**:
  - 3.2 saniyəlik təcililik qarmağı (hook): `🔥 TƏCİLİ KUPÇALI SATIŞ`.
  - Subtitr rəngi viral qızılı-sarıya (`&H0000FFFF`) və qalın qara kontura dəyişdirildi.

- [x] **Musiqi Variantlarının İstehsalı və Telegram Çatdırılması**:
  - **Variant 1 (Modern Trap Beat)**: `video_6532081_beat.mp4` (11.17 MB) render edildi -> Telegram CRM botuna uğurla göndərildi (**Message ID: 5**).
  - **Variant 2 (Luxury Piano Lounge)**: `video_6532081_lounge.mp4` (11.16 MB) render edildi -> Telegram CRM botuna uğurla göndərildi (**Message ID: 6**).

- [x] **Masaüstü 1-Kliklə Başlatma**:
  - `C:\Users\HP\Desktop\Baku Estate AI.lnk` qısayolu yaradıldı.
  - 3D lüks daşınmaz əmlak loqosu (`assets/logo.ico`) tətbiq edildi.

- [x] **Avtomatlaşdırılmış Testlər**:
  - Bütün 63 unit və inteqrasiya testləri uğurla keçdi (`Ran 63 tests in 18.789s -> OK`, 0 xəta, 0 uğursuzluq).

---

## 2. Təsdiqlənmiş Qərar və İnteqrasiya

- [x] **İstifadəçi Qərarı:** Variant 2 (**Luxury Acoustic Piano Lounge**) əsas seçim olaraq təsdiqləndi.
- [x] `config/settings.py` və `.env` konfiqurasiyasında `DEFAULT_BG_MUSIC` olaraq `assets/music/luxury_lounge.mp3` təyin edildi.
- [x] Səs rejimi olaraq OpenAI Studio `nova` (HD) qadın səsi və avtomatik `az-AZ-BanuNeural` fallback qüvvədə saxlanıldı.
- [x] `START_BAKU_ESTATE.bat` və masaüstü qısayol yeniləndi (İstifadəçi masaüstündəki ikonaya 1 dəfə klikləməklə birbaşa bu konfiqurasiya ilə videolar yaradır).
- [x] Bütün 63 test 100% uğurla keçdi (`OK`).

---

## 3. Növbəti Addımlar

- [ ] İstifadəçinin bəyəndiyi musiqi stilini `DEFAULT_BG_MUSIC` olaraq təsdiqləmək.
- [ ] Gündəlik avtomatik rejimdə (Daemon və ya 1-Click Runner) sistemi tam istifadəyə vermək.
