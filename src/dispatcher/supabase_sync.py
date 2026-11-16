"""
Supabase Cloud Database & Storage Synchronization Service for Baku Estate AI.
Handles:
1. Video upload to public Supabase Storage bucket ('baku-estate-media') for high-speed CDN delivery.
2. Cloud Postgres database sync into 'baku_estate_deals' with upsert on bina_id.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
import re
import json
import logging
import urllib.parse
from pathlib import Path
from typing import Dict, Any, Optional

import requests

from config.settings import (
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_BUCKET,
    SUPABASE_ENABLED,
    safe_parse_numeric
)
from src.scraper.bina_scraper import clean_phone_number

logger = logging.getLogger("supabase_sync")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


class SupabaseSync:
    """
    Synchronizes deals and uploaded media with Supabase Postgres & Storage.
    """

    def __init__(
        self,
        supabase_url: str = SUPABASE_URL,
        supabase_key: str = SUPABASE_KEY,
        bucket_name: str = SUPABASE_BUCKET,
        enabled: bool = SUPABASE_ENABLED
    ):
        self.supabase_url = (supabase_url or "").rstrip("/")
        self.supabase_key = supabase_key or ""
        self.bucket_name = bucket_name or "baku-estate-media"
        self.enabled = enabled and bool(self.supabase_url) and bool(self.supabase_key)

    def is_configured(self) -> bool:
        """Returns True if Supabase credentials are valid and enabled."""
        return self.enabled

    def _headers(self, content_type: str = "application/json") -> Dict[str, str]:
        return {
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
            "Content-Type": content_type
        }

    def upload_video(self, video_path: str, remote_filename: Optional[str] = None) -> Optional[str]:
        """
        Uploads local MP4 video file to Supabase public storage bucket.
        Returns the public streaming CDN URL on success, or None on error.
        """
        if not self.enabled:
            logger.info("Supabase sync disabled or unconfigured. Skipping video upload.")
            return None

        path = Path(video_path)
        if not path.is_file():
            logger.warning(f"Video file does not exist: {video_path}")
            return None

        filename = remote_filename or path.name
        upload_url = f"{self.supabase_url}/storage/v1/object/{self.bucket_name}/{filename}"
        public_cdn_url = f"{self.supabase_url}/storage/v1/object/public/{self.bucket_name}/{filename}"

        headers = self._headers(content_type="video/mp4")
        headers["x-upsert"] = "true"

        try:
            with open(path, "rb") as f:
                video_bytes = f.read()

            logger.info(f"Uploading video {filename} ({len(video_bytes)} bytes) to Supabase Storage...")
            response = requests.post(upload_url, headers=headers, data=video_bytes, timeout=60)

            if response.status_code in (200, 201):
                logger.info(f"Supabase video upload successful: {public_cdn_url}")
                return public_cdn_url
            else:
                logger.error(f"Supabase storage upload failed ({response.status_code}): {response.text}")
                return None
        except Exception as e:
            logger.error(f"Exception uploading video to Supabase: {e}", exc_info=True)
            return None

    def sync_deal(
        self,
        listing: Dict[str, Any],
        video_cdn_url: Optional[str] = None,
        video_duration: Optional[float] = None,
        script_text: Optional[str] = None,
        status: str = "COMPLETED"
    ) -> Dict[str, Any]:
        """
        Upserts deal record into 'public.baku_estate_deals' via Supabase REST API.
        """
        if not self.enabled:
            return {"success": False, "reason": "disabled"}

        bina_id = str(listing.get("bina_id", "")).strip()
        if not bina_id:
            logger.warning("Listing missing bina_id. Cannot sync to Supabase.")
            return {"success": False, "reason": "missing_bina_id"}

        raw_phone = listing.get("owner_phone", "")
        normalized_phone = clean_phone_number(raw_phone)
        wa_digits = normalized_phone.lstrip("+")
        if wa_digits:
            wa_text = f"Salam, bina.az-dakı {bina_id} nömrəli elanınızla bağlı yazıram."
            wa_url = f"https://wa.me/{wa_digits}?text={urllib.parse.quote(wa_text)}"
        else:
            wa_url = f"https://bina.az/items/{bina_id}"

        price_val = safe_parse_numeric(listing.get("price"), default=0.0, is_price=True)
        area_val = safe_parse_numeric(listing.get("area"), default=0.0, is_price=False)
        rooms_val = int(safe_parse_numeric(listing.get("rooms"), default=0.0, is_price=False))
        floor_val = int(safe_parse_numeric(listing.get("floor"), default=0.0, is_price=False))
        floors_val = int(safe_parse_numeric(listing.get("floors"), default=0.0, is_price=False))

        payload = {
            "bina_id": bina_id,
            "title": str(listing.get("title") or f"Mənzil {bina_id}"),
            "price": price_val,
            "currency": str(listing.get("currency") or "AZN"),
            "location": str(listing.get("location") or listing.get("address") or "Bakı"),
            "address": str(listing.get("address") or ""),
            "rooms": rooms_val,
            "area": area_val,
            "floor": floor_val,
            "floors": floors_val,
            "has_bill_of_sale": bool(listing.get("has_bill_of_sale", True)),
            "is_owner": bool(listing.get("is_owner", False)),
            "contact_name": str(listing.get("contact_name") or "Mülkiyyətçi"),
            "owner_phone": normalized_phone or raw_phone,
            "whatsapp_url": wa_url,
            "video_cdn_url": video_cdn_url or "",
            "video_duration": float(video_duration) if video_duration else 0.0,
            "script_text": script_text or "",
            "status": status,
            "raw_data": {k: v for k, v in listing.items() if k not in ("downloaded_photos",)}
        }

        rest_url = f"{self.supabase_url}/rest/v1/baku_estate_deals?on_conflict=bina_id"
        headers = self._headers()
        headers["Prefer"] = "resolution=merge-duplicates,return=representation"

        try:
            logger.info(f"Syncing deal {bina_id} to Supabase 'baku_estate_deals'...")
            response = requests.post(rest_url, headers=headers, json=[payload], timeout=15)

            if response.status_code in (200, 201):
                logger.info(f"Supabase deal sync successful for bina_id {bina_id}.")
                return {"success": True, "bina_id": bina_id, "data": response.json()}
            else:
                logger.error(f"Supabase deal sync failed ({response.status_code}): {response.text}")
                return {"success": False, "status_code": response.status_code, "error": response.text}
        except Exception as e:
            logger.error(f"Exception syncing deal to Supabase: {e}", exc_info=True)
            return {"success": False, "error": str(e)}
