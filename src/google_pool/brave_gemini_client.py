"""
Google AI Pro (Gemini Advanced) Client.
Leverages user's active Google AI Pro (Gemini Advanced / Gemini 4) subscriptions
via Playwright persistent browser contexts (data/profiles/acc_1 .. acc_6).
Features automatic account rotation, streaming settlement detection,
and robust error handling with fallback. Zero process conflicts or port locks.
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
from typing import Optional, Dict, Any, List
from pathlib import Path

from src.ui.account_switcher_dialog import prompt_account_switch
from src.google_pool.pool_manager import GooglePoolManager
from src.google_pool.setup_accounts import check_profile_login_status
from config.settings import GOOGLE_ACCOUNT_PROFILES, PROFILES_DIR, DB_PATH

logger = logging.getLogger("brave_gemini")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def clean_gemini_response(text: str) -> str:
    """Cleans Gemini raw response into clean spoken Azerbaijani prose for TTS."""
    from src.media.tts_service import normalize_azerbaijani_phonetics
    lines = text.strip().splitlines()
    cleaned_lines = []
    for line in lines:
        l = line.strip()
        if not l:
            continue
        # Skip introductory chatter or speaker labels
        if re.search(r'^(əlbəttə|buyurun|videoçarx ssenarisi|ssenari:|giriş:|kadr|reels ssenarisi|gemini said|model said)', l, re.IGNORECASE):
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
        # Remove bullet markers and numbered list markers (e.g. "1. ", "1) ", "* ", "- ")
        l = re.sub(r'^(?:[\-\*•]|\d+[\.\)])\s*', '', l)
        l = l.strip()
        if l:
            cleaned_lines.append(l)
    merged = ' '.join(cleaned_lines)
    return normalize_azerbaijani_phonetics(merged)


def is_brave_debugging_open(host: str = "127.0.0.1", port: int = 9222) -> bool:
    """
    Checks if Google AI Pro pool is ready to generate scripts.
    Returns True if at least one profile has an active persistent session
    or if a local CDP browser port is reachable.
    """
    # Check if local port 9222 is open (legacy CDP support)
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.2)
    try:
        if s.connect_ex((host, port)) == 0:
            return True
    except Exception:
        pass
    finally:
        s.close()

    # Check if pool manager has accounts with persistent sessions
    try:
        for p in GOOGLE_ACCOUNT_PROFILES:
            status = check_profile_login_status(p)
            if status.get("has_session", False):
                return True
    except Exception:
        pass

    return False


def ensure_brave_ai_running(timeout: int = 8) -> bool:
    """
    Ensures Google AI Pro pool is ready.
    Initializes profiles if not present. Never terminates running browser processes.
    """
    if is_brave_debugging_open():
        return True

    try:
        from src.google_pool.setup_accounts import setup_all_profiles
        setup_all_profiles()
    except Exception as e:
        logger.warning(f"Could not setup account profiles: {e}")

    return is_brave_debugging_open()


class BraveGeminiClient:
    """
    Client for generating viral real estate scripts using Google AI Pro (Gemini Advanced).
    Rotates accounts across data/profiles/acc_1 .. acc_6 via GooglePoolManager.
    """
    def __init__(
        self,
        cdp_url: str = "http://127.0.0.1:9222",
        max_videos_per_account: int = 5,
        pool_manager: Optional[GooglePoolManager] = None
    ):
        self.cdp_url = cdp_url
        self.max_videos_per_account = max_videos_per_account
        self.pool_manager = pool_manager or GooglePoolManager()
        self.videos_generated_this_account = 0
        self.current_account_index = 1

    def is_connected(self) -> bool:
        """Returns True if Google AI Pro pool is ready."""
        return is_brave_debugging_open()

    def ensure_connected(self) -> bool:
        """Ensures client is ready to process scripts."""
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

    def generate_script(self, listing: Dict[str, Any], max_account_retries: Optional[int] = None) -> Optional[str]:
        """
        Interacts with Google AI Pro (Gemini Advanced) via Playwright persistent context.
        Rotates accounts across the pool if quota is reached or errors occur.
        """
        if not self.is_connected():
            logger.warning("Google AI Pro pool not available. Using fallback template.")
            return None

        prompt_text = self.build_real_estate_prompt(listing)
        retries = max_account_retries if max_account_retries is not None else len(GOOGLE_ACCOUNT_PROFILES)
        attempted_profiles = set()

        for attempt in range(retries):
            account = self.pool_manager.acquire_account(prioritize_sessions=True)
            if not account:
                logger.warning("No Google AI Pro accounts currently available in pool.")
                break

            profile_name = account["profile_name"]
            if profile_name in attempted_profiles:
                continue
            attempted_profiles.add(profile_name)

            status = check_profile_login_status(profile_name, self.pool_manager.profiles_dir)

            if not status.get("has_session", False):
                logger.warning(f"Profile {profile_name} does not have a saved Google session yet. Rotating to next...")
                self.pool_manager.release_account(profile_name, success=False, custom_cooldown=3600)
                continue

            logger.info(f"Using Google AI Pro profile: {profile_name} (Attempt {attempt+1}/{retries})")

            try:
                result = self._execute_gemini_prompt(profile_name, prompt_text)
                if result.get("quota_hit"):
                    logger.warning(f"Quota limit reached on {profile_name}. Putting into cooldown and rotating...")
                    self.pool_manager.release_account(profile_name, success=False, custom_cooldown=3600)
                    continue

                if result.get("captcha_hit"):
                    logger.warning(f"Google bot challenge/CAPTCHA on {profile_name}. Putting into cooldown and rotating...")
                    self.pool_manager.release_account(profile_name, success=False, custom_cooldown=1800)
                    continue

                if result.get("login_required"):
                    logger.warning(f"Google session expired for {profile_name}. Putting into cooldown and rotating...")
                    self.pool_manager.release_account(profile_name, success=False, custom_cooldown=3600)
                    continue

                if result.get("success") and result.get("text"):
                    self.pool_manager.release_account(profile_name, success=True)
                    cleaned = clean_gemini_response(result["text"])
                    logger.info(f"Successfully generated script via {profile_name} ({len(cleaned)} chars).")
                    return cleaned

                # If failed without quota hit (e.g. timeout)
                logger.warning(f"Generation failed on {profile_name}: {result.get('reason', 'unknown')}. Rotating...")
                self.pool_manager.release_account(profile_name, success=False, custom_cooldown=120)

            except Exception as e:
                logger.warning(f"Error during Gemini interaction with {profile_name}: {e}")
                self.pool_manager.release_account(profile_name, success=False, custom_cooldown=120)

        logger.warning("All attempted Google AI Pro accounts failed. Returning None for fallback.")
        return None

    def _execute_gemini_prompt(self, profile_name: str, prompt_text: str) -> Dict[str, Any]:
        """
        Launches Playwright persistent context for profile_name, submits prompt,
        and waits for response completion.
        """
        with self.pool_manager.persistent_playwright_context(profile_name, headless=True) as context:
            if not context:
                return {"success": False, "reason": "No browser context"}

            page = context.pages[0] if context.pages else context.new_page()

            # Anti-detection: mask navigator.webdriver
            try:
                page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")
            except Exception:
                pass

            try:
                page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=40000)
            except Exception as e:
                logger.warning(f"Timeout or error navigating to Gemini: {e}")

            time.sleep(2)

            # Check if redirected to login or CAPTCHA
            curr_url = page.url.lower()
            if "accounts.google.com" in curr_url:
                logger.warning(f"Session expired or login required for {profile_name} ({page.url})")
                return {"success": False, "login_required": True}

            if "google.com/sorry" in curr_url or "recaptcha" in curr_url:
                logger.warning(f"Google bot challenge/CAPTCHA detected for {profile_name} ({page.url})")
                return {"success": False, "captcha_hit": True, "reason": "CAPTCHA challenge"}

            try:
                body_sample = page.locator("body").inner_text()[:400].lower()
                if any(phrase in body_sample for phrase in ["unusual traffic", "not a robot", "robot deyilsiniz"]):
                    logger.warning(f"Unusual traffic detected for {profile_name}")
                    return {"success": False, "captcha_hit": True, "reason": "Unusual traffic warning"}
            except Exception:
                pass

            # Locate editable input field
            input_selector = 'div[contenteditable="true"]'
            try:
                input_elem = page.locator(input_selector).first
                input_elem.wait_for(state="visible", timeout=20000)
            except Exception as e:
                logger.warning(f"Could not locate editable prompt box on {profile_name}: {e}")
                return {"success": False, "reason": "Input element not found"}

            initial_msg_count = page.locator('message-content').count()

            # Fill and submit prompt
            input_elem.click()
            time.sleep(0.3)
            input_elem.fill(prompt_text)
            time.sleep(0.5)

            # Look for send button or press enter
            send_btn = page.locator("button[aria-label*='Send'], button[aria-label*='Göndər'], button[aria-label*='Gönder'], button.send-button").first
            if send_btn.count() > 0 and send_btn.is_visible():
                send_btn.click()
            else:
                page.keyboard.press("Enter")

            # Stream settling detection
            prev_text = ""
            stable_count = 0
            start_t = time.time()
            max_wait_seconds = 45

            while time.time() - start_t < max_wait_seconds:
                time.sleep(1.5)

                # Check for quota limit warning on page
                try:
                    page_content = page.content().lower()
                    if any(q in page_content for q in ["reached your limit", "limitə çatdınız", "try again later", "gözləməlisiniz", "günlük limit"]):
                        return {"success": False, "quota_hit": True}
                except Exception:
                    pass

                all_msgs = page.locator('message-content').all()
                if len(all_msgs) > initial_msg_count:
                    curr_text = all_msgs[-1].inner_text().strip()
                elif all_msgs:
                    curr_text = all_msgs[-1].inner_text().strip()
                else:
                    curr_text = ""

                if curr_text and len(curr_text) > 40:
                    if curr_text == prev_text:
                        stable_count += 1
                        if stable_count >= 2:
                            return {"success": True, "text": curr_text}
                    else:
                        stable_count = 0
                        prev_text = curr_text

            if prev_text and len(prev_text) > 30:
                return {"success": True, "text": prev_text}

            return {"success": False, "reason": "Response timed out or empty"}


if __name__ == "__main__":
    client = BraveGeminiClient()
    print("Is Google AI Pro ready:", client.is_connected())
