"""
Google Account Pool setup script.
Creates persistent browser profile directories (data/profiles/acc_1 .. acc_6),
enables manual 1-click Google login using Brave Browser (immune to bot detection),
and tracks account status in SQLite database.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
import subprocess
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any

from config.settings import PROFILES_DIR, GOOGLE_ACCOUNT_PROFILES, ACCOUNT_DAILY_QUOTA, DB_PATH
from src.database import get_connection, init_db

logger = logging.getLogger("google_setup")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PREFERRED_BROWSER_PATHS = [
    # Brave Browser (User Primary)
    r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"),
    # Google Chrome fallback
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]


def find_browser_executable() -> Optional[str]:
    """Finds installed Brave or Chrome executable on Windows."""
    for p in PREFERRED_BROWSER_PATHS:
        if os.path.exists(p):
            return p
    return None


def setup_all_profiles(profiles_dir: Optional[Path] = None, db_path: Optional[Path] = None) -> List[str]:
    """
    Initializes profile directories on disk and registers accounts in database.
    Returns list of created profile names.
    """
    target_profiles_dir = profiles_dir or PROFILES_DIR
    target_profiles_dir.mkdir(parents=True, exist_ok=True)

    init_db(db_path)
    conn = get_connection(db_path)

    created = []
    with conn:
        for profile_name in GOOGLE_ACCOUNT_PROFILES:
            profile_path = target_profiles_dir / profile_name
            profile_path.mkdir(parents=True, exist_ok=True)

            # Register or update in DB
            conn.execute("""
                INSERT INTO google_accounts (profile_name, is_active, max_daily_quota)
                VALUES (?, 1, ?)
                ON CONFLICT(profile_name) DO UPDATE SET
                    is_active = 1
            """, (profile_name, ACCOUNT_DAILY_QUOTA))

            created.append(profile_name)
            logger.info(f"Initialized persistent context folder: {profile_path}")

    conn.close()
    logger.info(f"Successfully configured {len(created)} Google account profiles.")
    return created


def check_profile_login_status(profile_name: str, profiles_dir: Optional[Path] = None) -> Dict[str, Any]:
    """
    Checks if a profile folder contains persistent session data (Cookies, Storage).
    """
    target_dir = (profiles_dir or PROFILES_DIR) / profile_name
    if not target_dir.exists():
        return {"exists": False, "has_session": False, "size_mb": 0.0}

    total_bytes = sum(f.stat().st_size for f in target_dir.rglob('*') if f.is_file())
    size_mb = round(total_bytes / (1024 * 1024), 2)

    # Check for actual Google auth cookies (SID, SSID, SAPISID, HSID, etc.)
    cookies_paths = [
        target_dir / "Default" / "Network" / "Cookies",
        target_dir / "Default" / "Cookies",
        target_dir / "Network" / "Cookies"
    ]
    has_auth_session = False
    for cp in cookies_paths:
        if cp.exists() and cp.stat().st_size > 0:
            try:
                import sqlite3
                import tempfile
                import shutil
                tmp = tempfile.mktemp()
                shutil.copy2(cp, tmp)
                conn = sqlite3.connect(tmp)
                c = conn.cursor()
                c.execute("SELECT 1 FROM cookies WHERE name IN ('SID', 'SSID', 'SAPISID', 'HSID', '__Secure-1PSID') LIMIT 1")
                if c.fetchone():
                    has_auth_session = True
                conn.close()
                if os.path.exists(tmp):
                    os.remove(tmp)
                if has_auth_session:
                    break
            except Exception:
                pass

    has_cookies = any(p.exists() and p.stat().st_size > 0 for p in cookies_paths)

    return {
        "exists": True,
        "has_session": has_auth_session or (has_cookies and size_mb > 5.0),
        "size_mb": size_mb
    }


def launch_account_for_login(profile_name: str, headless: bool = False):
    """
    Launches Brave Browser with dedicated user-data-dir for manual login.
    Using real Brave prevents Google 'Browser not secure' blocks.
    """
    profile_path = (PROFILES_DIR / profile_name).resolve()
    profile_path.mkdir(parents=True, exist_ok=True)
    browser_exe = find_browser_executable()
    b_name = "Brave Browser" if browser_exe and "Brave" in browser_exe else "Google Chrome"

    if browser_exe and not headless:
        print(f"\n[Brave Setup] {b_name} açılır ({profile_name})...")
        print(f"[Brave Setup] Brauzer yolu: {browser_exe}")
        print(f"[Brave Setup] Profil qovluğu: {profile_path}")
        print(f"[Brave Setup] Zəhmət olmasa Google və Gemini hesabınıza daxil olun.")
        print(f"[Brave Setup] Giriş bitdikdən sonra Brave pəncərəsini bağlayın.\n")

        urls = [
            "https://gemini.google.com/app"
        ]
        cmd = [
            browser_exe,
            f"--user-data-dir={profile_path}",
            "--no-first-run",
            "--no-default-browser-check"
        ] + urls

        proc = subprocess.Popen(cmd)
        proc.wait()
        logger.info(f"{b_name} closed for {profile_name}. Session data saved.")
    else:
        # Fallback to Playwright if needed
        from playwright.sync_api import sync_playwright
        logger.info(f"Launching Playwright context for {profile_name}...")
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(
                user_data_dir=str(profile_path),
                headless=headless,
                executable_path=browser_exe,
                args=["--disable-blink-features=AutomationControlled"]
            )
            page = browser.new_page()
            page.goto("https://accounts.google.com")
            if not headless:
                input(f"Browser opened for {profile_name}. Press Enter after logging in...")
            browser.close()
            logger.info(f"Saved session state for {profile_name}.")


if __name__ == "__main__":
    setup_all_profiles()
