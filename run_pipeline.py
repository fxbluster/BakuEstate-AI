"""
End-to-End Orchestrator Pipeline for Baku Estate AI.
Coordinates:
1. Ingestion: bina.az scraping (Next.js SSR data, Kupça, Owner filter, Phone extraction, Full HD photos).
2. Database: Persistent state in SQLite (listings, accounts, videos).
3. Script & TTS: Azerbaijani narration script, Edge-TTS (az-AZ-BabekNeural, +10%), synchronized word-level SRT.
4. Video Composition: 1080x1920 (9:16) Ken Burns pan/zoom, blurred background + sharp 4:3 foreground,
   golden price banner (#F59E0B), green Kupça badge (#10B981), burned-in dynamic subtitles.
5. Telegram CRM Dispatch: Sends MP4 video, ready-to-copy Instagram/TikTok caption, WhatsApp link, viral hashtags.
"""

import sys
from pathlib import Path

# Add project root to sys.path
BASE_PROJECT_DIR = Path(__file__).resolve().parent
if str(BASE_PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_PROJECT_DIR))

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import argparse
import logging
from typing import List, Dict, Any, Optional

from config.settings import (
    DB_PATH,
    OUTPUT_DIR,
    DOWNLOADS_DIR,
    PROFILES_DIR,
    FILTER_DIRECT_OWNER_ONLY,
    EDGE_TTS_VOICE,
    EDGE_TTS_RATE
)
from src.database import (
    init_db,
    save_listing,
    update_listing_status,
    get_unprocessed_listings,
    get_listing_by_bina_id,
    record_generated_video,
    mark_video_dispatched
)
from src.scraper.bina_scraper import BinaScraper
from src.google_pool.setup_accounts import setup_all_profiles
from src.google_pool.pool_manager import GooglePoolManager
from src.media.tts_service import generate_tts_for_listing
from src.media.ffmpeg_compositor import VideoCompositor
from src.dispatcher.telegram_crm import TelegramCRMDispatcher
from src.google_pool.brave_gemini_client import BraveGeminiClient

