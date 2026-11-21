"""
[DEPRECATED] Notion CRM Dispatcher module for Baku Estate AI.
Active bidirectional Notion sync has been deprecated in favor of Supabase Postgres
as the single source of truth + the 24/7 Next.js Web CRM.

Disabled by default unless `NOTION_LEGACY_SYNC=true` is explicitly set in the environment
(or `enabled=True` is explicitly passed to NotionCRMDispatcher).
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
from typing import Dict, Any, Optional

import requests

from config.settings import (
    NOTION_DATABASE_ID,
    NOTION_DATA_SOURCE_ID,
    NOTION_API_KEY,
    NOTION_ENABLED,
    safe_parse_numeric,
    BAKU_LANDMARK_DISTRICT_MAP
)
from src.scraper.bina_scraper import clean_phone_number

logger = logging.getLogger("notion_crm")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def normalize_location_for_notion(raw_loc: str) -> str:
    """Normalizes location string to one of the predefined Notion select options."""
    if not raw_loc:
        return "Digər"
    l = raw_loc.lower()

    # 1. Direct district match
    if "nərimanov" in l or "nerimanov" in l:
        return "Nərimanov"
    elif "yasamal" in l:
        return "Yasamal"
    elif "nəsimi" in l or "nasimi" in l:
        return "Nəsimi"
    elif "xətai" in l or "xetai" in l:
        return "Xətai"
    elif "səbail" in l or "sebail" in l:
        return "Səbail"
    elif "binəqədi" in l or "bineqedi" in l:
        return "Binəqədi"
    elif "nizami" in l:
        return "Nizami"
    elif "sabunçu" in l or "sabuncu" in l:
        return "Sabunçu"
    elif "xəzər" in l or "xezer" in l:
        return "Xəzər"
    elif "suraxanı" in l or "suraxani" in l:
        return "Suraxanı"
    elif "abşeron" in l or "absheron" in l:
        return "Abşeron"

    # 2. Check metro stations and landmarks
    for landmark, district in BAKU_LANDMARK_DISTRICT_MAP.items():
        if landmark in l:
            return district

    return "Digər"


def is_notion_legacy_sync_enabled() -> bool:
    """Returns True only when legacy Notion sync is explicitly opted in via NOTION_LEGACY_SYNC=true."""
    return os.getenv("NOTION_LEGACY_SYNC", "false").strip().lower() in ("1", "true", "yes")


class NotionCRMDispatcher:
    """
    [DEPRECATED] Manages legacy lead and deal synchronization to the Notion CRM database.
    Disabled by default to prevent split-brain with Supabase Postgres + Web CRM.
    Set NOTION_LEGACY_SYNC=true to re-enable legacy Notion sync.
    """

    DEPRECATED = True

    def __init__(
        self,
        database_id: str = NOTION_DATABASE_ID,
        data_source_id: str = NOTION_DATA_SOURCE_ID,
        api_key: str = NOTION_API_KEY,
        enabled: Optional[bool] = None
    ):
        self.database_id = database_id
        self.data_source_id = data_source_id
        self.api_key = api_key
        self.enabled = is_notion_legacy_sync_enabled() if enabled is None else bool(enabled)
        if self.enabled:
            logger.warning(
                "NotionCRMDispatcher is DEPRECATED; Supabase Postgres + Web CRM is now the single source of truth."
            )

    def build_deal_page_payload(
        self,
        listing: Dict[str, Any],
        video_cdn_url: Optional[str] = None,
        script_text: Optional[str] = None,
        status: str = "Video Ready"
    ) -> Dict[str, Any]:
        """Constructs Notion page properties matching 'Baku Estate Deals' schema."""
        bina_id = str(listing.get("bina_id", ""))
        title = listing.get("title") or f"Mənzil {bina_id}"
        price = safe_parse_numeric(listing.get("price"), default=0.0, is_price=True)
        area = safe_parse_numeric(listing.get("area"), default=0.0, is_price=False)
        rooms = int(safe_parse_numeric(listing.get("rooms"), default=0.0, is_price=False))

        raw_phone = listing.get("owner_phone", "")
        clean_phone = clean_phone_number(raw_phone)
        wa_digits = clean_phone.lstrip("+")
        if wa_digits:
            wa_text = f"Salam, bina.az-dakı {bina_id} nömrəli elanınızla bağlı yazıram."
            wa_url = f"https://wa.me/{wa_digits}?text={urllib.parse.quote(wa_text)}"
        else:
            wa_url = f"https://bina.az/items/{bina_id}"

        location_select = normalize_location_for_notion(listing.get("location") or listing.get("address") or "")

        return {
            "properties": {
                "Property Title": title,
                "Price (AZN)": price,
                "Area (m²)": area,
                "Rooms": rooms,
                "Location": location_select,
                "Direct Owner": "__YES__" if listing.get("is_owner") else "__NO__",
                "Has Kupça": "__YES__" if listing.get("has_bill_of_sale", True) else "__NO__",
                "Owner Contact": clean_phone or raw_phone,
                "WhatsApp Link": wa_url,
                "Video CDN Link": video_cdn_url or "",
                "bina.az Link": f"https://bina.az/items/{bina_id}",
                "Status": status
            },
            "content": (
                f"## Baku Estate AI Lead Summary\n"
                f"- **Elan ID**: {bina_id}\n"
                f"- **Qiymət**: {price:,.0f} AZN\n"
                f"- **Sahə**: {area} m² ({rooms} otaq)\n"
                f"- **Ərazi**: {location_select}\n"
                f"- **Əlaqə**: {clean_phone or raw_phone}\n"
                f"- **WhatsApp**: {wa_url}\n"
                f"- **Video CDN**: {video_cdn_url or 'Hazırlanır'}\n"
                f"\n### Ssenari Mətni\n{script_text or '—'}\n"
            ),
            "parent": {
                "type": "data_source_id",
                "data_source_id": self.data_source_id
            }
        }

    def sync_deal(
        self,
        listing: Dict[str, Any],
        video_cdn_url: Optional[str] = None,
        script_text: Optional[str] = None,
        status: str = "Video Ready"
    ) -> Dict[str, Any]:
        """
        [DEPRECATED] Syncs deal to Notion only when explicitly enabled.
        If NOTION_API_KEY is present, sends via Notion REST API.
        Otherwise logs structured payload for MCP pipeline sync.
        """
        if not self.enabled:
            logger.info("Notion CRM sync is deprecated and disabled (set NOTION_LEGACY_SYNC=true to opt in).")
            return {"success": False, "reason": "disabled_deprecated"}

        payload = self.build_deal_page_payload(
            listing=listing,
            video_cdn_url=video_cdn_url,
            script_text=script_text,
            status=status
        )

        bina_id = listing.get("bina_id")
        logger.info(f"Prepared Notion CRM deal payload for listing {bina_id} (Status: {status}).")

        if self.api_key:
            url = "https://api.notion.com/v1/pages"
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            }
            try:
                r = requests.post(url, headers=headers, json=payload, timeout=15)
                if r.status_code in (200, 201):
                    logger.info(f"Notion deal successfully synced via API: {r.json().get('id')}")
                    return {"success": True, "notion_id": r.json().get("id")}
                else:
                    logger.warning(f"Notion API response ({r.status_code}): {r.text}")
                    return {"success": False, "error": r.text, "payload": payload}
            except Exception as e:
                logger.error(f"Error calling Notion API: {e}", exc_info=True)
                return {"success": False, "error": str(e), "payload": payload}

        return {"success": True, "mode": "mcp_ready", "payload": payload}
