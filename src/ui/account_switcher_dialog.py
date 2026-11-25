"""
Windows Desktop Modal Dialog for Human-in-the-Loop Google Account Switching.
Alerts the user when an account batch is finished or quota reached,
prompting them to switch Google Pro account in Brave and resume pipeline.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import ctypes
import logging
import os
from typing import Optional

try:
    import winsound  # type: ignore[import-not-found]
except ImportError:
    winsound = None  # Linux / macOS / Railway container environments

logger = logging.getLogger("account_switcher_dialog")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# Windows MessageBox Constants
MB_OKCANCEL = 0x00000001
MB_ICONINFORMATION = 0x00000040
MB_SYSTEMMODAL = 0x00001000
IDOK = 1
IDCANCEL = 2


def prompt_account_switch(
    account_number: int = 1,
    videos_completed: int = 0,
    reason: str = "Partiya tamamlandı"
) -> bool:
    """
    Displays an 'Always On Top' Windows modal alert with sound chime.
    Prompts the user to switch Google Pro account in Brave Browser.
    
    Returns True if user clicks OK (switched and continue).
    Returns False if user clicks Cancel (pause/stop).
    """
    # 1. Play alert chime sound (Windows desktop only)
    if winsound is not None:
        try:
            winsound.MessageBeep(winsound.MB_ICONASTERISK)
        except Exception:
            pass

    if sys.platform != "win32" or os.getenv("WORKER_MODE", "").strip().lower() == "railway":
        logger.warning(
            "Headless/non-Windows container (%s) cannot show desktop Google switch dialog #%s.",
            sys.platform,
            account_number,
        )
        return False

    title = "🔔 BakuEstate AI - Google Pro Hesab Dəyişdirici"
    message = (
        f"✅ {account_number}-ci Google Pro Hesabı üzrə iş tamamlandı!\n"
        f"📊 Bu sessiyada hazırlanan videolar: {videos_completed} ədəd\n"
        f"ℹ️ Səbəb: {reason}\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"👉 ZƏHMƏT OLMASA NÖVBƏTİ ADDIRMI EDİN:\n"
        f"1. Açıq olan Brave brauzerinə keçin.\n"
        f"2. Sağ yuxarıdakı dairəyə (profil şəklinə) basıb NÖVBƏTİ Google Pro hesabını seçin.\n"
        f"3. Hesabı dəyişdikdən sonra aşağıdakı 'OK' düyməsinə basın.\n\n"
        f"Sistem dərhal növbəti hesabınızla davam edəcək!\n"
        f"(İşi dayandırmaq üçün 'Cancel' basın)"
    )

    flags = MB_OKCANCEL | MB_ICONINFORMATION | MB_SYSTEMMODAL

    logger.info(f"Showing Account Switch dialog for account #{account_number}...")
    try:
        result = ctypes.windll.user32.MessageBoxW(0, message, title, flags)
        if result == IDOK:
            logger.info("User confirmed account switch. Resuming pipeline...")
            return True
        else:
            logger.info("User canceled/paused pipeline.")
            return False
    except Exception as e:
        logger.warning(f"Could not open native MessageBox: {e}. Falling back to console prompt.")
        print("\n" + "=" * 60)
        print(f"🔔 [DİQQƏT] {account_number}-ci Google Pro hesabı bitdi!")
        print("Zəhmət olmasa Brave-də növbəti hesaba keçin və Enter basın...")
        print("=" * 60)
        try:
            input("Davam etmək üçün Enter, dayandırmaq üçün 'q' yazıb Enter: ")
            return True
        except Exception:
            return False


if __name__ == "__main__":
    # Test dialog directly
    print("Testing Account Switcher dialog...")
    confirmed = prompt_account_switch(account_number=1, videos_completed=5, reason="Gündəlik limit / partiya sonu")
    print("Dialog result:", "CONTINUE" if confirmed else "CANCEL")
