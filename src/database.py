"""
SQLite database management module for Baku Estate AI.
Handles schema initialization, listing CRUD operations, Google account pool state,
and video generation metadata tracking.
"""

import sqlite3
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any

from config.settings import DB_PATH, GOOGLE_ACCOUNT_PROFILES, ACCOUNT_DAILY_QUOTA


def get_connection(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Creates a sqlite3 connection with dict-like row factory and foreign keys enabled."""
    target_path = Path(db_path) if db_path else DB_PATH
    target_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db(db_path: Optional[Path] = None) -> None:
    """Initializes the database schema for listings, google_accounts, and generated_videos."""
    conn = get_connection(db_path)
    with conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS listings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bina_id TEXT UNIQUE NOT NULL,
                url TEXT NOT NULL,
                title TEXT,
                price REAL,
                currency TEXT DEFAULT 'AZN',
                location TEXT,
                address TEXT,
                rooms INTEGER,
                area REAL,
                floor INTEGER,
                floors INTEGER,
                has_bill_of_sale BOOLEAN DEFAULT 1,
                is_owner BOOLEAN DEFAULT 0,
                contact_type_name TEXT,
                contact_name TEXT,
                owner_phone TEXT,
                photo_urls TEXT, -- JSON array of remote URLs
                downloaded_photos TEXT, -- JSON array of local file paths
                description TEXT,
                status TEXT DEFAULT 'NEW', -- NEW, PHOTOS_READY, TTS_READY, VIDEO_READY, DISPATCHED, FAILED
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_listings_bina_id ON listings(bina_id);
            CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
            CREATE INDEX IF NOT EXISTS idx_listings_is_owner ON listings(is_owner);

            CREATE TABLE IF NOT EXISTS google_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_name TEXT UNIQUE NOT NULL,
                email TEXT,
                is_active BOOLEAN DEFAULT 1,
                last_used_at TIMESTAMP,
                cooldown_until TIMESTAMP,
                quota_used_today INTEGER DEFAULT 0,
                max_daily_quota INTEGER DEFAULT 50,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS generated_videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
                video_path TEXT NOT NULL,
                audio_path TEXT,
                srt_path TEXT,
                script_text TEXT,
                duration_seconds REAL,
                status TEXT DEFAULT 'COMPLETED',
                telegram_message_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_videos_listing_id ON generated_videos(listing_id);
        """)

        # Seed Google accounts if not present
        for profile in GOOGLE_ACCOUNT_PROFILES:
            conn.execute("""
                INSERT OR IGNORE INTO google_accounts (profile_name, max_daily_quota)
                VALUES (?, ?)
            """, (profile, ACCOUNT_DAILY_QUOTA))

    conn.close()


def save_listing(listing_data: Dict[str, Any], db_path: Optional[Path] = None) -> int:
    """Inserts or updates a listing in the database."""
    conn = get_connection(db_path)
    bina_id = str(listing_data["bina_id"])
    url = listing_data.get("url", f"https://bina.az/items/{bina_id}")
    title = listing_data.get("title")
    price_val = listing_data.get("price")
    if isinstance(price_val, dict):
        price = float(price_val.get("total") or price_val.get("value") or 0)
    elif price_val is not None:
        try:
            price = float(price_val)
        except (ValueError, TypeError):
            price = 0.0
    else:
        price = 0.0

    currency = listing_data.get("currency", "AZN")
    loc_val = listing_data.get("location")
    location = loc_val.get("fullName") or loc_val.get("name") if isinstance(loc_val, dict) else (str(loc_val) if loc_val else "")
    address = str(listing_data.get("address") or "")

    rooms_val = listing_data.get("rooms")
    raw_rooms = rooms_val.get("value") if isinstance(rooms_val, dict) else rooms_val
    try:
        rooms = int(raw_rooms) if raw_rooms is not None else None
    except (ValueError, TypeError):
        rooms = None

    area_val = listing_data.get("area")
    raw_area = area_val.get("value") if isinstance(area_val, dict) else area_val
    try:
        area = float(raw_area) if raw_area is not None else None
    except (ValueError, TypeError):
        area = None

    floor_val = listing_data.get("floor")
    raw_floor = floor_val.get("value") if isinstance(floor_val, dict) else floor_val
    try:
        floor = int(raw_floor) if raw_floor is not None else None
    except (ValueError, TypeError):
        floor = None

    floors_val = listing_data.get("floors")
    raw_floors = floors_val.get("value") if isinstance(floors_val, dict) else floors_val
    try:
        floors = int(raw_floors) if raw_floors is not None else None
    except (ValueError, TypeError):
        floors = None

    has_bill_of_sale = 1 if listing_data.get("has_bill_of_sale", True) else 0
    is_owner = 1 if listing_data.get("is_owner", False) else 0
    contact_type_name = str(listing_data.get("contact_type_name") or "")
    contact_name = str(listing_data.get("contact_name") or "")
    owner_phone = str(listing_data.get("owner_phone") or "")
    photo_urls = json.dumps(listing_data.get("photo_urls", []), ensure_ascii=False)
    downloaded_photos = json.dumps(listing_data.get("downloaded_photos", []), ensure_ascii=False)
    description = str(listing_data.get("description") or "")
    status = listing_data.get("status", "NEW")

    now_iso = datetime.now(timezone.utc).isoformat()

    with conn:
        cursor = conn.execute("""
            INSERT INTO listings (
                bina_id, url, title, price, currency, location, address, rooms,
                area, floor, floors, has_bill_of_sale, is_owner, contact_type_name,
                contact_name, owner_phone, photo_urls, downloaded_photos, description,
                status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bina_id) DO UPDATE SET
                title = excluded.title,
                price = excluded.price,
                currency = excluded.currency,
                location = excluded.location,
                address = excluded.address,
                rooms = excluded.rooms,
                area = excluded.area,
                floor = excluded.floor,
                floors = excluded.floors,
                has_bill_of_sale = excluded.has_bill_of_sale,
                is_owner = excluded.is_owner,
                contact_type_name = excluded.contact_type_name,
                contact_name = excluded.contact_name,
                owner_phone = COALESCE(excluded.owner_phone, listings.owner_phone),
                photo_urls = excluded.photo_urls,
                downloaded_photos = CASE 
                    WHEN excluded.downloaded_photos != '[]' THEN excluded.downloaded_photos 
                    ELSE listings.downloaded_photos 
                END,
                description = excluded.description,
                updated_at = excluded.updated_at
        """, (
            bina_id, url, title, price, currency, location, address, rooms,
            area, floor, floors, has_bill_of_sale, is_owner, contact_type_name,
            contact_name, owner_phone, photo_urls, downloaded_photos, description,
            status, now_iso, now_iso
        ))

        # Retrieve row id
        row = conn.execute("SELECT id FROM listings WHERE bina_id = ?", (bina_id,)).fetchone()
        row_id = row["id"] if row else cursor.lastrowid

    conn.close()
    return row_id


