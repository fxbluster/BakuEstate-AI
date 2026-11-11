# Baku Estate AI — Autonomous Real Estate Social Media Video Pipeline

An end-to-end turn-key autonomous platform for Azerbaijani real estate social media video marketing.
Crawls verified direct owner listings from `bina.az`, generates conversational Azerbaijani scripts, synthesizes natural neural speech with synchronized word-level karaoke subtitles using Microsoft Edge-TTS (`az-AZ-BabekNeural` @ +10%), renders 1080x1920 (9:16) vertical videos with FFmpeg (Ken Burns dynamic pan/zoom, blurred backgrounds, golden price banners, green Kupça badges), and dispatches ready-to-post leads with direct WhatsApp links to Telegram CRM.

Includes a **1-click Interactive Terminal Menu (`menu.bat`)**, an **Autonomous Background Scheduler Daemon (`start_daemon.bat`)**, and a **Zero-Dependency `.env` Configuration System**.

---

## Architecture & Project Structure

```
baku-estate-ai/
├── config/
│   ├── __init__.py
│   └── settings.py              # Zero-dependency .env loader, directory layouts, scraper & video configs
├── data/
│   ├── database.sqlite          # SQLite database (listings, google_accounts, generated_videos)
│   ├── downloads/               # Downloaded Full HD images from bina.az CDN
│   ├── profiles/                # Playwright persistent contexts (acc_1 .. acc_6)
│   └── output/                  # Rendered MP4 videos, MP3 audio, SRT subs, and CRM lead JSONs
├── src/
│   ├── __init__.py
│   ├── database.py              # SQLite schema, transactional CRUD, and lead/video query helpers
│   ├── scheduler.py             # Autonomous background daemon (fixed daily times or repeating intervals)
│   ├── scraper/
│   │   ├── __init__.py
│   │   └── bina_scraper.py      # Next.js SSR scraper, __NEXT_DATA__ extractor, phone extractor
│   ├── google_pool/
│   │   ├── __init__.py
│   │   ├── setup_accounts.py    # Persistent context directory generator & account seeder
│   │   └── pool_manager.py      # Round-robin rotation, cooldown timers, daily quota management
│   ├── media/
│   │   ├── __init__.py
│   │   ├── tts_service.py       # Azerbaijani script generation, Edge-TTS (BabekNeural), word SRT
│   │   └── ffmpeg_compositor.py # 1080x1920 vertical compositor, Ken Burns, banners, subtitles
│   └── dispatcher/
│       ├── __init__.py
│       └── telegram_crm.py      # Telegram Bot API, WhatsApp direct links, captions & hashtags
├── tests/
│   ├── test_db.py               # SQLite schema & state tests
│   ├── test_scraper.py          # Next.js parser, phone normalizer & owner filter tests
│   ├── test_google_pool.py      # Round-robin, cooldown, quota tests
│   ├── test_tts.py              # Edge-TTS synthesis & word-level subtitle tests
│   ├── test_compositor.py       # FFmpeg 9:16 rendering, blur, banners, and subtitle tests
│   ├── test_dispatcher.py       # Social caption & Telegram CRM dispatcher tests
│   ├── test_pipeline.py         # End-to-end pipeline integration tests
│   ├── test_scheduler.py        # Autonomous scheduler calculation & daemon tests
│   └── test_menu_and_env.py     # Interactive terminal menu, .env loader & query tests
├── .env.example                 # Example configuration environment variables
├── requirements.txt             # Python dependencies
├── run_pipeline.py              # End-to-end pipeline CLI orchestrator
├── interactive_menu.py          # Terminal interactive control center
├── run.bat                      # 1-click batch script for running the pipeline CLI
├── menu.bat                     # 1-click batch script for launching the Interactive Menu
└── start_daemon.bat             # 1-click batch script for running the Background Scheduler
```

---

## 1-Click Interactive Control Center (`menu.bat`)

Launch the colorized terminal dashboard:
```cmd
menu.bat
```
*(or `python interactive_menu.py`)*

### Menu Operations:
- **[1] Yeni Mənzilləri Tap və Video Hazırla (Run Pipeline Now)**: Scrapes fresh direct owner listings and generates vertical videos immediately.
- **[2] Xüsusi Elan ID ilə Video Hazırla (Process Specific Listing ID)**: Enter any `bina.az` ID to download its photos, build subtitles, render video, and dispatch lead.
- **[3] 6 Google AI Hesabını Qeyd Et (Interactive Google Profile Setup 1..6)**: Inspect profiles, initialize disk directories, and open Playwright browser for manual login.
- **[4] Telegram Bot və Çat Parametrlərini Daxil Et (.env Setup)**: Interactively view and update your Telegram Bot Token, Chat ID, Mock mode, and price filters.
- **[5] Avtomatik Arxa Plan Cədvəlini Başlat (Start Background Daemon)**: Run the scheduler in current terminal or spawn in a detached background window.
- **[6] Hazır Videoları və Elan Sahibləri Bazasını Göstər (View Leads & Videos)**: Table view of captured leads, phone numbers, and rendered videos with 1-click Explorer opening.
- **[7] Bütün Testləri İcra Et (Run Full Test Suite)**: Executes all 51 automated tests directly from the menu.
- **[0] Çıxış**: Clean exit.

---

## Autonomous Background Daemon (`start_daemon.bat`)

Run unattended on a schedule (e.g. daily at 12:30 and 19:30):
```cmd
start_daemon.bat
```

Command-line flags supported by `src/scheduler.py`:
- `--times 12:30,19:30`: Set specific daily execution times (24-hour format).
- `--interval 2.0`: Run continuously every N hours.
- `--pages 1`: Number of search pages to scan per run.
- `--limit 3`: Max listings to convert into videos per run.
- `--once`: Execute a single run immediately and exit (ideal for cron or Windows Task Scheduler).
- `--live-dispatch`: Send directly to real Telegram chat instead of mock mode.
- `--no-startup-run`: Wait until the next scheduled time without running immediately on startup.

---

## Configuration via `.env`

Copy `.env.example` to `.env` or edit directly via Menu option `[4]`:
```env
# Telegram CRM / Dispatcher
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_MOCK_DISPATCH=true

# Bina.az Filtering
CITY_ID=1
MIN_PRICE=100000
MAX_PRICE=350000
BINA_OWNER_ONLY=true

# Daemon Scheduling
SCHEDULE_TIMES=12:30,19:30
SCHEDULE_INTERVAL_HOURS=0
SCHEDULE_PAGES=1
SCHEDULE_LIMIT=3
SCHEDULE_RUN_ON_STARTUP=true

# Google Pool & TTS
GOOGLE_POOL_SIZE=6
EDGE_TTS_VOICE=az-AZ-BabekNeural
EDGE_TTS_RATE=+10%
```

---

## Running the Automated Test Suite

Run all 51 unit and integration tests:
```bash
python -m unittest discover tests
```
All tests verify real live bina.az crawling, Microsoft Edge-TTS audio generation, word-level SRT sync, FFmpeg 1080x1920 video composition, database persistence, scheduler calculations, and interactive menu operations.
