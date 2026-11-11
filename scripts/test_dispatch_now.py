import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.dispatcher.telegram_crm import TelegramCRMDispatcher
from src.database import get_listing_by_bina_id

def main():
    listing = get_listing_by_bina_id("6532081")
    if not listing:
        print("Listing 6532081 not found in DB!")
        return

    video_path = ROOT / "data" / "output" / "video_6532081.mp4"
    if not video_path.exists():
        print(f"Video file not found at: {video_path}")
        return

    print(f"Dispatching video for listing {listing['bina_id']} to Telegram...")
    dispatcher = TelegramCRMDispatcher()
    res = dispatcher.send_video_lead(dict(listing), str(video_path))
    print("Dispatch result:", res)

if __name__ == "__main__":
    main()
