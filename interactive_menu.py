"""
Baku Estate AI - Interactive Control Center & Terminal Menu.
Provides a turn-key interface for managing scraping, video generation,
Google account pool, Telegram CRM setup, daemon scheduling, and database leads.
"""

import sys
import os
from pathlib import Path

# Add project root to sys.path
BASE_PROJECT_DIR = Path(__file__).resolve().parent
if str(BASE_PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_PROJECT_DIR))

# Ensure UTF-8 on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass
    # Enable Windows ANSI escape sequence processing
    os.system("")

import subprocess
from datetime import datetime
from typing import Optional, List, Dict, Any

from config.settings import (
    BASE_DIR,
    DB_PATH,
    OUTPUT_DIR,
    PROFILES_DIR,
    ENV_PATH,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    TELEGRAM_MOCK_DISPATCH,
    MIN_PRICE,
    MAX_PRICE,
    SCRAPE_CITY_ID,
    SCHEDULE_TIMES,
    SCHEDULE_INTERVAL_HOURS,
    load_env,
    save_env_value
)
from src.database import (
    init_db,
    get_recent_listings,
    get_recent_videos,
    get_google_accounts,
    get_listing_by_bina_id
)
from src.google_pool.setup_accounts import setup_all_profiles, launch_account_for_login
from src.scheduler import BakuEstateScheduler, parse_schedule_times
from run_pipeline import BakuEstatePipeline


# Terminal Color Schemes
class Colors:
    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"


def clear_screen():
    """Clears the console screen if attached to an interactive terminal."""
    if sys.stdout.isatty() and not os.getenv("TEST_MODE"):
        os.system("cls" if os.name == "nt" else "clear")


def print_banner():
    """Prints the Baku Estate AI branding header."""
    print(f"{Colors.CYAN}{Colors.BOLD}")
    print("  ========================================================================")
    print("     ██████╗  █████╗ ██╗  ██╗██╗   ██╗    ███████╗███████╗████████╗ █████╗ ████████╗███████╗")
    print("     ██╔══██╗██╔══██╗██║ ██╔╝██║   ██║    ██╔════╝██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██╔════╝")
    print("     ██████╔╝███████║█████╔╝ ██║   ██║    █████╗  ███████╗   ██║   ███████║   ██║   █████╗  ")
    print("     ██╔══██╗██╔══██║██╔═██╗ ██║   ██║    ██╔══╝  ╚════██║   ██║   ██╔══██║   ██║   ██╔══╝  ")
    print("     ██████╔╝██║  ██║██║  ██╗╚██████╔╝    ███████╗███████║   ██║   ██║  ██║   ██║   ███████╗")
    print("  ========================================================================")
    print("         AUTONOMOUS REAL ESTATE VIDEO PRODUCTION & DISPATCH ENGINE        ")
    print("  ========================================================================")
    print(f"{Colors.RESET}")


def pause(prompt_text: str = "Davam etmək üçün Enter düyməsini basın..."):
    """Waits for user input before returning."""
    print(f"\n{Colors.DIM}{prompt_text}{Colors.RESET}", end="")
    try:
        input()
    except (EOFError, KeyboardInterrupt):
        pass


