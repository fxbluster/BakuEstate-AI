"""
Brave Browser Gemini Pro Client.
Connects to the user's running Brave Browser session over CDP (port 9222).
Enables zero-cost usage of the user's active Google Pro (Gemini Advanced) subscription
for professional Azerbaijani real estate copywriting and script generation.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import time
import socket
import logging
import re
from typing import Optional, Dict, Any

from src.ui.account_switcher_dialog import prompt_account_switch

logger = logging.getLogger("brave_gemini")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def clean_gemini_response(text: str) -> str:
    """Cleans Gemini raw response into clean spoken Azerbaijani prose for Edge-TTS."""
    lines = text.strip().splitlines()
    cleaned_lines = []
    for line in lines:
        l = line.strip()
        if not l:
            continue
        # Skip introductory chatter
        if re.search(r'^(əlbəttə|buyurun|videoçarx ssenarisi|ssenari:|giriş:|kadr|reels ssenarisi)', l, re.IGNORECASE):
            continue
        # Skip outtro chatter
        if re.search(r'^(uğurlar|ümid edirəm|bu ssenari|qeyd:)', l, re.IGNORECASE):
            continue
        # Remove bold/italic markdown
        l = re.sub(r'\*\*(.*?)\*\*', r'\1', l)
        l = re.sub(r'[\*#_`]', '', l)
        # Remove bracketed stage directions like [Musiqi çalır] or (Kadr dəyişir)
        l = re.sub(r'\[.*?\]', '', l)
        l = re.sub(r'\(.*?\)', '', l)
        l = l.strip()
        if l:
            cleaned_lines.append(l)
    return ' '.join(cleaned_lines)


def is_brave_debugging_open(host: str = "127.0.0.1", port: int = 9222) -> bool:
    """Checks if Brave is running with --remote-debugging-port=9222."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.8)
    try:
        res = s.connect_ex((host, port))
        return res == 0
    except Exception:
        return False
    finally:
        s.close()


