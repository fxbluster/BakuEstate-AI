import sys
from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.google_pool.pool_manager import GooglePoolManager

pm = GooglePoolManager()
with pm.persistent_playwright_context("acc_1", headless=True) as context:
    page = context.pages[0] if context.pages else context.new_page()
    page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=40000)
    import time
    time.sleep(3)
    
    # Check avatar or user info
    user_btn = page.locator("a[aria-label*='Google Account'], button[aria-label*='Google Account'], div[aria-label*='Google Account'], [aria-label*='Google Hesabı']")
    print("User account button count:", user_btn.count())
    for i in range(user_btn.count()):
        print(f"  Attr aria-label {i}: {user_btn.nth(i).get_attribute('aria-label')}")
        
    # Check bottom left avatar
    avatar = page.locator(".user-avatar, [data-test-id='user-profile-button'], [aria-label*='Google']")
    print("Avatar selector count:", avatar.count())
    for i in range(avatar.count()):
        print(f"  Avatar {i}: {avatar.nth(i).get_attribute('aria-label')}")

    # Check if prompt can be typed
    prompt_box = page.locator("div[contenteditable='true'], rich-textarea")
    print("Prompt box count:", prompt_box.count())
    for i in range(prompt_box.count()):
        print(f"  Prompt box {i} visible:", prompt_box.nth(i).is_visible())
