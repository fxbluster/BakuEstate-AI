"""
Configuration settings for Baku Estate AI Automated Pipeline.
Includes zero-dependency .env loader, directory layouts, scraper filters,
TTS options, video parameters, and Telegram CRM credentials.
"""

from pathlib import Path
import os
import sys
from typing import Optional, Dict

# Ensure UTF-8 on Windows environments
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Base Directory Paths
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
PROFILES_DIR = DATA_DIR / "profiles"
DOWNLOADS_DIR = DATA_DIR / "downloads"
OUTPUT_DIR = DATA_DIR / "output"
DB_PATH = DATA_DIR / "database.sqlite"
ENV_PATH = BASE_DIR / ".env"

# Create required directories automatically
for directory in [DATA_DIR, PROFILES_DIR, DOWNLOADS_DIR, OUTPUT_DIR]:
    directory.mkdir(parents=True, exist_ok=True)


# Zero-dependency .env loader & writer
import re

def parse_env_value(raw: str) -> str:
    """
    Parses raw .env value, stripping inline comments, unquoting,
    and resolving escape sequences.
    """
    raw = raw.strip()
    if not raw:
        return ""
    if raw.startswith('"'):
        end = raw.find('"', 1)
        while end != -1 and raw[end - 1] == '\\':
            end = raw.find('"', end + 1)
        if end != -1:
            val = raw[1:end]
            return val.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"')
        return raw[1:]
    elif raw.startswith("'"):
        end = raw.find("'", 1)
        while end != -1 and raw[end - 1] == '\\':
            end = raw.find("'", end + 1)
        if end != -1:
            val = raw[1:end]
            return val.replace('\\n', '\n').replace('\\t', '\t').replace("\\'", "'")
        return raw[1:]
    else:
        # Unquoted: strip inline comments preceded by whitespace
        m = re.search(r'\s+#', raw)
        if m:
            raw = raw[:m.start()].strip()
        return raw.replace('\\n', '\n').replace('\\t', '\t')


def load_env(env_path: Optional[Path] = None, override: bool = False) -> Dict[str, str]:
    """
    Zero-dependency .env parser.
    Reads key=value pairs, ignores comments and whitespace,
    unquotes strings, handles inline comments, and injects into os.environ.
    """
    path = Path(env_path) if env_path else ENV_PATH
    parsed: Dict[str, str] = {}
    if not path.is_file():
        return parsed

    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, raw_val = line.split("=", 1)
                key = key.strip()
                val = parse_env_value(raw_val)
                parsed[key] = val
                if override or key not in os.environ:
                    os.environ[key] = val
    except Exception:
        pass
    return parsed


def save_env_value(key: str, value: str, env_path: Optional[Path] = None) -> None:
    """
    Saves or updates a single key=value in the .env file.
    Creates the .env file if missing, updates the line if key exists,
    or appends a new line. Also updates os.environ.
    """
    path = Path(env_path) if env_path else ENV_PATH
    lines = []
    found = False

    if path.is_file():
        try:
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
        except Exception:
            lines = []

    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            k, _ = stripped.split("=", 1)
            if k.strip() == key:
                new_lines.append(f"{key}={value}\n")
                found = True
                continue
        new_lines.append(line)

    if not found:
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines[-1] += "\n"
        new_lines.append(f"{key}={value}\n")

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

    os.environ[key] = str(value)


def _safe_int(val: Optional[str], default: int) -> int:
    """Safely converts string to int, handling commas and currency strings."""
    if not val:
        return default
    try:
        cleaned = re.sub(r"[^\d-]", "", str(val).strip())
        return int(cleaned) if cleaned else default
    except Exception:
        return default


def _safe_float(val: Optional[str], default: float) -> float:
    """Safely converts string to float."""
    if not val:
        return default
    try:
        cleaned = re.sub(r"[^\d.-]", "", str(val).strip())
        return float(cleaned) if cleaned else default
    except Exception:
        return default


# Automatically load .env if present
load_env(ENV_PATH, override=False)


