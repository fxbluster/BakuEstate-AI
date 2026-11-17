import sys
import logging
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.google_pool.brave_gemini_client import BraveGeminiClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

client = BraveGeminiClient()

test_listing = {
    "id": 5616503,
    "title": "Nərimanov metrosu yaxınlığında 3 otaqlı lüks mənzil",
    "price": "245000",
    "currency": "AZN",
    "location": "Nərimanov r., Təbriz küçəsi",
    "rooms": 3,
    "area": "125",
    "floor": 8,
    "floors": 16,
    "has_bill_of_sale": True,
    "description": "Əla təmirli, keyfiyyətli materiallar, geniş zal, quraşdırılmış mətbəx mebeli, kombi sistemi, Qaz, su, işıq daimidir. Çıxarış var."
}

# Find real photos of listing 5616503 if they exist
photo_dir = Path(f"data/downloads/{test_listing['id']}/photos")
photos = []
if photo_dir.exists():
    photos = [str(f.resolve()) for f in photo_dir.glob("*.jpg")][:4]

print(f"Testing Gemini script generation for listing {test_listing['id']} with {len(photos)} photos...")
script = client.generate_script(test_listing, photo_paths=photos)

print("\n" + "="*50)
print("GENERATED GEMINI SCRIPT:")
print("="*50)
print(script)
print("="*50)
