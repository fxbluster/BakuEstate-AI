"""
Generates two comparison video variants for BakuEstate-AI:
Variant 1: Female voice (Nova HD) + Modern Luxury Beat
Variant 2: Female voice (Nova HD) + Luxury Piano Lounge
Dispatches both directly to user's Telegram chat.
"""

import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
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
print(f"Using listing {listing['bina_id']} with {len(photos)} photos")

# 1. Generate Voiceover with Nova HD
print("Synthesizing voiceover with OpenAI Nova HD...")
script_text, a_path, s_path, duration = generate_tts_for_listing(
    listing=listing,
    output_dir=OUTPUT_DIR
)
print(f"Voice synthesized: {duration:.2f}s audio at {a_path}")
print(f"Script: {script_text}")

compositor = VideoCompositor()
dispatcher = TelegramCRMDispatcher(mock_mode=False)

# Track 1: Modern Beat
vid_beat = OUTPUT_DIR / "video_6532081_beat.mp4"
music_beat = BASE_DIR / "assets" / "music" / "luxury_beat.mp3"
print("Rendering Video 1 (Modern Beat)...")
compositor.build_video(
    listing=listing,
    image_paths=photos,
    audio_path=a_path,
    srt_path=s_path,
    output_video_path=vid_beat,
    bg_music_path=str(music_beat),
    duration=duration
)
print("Video 1 rendered successfully! Dispatching to Telegram...")
caption_beat = (
    "🔥 <b>VARİANT 1: XANIM SƏSİ (NOVA HD) + MODERN LÜKS BEAT</b>\n\n"
    "✨ <b>Xüsusiyyətlər:</b>\n"
    "• Səs: OpenAI Nova HD (Canlı, enerjili xanım aparıcı)\n"
    "• Musiqi: Modern Lo-Fi Luxury Trap Beat\n"
    "• Effektlər: Auto-ducking + 0.5s qızılı zəng (chime) + sarı TikTok subtitrlər\n\n"
    "Zəhmət olmasa baxıb fikrini de!"
)
dispatcher.send_video_lead(listing=listing, video_path=str(vid_beat), custom_caption=caption_beat)
print("Variant 1 dispatched to Telegram!")

# Track 2: Luxury Piano Lounge
vid_lounge = OUTPUT_DIR / "video_6532081_lounge.mp4"
music_lounge = BASE_DIR / "assets" / "music" / "luxury_lounge.mp3"
print("Rendering Video 2 (Piano Lounge)...")
compositor.build_video(
    listing=listing,
    image_paths=photos,
    audio_path=a_path,
    srt_path=s_path,
    output_video_path=vid_lounge,
    bg_music_path=str(music_lounge),
    duration=duration
)
print("Video 2 rendered successfully! Dispatching to Telegram...")
caption_lounge = (
    "🎹 <b>VARİANT 2: XANIM SƏSİ (NOVA HD) + LÜKS PİANO LOUNGE</b>\n\n"
    "✨ <b>Xüsusiyyətlər:</b>\n"
    "• Səs: OpenAI Nova HD (Canlı, enerjili xanım aparıcı)\n"
    "• Musiqi: Zərif Akustik Piano Lounge\n"
    "• Effektlər: Auto-ducking + 0.5s qızılı zəng (chime) + sarı TikTok subtitrlər\n\n"
    "Zəhmət olmasa baxıb fikrini de!"
)
dispatcher.send_video_lead(listing=listing, video_path=str(vid_lounge), custom_caption=caption_lounge)
print("Variant 2 dispatched to Telegram! BOTH COMPLETE!")
