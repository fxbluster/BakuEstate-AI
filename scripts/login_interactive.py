import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.google_pool.setup_accounts import (
    launch_account_for_login,
    setup_all_profiles,
    check_profile_login_status,
    find_browser_executable
)
from config.settings import GOOGLE_ACCOUNT_PROFILES

def print_status_table():
    browser_exe = find_browser_executable()
    b_name = "Brave Browser" if browser_exe and "Brave" in browser_exe else "Google Chrome"

    print("\n" + "=" * 65)
    print(f"      GOOGLE AI PRO (GEMINI) 6 HESABININ CARİ VƏZİYYƏTİ")
    print(f"      Brauzer: {b_name} ({browser_exe})")
    print("=" * 65)
    print(f" {'Hesab':<10} {'Profil Adı':<12} {'Sessiya / Giriş':<22} {'Profil Həcmi'}")
    print("-" * 65)
    for i, p_name in enumerate(GOOGLE_ACCOUNT_PROFILES, 1):
        st = check_profile_login_status(p_name)
        if st["has_session"]:
            sess_txt = "✅ Daxil olunub (Hazır)"
        elif st["size_mb"] > 0:
            sess_txt = "⚠️ Giriş bitməyib (Auth yoxdur)"
        elif st["exists"]:
            sess_txt = "⏳ Boş (Giriş edilməyib)"
        else:
            sess_txt = "❌ Qovluq yoxdur"
        size_txt = f"{st['size_mb']} MB"
        print(f" [{i}]        {p_name:<12} {sess_txt:<32} {size_txt}")
    print("=" * 65)

def main():
    setup_all_profiles()
    browser_exe = find_browser_executable()
    b_name = "Brave" if browser_exe and "Brave" in browser_exe else "Chrome"

    while True:
        print_status_table()
        print("\nNƏ ETMƏK İSTƏYİRSİNİZ?")
        print(f"  [1] Hesab 1 (acc_1) üçün {b_name} aç və daxil ol")
        print(f"  [2] Hesab 2 (acc_2) üçün {b_name} aç və daxil ol")
        print(f"  [3] Hesab 3 (acc_3) üçün {b_name} aç və daxil ol")
        print(f"  [4] Hesab 4 (acc_4) üçün {b_name} aç və daxil ol")
        print(f"  [5] Hesab 5 (acc_5) üçün {b_name} aç və daxil ol")
        print(f"  [6] Hesab 6 (acc_6) üçün {b_name} aç və daxil ol")
        print("  [R] Vəziyyəti yenidən yoxla (Refresh)")
        print("  [0] Çıxış")

        choice = input("\nSeçiminiz (1-6, R, 0): ").strip().upper()
        if choice == "0":
            break
        elif choice == "R":
            continue
        elif choice in ["1", "2", "3", "4", "5", "6"]:
            acc_name = f"acc_{choice}"
            print(f"\n>>> {acc_name} üçün {b_name} açılır...")
            print(f">>> Google və Gemini hesabınıza daxil olun. Bitirdikdə {b_name}-i bağlayın.")
            launch_account_for_login(acc_name, headless=False)
            print(f">>> {acc_name} sessiyası qeyd edildi!\n")
        else:
            print("Yanlış seçim! Yenidən cəhd edin.")

if __name__ == "__main__":
    main()
