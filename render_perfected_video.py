import sys
from pathlib import Path

BASE_DIR = Path(r"C:\Users\HP\BakuEstate-AI")
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import os
from config.settings import load_env, ENV_PATH, OUTPUT_DIR, DB_PATH
from src.database import get_listing_by_bina_id
from src.media.tts_service import generate_tts_for_listing
from src.media.ffmpeg_compositor import VideoCompositor
from src.dispatcher.telegram_crm import TelegramCRMDispatcher

load_env(ENV_PATH, override=True)
os.environ["OPENAI_TTS_VOICE"] = "nova"
os.environ["OPENAI_TTS_MODEL"] = "tts-1-hd"

listing = get_listing_by_bina_id("6532081", DB_PATH)
if not listing:
    print("Listing not found!")
    sys.exit(1)

photos = listing.get("downloaded_photos", [])
print(f"Processing listing {listing['bina_id']} with {len(photos)} photos...")

# 1. Synthesize voiceover with normalized phonetics
script_text, a_path, s_path, duration = generate_tts_for_listing(
    listing=listing,
    output_dir=OUTPUT_DIR
)
print(f"Generated clean script: {script_text}")

# 2. Compose video with new unified card, bottom CTA, and ASS safe-zone subtitles
compositor = VideoCompositor()
out_vid = OUTPUT_DIR / "video_6532081_perfected.mp4"
music_path = BASE_DIR / "assets" / "music" / "luxury_lounge.mp3"

print("Rendering perfected video...")
compositor.build_video(
    listing=listing,
    image_paths=photos,
    audio_path=a_path,
    srt_path=s_path,
    output_video_path=out_vid,
    bg_music_path=str(music_path),
    duration=duration
)
print(f"Rendered video size: {out_vid.stat().st_size} bytes")

# 3. Dispatch to Telegram
dispatcher = TelegramCRMDispatcher(mock_mode=False)
disp_res = dispatcher.dispatch_listing_video(listing, str(out_vid))
print("Dispatched to Telegram:", disp_res)