def action_run_pipeline_now(test_mode: bool = False, limit_input: Optional[int] = None):
    """Option [1]: Run Pipeline Now to find new listings and produce videos."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}>>> [1] YENİ MƏNZİLLƏRİ TAP VƏ VİDEO HAZIRLA <<<{Colors.RESET}\n")

    if not test_mode and limit_input is None:
        try:
            val = input(f"Hazırlanacaq video sayı (Varsayılan: 1): ").strip()
            limit = int(val) if val.isdigit() and int(val) > 0 else 1
        except (EOFError, KeyboardInterrupt):
            return
    else:
        limit = limit_input or 1

    load_env(ENV_PATH, override=True)
    mock = os.getenv("TELEGRAM_MOCK_DISPATCH", "true").lower() in ("1", "true", "yes")
    owner_only = os.getenv("BINA_OWNER_ONLY", "true").lower() in ("1", "true", "yes")

    print(f"{Colors.CYAN}Bina.az axtarışı başladılır (Limit: {limit}, Mock Telegram: {mock}, Sahibindən: {owner_only})...{Colors.RESET}\n")

    pipeline = BakuEstatePipeline(owner_only=owner_only, mock_dispatch=mock, db_path=DB_PATH)
    try:
        results = pipeline.run_full_pipeline(pages=1, limit=limit)
        print(f"\n{Colors.GREEN}{Colors.BOLD}✔ Əməliyyat tamamlandı! {len(results)} ədəd video hazırlandı.{Colors.RESET}")
        for idx, res in enumerate(results, 1):
            print(f"  {idx}. Elan ID: {res.get('bina_id')} | Video: {res.get('video_path')} | Müddət: {res.get('duration', 0):.1f} san")
    except Exception as e:
        print(f"{Colors.RED}✖ Xəta baş verdi: {e}{Colors.RESET}")

    if not test_mode:
        pause()


def action_process_specific_id(test_mode: bool = False, id_input: Optional[str] = None):
    """Option [2]: Process Specific Listing ID."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}>>> [2] XÜSUSİ ELAN ID İLƏ VİDEO HAZIRLA <<<{Colors.RESET}\n")

    if not test_mode and id_input is None:
        try:
            listing_input = input("bina.az elan ID-sini və ya linkini daxil edin (məs: 4567890 və ya https://bina.az/items/4567890): ").strip()
        except (EOFError, KeyboardInterrupt):
            return
    else:
        listing_input = id_input or ""

    import re
    # Extract numerical ID even if user pasted a full URL
    m = re.search(r"(\d+)", listing_input)
    listing_id = m.group(1) if m else ""

    if not listing_id:
        print(f"{Colors.RED}✖ Elan ID boş və ya yanlışdır.{Colors.RESET}")
        if not test_mode:
            pause()
        return

    load_env(ENV_PATH, override=True)
    mock = os.getenv("TELEGRAM_MOCK_DISPATCH", "true").lower() in ("1", "true", "yes")

    print(f"\n{Colors.CYAN}Elan #{listing_id} üçün məlumatlar və şəkillər endirilir...{Colors.RESET}")
    pipeline = BakuEstatePipeline(owner_only=False, mock_dispatch=mock, db_path=DB_PATH)
    try:
        results = pipeline.run_full_pipeline(pages=1, limit=1, specific_id=listing_id)
        if results and results[0].get("video_path"):
            res = results[0]
            print(f"\n{Colors.GREEN}{Colors.BOLD}✔ Elan #{listing_id} üçün video uğurla yaradıldı!{Colors.RESET}")
            print(f"  Fayl: {res.get('video_path')}")
            print(f"  Audio: {res.get('audio_path')}")
            print(f"  Subtitr: {res.get('srt_path')}")
            print(f"  Telegram: {res.get('dispatch', {}).get('status', 'OK')}")
        else:
            print(f"{Colors.RED}✖ Elan tapılmadı və ya video hazırlana bilmədi.{Colors.RESET}")
    except Exception as e:
        print(f"{Colors.RED}✖ Xəta baş verdi: {e}{Colors.RESET}")

    if not test_mode:
        pause()


