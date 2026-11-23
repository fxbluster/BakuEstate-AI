#!/usr/bin/env python3
"""
BakuEstate-AI Degraded Listings Batch Re-render Utility.

Re-renders degraded/unvoiced listings using BakuEstatePipeline with:
- Dual-Voice Studio ElevenLabs synthesis (Ayan for Affordable, Arif for Luxury/General).
- Frame-accurate dynamic kinetic subtitles.
- Cinematic FFmpeg video compositing with audio ducking and peak limiting.
- Automatic Supabase Storage upload and version incrementing (v2, v3, etc.).
- Bypasses Telegram dispatch during re-render (skip_telegram_dispatch=True).
- Preserves 1.5s inter-job delay to respect ElevenLabs concurrency limits.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# Add project root to sys.path
BASE_PROJECT_DIR = Path(__file__).resolve().parent.parent
if str(BASE_PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_PROJECT_DIR))

from run_pipeline import BakuEstatePipeline
from config.settings import (
    ELEVENLABS_VOICE_ARIF,
    ELEVENLABS_VOICE_AYAN,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [ReRenderBatch] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("rerender_degraded_batch")

# Canonical targets for native dual-voice & cinematic compositor upgrade
TARGET_LISTINGS: List[Dict[str, Any]] = [
    {
        "bina_id": "6343052",
        "voice_id": ELEVENLABS_VOICE_AYAN or "DZaip8UahF0Qri1FxU8M",
        "voice_name": "Ayan",
        "tier": "Affordable",
        "target_account": "@baku.serfeli.evler",
    },
    {
        "bina_id": "6304638",
        "voice_id": ELEVENLABS_VOICE_ARIF or "ZQJv3hwvRAIC7fvWZ1Qr",
        "voice_name": "Arif",
        "tier": "General",
        "target_account": "@bakuestate.official",
    },
    {
        "bina_id": "5867067",
        "voice_id": ELEVENLABS_VOICE_ARIF or "ZQJv3hwvRAIC7fvWZ1Qr",
        "voice_name": "Arif",
        "tier": "Luxury",
        "target_account": "@bakuestate.premium",
    },
    {
        "bina_id": "6567513",
        "voice_id": ELEVENLABS_VOICE_ARIF or "ZQJv3hwvRAIC7fvWZ1Qr",
        "voice_name": "Arif",
        "tier": "Luxury",
        "target_account": "@bakuestate.premium",
    },
    {
        "bina_id": "6560444",
        "voice_id": ELEVENLABS_VOICE_AYAN or "DZaip8UahF0Qri1FxU8M",
        "voice_name": "Ayan",
        "tier": "Affordable",
        "target_account": "@baku.serfeli.evler",
    },
    {
        "bina_id": "6589921",
        "voice_id": ELEVENLABS_VOICE_ARIF or "ZQJv3hwvRAIC7fvWZ1Qr",
        "voice_name": "Arif",
        "tier": "Luxury",
        "target_account": "@bakuestate.premium",
    },
]


def rerender_batch(
    pipeline: BakuEstatePipeline,
    targets: Optional[List[Dict[str, Any]]] = None,
    delay_seconds: float = 1.5,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """
    Executes batch re-rendering of target listings through BakuEstatePipeline.

    Args:
        pipeline: Initialized BakuEstatePipeline with Supabase enabled.
        targets: List of target definitions (bina_id, voice_id, tier).
        delay_seconds: Delay between listing processing to respect concurrency.
        dry_run: If True, inspects candidate listings without executing rendering.

    Returns:
        Summary dict containing counts of processed, succeeded, and failed jobs.
    """
    items = targets or TARGET_LISTINGS
    total = len(items)
    logger.info("Starting batch re-render for %d listings (dry_run=%s, delay=%.1fs)...", total, dry_run, delay_seconds)

    results: List[Dict[str, Any]] = []

    for index, target in enumerate(items, start=1):
        bina_id = str(target["bina_id"]).strip()
        voice_id = target["voice_id"]
        voice_name = target.get("voice_name", "custom")
        tier = target.get("tier", "Unknown")

        logger.info(
            "[%d/%d] Processing listing %s | Tier: %s | Designated Voice: %s (%s)...",
            index,
            total,
            bina_id,
            tier,
            voice_name,
            voice_id,
        )

        # 1. Fetch canonical listing from Supabase
        listing = pipeline.supabase_repo.get_listing_by_bina_id(bina_id)
        if not listing:
            logger.warning("Listing %s not found in Supabase! Using fallback skeleton.", bina_id)
            listing = {"bina_id": bina_id}

        if dry_run:
            photo_urls = listing.get("photo_urls") or []
            price = listing.get("price")
            currency = listing.get("currency") or "AZN"
            logger.info(
                "  [DRY-RUN] Listing %s: price=%s %s, photos=%d, assigned_voice=%s (%s)",
                bina_id,
                price,
                currency,
                len(photo_urls),
                voice_name,
                voice_id,
            )
            results.append({
                "bina_id": bina_id,
                "status": "DRY_RUN_OK",
                "voice_id": voice_id,
                "voice_name": voice_name,
                "photos_count": len(photo_urls),
            })
            if index < total and delay_seconds > 0:
                time.sleep(delay_seconds)
            continue

        # 2. Live re-rendering through BakuEstatePipeline
        try:
            render_res = pipeline.process_listing_video_and_dispatch(
                listing=listing,
                voice_engine="elevenlabs",
                voice_id=voice_id,
                trigger_reason="MANUAL_RERENDER",
                skip_telegram_dispatch=True,
            )
            logger.info("  [SUCCESS] Listing %s rendered successfully: %s", bina_id, render_res.get("video_path") or "OK")
            results.append({
                "bina_id": bina_id,
                "status": "COMPLETED",
                "voice_id": voice_id,
                "voice_name": voice_name,
                "video_path": str(render_res.get("video_path") or ""),
                "render_version_id": render_res.get("render_version_id"),
            })
        except Exception as exc:
            logger.error("  [FAILED] Listing %s re-render encountered error: %s", bina_id, exc, exc_info=True)
            results.append({
                "bina_id": bina_id,
                "status": "FAILED",
                "voice_id": voice_id,
                "voice_name": voice_name,
                "error": str(exc),
            })

        # Inter-job rate-limiting delay
        if index < total and delay_seconds > 0:
            logger.info("Sleeping %.1fs before next listing...", delay_seconds)
            time.sleep(delay_seconds)

    succeeded = [r for r in results if r.get("status") in ("COMPLETED", "DRY_RUN_OK")]
    failed = [r for r in results if r.get("status") == "FAILED"]
    summary = {
        "total": total,
        "succeeded": len(succeeded),
        "failed": len(failed),
        "dry_run": dry_run,
        "results": results,
    }
    logger.info(
        "Batch re-render complete! Total: %d, Succeeded: %d, Failed: %d (dry_run=%s)",
        total,
        len(succeeded),
        len(failed),
        dry_run,
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Re-render degraded/unvoiced listings using BakuEstatePipeline with native dual-voice ElevenLabs."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate execution, inspect listings and verify voice routing without rendering.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=1.5,
        help="Delay in seconds between processing listings (default: 1.5s).",
    )
    parser.add_argument(
        "--listing-id",
        type=str,
        default=None,
        help="Optional single bina_id to re-render instead of all 6.",
    )
    args = parser.parse_args()

    pipeline = BakuEstatePipeline(enable_supabase=True)

    targets = TARGET_LISTINGS
    if args.listing_id:
        targets = [t for t in TARGET_LISTINGS if t["bina_id"] == args.listing_id.strip()]
        if not targets:
            logger.error("Specified listing ID %s is not in canonical target list.", args.listing_id)
            sys.exit(1)

    summary = rerender_batch(
        pipeline=pipeline,
        targets=targets,
        delay_seconds=args.delay,
        dry_run=args.dry_run,
    )

    if summary["failed"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