logger = logging.getLogger("estate_pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class BakuEstatePipeline:
    def __init__(
        self,
        owner_only: bool = FILTER_DIRECT_OWNER_ONLY,
        mock_dispatch: bool = True,
        db_path: Path = DB_PATH,
        use_gemini: bool = False,
        bg_music_path: Optional[str] = None
    ):
        self.db_path = db_path
        self.owner_only = owner_only
        self.mock_dispatch = mock_dispatch
        self.use_gemini = use_gemini
        self.bg_music_path = bg_music_path
        self.gemini_client = BraveGeminiClient()

        # Ensure DB is initialized
        init_db(self.db_path)
        self.scraper = BinaScraper(owner_only=self.owner_only)
        self.pool_manager = GooglePoolManager(db_path=self.db_path)
        self.compositor = VideoCompositor()
        self.dispatcher = TelegramCRMDispatcher(mock_mode=self.mock_dispatch)

    def run_ingestion(self, pages: int = 1, limit_per_page: int = 3, specific_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Scrapes listings from bina.az and saves them to the SQLite database."""
        logger.info(f"--- [Phase 1/5: INGESTION] Starting (owner_only={self.owner_only}) ---")
        saved_listings = []

        if specific_id:
            logger.info(f"Targeting single bina.az ID: {specific_id}")
            details = self.scraper.fetch_item_details(specific_id)
            if details:
                phone = self.scraper.fetch_contact_phone(specific_id)
                if phone:
                    details["owner_phone"] = phone
                if details.get("photo_urls"):
                    downloaded = self.scraper.download_full_hd_photos(specific_id, details["photo_urls"])
                    details["downloaded_photos"] = downloaded
                    if downloaded:
                        details["status"] = "PHOTOS_READY"
                save_listing(details, self.db_path)
                saved_listings.append(details)
            return saved_listings

        for page in range(1, pages + 1):
            logger.info(f"Processing listings page {page}/{pages}...")
            items = self.scraper.scrape_and_process_page(page=page, limit=limit_per_page)
            for item in items:
                row_id = save_listing(item, self.db_path)
                logger.info(f"Saved listing ID {item['bina_id']} to DB (row {row_id}, photos: {len(item.get('downloaded_photos', []))})")
                saved_listings.append(item)

        logger.info(f"--- [Phase 1/5: INGESTION] Completed: {len(saved_listings)} listings ingested ---")
        return saved_listings

    def process_listing_video_and_dispatch(self, listing: Dict[str, Any]) -> Dict[str, Any]:
        """Runs the full pipeline for a single listing: TTS -> Video Composition -> Telegram Dispatch."""
        bina_id = listing["bina_id"]
        logger.info(f"=== Processing video pipeline for listing {bina_id} ===")

        # 1. Download photos if not already downloaded
        downloaded_photos = listing.get("downloaded_photos", [])
        if not downloaded_photos and listing.get("photo_urls"):
            logger.info(f"Downloading photos for {bina_id}...")
            downloaded_photos = self.scraper.download_full_hd_photos(bina_id, listing["photo_urls"])
            listing["downloaded_photos"] = downloaded_photos
            update_listing_status(bina_id, "PHOTOS_READY", downloaded_photos, self.db_path)

        if not downloaded_photos:
            logger.warning(f"No photos available for listing {bina_id}. Cannot compose video.")
            update_listing_status(bina_id, "FAILED", db_path=self.db_path)
            return {"status": "FAILED", "reason": "No photos"}

        # 2. Generate Narration Script & Edge-TTS Speech with synchronized SRT
        logger.info(f"--- [Phase 2/5: SCRIPT & TTS] Generating Azerbaijani voiceover for {bina_id} ---")
        custom_script = None
        if self.use_gemini:
            if not self.gemini_client.is_connected():
                logger.info("Brave port 9222 aktiv deyil. Brave avtomatik başladılır...")
                self.gemini_client.ensure_connected()

            if self.gemini_client.is_connected():
                logger.info("Requesting viral AI script from Google Pro (Gemini Advanced) in Brave...")
                custom_script = self.gemini_client.generate_script(listing)
            else:
                logger.info("Brave remote port 9222 not active. Using built-in high-quality script generator.")

        script_text, audio_path, srt_path, duration = generate_tts_for_listing(
            listing=listing,
            output_dir=OUTPUT_DIR,
            voice=EDGE_TTS_VOICE,
            rate=EDGE_TTS_RATE,
            custom_script=custom_script
        )
        update_listing_status(bina_id, "TTS_READY", db_path=self.db_path)

        # 3. 1080x1920 Vertical Video Composition with FFmpeg
        logger.info(f"--- [Phase 3/5: VIDEO COMPOSITION] Rendering 9:16 vertical video with Ken Burns & Banners ---")
        output_video_path = OUTPUT_DIR / f"video_{bina_id}.mp4"
        self.compositor.build_video(
            listing=listing,
            image_paths=downloaded_photos,
            audio_path=audio_path,
            srt_path=srt_path,
            output_video_path=output_video_path,
            bg_music_path=self.bg_music_path,
            duration=duration
        )

        # Record video in DB
        db_listing = get_listing_by_bina_id(bina_id, self.db_path)
        listing_row_id = db_listing["id"] if db_listing else 0

        record_generated_video(
            listing_id=listing_row_id,
            video_path=str(output_video_path.resolve()),
            audio_path=audio_path,
            srt_path=srt_path,
            script_text=script_text,
            duration_seconds=duration,
            status="COMPLETED",
            db_path=self.db_path
        )

        # 4. Telegram CRM Dispatch
        logger.info(f"--- [Phase 4/5: DISPATCH] Sending video lead to Telegram CRM ---")
        dispatch_result = self.dispatcher.send_video_lead(
            listing=listing,
            video_path=str(output_video_path.resolve())
        )

        mark_video_dispatched(
            listing_id=listing_row_id,
            telegram_message_id=dispatch_result.get("message_id"),
            db_path=self.db_path
        )

        logger.info(f"=== Successfully completed pipeline for listing {bina_id}! ===")
        return {
            "bina_id": bina_id,
            "video_path": str(output_video_path.resolve()),
            "audio_path": audio_path,
            "srt_path": srt_path,
            "duration": duration,
            "dispatch": dispatch_result
        }

    def run_full_pipeline(self, pages: int = 1, limit: int = 1, specific_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """End-to-end execution across ingestion and video production."""
        logger.info("=================================================================")
        logger.info("   BAKU ESTATE AI - AUTOMATED SOCIAL MEDIA VIDEO PIPELINE       ")
        logger.info("=================================================================")

        # Ingest listings
        ingested = self.run_ingestion(pages=pages, limit_per_page=limit, specific_id=specific_id)

        # Prioritize specific requested ID if provided, otherwise fetch unprocessed items
        if specific_id:
            specific = get_listing_by_bina_id(specific_id, self.db_path)
            pending_listings = [specific] if specific else []
        else:
            pending_listings = get_unprocessed_listings(limit=limit, db_path=self.db_path)

        results = []
        for item in pending_listings[:limit]:
            res = self.process_listing_video_and_dispatch(item)
            results.append(res)

        logger.info(f"--- Pipeline finished. Successfully processed {len(results)} videos ---")
        return results


def main():
    parser = argparse.ArgumentParser(description="Baku Estate AI Video Pipeline Runner")
    parser.add_argument("--pages", type=int, default=1, help="Number of bina.az search pages to crawl")
    parser.add_argument("--limit", type=int, default=1, help="Max number of listings to convert into videos")
    parser.add_argument("--listing-id", type=str, default=None, help="Process a specific bina.az ID directly")
    parser.add_argument("--allow-agents", action="store_true", help="Allow agent listings (defaults to owner only)")
    parser.add_argument("--setup-accounts", action="store_true", help="Initialize Google account pool profiles")
    parser.add_argument("--init-db-only", action="store_true", help="Initialize SQLite database schema and exit")
    parser.add_argument("--live-dispatch", action="store_true", help="Send to real Telegram bot instead of mock")
    parser.add_argument("--use-gemini", action="store_true", help="Use active Google Pro (Gemini) session in Brave for scripts")

    args = parser.parse_args()

    if args.init_db_only:
        init_db(DB_PATH)
        print("Database schema successfully initialized.")
        return

    if args.setup_accounts:
        setup_all_profiles(PROFILES_DIR, DB_PATH)
        print("Google account profiles successfully configured.")
        return

    pipeline = BakuEstatePipeline(
        owner_only=not args.allow_agents,
        mock_dispatch=not args.live_dispatch,
        db_path=DB_PATH,
        use_gemini=args.use_gemini
    )

    pipeline.run_full_pipeline(
        pages=args.pages,
        limit=args.limit,
        specific_id=args.listing_id
    )


if __name__ == "__main__":
    main()