def action_google_accounts_setup(test_mode: bool = False, choice_input: Optional[str] = None, acc_input: Optional[str] = None):
    """Option [3]: Interactive Google Profile Setup (acc_1 .. acc_6)."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}>>> [3] 6 GOOGLE AI HESABINI QEYD ET (acc_1 .. acc_6) <<<{Colors.RESET}\n")

    init_db(DB_PATH)
    accounts = get_google_accounts(DB_PATH)

    print(f"{Colors.CYAN}Mövcud Google Hesabları Statusu:{Colors.RESET}")
    print(f" {'ID':<4} {'Profil Adı':<12} {'Status':<10} {'Günlük Kvota':<15} {'Qovluq Mövcuddur?'}")
    print(f" {'-'*65}")

    for acc in accounts:
        p_name = acc["profile_name"]
        p_dir = PROFILES_DIR / p_name
        dir_exists = f"{Colors.GREEN}Bəli (Hazırdır){Colors.RESET}" if p_dir.is_dir() else f"{Colors.YELLOW}Yoxdur{Colors.RESET}"
        status_txt = f"{Colors.GREEN}Aktiv{Colors.RESET}" if acc["is_active"] else f"{Colors.RED}Qeyri-aktiv{Colors.RESET}"
        quota_txt = f"{acc['quota_used_today']}/{acc['max_daily_quota']}"
        print(f" {acc['id']:<4} {p_name:<12} {status_txt:<19} {quota_txt:<15} {dir_exists}")

    print(f"\nSeçimlər:")
    print(f"  [1] Bütün 6 profili avtomatik yarat və konfiqurasiya et")
    print(f"  [2] Xüsusi hesaba daxil olmaq üçün Playwright brauzeri aç (Manual Login)")
    print(f"  [0] Əsas menyuya qayıt")

    if not test_mode and choice_input is None:
        try:
            choice = input(f"\nSeçiminizi edin (0-2): ").strip()
        except (EOFError, KeyboardInterrupt):
            return
    else:
        choice = choice_input or "0"

    if choice == "1":
        created = setup_all_profiles(PROFILES_DIR, DB_PATH)
        print(f"\n{Colors.GREEN}{Colors.BOLD}✔ {len(created)} profil uğurla qeydiyyatdan keçdi və qovluqlar yaradıldı!{Colors.RESET}")
    elif choice == "2":
        try:
            if not test_mode and acc_input is None:
                acc_num = input("Giriş üçün hesab nömrəsini daxil edin (1-6): ").strip()
            else:
                acc_num = acc_input or "1"
            if acc_num in [str(i) for i in range(1, 7)]:
                profile_name = f"acc_{acc_num}"
                print(f"{Colors.CYAN}Google girişi üçün brauzer başladılır ({profile_name})...{Colors.RESET}")
                launch_account_for_login(profile_name, headless=test_mode)
            else:
                print(f"{Colors.RED}✖ Yanlış hesab nömrəsi.{Colors.RESET}")
        except Exception as e:
            print(f"{Colors.RED}✖ Xəta: {e}{Colors.RESET}")

    if not test_mode:
        pause()


def action_telegram_env_setup(test_mode: bool = False, inputs: Optional[Dict[str, str]] = None, env_path: Optional[Path] = None):
    """Option [4]: Setup Telegram Bot, Chat ID, and Scraping Parameters (.env)."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}>>> [4] TELEGRAM BOT VƏ .ENV PARAMETRLƏRİ <<<{Colors.RESET}\n")

    target_env = env_path or ENV_PATH
    current_env = load_env(target_env, override=True)
    cur_token = current_env.get("TELEGRAM_BOT_TOKEN") or os.getenv("TELEGRAM_BOT_TOKEN", "")
    cur_chat_id = current_env.get("TELEGRAM_CHAT_ID") or os.getenv("TELEGRAM_CHAT_ID", "")
    cur_mock = current_env.get("TELEGRAM_MOCK_DISPATCH") or os.getenv("TELEGRAM_MOCK_DISPATCH", "true")
    cur_min_price = current_env.get("MIN_PRICE") or os.getenv("MIN_PRICE", "0")
    cur_max_price = current_env.get("MAX_PRICE") or os.getenv("MAX_PRICE", "0")
    cur_city = current_env.get("CITY_ID") or os.getenv("CITY_ID", "1")

    # Mask token for display
    masked_token = (cur_token[:6] + "..." + cur_token[-4:]) if len(cur_token) > 10 else (cur_token or "Təyin edilməyib")

    print(f"Mövcud Parametrlər:")
    print(f"  1. Telegram Bot Token : {Colors.CYAN}{masked_token}{Colors.RESET}")
    print(f"  2. Telegram Chat ID   : {Colors.CYAN}{cur_chat_id or 'Təyin edilməyib'}{Colors.RESET}")
    print(f"  3. Test / Mock Rejimi : {Colors.CYAN}{cur_mock} (true = simulyasiya, false = canlı göndəriş){Colors.RESET}")
    print(f"  4. Min Qiymət (AZN)   : {Colors.CYAN}{cur_min_price}{Colors.RESET}")
    print(f"  5. Max Qiymət (AZN)   : {Colors.CYAN}{cur_max_price}{Colors.RESET}")
    print(f"  6. Şəhər Kodu (CITY)  : {Colors.CYAN}{cur_city} (1 = Bakı){Colors.RESET}")
    print(f"\n{Colors.DIM}(Dəyişmək istəmədiyiniz sətirlərdə birbaşa Enter düyməsini basın){Colors.RESET}\n")

    if not test_mode:
        try:
            new_token = input(f"Yeni Telegram Bot Token [{masked_token}]: ").strip()
            new_chat_id = input(f"Yeni Telegram Chat ID [{cur_chat_id}]: ").strip()
            new_mock = input(f"Mock Rejimi (true/false) [{cur_mock}]: ").strip()
            new_min_p = input(f"Minimum Qiymət [{cur_min_price}]: ").strip()
            new_max_p = input(f"Maksimum Qiymət [{cur_max_price}]: ").strip()
            new_city = input(f"Şəhər ID [{cur_city}]: ").strip()
        except (EOFError, KeyboardInterrupt):
            return
    else:
        new_token = (inputs or {}).get("token", "")
        new_chat_id = (inputs or {}).get("chat_id", "")
        new_mock = (inputs or {}).get("mock", "")
        new_min_p = (inputs or {}).get("min_price", "")
        new_max_p = (inputs or {}).get("max_price", "")
        new_city = (inputs or {}).get("city_id", "")

    updated_count = 0
    if new_token:
        save_env_value("TELEGRAM_BOT_TOKEN", new_token, target_env)
        updated_count += 1
    if new_chat_id:
        save_env_value("TELEGRAM_CHAT_ID", new_chat_id, target_env)
        updated_count += 1
    if new_mock:
        save_env_value("TELEGRAM_MOCK_DISPATCH", new_mock.lower(), target_env)
        updated_count += 1
    if new_min_p:
        save_env_value("MIN_PRICE", new_min_p, target_env)
        os.environ["BINA_MIN_PRICE"] = new_min_p
        updated_count += 1
    if new_max_p:
        save_env_value("MAX_PRICE", new_max_p, target_env)
        os.environ["BINA_MAX_PRICE"] = new_max_p
        updated_count += 1
    if new_city:
        save_env_value("CITY_ID", new_city, target_env)
        os.environ["BINA_CITY_ID"] = new_city
        updated_count += 1

    if updated_count > 0:
        print(f"\n{Colors.GREEN}{Colors.BOLD}✔ {updated_count} parametr uğurla .env faylında saxlanıldı!{Colors.RESET}")
    else:
        print(f"\n{Colors.YELLOW}Heç bir parametr dəyişdirilmədi.{Colors.RESET}")

    if not test_mode:
        pause()