def ensure_brave_ai_running(timeout: int = 8) -> bool:
    """
    Ensures Brave is running with remote debugging port 9222 and user's profile.
    If not running or port not open, starts Brave automatically.
    """
    if is_brave_debugging_open():
        return True

    from src.google_pool.setup_accounts import find_browser_executable
    brave_exe = find_browser_executable()
    if not brave_exe:
        logger.error("Brave browser executable not found on system.")
        return False

    import subprocess
    import os
    user_data = os.path.expandvars(r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data")

    # If brave is running without port 9222, restart it cleanly
    try:
        subprocess.run(["taskkill", "/F", "/IM", "brave.exe"], capture_output=True, timeout=5)
        time.sleep(1.5)
    except Exception:
        pass

    logger.info("Brave avtomatik açılır (Google Pro AI sessiyası aktiv edilir)...")
    creation_flags = 0
    if sys.platform == "win32":
        creation_flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP

    subprocess.Popen([
        brave_exe,
        "--remote-debugging-port=9222",
        "--remote-allow-origins=*",
        f"--user-data-dir={user_data}",
        "https://gemini.google.com/app"
    ], creationflags=creation_flags)

    start_t = time.time()
    while time.time() - start_t < timeout:
        if is_brave_debugging_open():
            logger.info("Brave uğurla Google Pro rejiminə qoşuldu (Port 9222 Aktivdir)!")
            return True
        time.sleep(0.5)

    return is_brave_debugging_open()


class BraveGeminiClient:
    def __init__(self, cdp_url: str = "http://127.0.0.1:9222", max_videos_per_account: int = 5):
        self.cdp_url = cdp_url
        self.max_videos_per_account = max_videos_per_account
        self.videos_generated_this_account = 0
        self.current_account_index = 1

    def is_connected(self) -> bool:
        """Returns True if Brave CDP port is open and reachable."""
        return is_brave_debugging_open()

    def ensure_connected(self) -> bool:
        """Ensures Brave is running and connected on CDP port 9222."""
        return ensure_brave_ai_running()

    def build_real_estate_prompt(self, listing: Dict[str, Any]) -> str:
        """Constructs an ultra-engaging, viral Azerbaijani prompt for Gemini Advanced."""
        title = listing.get("title", "")
        price = listing.get("price", "")
        currency = listing.get("currency", "AZN")
        location = listing.get("location") or listing.get("address") or "Bakı"
        rooms = listing.get("rooms", "")
        area = listing.get("area", "")
        floor = listing.get("floor", "")
        floors = listing.get("floors", "")
        has_kupca = listing.get("has_bill_of_sale", True)
        description = listing.get("description", "")

        prompt = (
            f"Sən daşınmaz əmlak üzrə peşəkar, gənc, həddindən artıq enerjili və cəlbedici XANIM aparıcısan (Instagram Reels / TikTok ulduzu). "
            f"Aşağıdakı mənzil üçün 25-28 saniyəlik həyəcanlı, maraq oyadan, satıcı və canlı "
            f"Azərbaycan dilində səsli videoçarx ssenarisi yaz.\n\n"
            f"MƏNZİL MƏLUMATLARI:\n"
            f"- Başlıq: {title}\n"
            f"- Qiymət: {price} {currency}\n"
            f"- Yerləşmə: {location}\n"
            f"- Parametrlər: {rooms} otaq, {area} kv.m, mərtəbə {floor}/{floors}\n"
            f"- Sənəd: {'Dövlət Çıxarışı (Kupça) var, ipotekaya tam yararlıdır' if has_kupca else 'Müqaviləli'}\n"
            f"- Əlavə məlumat: {description[:300]}\n\n"
            f"TƏLƏBLƏR:\n"
            f"1. YALNIZ diktor xanımın oxuyacağı təmiz, danışıq dilində mətn yaz. Heç bir kadr qeydi, mötərizə və ya təlimat yazma!\n"
            f"2. İLK 3 SANİYƏDƏ şok, maraq və ya təcili satış qarmağı (hook) at: məsələn, 'Dayanın! Zarafat deyil! Bu qiymətə Kupçalı ev?!' və ya 'Bakıda belə fürsət ildə bir dəfə olur!'.\n"
            f"3. Cümlələri qısa, ritmik və dinamik qur (4-8 söz). Həyəcanı artırmaq üçün nida işarələrindən (!) və təbii fasilələrdən (—) istifadə et.\n"
            f"4. Qiyməti (məsələn: 'cəmi {price} min manat'), yerləşməni və kupçanın olmasını mütləq vurğula.\n"
            f"5. Sonda dərhal nömrəyə zəng etməyə və ya WhatsApp-a yazmağa güclü çağırışla (Call-to-Action) bitir."
        )
        return prompt

    def generate_script(self, listing: Dict[str, Any]) -> Optional[str]:
        """
        Interacts with the user's active Brave session to generate the script via Gemini Advanced.
        Triggers Account Switcher dialog if batch limit is reached.
        """
        # Check batch limit before running
        if self.videos_generated_this_account >= self.max_videos_per_account:
            logger.info(f"Reached batch limit ({self.max_videos_per_account} videos) for account #{self.current_account_index}.")
            user_continued = prompt_account_switch(
                account_number=self.current_account_index,
                videos_completed=self.videos_generated_this_account,
                reason="Hesab partiyası tamamlandı"
            )
            if user_continued:
                self.current_account_index += 1
                self.videos_generated_this_account = 0
            else:
                logger.info("User requested to pause after batch completion.")
                return None

        if not self.is_connected():
            logger.warning("Brave remote debugging port 9222 not reachable. Using fallback template.")
            return None

        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                logger.info(f"Connecting to live Brave Browser at {self.cdp_url}...")
                browser = p.chromium.connect_over_cdp(self.cdp_url)
                context = browser.contexts[0] if browser.contexts else browser

                # Find existing Gemini tab or open new one
                gemini_page = None
                for _ in range(5):
                    for page in context.pages:
                        if "gemini.google.com" in page.url:
                            gemini_page = page
                            break
                    if gemini_page:
                        break
                    time.sleep(1)

                if not gemini_page:
                    logger.info("Opening Gemini tab in Brave...")
                    gemini_page = context.new_page()
                    gemini_page.goto("https://gemini.google.com/app", wait_until="domcontentloaded")
                    time.sleep(3)

                gemini_page.bring_to_front()
                time.sleep(2)

                # Locate input box with resilience
                prompt_text = self.build_real_estate_prompt(listing)
                input_selector = "textarea.gds-body-l, rich-textarea, div[contenteditable='true'], div[role='textbox'], textarea"
                
                input_elem = gemini_page.locator(input_selector).first
                input_elem.wait_for(state="visible", timeout=15000)

                logger.info("Submitting real estate prompt to Gemini Advanced in Brave...")
                input_elem.click()
                time.sleep(0.3)
                input_elem.fill(prompt_text)
                time.sleep(0.5)

                # Press Enter or click send button
                send_btn = gemini_page.locator("button[aria-label*='Send'], button[aria-label*='Göndər'], button[aria-label*='Gönder'], button.send-button").first
                if send_btn.is_visible():
                    send_btn.click()
                else:
                    gemini_page.keyboard.press("Enter")

                # Wait for response completion
                logger.info("Waiting for Gemini to finish generating script...")
                time.sleep(5)

                response_selectors = [
                    "message-content",
                    ".model-response-text",
                    ".response-content",
                    "div.markdown"
                ]
                latest_text = ""
                for _ in range(10):
                    time.sleep(1)
                    for sel in response_selectors:
                        try:
                            elements = gemini_page.locator(sel).all()
                            if elements:
                                txt = elements[-1].inner_text().strip()
                                if len(txt) > 50:
                                    latest_text = txt
                                    break
                        except Exception:
                            pass
                    if latest_text:
                        break

                # Check for quota limitation message
                page_content = gemini_page.content().lower()
                quota_hit = any(q in page_content for q in ["reached your limit", "limitə çatdınız", "try again later", "gözləməlisiniz"])
                if quota_hit:
                    logger.warning(f"Google Pro Quota limit detected on account #{self.current_account_index}!")
                    user_continued = prompt_account_switch(
                        account_number=self.current_account_index,
                        videos_completed=self.videos_generated_this_account,
                        reason="Google Pro kvota limitinə çatıldı"
                    )
                    browser.close()
                    if user_continued:
                        self.current_account_index += 1
                        self.videos_generated_this_account = 0
                        # Retry with the switched account
                        return self.generate_script(listing)
                    return None

                if latest_text:
                    cleaned_script = clean_gemini_response(latest_text)
                    logger.info(f"Successfully received and cleaned AI script from Gemini ({len(cleaned_script)} chars)!")
                    self.videos_generated_this_account += 1
                    browser.close()
                    return cleaned_script
                else:
                    logger.warning("Could not extract clean text from Gemini page. Using fallback.")
                    browser.close()
                    return None

        except Exception as e:
            logger.warning(f"Error communicating with Gemini in Brave: {e}. Falling back to template.")
            return None


if __name__ == "__main__":
    client = BraveGeminiClient()
    print("Is Brave CDP open:", client.is_connected())