def update_listing_status(bina_id: str, status: str, downloaded_photos: Optional[List[str]] = None, db_path: Optional[Path] = None) -> None:
    """Updates listing processing status and optionally the downloaded photos list."""
    conn = get_connection(db_path)
    now_iso = datetime.now(timezone.utc).isoformat()
    with conn:
        if downloaded_photos is not None:
            conn.execute("""
                UPDATE listings
                SET status = ?, downloaded_photos = ?, updated_at = ?
                WHERE bina_id = ?
            """, (status, json.dumps(downloaded_photos, ensure_ascii=False), now_iso, str(bina_id)))
        else:
            conn.execute("""
                UPDATE listings
                SET status = ?, updated_at = ?
                WHERE bina_id = ?
            """, (status, now_iso, str(bina_id)))
    conn.close()


def get_listing_by_bina_id(bina_id: str, db_path: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Retrieves a single listing by its bina.az ID."""
    conn = get_connection(db_path)
    row = conn.execute("SELECT * FROM listings WHERE bina_id = ?", (str(bina_id),)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    d["photo_urls"] = json.loads(d["photo_urls"]) if d.get("photo_urls") else []
    d["downloaded_photos"] = json.loads(d["downloaded_photos"]) if d.get("downloaded_photos") else []
    return d


def get_unprocessed_listings(limit: int = 10, db_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Retrieves listings that need video generation (status in NEW, PHOTOS_READY)."""
    conn = get_connection(db_path)
    rows = conn.execute("""
        SELECT * FROM listings 
        WHERE status IN ('NEW', 'PHOTOS_READY')
        ORDER BY id DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    results = []
    for row in rows:
        d = dict(row)
        d["photo_urls"] = json.loads(d["photo_urls"]) if d.get("photo_urls") else []
        d["downloaded_photos"] = json.loads(d["downloaded_photos"]) if d.get("downloaded_photos") else []
        results.append(d)
    return results


def record_generated_video(
    listing_id: int,
    video_path: str,
    audio_path: Optional[str] = None,
    srt_path: Optional[str] = None,
    script_text: Optional[str] = None,
    duration_seconds: Optional[float] = None,
    status: str = "COMPLETED",
    db_path: Optional[Path] = None
) -> int:
    """Records a rendered video for a listing."""
    conn = get_connection(db_path)
    with conn:
        cursor = conn.execute("""
            INSERT INTO generated_videos (
                listing_id, video_path, audio_path, srt_path, script_text,
                duration_seconds, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (listing_id, video_path, audio_path, srt_path, script_text, duration_seconds, status))
        vid_id = cursor.lastrowid
        # Also mark listing as VIDEO_READY
        conn.execute("UPDATE listings SET status = 'VIDEO_READY' WHERE id = ?", (listing_id,))
    conn.close()
    return vid_id


def mark_video_dispatched(listing_id: int, telegram_message_id: Optional[str] = None, db_path: Optional[Path] = None) -> None:
    """Marks video as dispatched and updates listings status."""
    conn = get_connection(db_path)
    with conn:
        if telegram_message_id:
            conn.execute("""
                UPDATE generated_videos
                SET telegram_message_id = ?
                WHERE listing_id = ?
            """, (str(telegram_message_id), listing_id))
        conn.execute("UPDATE listings SET status = 'DISPATCHED' WHERE id = ?", (listing_id,))
    conn.close()


def get_recent_listings(limit: int = 20, db_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Retrieves most recent listings from the database."""
    conn = get_connection(db_path)
    rows = conn.execute("""
        SELECT * FROM listings 
        ORDER BY id DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    results = []
    for row in rows:
        d = dict(row)
        d["photo_urls"] = json.loads(d["photo_urls"]) if d.get("photo_urls") else []
        d["downloaded_photos"] = json.loads(d["downloaded_photos"]) if d.get("downloaded_photos") else []
        results.append(d)
    return results


def get_recent_videos(limit: int = 20, db_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Retrieves generated videos along with basic listing info."""
    conn = get_connection(db_path)
    rows = conn.execute("""
        SELECT v.*, l.bina_id, l.title, l.price, l.currency, l.owner_phone
        FROM generated_videos v
        LEFT JOIN listings l ON v.listing_id = l.id
        ORDER BY v.id DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_google_accounts(db_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Retrieves all Google accounts from database."""
    conn = get_connection(db_path)
    rows = conn.execute("SELECT * FROM google_accounts ORDER BY id ASC").fetchall()
    conn.close()
    return [dict(row) for row in rows]