def action_start_scheduler_daemon(test_mode: bool = False, subchoice_input: Optional[str] = None):
    """Option [5]: Start Background Daemon / Scheduler."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}>>> [5] AVTOMATİK ARXA PLAN CƏDVƏLİNİ BAŞLAT <<<{Colors.RESET}\n")

    current_env = load_env(ENV_PATH, override=True)
    times = current_env.get("SCHEDULE_TIMES", SCHEDULE_TIMES)
    interval = float(current_env.get("SCHEDULE_INTERVAL_HOURS", SCHEDULE_INTERVAL_HOURS))

    print(f"Cari Cədvəl Tənzimləmələri:")
    if interval > 0:
        print(f"  Rejim: Təkrarlanan fasilə ({interval} saatdan bir)")
    else:
        print(f"  Rejim: Günlük qeyd olunmuş saatlar ({times})")

    print(f"\nSeçimlər:")
    print(f"  [1] Cari terminalda daemon rejimini başlat (Dayandırmaq üçün Ctrl+C)")
    print(f"  [2] Ayrı bir arxa plan pəncərəsində başlat (start_daemon.bat)")
    print(f"  [3] Tək bir dəfə dərhal icra et (Single Tick)")
    print(f"  [0] Əsas menyuya qayıt")

    if not test_mode and subchoice_input is None:
        try:
            choice = input("\nSeçiminizi edin (0-3): ").strip()
        except (EOFError, KeyboardInterrupt):
            return
    else:
        choice = subchoice_input or "0"

    if choice == "1":
        print(f"\n{Colors.CYAN}Daemon işə salınır... Dayandırmaq üçün istənilən vaxt Ctrl+C basın.{Colors.RESET}\n")
        scheduler = BakuEstateScheduler(
            scheduled_times=parse_schedule_times(times),
            interval_hours=interval,
            run_on_startup=True,
            owner_only=True,
            mock_dispatch=os.getenv("TELEGRAM_MOCK_DISPATCH", "true").lower() in ("1", "true", "yes")
        )
        try:
            scheduler.start()
        except KeyboardInterrupt:
            scheduler.stop()
            print(f"\n{Colors.YELLOW}Daemon dayandırıldı və menyuya qayıdıldı.{Colors.RESET}")
    elif choice == "2":
        bat_file = BASE_DIR / "start_daemon.bat"
        if bat_file.is_file() and sys.platform == "win32":
            subprocess.Popen(["cmd.exe", "/c", "start", str(bat_file)], shell=True)
            print(f"\n{Colors.GREEN}{Colors.BOLD}✔ start_daemon.bat ayrıca pəncərədə uğurla başladıldı!{Colors.RESET}")
        else:
            print(f"{Colors.YELLOW}Batch faylı tapılmadı və ya qeyri-Windows sistem.{Colors.RESET}")
    elif choice == "3":
        print(f"\n{Colors.CYAN}Tək icra başladılır...{Colors.RESET}")
        scheduler = BakuEstateScheduler(
            scheduled_times=parse_schedule_times(times),
            interval_hours=interval,
            run_on_startup=False
        )
        scheduler.run_job()
        print(f"\n{Colors.GREEN}✔ Tək dövr başa çatdı.{Colors.RESET}")

    if not test_mode:
        pause()


def action_view_leads_and_videos(test_mode: bool = False, subaction: Optional[str] = None):
    """Option [6]: View Leads & Video Database."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}>>> [6] HAZIR VİDEOLAR VƏ ELAN SAHİBLƏRİ BAZASI <<<{Colors.RESET}\n")

    init_db(DB_PATH)
    listings = get_recent_listings(limit=10, db_path=DB_PATH)
    videos = get_recent_videos(limit=10, db_path=DB_PATH)

    print(f"{Colors.CYAN}{Colors.BOLD}--- Ən Son Elanlar (Leads & Contacts) ---{Colors.RESET}")
    if listings:
        print(f" {'ID':<8} {'Qiymət':<14} {'Əlaqə Sahibi':<16} {'Telefon':<16} {'Status':<12} {'Başlıq'}")
        print(f" {'-'*85}")
        for item in listings:
            b_id = str(item.get("bina_id"))
            price = f"{item.get('price', 0):,.0f} {item.get('currency', 'AZN')}"
            owner = (item.get("contact_name") or ("Sahib" if item.get("is_owner") else "Vasitəçi"))[:15]
            phone = item.get("owner_phone") or "Yoxdur"
            status = item.get("status", "NEW")
            title = (item.get("title") or "")[:25]
            print(f" {b_id:<8} {price:<14} {owner:<16} {phone:<16} {status:<12} {title}")
    else:
        print("  Hələlik bazada elan qeydə alınmayıb.")

    print(f"\n{Colors.CYAN}{Colors.BOLD}--- Hazır Videolar (Generated Social Media Videos) ---{Colors.RESET}")
    if videos:
        print(f" {'Elan ID':<8} {'Müddət':<8} {'Telegram Status':<18} {'Video Fayl Yolu'}")
        print(f" {'-'*75}")
        for vid in videos:
            b_id = str(vid.get("bina_id"))
            dur = f"{vid.get('duration_seconds', 0):.1f} san"
            tg_stat = f"{Colors.GREEN}Göndərildi (ID {vid.get('telegram_message_id')}){Colors.RESET}" if vid.get("telegram_message_id") else f"{Colors.YELLOW}Gözləyir{Colors.RESET}"
            v_path = Path(vid.get("video_path", "")).name
            print(f" {b_id:<8} {dur:<8} {tg_stat:<28} {v_path}")
    else:
        print("  Hələlik bazada hazır video mövcud deyil.")

    print(f"\nSeçimlər:")
    print(f"  [1] Videolar qovluğunu kompüterdə aç (Explorer)")
    print(f"  [0] Əsas menyuya qayıt")

    if not test_mode and subaction is None:
        try:
            choice = input("\nSeçim (0-1): ").strip()
        except (EOFError, KeyboardInterrupt):
            return
    else:
        choice = subaction or "0"

    if choice == "1":
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            os.system(f'explorer "{OUTPUT_DIR}"')
            print(f"{Colors.GREEN}Qovluq açıldı: {OUTPUT_DIR}{Colors.RESET}")
        else:
            print(f"Video qovluğu: {OUTPUT_DIR}")

    if not test_mode:
        pause()


