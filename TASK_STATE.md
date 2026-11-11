# Baku Estate AI — Cari İcraat Vəziyyəti (Task State)

- **Son Yenilənmə:** 2026-11-11 15:21 (UTC+4 Baku)
- **Aktiv Məqsəd:** Canlı sosial media (Instagram Reels / TikTok / Shorts) video istehsalında cansızlığın aradan qaldırılması, OpenAI Nova HD qadın səsi, fon musiqisi (Modern Trap Beat və Luxury Piano Lounge), ağıllı audio ducking və Telegram CRM avtomatik çatdırılması.
- **Git Checkpoint:** `5e70d70` (master)

---

## 1. Tamamlananlar və Faktiki Sübutlar (Verified & Proven)

- [x] **OpenAI Studio HD Səsləndirmə İnteqrasiyası (`src/media/openai_tts.py`)**:
  - `tts-1-hd` modeli və `nova` qadın səsi inteqrasiya edildi.
  - Avtomatik `az-AZ-BanuNeural` (Edge-TTS) fallback mexanizmi quruldu.
  - Azərbaycan dili üçün fonetik tənzimləmə funksiyası (`normalize_azerbaijani_phonetics`) əlavə olundu: ("95 000 AZN" -> "95 min manat", "kv.m" -> "kvadrat metr", "q." -> "qəsəbəsi").
  - FFmpeg ilə sözbəsöz dəqiq sinxron SRT subtitr generasiyası tamamlandı.

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

## 2. Cari Vəziyyət və İstifadəçidən Qərar Gözləyən Nöqtə

- Hər iki video variantı istifadəçinin Telegram botuna (`@bakuestatee_bot`) çatdırılıb:
  - **Variant 1:** Nova HD Səs + Modern Trap Beat
  - **Variant 2:** Nova HD Səs + Luxury Piano Lounge
- İstifadəçinin bu iki musiqi stilindən birini daimi default seçməsi və ya dinamik rejim (məsələn, qiyməti ucuz/təcili elanlar üçün Beat, premium elanlar üçün Piano Lounge) seçməsi gözlənilir.

---

## 3. Növbəti Addımlar

- [ ] İstifadəçinin bəyəndiyi musiqi stilini `DEFAULT_BG_MUSIC` olaraq təsdiqləmək.
- [ ] Gündəlik avtomatik rejimdə (Daemon və ya 1-Click Runner) sistemi tam istifadəyə vermək.
