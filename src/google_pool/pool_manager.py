"""
Google Account Pool Manager.
Manages account rotation with round-robin scheduling, cooldown intervals (10 mins),
daily quota constraints, and Playwright persistent browser context provisioning.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Dict, Any, List
from contextlib import contextmanager

from config.settings import (
    PROFILES_DIR,
    ACCOUNT_COOLDOWN_SECONDS,
    ACCOUNT_DAILY_QUOTA,
    DB_PATH
)
from src.database import get_connection
from src.google_pool.setup_accounts import find_browser_executable

logger = logging.getLogger("pool_manager")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class GooglePoolManager:
    def __init__(
        self,
        profiles_dir: Optional[Path] = None,
        db_path: Optional[Path] = None,
        cooldown_seconds: int = ACCOUNT_COOLDOWN_SECONDS,
        daily_quota: int = ACCOUNT_DAILY_QUOTA
    ):
        self.profiles_dir = profiles_dir or PROFILES_DIR
        self.db_path = db_path or DB_PATH
        self.cooldown_seconds = cooldown_seconds
        self.daily_quota = daily_quota

    def acquire_account(
        self,
        require_session: bool = False,
        prioritize_sessions: bool = True
    ) -> Optional[Dict[str, Any]]:
        """
        Selects an available account using round-robin (least recently used)
        that is active, not in cooldown, and under its daily quota.
        If prioritize_sessions is True, accounts with persistent sessions on disk
        are prioritized over unconfigured profiles.
        """
        conn = get_connection(self.db_path)
        now_dt = datetime.now(timezone.utc)
        now_iso = now_dt.isoformat()

        try:
            with conn:
                # First look for active accounts whose cooldown has passed and quota not exceeded
                rows = conn.execute("""
                    SELECT * FROM google_accounts
                    WHERE is_active = 1
                      AND (cooldown_until IS NULL OR cooldown_until <= ?)
                      AND quota_used_today < max_daily_quota
                    ORDER BY COALESCE(last_used_at, '1970-01-01') ASC, id ASC
                """, (now_iso,)).fetchall()

                if not rows:
                    logger.warning("No Google accounts currently available (all cooling down or at quota limit).")
                    return None

                selected = None
                from src.google_pool.setup_accounts import check_profile_login_status
                if prioritize_sessions or require_session:
                    for r in rows:
                        status = check_profile_login_status(r["profile_name"], self.profiles_dir)
                        if status.get("has_session", False):
                            selected = dict(r)
                            break

                if not selected:
                    if require_session:
                        logger.warning("No authenticated Google accounts available with active sessions.")
                        return None
                    selected = dict(rows[0])

                # Update last_used_at immediately to reserve it
                conn.execute("""
                    UPDATE google_accounts
                    SET last_used_at = ?
                    WHERE id = ?
                """, (now_iso, selected["id"]))
        finally:
            conn.close()

        logger.info(f"Acquired Google account profile: {selected['profile_name']}")
        return selected

    def release_account(
        self,
        profile_name: str,
        success: bool = True,
        custom_cooldown: Optional[int] = None,
        record_quota: Optional[bool] = None
    ) -> None:
        """
        Releases an account, records quota consumption (if successful or requested),
        and puts it in cooldown.
        """
        conn = get_connection(self.db_path)
        now_dt = datetime.now(timezone.utc)
        cooldown_dur = custom_cooldown if custom_cooldown is not None else self.cooldown_seconds
        cooldown_until_iso = (now_dt + timedelta(seconds=cooldown_dur)).isoformat()
        now_iso = now_dt.isoformat()

        should_record_quota = record_quota if record_quota is not None else (success is True)

        try:
            with conn:
                if should_record_quota:
                    conn.execute("""
                        UPDATE google_accounts
                        SET quota_used_today = quota_used_today + 1,
                            cooldown_until = ?,
                            last_used_at = ?
                        WHERE profile_name = ?
                    """, (cooldown_until_iso, now_iso, profile_name))
                else:
                    conn.execute("""
                        UPDATE google_accounts
                        SET cooldown_until = ?,
                            last_used_at = ?
                        WHERE profile_name = ?
                    """, (cooldown_until_iso, now_iso, profile_name))
        finally:
            conn.close()

        status_str = "success" if success else "failed"
        quota_str = "+1 quota" if should_record_quota else "no quota consumed"
        logger.info(f"Released account {profile_name} ({status_str}, {quota_str}). Cooldown until: {cooldown_until_iso} ({cooldown_dur}s)")

    def get_pool_status(self) -> List[Dict[str, Any]]:
        """Returns the real-time operational status of all accounts in the pool."""
        conn = get_connection(self.db_path)
        now_dt = datetime.now(timezone.utc)

        try:
            rows = conn.execute("""
                SELECT * FROM google_accounts ORDER BY id ASC
            """).fetchall()
        finally:
            conn.close()

        status_list = []
        for r in rows:
            d = dict(r)
            cooldown_rem = 0
            if d.get("cooldown_until"):
                try:
                    cd_dt = datetime.fromisoformat(d["cooldown_until"])
                    diff = (cd_dt - now_dt).total_seconds()
                    cooldown_rem = max(0, int(diff))
                except Exception:
                    cooldown_rem = 0

            d["cooldown_remaining_seconds"] = cooldown_rem
            d["is_available"] = (
                bool(d["is_active"])
                and cooldown_rem == 0
                and d["quota_used_today"] < d["max_daily_quota"]
            )
            d["profile_path"] = str((self.profiles_dir / d["profile_name"]).resolve())
            status_list.append(d)

        return status_list

    def reset_daily_quotas(self) -> None:
        """Resets the quota_used_today counter for all accounts (e.g. daily cron)."""
        conn = get_connection(self.db_path)
        try:
            with conn:
                conn.execute("UPDATE google_accounts SET quota_used_today = 0")
        finally:
            conn.close()
        logger.info("Reset all Google accounts daily quota counters.")

    @contextmanager
    def persistent_playwright_context(self, profile_name: str, headless: bool = True):
        """
        Context manager providing a Playwright BrowserContext with persistent user data dir.
        Applies stealth anti-detection flags to avoid Google CAPTCHA / bot blocks.
        Gracefully yields None if Playwright binary is not available.
        """
        profile_path = self.profiles_dir / profile_name
        profile_path.mkdir(parents=True, exist_ok=True)

        try:
            from playwright.sync_api import sync_playwright
            browser_exe = find_browser_executable()
            with sync_playwright() as p:
                try:
                    context = p.chromium.launch_persistent_context(
                        user_data_dir=str(profile_path),
                        headless=headless,
                        executable_path=browser_exe,
                        ignore_default_args=["--enable-automation"],
                        args=[
                            "--disable-blink-features=AutomationControlled",
                            "--no-sandbox",
                            "--disable-infobars",
                            "--disable-dev-shm-usage",
                            "--no-first-run",
                            "--no-default-browser-check"
                        ]
                    )
                except Exception as e:
                    logger.warning(f"Could not launch browser for profile {profile_name} (needs playwright browser download): {e}")
                    yield None
                    return

                try:
                    yield context
                finally:
                    context.close()
        except ImportError:
            logger.warning("Playwright is not installed in current environment.")
            yield None