def action_run_tests(test_mode: bool = False, runner_cmd: Optional[List[str]] = None) -> bool:
    """Option [7]: Run Full Test Suite."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}>>> [7] TESTLƏRİN İCRA EDİLMƏSİ (RUN TEST SUITE) <<<{Colors.RESET}\n")

    py_exe = sys.executable
    if not Path(py_exe).is_file() or "WindowsApps" in py_exe:
        candidate = r"C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe"
        if Path(candidate).is_file():
            py_exe = candidate

    print(f"{Colors.CYAN}Python: {py_exe}{Colors.RESET}")
    print(f"{Colors.CYAN}Bütün testlər icra olunur...{Colors.RESET}\n")

    cmd = runner_cmd or [py_exe, "-m", "unittest", "discover", "tests"]
    res = subprocess.run(cmd, cwd=str(BASE_DIR))

    success = (res.returncode == 0)
    if success:
        print(f"\n{Colors.GREEN}{Colors.BOLD}✔ Bütün testlər 100% uğurla tamamlandı!{Colors.RESET}")
    else:
        print(f"\n{Colors.RED}{Colors.BOLD}✖ Testlərin icrası zamanı xəta baş verdi!{Colors.RESET}")

    if not test_mode:
        pause()

    return success


def action_run_gemini_brave_mode(test_mode: bool = False, limit_input: Optional[int] = None):
    """Option [G]: Run pipeline with active Google Pro (Gemini) session in Brave."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}>>> [G] BRAVE İLƏ CANLI GOOGLE AI PRO (GEMINI) REJİMİ <<<{Colors.RESET}\n")
    from src.google_pool.brave_gemini_client import is_brave_debugging_open, ensure_brave_ai_running

    if not is_brave_debugging_open():
        print(f"{Colors.YELLOW}Brave brauzeri Google AI Pro rejimində avtomatik açılır...{Colors.RESET}")
        if not ensure_brave_ai_running():
            print(f"{Colors.RED}✖ Brave brauzeri başladıla bilmədi.{Colors.RESET}")
            if not test_mode:
                pause()
            return
        print(f"{Colors.GREEN}✔ Brave brauzeri Google AI Pro rejiminə uğurla qoşuldu!{Colors.RESET}")

    if not test_mode and limit_input is None:
        try:
            limit_str = input(f"\nNeçə mənzil videosu hazırlansın? (Məsələn 3): ").strip()
            limit = int(limit_str) if limit_str.isdigit() and int(limit_str) > 0 else 3
        except (EOFError, KeyboardInterrupt):
            return
    else:
        limit = limit_input or 1

    print(f"\n{Colors.CYAN}Google AI Pro (Gemini) + Brave rejimi başladılır (Limit: {limit})...{Colors.RESET}\n")
    is_mock = os.getenv("TELEGRAM_MOCK_DISPATCH", "false").lower() in ("1", "true", "yes")
    pipeline = BakuEstatePipeline(
        owner_only=True,
        mock_dispatch=is_mock,
        db_path=DB_PATH,
        use_gemini=True
    )
    pipeline.run_full_pipeline(pages=1, limit=limit)

    if not test_mode:
        pause()


