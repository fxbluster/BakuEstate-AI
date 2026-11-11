"""
Live real-world verification script for BraveGeminiClient and Google AI Pro pool.
Generates a full Azerbaijani real estate Reels/Shorts script from a real listing.
"""

import sys
from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.google_pool.brave_gemini_client import BraveGeminiClient
from src.google_pool.pool_manager import GooglePoolManager

def main():
    print("==================================================================")
    print("   LIVE GOOGLE AI PRO (GEMINI ADVANCED 4) SCRIPT GENERATION TEST   ")
    print("==================================================================")

    pm = GooglePoolManager()
    if "--reset-cooldown" in sys.argv:
        from src.database import get_connection
        conn = get_connection(pm.db_path)
        with conn:
            conn.execute("UPDATE google_accounts SET cooldown_until = NULL")
        conn.close()
        print("Cooldowns cleared for testing.")

    client = BraveGeminiClient(pool_manager=pm)

    test_listing = {
        "bina_id": 6585624,
        "title": "2 otaqlı kupçalı mənzil, 65 m²",
        "price": 166000,
        "currency": "AZN",
        "location": "Nərimanov rayonu, Heydər Əliyev Mərkəzi yaxınlığında",
        "rooms": 2,
        "area": 65,
        "floor": 7,
        "floors": 16,
        "has_bill_of_sale": True,
        "description": "Əla təmirli, dərhal köçməyə hazır, kupçalı və ipotekaya yararlı mənzil. Qaz, su, işıq daimidir."
    }

    print(f"Submitting test listing {test_listing['bina_id']} to Google AI Pro...")
    script = client.generate_script(test_listing)

    if script:
        print("\nSUCCESS! Generated Real Estate Script:")
        print("------------------------------------------------------------------")
        print(script)
        print("------------------------------------------------------------------")
        print(f"Script length: {len(script)} characters.")
        return 0
    else:
        print("\nFAILURE: Could not generate script from Google AI Pro.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
