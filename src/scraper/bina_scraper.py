"""
Canonical Next.js SSR scraper for bina.az real estate listings.
Extracts __NEXT_DATA__ JSON from item pages, retrieves contact phone numbers from /items/{id}/phones,
identifies direct owner listings, and downloads Full HD photos.
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
import time
import json
import hashlib
import logging
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple, Iterable, Union
import requests
from bs4 import BeautifulSoup

from config.settings import (
    BINA_BASE_URL,
    SCRAPE_CITY_ID,
    SCRAPE_CATEGORY_ID,
    SCRAPE_HAS_BILL_OF_SALE,
    MIN_PRICE,
    MAX_PRICE,
    FILTER_DIRECT_OWNER_ONLY,
    DEFAULT_HEADERS,
    DOWNLOADS_DIR,
)

logger = logging.getLogger("bina_scraper")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

OWNER_KEYWORDS = [
    "mülkiyyətçi",
    "mülkiyyetci",
    "sahibi",
    "sahibindən",
    "sahibinden",
    "öz mənzilim",
    "öz evim",
    "özüm satıram"
]

# Liveness check return states
LIVENESS_ACTIVE = "ACTIVE"
LIVENESS_REMOVED = "REMOVED_ON_BINA"
LIVENESS_TRANSIENT_ERROR = "TRANSIENT_ERROR"

REMOVED_DOM_PHRASES = (
    "elan tapılmadı",
    "elan tapilmadi",
    "elan silinib",
    "elan silinmişdir",
    "elan silinmisdir",
    "elan artıq mövcud deyil",
    "elan artiq movcud deyil",
    "bu elan artıq aktiv deyil",
    "bu elan artiq aktiv deyil",
    "elan müddəti bitib",
    "elan muddeti bitib",
    "объявление не найдено",
    "объявление удалено",
)

BOT_CHALLENGE_PHRASES = (
    "just a moment...",
    "cf-browser-verification",
    "attention required! | cloudflare",
    "checking your browser",
)


def _hash_photo_urls(photo_urls: Optional[List[str]]) -> str:
    """Local SHA-256 digest of normalized sorted photo URLs (avoids circular imports)."""
    if not photo_urls:
        return ""
    cleaned = sorted({str(u).strip() for u in photo_urls if u and str(u).strip()})
    if not cleaned:
        return ""
    return hashlib.sha256("\n".join(cleaned).encode("utf-8")).hexdigest()


def clean_phone_number(raw_phone: Optional[str]) -> str:
    """Normalizes phone number to international Azerbaijan format (+994XXXXXXXXX)."""
    if not raw_phone:
        return ""
    digits = re.sub(r"\D", "", str(raw_phone))
    if digits.startswith("994"):
        return f"+{digits}"
    elif digits.startswith("0") and len(digits) == 10:
        return f"+994{digits[1:]}"
    elif len(digits) == 9:
        return f"+994{digits}"
    return f"+{digits}" if digits else ""


def is_direct_owner(contact_type: Optional[str], description: Optional[str] = None) -> bool:
    """Determines whether a listing is sold directly by the owner (mülkiyyətçi / sahibi)."""
    contact_str = (contact_type or "").lower()
    for kw in OWNER_KEYWORDS:
        if kw in contact_str:
            return True

    # If contact_type explicitly says agent/vasitəçi, reject
    if any(agent_word in contact_str for agent_word in ["vasitəçi", "vasiteci", "agent", "şirkət", "makler"]):
        return False

    if description:
        desc_lower = description.lower()
        if any(kw in desc_lower for kw in ["sahibindən satılır", "sahibinden satilir", "özüm satıram", "mülkiyyətçiyəm"]):
            return True

    return False


class BinaScraper:
    def __init__(
        self,
        city_id: int = SCRAPE_CITY_ID,
        category_id: int = SCRAPE_CATEGORY_ID,
        has_bill_of_sale: bool = SCRAPE_HAS_BILL_OF_SALE,
        owner_only: bool = FILTER_DIRECT_OWNER_ONLY,
        min_price: int = MIN_PRICE,
        max_price: int = MAX_PRICE,
        session: Optional[requests.Session] = None
    ):
        self.city_id = city_id
        self.category_id = category_id
        self.has_bill_of_sale = has_bill_of_sale
        self.owner_only = owner_only
        self.min_price = min_price
        self.max_price = max_price
        self.session = session or requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)

    def build_listings_url(self, page: int = 1) -> str:
        """Constructs search URL with query parameters."""
        url = f"{BINA_BASE_URL}/items?city_id={self.city_id}&category_id={self.category_id}"
        if self.has_bill_of_sale:
            url += "&has_bill_of_sale=true"
        if self.min_price > 0:
            url += f"&price_from={self.min_price}"
        if self.max_price > 0:
            url += f"&price_to={self.max_price}"
        if page > 1:
            url += f"&page={page}"
        return url

    def fetch_item_ids_from_page(self, page: int = 1) -> List[str]:
        """Fetches a page of search results and returns list of item IDs."""
        url = self.build_listings_url(page)
        logger.info(f"Fetching listings page {page}: {url}")
        resp = self.session.get(url, timeout=15)
        if resp.status_code != 200:
            logger.error(f"Failed to fetch page {page}: status {resp.status_code}")
            return []

        soup = BeautifulSoup(resp.text, "html.parser")
        item_ids = []
        links = soup.find_all("a", class_="item_link")
        for link in links:
            href = link.get("href", "")
            match = re.search(r"/items/(\d+)", href)
            if match:
                item_id = match.group(1)
                if item_id not in item_ids:
                    item_ids.append(item_id)

        logger.info(f"Found {len(item_ids)} item IDs on page {page}")
        return item_ids

    def fetch_item_details(self, bina_id: str) -> Optional[Dict[str, Any]]:
        """
        Fetches canonical item page and extracts structured data from __NEXT_DATA__ JSON.
        Falls back to HTML selectors if __NEXT_DATA__ is absent.
        """
        detail_url = f"{BINA_BASE_URL}/items/{bina_id}"
        logger.info(f"Fetching listing details for ID {bina_id} ({detail_url})")

        try:
            resp = self.session.get(detail_url, timeout=15)
            if resp.status_code != 200:
                logger.warning(f"Item {bina_id} returned status {resp.status_code}")
                return None

            soup = BeautifulSoup(resp.text, "html.parser")
            next_script = soup.find("script", id="__NEXT_DATA__")

            if next_script and next_script.string:
                raw_data = json.loads(next_script.string)
                page_props = raw_data.get("props", {}).get("pageProps", {})
                current_item = page_props.get("currentItemData", {})
                if current_item:
                    return self._parse_next_data(bina_id, detail_url, current_item)

            # Fallback parsing directly from HTML
            return self._parse_html_fallback(bina_id, detail_url, soup)

        except Exception as e:
            logger.error(f"Error fetching item details {bina_id}: {e}")
            return None

    def _parse_next_data(self, bina_id: str, url: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Parses __NEXT_DATA__ currentItemData dict into standardized listing dict."""
        price_info = data.get("price") or {}
        if isinstance(price_info, dict):
            raw_p = price_info.get("total") or price_info.get("value")
            try:
                price = float(raw_p) if raw_p is not None else 0.0
            except (ValueError, TypeError):
                price = 0.0
            currency = price_info.get("currency") or "AZN"
        else:
            try:
                price = float(price_info) if price_info is not None else 0.0
            except (ValueError, TypeError):
                price = 0.0
            currency = "AZN"

        contact_type = str(data.get("contactTypeName") or "")
        contact_name = str(data.get("contactName") or "")
        description = str(data.get("description") or "")

        # Determine owner status
        owner_flag = is_direct_owner(contact_type, description)

        # Location extraction
        loc_obj = data.get("location")
        loc_name = ""
        if isinstance(loc_obj, dict):
            loc_name = loc_obj.get("fullName") or loc_obj.get("name") or ""
        elif isinstance(loc_obj, str):
            loc_name = loc_obj

        # Extract full photo URLs (prefer full resolution)
        photo_urls = []
        for p in data.get("photos", []):
            if isinstance(p, dict):
                full_url = p.get("full") or p.get("f660x496") or p.get("thumbnail")
                if full_url and full_url not in photo_urls:
                    photo_urls.append(full_url)
            elif isinstance(p, str) and p not in photo_urls:
                photo_urls.append(p)

        rooms_val = data.get("rooms")
        raw_rooms = rooms_val.get("value") if isinstance(rooms_val, dict) else rooms_val
        try:
            rooms = int(raw_rooms) if raw_rooms is not None else None
        except (ValueError, TypeError):
            rooms = None

        area_val = data.get("area")
        raw_area = area_val.get("value") if isinstance(area_val, dict) else area_val
        try:
            area = float(raw_area) if raw_area is not None else None
        except (ValueError, TypeError):
            area = None

        floor_val = data.get("floor")
        raw_floor = floor_val.get("value") if isinstance(floor_val, dict) else floor_val
        try:
            floor = int(raw_floor) if raw_floor is not None else None
        except (ValueError, TypeError):
            floor = None

        floors_val = data.get("floors")
        raw_floors = floors_val.get("value") if isinstance(floors_val, dict) else floors_val
        try:
            floors = int(raw_floors) if raw_floors is not None else None
        except (ValueError, TypeError):
            floors = None

        title_parts = []
        if rooms:
            title_parts.append(f"{rooms} otaqlı mənzil")
        if area:
            title_parts.append(f"{int(area)} m²")
        title_str = ", ".join(title_parts) if title_parts else f"Mənzil satılır ID {bina_id}"

        raw_bill = data.get("hasBillOfSale")
        has_bill_of_sale = True if raw_bill is None else bool(raw_bill)

        listing = {
            "bina_id": str(bina_id),
            "url": url,
            "title": title_str,
            "price": price,
            "currency": currency,
            "location": loc_name,
            "address": data.get("address") or "",
            "rooms": rooms,
            "area": area,
            "floor": floor,
            "floors": floors,
            "has_bill_of_sale": has_bill_of_sale,
            "is_owner": owner_flag,
            "contact_type_name": contact_type,
            "contact_name": contact_name,
            "description": description,
            "photo_urls": photo_urls,
            "photo_urls_hash": _hash_photo_urls(photo_urls),
            "downloaded_photos": [],
            "owner_phone": "",
            "status": "NEW"
        }
        return listing

    def _parse_html_fallback(self, bina_id: str, url: str, soup: BeautifulSoup) -> Dict[str, Any]:
        """Fallback extractor using standard DOM selectors."""
        price_val = soup.find("span", class_="price-val")
        price = 0.0
        if price_val:
            raw_p = re.sub(r"\s+", "", price_val.get_text(strip=True))
            try:
                price = float(raw_p)
            except ValueError:
                price = 0.0

        currency_elem = soup.find("span", class_="price-cur")
        currency = currency_elem.get_text(strip=True) if currency_elem else "AZN"

        desc_elem = soup.find("article", class_="description__body")
        description = desc_elem.get_text(strip=True) if desc_elem else ""

        contact_elem = soup.find("div", class_="contacts__name")
        contact_name = contact_elem.get_text(strip=True) if contact_elem else ""

        contact_type_elem = soup.find("div", class_="contacts__type")
        contact_type = contact_type_elem.get_text(strip=True) if contact_type_elem else ""

        owner_flag = is_direct_owner(contact_type, description)

        # Image URLs
        photo_urls = []
        for img in soup.find_all("img"):
            src = img.get("src") or img.get("data-src") or ""
            if "bina.azstatic.com" in src or "turbo.azstatic.com" in src:
                # Upgrade thumbnail or medium to full if possible
                full_src = src.replace("/thumbnail/", "/full/").replace("/f660x496/", "/full/")
                if full_src.startswith("//"):
                    full_src = "https:" + full_src
                elif full_src.startswith("/"):
                    full_src = BINA_BASE_URL + full_src
                if full_src not in photo_urls:
                    photo_urls.append(full_src)

        return {
            "bina_id": str(bina_id),
            "url": url,
            "title": f"Mənzil satılır ID {bina_id}",
            "price": price,
            "currency": currency,
            "location": "",
            "address": "",
            "rooms": None,
            "area": None,
            "floor": None,
            "floors": None,
            "has_bill_of_sale": True,
            "is_owner": owner_flag,
            "contact_type_name": contact_type,
            "contact_name": contact_name,
            "description": description,
            "photo_urls": photo_urls,
            "photo_urls_hash": _hash_photo_urls(photo_urls),
            "downloaded_photos": [],
            "owner_phone": "",
            "status": "NEW"
        }

    def fetch_contact_phone(self, bina_id: str) -> Optional[str]:
        """
        Fetches contact phone numbers from https://bina.az/items/{id}/phones.
        Returns the primary normalized contact phone number.
        """
        phone_url = f"{BINA_BASE_URL}/items/{bina_id}/phones"
        logger.info(f"Extracting phone numbers from {phone_url}")
        headers = {**DEFAULT_HEADERS, "X-Requested-With": "XMLHttpRequest"}
        try:
            resp = self.session.get(phone_url, headers=headers, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                phones = data.get("phones", [])
                if phones:
                    raw_first = phones[0]
                    clean = clean_phone_number(raw_first)
                    logger.info(f"Extracted phone for {bina_id}: {clean} (raw: {raw_first})")
                    return clean
            else:
                logger.warning(f"Phone fetch for {bina_id} returned status {resp.status_code}")
        except Exception as e:
            logger.error(f"Error fetching phone for {bina_id}: {e}")

        return None

    def check_listing_liveness(self, bina_id: str) -> str:
        """
        Checks whether a listing is still live on bina.az.
        Returns strictly one of:
          - 'ACTIVE'
          - 'REMOVED_ON_BINA' (ONLY on HTTP 404/410 or explicit removed/deleted DOM/Next.js state)
          - 'TRANSIENT_ERROR' (on HTTP 429/403/5xx, bot challenge, or network errors)
        """
        detail_url = f"{BINA_BASE_URL}/items/{str(bina_id).strip()}"
        try:
            resp = self.session.get(detail_url, timeout=15, allow_redirects=True)
        except Exception as exc:
            logger.warning(f"Liveness check network error for {bina_id}: {exc}")
            return LIVENESS_TRANSIENT_ERROR

        status_code = getattr(resp, "status_code", 0)
        if status_code in (404, 410):
            logger.info(f"Liveness check: {bina_id} returned HTTP {status_code} -> {LIVENESS_REMOVED}")
            return LIVENESS_REMOVED

        if status_code in (429, 403) or status_code >= 500 or status_code != 200:
            logger.warning(f"Liveness check: {bina_id} returned HTTP {status_code} -> {LIVENESS_TRANSIENT_ERROR}")
            return LIVENESS_TRANSIENT_ERROR

        html = resp.text or ""
        html_lower = html.lower()

        if any(marker in html_lower for marker in BOT_CHALLENGE_PHRASES):
            logger.warning(f"Liveness check: {bina_id} hit bot challenge -> {LIVENESS_TRANSIENT_ERROR}")
            return LIVENESS_TRANSIENT_ERROR

        soup = BeautifulSoup(html, "html.parser")
        next_script = soup.find("script", id="__NEXT_DATA__")
        has_active_next_item = False
        if next_script and next_script.string:
            try:
                raw_data = json.loads(next_script.string)
                page_props = raw_data.get("props", {}).get("pageProps", {})
                current_item = page_props.get("currentItemData")
                if isinstance(current_item, dict) and current_item:
                    item_status = str(current_item.get("status") or "").strip().lower()
                    if item_status in ("deleted", "removed", "expired", "archived", "sold", "inactive"):
                        return LIVENESS_REMOVED
                    if current_item.get("isDeleted") or current_item.get("isExpired"):
                        return LIVENESS_REMOVED
                    has_active_next_item = True
                elif page_props.get("statusCode") in (404, 410):
                    return LIVENESS_REMOVED
            except Exception:
                pass

        if not has_active_next_item:
            body_text = soup.get_text(" ", strip=True).lower()
            if any(phrase in body_text for phrase in REMOVED_DOM_PHRASES):
                logger.info(f"Liveness check: {bina_id} matched removed DOM phrase -> {LIVENESS_REMOVED}")
                return LIVENESS_REMOVED

        return LIVENESS_ACTIVE

    check_liveness = check_listing_liveness

    def download_full_hd_photos(
        self,
        bina_id: str,
        photo_urls: List[str],
        max_photos: int = 8,
        photo_urls_hash: Optional[str] = None,
        force_refresh: bool = False,
    ) -> List[str]:
        """
        Downloads Full HD images to data/downloads/{bina_id}/
        Refreshes cached photos automatically when photo_urls_hash changes or force_refresh=True.
        Returns list of downloaded file paths.
        """
        target_dir = DOWNLOADS_DIR / str(bina_id)
        target_dir.mkdir(parents=True, exist_ok=True)

        current_hash = (photo_urls_hash or _hash_photo_urls(photo_urls) or "").strip()
        hash_marker = target_dir / ".photo_urls_hash"
        previous_hash = ""
        if hash_marker.is_file():
            try:
                previous_hash = hash_marker.read_text(encoding="utf-8").strip()
            except Exception:
                previous_hash = ""

        should_refresh = bool(force_refresh) or (
            bool(previous_hash) and bool(current_hash) and previous_hash != current_hash
        )
        if should_refresh:
            logger.info(
                f"Photo hash changed for {bina_id} ({previous_hash[:8]} -> {current_hash[:8]}). Refreshing cached photos..."
            )
            for old_file in target_dir.glob("photo_*.jpg"):
                try:
                    old_file.unlink()
                except Exception:
                    pass

        downloaded_paths = []
        for idx, url in enumerate(photo_urls[:max_photos]):
            file_name = f"photo_{idx+1:02d}.jpg"
            file_path = target_dir / file_name

            if not should_refresh and file_path.exists() and file_path.stat().st_size > 1000:
                downloaded_paths.append(str(file_path.resolve()))
                continue

            try:
                logger.info(f"Downloading photo {idx+1}/{len(photo_urls[:max_photos])} for item {bina_id}: {url}")
                resp = self.session.get(url, timeout=15)
                if resp.status_code == 200 and len(resp.content) > 1000:
                    with open(file_path, "wb") as f:
                        f.write(resp.content)
                    downloaded_paths.append(str(file_path.resolve()))
                else:
                    logger.warning(f"Failed to download image {url} (status: {resp.status_code})")
            except Exception as e:
                logger.error(f"Exception downloading photo {url}: {e}")

            time.sleep(0.2)

        if downloaded_paths and current_hash:
            try:
                hash_marker.write_text(current_hash, encoding="utf-8")
            except Exception:
                pass

        return downloaded_paths

    def scrape_and_process_page(
        self,
        page: int = 1,
        limit: int = 5,
        known_bina_ids: Optional[Union[Iterable[str], Dict[str, Dict[str, Any]]]] = None,
        repo: Optional[Any] = None,
        check_existing_for_changes: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Scrapes a page, filters direct owners (if configured), fetches phones and photos.
        Pre-scrape skips known unchanged bina_ids so they do NOT consume `limit`
        (eliminating page-1 starvation).

        Args:
            page: Search results page number (1-indexed).
            limit: Maximum number of new (or changed) listings to return.
            known_bina_ids: Optional set/list of already-known bina_ids to skip pre-scrape,
                or dict mapping bina_id -> existing listing row.
            repo: Optional SupabaseRepo instance. When provided and known_bina_ids is None,
                performs 1 batch lookup (`get_listings_by_bina_ids`) and touches `last_seen_at`
                for unchanged known listings.
            check_existing_for_changes: When True and existing listing dicts are available,
                fetches detail pages for known IDs to detect price/kupça/photo changes;
                unchanged listings still do not consume `limit`.
        """
        item_ids = self.fetch_item_ids_from_page(page)
        if not item_ids:
            return []

        existing_map: Dict[str, Dict[str, Any]] = {}
        known_id_set = set()

        if isinstance(known_bina_ids, dict):
            existing_map = {str(k): v for k, v in known_bina_ids.items()}
            known_id_set = set(existing_map.keys())
        elif known_bina_ids is not None:
            known_id_set = {str(bid).strip() for bid in known_bina_ids if str(bid).strip()}
        elif repo is not None and hasattr(repo, "get_listings_by_bina_ids"):
            existing_map = repo.get_listings_by_bina_ids(item_ids) or {}
            known_id_set = set(existing_map.keys())

        processed_listings: List[Dict[str, Any]] = []
        unchanged_seen_ids: List[str] = []

        for item_id in item_ids:
            if len(processed_listings) >= limit:
                break

            item_id_str = str(item_id).strip()

            # Pre-scrape skip for known IDs when not scanning existing items for changes
            if item_id_str in known_id_set and not (check_existing_for_changes and item_id_str in existing_map):
                logger.info(f"Pre-scrape skipping known bina_id {item_id_str} (does not consume limit).")
                unchanged_seen_ids.append(item_id_str)
                continue

            details = self.fetch_item_details(item_id_str)
            if not details:
                continue

            existing_row = existing_map.get(item_id_str)
            if existing_row is not None and check_existing_for_changes:
                from src.dedup.change_detector import detect_listing_changes

                changes = detect_listing_changes(existing_row, details)
                if not changes["has_changes"]:
                    logger.info(
                        f"Known bina_id {item_id_str} unchanged (AZN={changes['new_price_azn']}); touching last_seen_at."
                    )
                    unchanged_seen_ids.append(item_id_str)
                    continue

                # Listing changed (price drop, kupça, or photos): refresh photos if hash changed
                details["_existing"] = existing_row
                details["_changes"] = changes
                if details.get("photo_urls"):
                    downloaded = self.download_full_hd_photos(
                        item_id_str,
                        details["photo_urls"],
                        photo_urls_hash=details.get("photo_urls_hash"),
                        force_refresh=bool(changes.get("photos_changed")),
                    )
                    details["downloaded_photos"] = downloaded
                    if downloaded:
                        details["status"] = "PHOTOS_READY"
                processed_listings.append(details)
                time.sleep(0.5)
                continue

            # Check owner filter for new listings
            if self.owner_only and not details.get("is_owner"):
                logger.info(f"Skipping ID {item_id_str}: Not direct owner (type: {details.get('contact_type_name')})")
                continue

            # Fetch phone
            phone = self.fetch_contact_phone(item_id_str)
            if phone:
                details["owner_phone"] = phone

            # Download photos
            if details.get("photo_urls"):
                downloaded = self.download_full_hd_photos(
                    item_id_str,
                    details["photo_urls"],
                    photo_urls_hash=details.get("photo_urls_hash"),
                )
                details["downloaded_photos"] = downloaded
                if downloaded:
                    details["status"] = "PHOTOS_READY"

            processed_listings.append(details)
            time.sleep(0.5)

        if unchanged_seen_ids and repo is not None and hasattr(repo, "touch_listings_last_seen"):
            repo.touch_listings_last_seen(unchanged_seen_ids)

        return processed_listings
