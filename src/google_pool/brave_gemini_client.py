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
from config.settings import (
    GOOGLE_ACCOUNT_PROFILES,
    PROFILES_DIR,
    DB_PATH,
    BAKU_DISTRICT_MEDIAN_M2,
    BAKU_LANDMARK_DISTRICT_MAP,
    safe_parse_numeric
)

logger = logging.getLogger("brave_gemini")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def get_keenable_market_comparison(location: str, price: Any, area: Any) -> Dict[str, Any]:
    """
    Calculates Keenable real-time district market price comparison and discount percentage.
    """
    try:
        num_price = safe_parse_numeric(price, default=0.0, is_price=True)
        num_area = safe_parse_numeric(area, default=0.0, is_price=False)
        if num_price <= 0 or num_area <= 0:
            return {}
        m2_price = int(num_price / num_area)
    except Exception:
        return {}

    loc_lower = (location or "").lower()
    matched_district = None
    district_median = BAKU_DISTRICT_MEDIAN_M2.get("baku_median", 2650)

    # 1. Direct district match
    for d_name, d_price in BAKU_DISTRICT_MEDIAN_M2.items():
        if d_name != "baku_median" and d_name in loc_lower:
            matched_district = d_name.capitalize()
            district_median = d_price
            break

    # 2. Check metro stations & landmarks
    if not matched_district:
        for landmark, dist_name in BAKU_LANDMARK_DISTRICT_MAP.items():
            if landmark in loc_lower:
                matched_district = dist_name
                d_key = dist_name.lower()
                district_median = BAKU_DISTRICT_MEDIAN_M2.get(d_key, district_median)
                break

    if not matched_district:
        matched_district = "Bakı"

    diff = district_median - m2_price
    discount_pct = round((diff / district_median) * 100, 1)

    return {
        "m2_price": m2_price,
        "district": matched_district,
        "district_median": district_median,
        "discount_pct": discount_pct,
        "is_below_market": discount_pct > 0
    }


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

    def build_real_estate_prompt(
        self,
        listing: Dict[str, Any],
        has_photos: bool = False,
        archetype: Optional[str] = None
    ) -> str:
        """Constructs an ultra-engaging, archetype-specific Azerbaijani prompt for Gemini Advanced."""
        from src.media.tts_service import (
            canonicalize_location_phrase,
            detect_listing_archetype,
            verbalize_baku_price
        )

        title = listing.get("title", "")
        price = listing.get("price", "")
        currency = listing.get("currency", "AZN")
        raw_location = listing.get("location") or listing.get("address") or "Bakı"
        location = canonicalize_location_phrase(raw_location)
        rooms = listing.get("rooms", "")
        area = listing.get("area", "")
        floor = listing.get("floor", "")
        floors = listing.get("floors", "")
        has_kupca = listing.get("has_bill_of_sale", True)
        description = listing.get("description", "")
        spoken_price = verbalize_baku_price(price)
        arch = archetype or detect_listing_archetype(listing)

        market_stats = get_keenable_market_comparison(location, price, area)
        market_info_line = ""
        market_requirement = ""
        if market_stats and market_stats.get("m2_price"):
            m2_price = market_stats["m2_price"]
            dist_name = market_stats["district"]
            dist_med = market_stats["district_median"]
            disc_pct = market_stats["discount_pct"]
            if market_stats.get("is_below_market"):
                market_info_line = (
                    f"- Keenable Bazar Analitikası (2026): {dist_name} ərazisində 1 m² üçün median bazar qiyməti {dist_med} AZN-dir. "
                    f"Bu mənzildə isə 1 m² cəmi {m2_price} AZN təşkil edir (bazar qiymətindən təxminən {int(disc_pct)}% UCUZ və son dərəcə sərfəli!).\n"
                )
                market_requirement = (
                    f"6. Keenable bazar qiymət müqayisəsini güclü satış arqumenti kimi istifadə et: "
                    f"məsələn, '{dist_name} ərazisində orta qiymət 1 kvadratı {dist_med} manat olduğu halda, bu evdə cəmi {m2_price} manata!' "
                    f"və ya 'Bazar qiymətindən tam {int(disc_pct)} faiz ucuz super fürsət!'.\n"
                )
            else:
                market_info_line = (
                    f"- Keenable Bazar Analitikası (2026): 1 m² qiyməti {m2_price} AZN ({dist_name} üzrə median: {dist_med} AZN).\n"
                )

        floor_objection_directive = ""
        if floor and floors and str(floor) == str(floors) and int(floors) <= 5:
            floor_objection_directive = (
                "- MƏRTƏBƏ / DAM TƏMİNATI: Mənzil 5 mərtəbəli binanın 5-ci mərtəbəsində yerləşir. "
                "Alıcıların tərəddüdünü aradan qaldırmaq üçün dam örtüyünün tamamilə yeniləndiyini və "
                "üst mərtəbədə ayaq səsi olmadan sakit ailə həyatı təmin etdiyini xüsusi vurğula!\n"
            )

        desc_lower = (str(description) + " " + str(title)).lower()
        is_stone = any(kw in desc_lower for kw in ["daş", "minsk", "leninqrad", "eksperimental", "xruşşov"])
        stone_directive = ""
        if is_stone:
            stone_directive = (
                "- DAŞ BİNA ÜSTÜNLÜYÜ: Bina tam daşdır! Qalın daş divarların yayda təbii sərinlik, "
                "qışda isə ideal istilik saxladığını, panel binalardan fərqli olaraq yüksək səs izolyasiyasına malik olduğunu vurğula!\n"
            )

        photo_directive = ""
        if has_photos:
            photo_directive = (
                "7. VİZUAL ANALİZ TƏLƏBİ: Mənzilin real çəkilmiş interyer fotoları yuxarıda əlavə edilib! "
                "Fotolara diqqətlə bax: təmirin üslubunu (modern/neoklassika, asma tavan, gizli LED işıqlar, laminat/mərmər döşəmə, "
                "geniş vitraj pəncərələr, mətbəx mebeli və ya mənzərə) birbaşa ssenariyə daxil et. "
                "Şablon sözlər deyil, məhz fotoda GÖRÜNƏN real vizual üstünlükləri vurğula!\n"
            )

        if arch == "luxury":
            persona_desc = (
                "Sən elit daşınmaz əmlak üzrə yüksək statuslu, dərin və təmkinli aparıcısan (Architectural Digest / Luxury Real Estate). "
                "Heç vaxt qışqırma və ya ucuz şablonlar ('Dayanın!', 'Şok təklif!') işlətmə. "
                "Sakit, dəbdəbəli, vitraj pəncərələri, tavan hündürlüyünü və prestijli ünvanı vurğulayan 25-28 saniyəlik zərif, canlı Azərbaycan dilində ssenari yaz."
            )
            hook_guidance = "İlk 3 saniyədə elit layihənin arxitekturasını və eksklüzivliyini zərif vurğula."
        elif arch == "villa":
            persona_desc = (
                "Sən bağ evləri və villalar üzrə aparıcısan. "
                "Şəhərin səs-küyündən uzaqlaşmaq, təmiz hava, filterli hovuz, abad bağça və 4 fəsil kurort rahatlığı hissini yaradan 25-28 saniyəlik canlı Azərbaycan dilində ssenari yaz."
            )
            hook_guidance = "İlk 3 saniyədə şəhərdən kənar istirahət və ailə komfortu hissini canlandır."
        elif arch == "commercial":
            persona_desc = (
                "Sən kommersiya daşınmaz əmlakı və investisiya üzrə analitik işgüzar ekspertsən. "
                "Rəqəmlərlə danış: yüksək piyada axını, aylıq stabil icarə gəliri, payback müddəti və likvidliyi ön plana çıxaran 25-28 saniyəlik işgüzar, canlı Azərbaycan dilində ssenari yaz."
            )
            hook_guidance = "İlk 3 saniyədə aylıq nağd icarə gəlirini və yüksək rentabellik rəqəmini qarmaq kimi at."
        else:
            persona_desc = (
                "Sən daşınmaz əmlak üzrə səmimi, ailəvi və etibarlı aparıcısan. "
                "Ucuz süni şou və ya qışqırıq ('Dayanın!', 'Şok!') deyil, real alıcıya sərfəli ailə evi təqdim edən, metroya yaxınlığı, daş binanın istiliyini və ipoteka rahatlığını vurğulayan 25-28 saniyəlik canlı Azərbaycan dilində ssenari yaz."
            )
            hook_guidance = f"İlk 3 saniyədə metroya yaxınlıq və ya büdcə qənaətini səmimi dildə vurğula (məsələn: '{location} ərazisində daş binada hazır kupçalı ailə mənzili!')."

        prompt = (
            f"{persona_desc}\n\n"
            f"MƏNZİL MƏLUMATLARI:\n"
            f"- Başlıq: {title}\n"
            f"- Qiymət: {spoken_price} ({price} {currency})\n"
            f"- Yerləşmə: {location}\n"
            f"- Parametrlər: {rooms} otaq, {area} kv.m, mərtəbə {floor}/{floors}\n"
            f"- Sənəd: {'Dövlət Çıxarışı (Kupça) var, ipotekaya tam yararlıdır' if has_kupca else 'Müqaviləli'}\n"
            f"{floor_objection_directive}"
            f"{stone_directive}"
            f"{market_info_line}"
            f"- Əlavə məlumat: {description[:300]}\n\n"
            f"TƏLƏBLƏR:\n"
            f"1. YALNIZ diktorun oxuyacağı təmiz, danışıq dilində mətn yaz. Heç bir kadr qeydi, mötərizə və ya təlimat yazma!\n"
            f"2. {hook_guidance}\n"
            f"3. Cümlələri qısa, ritmik və dinamik qur (4-8 söz). Nida işarələrindən (!) və təbii fasilələrdən (—) istifadə et.\n"
            f"4. Qiyməti ('cəmi {spoken_price}'), yerləşməni və kupçanın olmasını mütləq vurğula.\n"
            f"5. Sonda dərhal nömrəyə zəng etməyə və ya WhatsApp-a yazmağa güclü çağırışla (Call-to-Action) bitir.\n"
            f"{market_requirement}"
            f"{photo_directive}"
        )
        return prompt

    def generate_script(
        self,
        listing: Dict[str, Any],
        photo_paths: Optional[List[str]] = None,
        max_account_retries: Optional[int] = None
    ) -> Optional[str]:
        """
        Interacts with Google AI Pro (Gemini Advanced) via Playwright persistent context.
        Supports multimodal photo upload: passes property photos directly into Gemini.
        Rotates accounts across the pool if quota is reached or errors occur.
        """
        if not self.is_connected():
            logger.warning("Google AI Pro pool not available. Using fallback template.")
            return None

        # Filter valid existing photos
        valid_photos = []
        if photo_paths:
            for p in photo_paths:
                try:
                    fpath = Path(p)
                    if fpath.is_file() and fpath.stat().st_size > 1000:
                        valid_photos.append(str(fpath.resolve()))
                except Exception:
                    pass
        # Limit to top 4 photos to optimize web upload latency
        valid_photos = valid_photos[:4]

        prompt_text = self.build_real_estate_prompt(listing, has_photos=bool(valid_photos))
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

            logger.info(f"Using Google AI Pro profile: {profile_name} (Attempt {attempt+1}/{retries}, photos: {len(valid_photos)})")

            try:
                result = self._execute_gemini_prompt(profile_name, prompt_text, photo_paths=valid_photos)
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
                    logger.info(f"Successfully generated multimodal script via {profile_name} ({len(cleaned)} chars).")
                    return cleaned

                # If failed without quota hit (e.g. timeout)
                logger.warning(f"Generation failed on {profile_name}: {result.get('reason', 'unknown')}. Rotating...")
                self.pool_manager.release_account(profile_name, success=False, custom_cooldown=120)

            except Exception as e:
                logger.warning(f"Error during Gemini interaction with {profile_name}: {e}")
                self.pool_manager.release_account(profile_name, success=False, custom_cooldown=120)

        logger.warning("All attempted Google AI Pro accounts failed. Returning None for fallback.")
        return None

    def _execute_gemini_prompt(
        self,
        profile_name: str,
        prompt_text: str,
        photo_paths: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Launches Playwright persistent context for profile_name, submits prompt,
        attaches multimodal property photos if available, and waits for response completion.
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

            # Dismiss any welcome overlays, dialogs or onboarding popups (cdk-overlay)
            try:
                for dismiss_selector in [
                    "button[aria-label*='Close']",
                    "button[aria-label*='Bağla']",
                    "button:has-text('Got it')",
                    "button:has-text('I agree')",
                    "button:has-text('Accept')",
                    "button:has-text('Continue')",
                    "button:has-text('Anladım')",
                    "button:has-text('Razıyam')",
                    "button:has-text('Davam et')",
                ]:
                    btn = page.locator(dismiss_selector).first
                    if btn.count() > 0 and btn.is_visible():
                        btn.click(timeout=1500)
                        time.sleep(0.5)
                page.keyboard.press("Escape")
                time.sleep(0.3)
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

            # If multimodal photos provided, upload them before submitting prompt
            if photo_paths:
                try:
                    logger.info(f"Uploading {len(photo_paths)} property photos to Gemini chat for multimodal vision analysis...")
                    file_input = page.locator('input[type="file"]').first
                    if file_input.count() > 0:
                        file_input.set_input_files(photo_paths)
                        time.sleep(2.5)
                    else:
                        attach_selectors = [
                            "button[aria-label*='Upload']",
                            "button[aria-label*='Attach']",
                            "button[aria-label*='Şəkil']",
                            "button[aria-label*='şəkil']",
                            "button[aria-label*='file']",
                            "button[aria-label*='File']",
                            "button[aria-label*='Add']",
                            "button[aria-label*='Əlavə']",
                            "button.uploader-button",
                            "button.attach-button"
                        ]
                        for sel in attach_selectors:
                            btn = page.locator(sel).first
                            if btn.count() > 0 and btn.is_visible():
                                btn.click(timeout=1500)
                                time.sleep(1.0)
                                file_input = page.locator('input[type="file"]').first
                                if file_input.count() > 0:
                                    file_input.set_input_files(photo_paths)
                                    time.sleep(2.5)
                                    break
                except Exception as img_err:
                    logger.warning(f"Failed to attach photos to Gemini prompt: {img_err}. Proceeding with text-only.")

            # Fill and submit prompt with robust click
            try:
                input_elem.click(timeout=3000)
            except Exception:
                try:
                    page.keyboard.press("Escape")
                    time.sleep(0.5)
                except Exception:
                    pass
                input_elem.click(force=True)

            time.sleep(0.3)
            try:
                input_elem.fill(prompt_text)
            except Exception:
                input_elem.focus()
                page.keyboard.insert_text(prompt_text)
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