# Bina.az Scraping Settings
BINA_BASE_URL = "https://bina.az"
SCRAPE_CITY_ID = _safe_int(os.getenv("CITY_ID") or os.getenv("BINA_CITY_ID"), 1)           # 1 = Baku
SCRAPE_CATEGORY_ID = _safe_int(os.getenv("BINA_CATEGORY_ID"), 1)                           # 1 = Mənzillər (Apartments)
SCRAPE_HAS_BILL_OF_SALE = True                                                              # has_bill_of_sale=true (Kupçalı)
MIN_PRICE = _safe_int(os.getenv("MIN_PRICE") or os.getenv("BINA_MIN_PRICE"), 0)           # Min price filter (0 = no limit)
MAX_PRICE = _safe_int(os.getenv("MAX_PRICE") or os.getenv("BINA_MAX_PRICE"), 0)           # Max price filter (0 = no limit)
FILTER_DIRECT_OWNER_ONLY = os.getenv("BINA_OWNER_ONLY", "true").lower() in ("1", "true", "yes")

# Request Headers
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "az,en-US;q=0.9,en;q=0.8,ru;q=0.7",
}

# Google Pool Settings
GOOGLE_POOL_SIZE = int(os.getenv("GOOGLE_POOL_SIZE", "6"))
GOOGLE_ACCOUNT_PROFILES = [f"acc_{i+1}" for i in range(GOOGLE_POOL_SIZE)]
ACCOUNT_COOLDOWN_SECONDS = int(os.getenv("ACCOUNT_COOLDOWN_SECONDS", "600"))  # 10 minutes
ACCOUNT_DAILY_QUOTA = int(os.getenv("ACCOUNT_DAILY_QUOTA", "50"))

# Microsoft Edge-TTS Settings
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "az-AZ-BabekNeural")
EDGE_TTS_RATE = os.getenv("EDGE_TTS_RATE", "+10%")
EDGE_TTS_VOLUME = os.getenv("EDGE_TTS_VOLUME", "+0%")

# OpenAI Professional Studio TTS Settings
TTS_ENGINE = os.getenv("TTS_ENGINE", "openai" if os.getenv("OPENAI_API_KEY") else "edge").lower()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "tts-1")  # 'tts-1' or 'tts-1-hd'
OPENAI_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "onyx")   # onyx, alloy, echo, nova, shimmer
OPENAI_TTS_SPEED = _safe_float(os.getenv("OPENAI_TTS_SPEED"), 1.05)

# Video Compositor Settings (9:16 vertical short format for Reels/TikTok/Shorts)
VIDEO_WIDTH = 1080
VIDEO_HEIGHT = 1920
FPS = 30
SLIDE_DURATION = 3.5  # Seconds per photo in Ken Burns slideshow
MIN_VIDEO_DURATION = 12.0
MAX_VIDEO_DURATION = 55.0

# Assets and Background Music
ASSETS_DIR = BASE_DIR / "assets"
MUSIC_DIR = ASSETS_DIR / "music"
SFX_DIR = ASSETS_DIR / "sfx"
DEFAULT_BG_MUSIC = os.getenv("DEFAULT_BG_MUSIC", str(MUSIC_DIR / "luxury_beat.mp3"))

# Colors for banners & badges
COLOR_GOLDEN_BANNER = "#F59E0B"  # Golden price banner
COLOR_KUPCA_BADGE = "#10B981"    # Emerald green Kupça badge
COLOR_TEXT_PRIMARY = "#FFFFFF"
COLOR_TEXT_DARK = "#1F2937"

# Background blur settings
BLUR_FILTER = "boxblur=25:5"

# Telegram CRM / Dispatcher Settings
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
TELEGRAM_MOCK_DISPATCH = os.getenv("TELEGRAM_MOCK_DISPATCH", "true").lower() in ("1", "true", "yes")

# Scheduler & Daemon Settings
SCHEDULE_TIMES = os.getenv("SCHEDULE_TIMES", "12:30,19:30")
SCHEDULE_INTERVAL_HOURS = _safe_float(os.getenv("SCHEDULE_INTERVAL_HOURS"), 0.0)
SCHEDULE_PAGES = _safe_int(os.getenv("SCHEDULE_PAGES"), 1)
SCHEDULE_LIMIT = _safe_int(os.getenv("SCHEDULE_LIMIT"), 3)
SCHEDULE_RUN_ON_STARTUP = os.getenv("SCHEDULE_RUN_ON_STARTUP", "true").lower() in ("1", "true", "yes")