def main_loop(interactive: bool = True):
    """Main interactive terminal loop."""
    while True:
        clear_screen()
        print_banner()

        print(f"  {Colors.BOLD}ƏSAS MENYU:{Colors.RESET}")
        print(f"  {Colors.CYAN}{Colors.BOLD}[G]{Colors.RESET} Brave ilə Canlı Google AI Pro (Gemini) Rejimi (Live AI)")
        print(f"  {Colors.GREEN}[1]{Colors.RESET} Yeni Mənzilləri Tap və Video Hazırla (Run Pipeline Now)")
        print(f"  {Colors.GREEN}[2]{Colors.RESET} Xüsusi Elan ID ilə Video Hazırla (Process Specific Listing ID)")
        print(f"  {Colors.GREEN}[3]{Colors.RESET} 6 Google AI Hesabını Qeyd Et (Interactive Google Profile Setup 1..6)")
        print(f"  {Colors.GREEN}[4]{Colors.RESET} Telegram Bot və Çat Parametrlərini Daxil Et (.env Setup)")
        print(f"  {Colors.GREEN}[5]{Colors.RESET} Avtomatik Arxa Plan Cədvəlini Başlat (Start Background Daemon)")
        print(f"  {Colors.GREEN}[6]{Colors.RESET} Hazır Videoları və Elan Sahibləri Bazasını Göstər (View Leads & Videos)")
        print(f"  {Colors.GREEN}[7]{Colors.RESET} Bütün Testləri İcra Et (Run 29+ Test Suite)")
        print(f"  {Colors.RED}[0]{Colors.RESET} Çıxış")
        print()

        if not interactive:
            break

        try:
            choice = input(f" {Colors.BOLD}Seçiminizi edin (0-7): {Colors.RESET}").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nÇıxış edilir...")
            break

        choice = choice.strip()
        if choice.upper() == "G":
            action_run_gemini_brave_mode()
        elif choice == "1":
            action_run_pipeline_now()
        elif choice == "2":
            action_process_specific_id()
        elif choice == "3":
            action_google_accounts_setup()
        elif choice == "4":
            action_telegram_env_setup()
        elif choice == "5":
            action_start_scheduler_daemon()
        elif choice == "6":
            action_view_leads_and_videos()
        elif choice == "7":
            action_run_tests()
        elif choice == "0":
            print(f"\n{Colors.CYAN}Baku Estate AI sistemindən istifadə etdiyiniz üçün təşəkkür edirik! Görüşənədək.{Colors.RESET}\n")
            break
        else:
            print(f"\n{Colors.RED}Yanlış seçim! Zəhmət olmasa 0-7 arasında rəqəm daxil edin.{Colors.RESET}")
            pause()


if __name__ == "__main__":
    main_loop(interactive=True)
