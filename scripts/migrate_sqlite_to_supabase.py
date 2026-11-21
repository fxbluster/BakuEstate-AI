"""
Idempotent one-time migration script: SQLite (data/database.sqlite) -> Supabase Postgres.

Migrates:
  - listings         -> public.listings         (upsert on bina_id)
  - generated_videos -> public.render_versions  (upsert on listing_id, version_num)
  - initial audit    -> public.listing_events   (idempotent SCRAPED_NEW per listing)

Usage:
  python scripts/migrate_sqlite_to_supabase.py --dry-run
  python scripts/migrate_sqlite_to_supabase.py --sqlite-path data/database.sqlite

Environment variables (required only for live execution, NOT --dry-run):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY (fallback: SUPABASE_KEY)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import requests

# Allowed enum sets matching supabase/migrations/202611180001_crm_core_schema.sql
VALID_CURRENCIES = {"AZN", "USD", "EUR"}
VALID_ARCHETYPES = {"budget", "luxury", "villa", "commercial"}
VALID_PIPELINE_STATUSES = {"NEW", "QUEUED", "RENDERING", "DISPATCHED", "FAILED", "SKIPPED_DUPLICATE"}
VALID_EDITORIAL_STATUSES = {"PENDING_REVIEW", "APPROVED", "PUBLISHED", "NEEDS_RERENDER", "REJECTED", "ARCHIVED"}
VALID_RENDER_STATUSES = {"QUEUED", "RUNNING", "COMPLETED", "FAILED", "SUPERSEDED"}

DISTRICT_KEYWORDS: Dict[str, str] = {
    "nərimanov": "Nərimanov",
    "nerimanov": "Nərimanov",
    "gənclik": "Nərimanov",
    "genclik": "Nərimanov",
    "montin": "Nərimanov",
    "nəsimi": "Nəsimi",
    "nasimi": "Nəsimi",
    "28 may": "Nəsimi",
    "səbail": "Səbail",
    "sebail": "Səbail",
    "bayıl": "Səbail",
    "badamdar": "Səbail",
    "şıxov": "Səbail",
    "sixov": "Səbail",
    "yasamal": "Yasamal",
    "elmlər": "Yasamal",
    "inşaatçılar": "Yasamal",
    "xəzər": "Xəzər",
    "mərdəkan": "Xəzər",
    "buzovna": "Xəzər",
    "bilgəh": "Xəzər",
    "şüvəlan": "Xəzər",
    "nizami": "Nizami",
    "xalqlar": "Nizami",
    "qara qarayev": "Nizami",
    "neftçilər": "Nizami",
    "8-ci kilometr": "Nizami",
    "xətai": "Xətai",
    "əhmədli": "Xətai",
    "həzi aslanov": "Xətai",
    "ağ şəhər": "Xətai",
    "binəqədi": "Binəqədi",
    "biləcəri": "Binəqədi",
    "memar əcəmi": "Binəqədi",
    "sabunçu": "Sabunçu",
    "bakıxanov": "Sabunçu",
    "zabrat": "Sabunçu",
    "suraxanı": "Suraxanı",
    "hövsan": "Suraxanı",
    "qaraçuxur": "Suraxanı",
    "abşeron": "Abşeron",
    "xırdalan": "Abşeron",
    "masazır": "Abşeron",
    "saray": "Abşeron",
    "mehdiabad": "Abşeron",
}


def load_dotenv_into_env(env_path: Path) -> None:
    """Minimal .env loader (non-overriding) so the script works standalone."""
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def normalize_phone(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) == 12 and digits.startswith("994"):
        return f"+{digits}"
    if len(digits) == 10 and digits.startswith("0"):
        return f"+994{digits[1:]}"
    if len(digits) == 9 and re.match(r"^(50|51|55|70|77|99|10|12)", digits):
        return f"+994{digits}"
    return None


def normalize_district(location: Optional[str], address: Optional[str]) -> Optional[str]:
    combined = f"{location or ''} {address or ''}".lower()
    for keyword, canonical in DISTRICT_KEYWORDS.items():
        if keyword in combined:
            return canonical
    return None


def normalize_price_to_azn(
    price: Optional[float],
    currency: str,
    usd_rate: float = 1.70,
    eur_rate: float = 1.85,
) -> float:
    val = float(price or 0.0)
    curr = (currency or "AZN").upper().strip()
    if curr == "USD":
        return round(val * usd_rate, 2)
    if curr == "EUR":
        return round(val * eur_rate, 2)
    return round(val, 2)


def detect_archetype(row: Dict[str, Any], price_azn: float) -> str:
    title = str(row.get("title") or "").lower()
    desc = str(row.get("description") or "").lower()
    combined = f"{title} {desc}"
    if any(k in title for k in ("həyət evi", "heyet evi", "bağ evi", "bag evi", "villa")):
        return "villa"
    if any(k in title for k in ("obyekt", "ofis", "kommersiya", "torpaq")):
        return "commercial"
    if price_azn >= 400000 or any(k in combined for k in ("penthouse", "ağ şəhər", "white city", "lüks")):
        return "luxury"
    return "budget"


def compute_photo_urls_hash(photo_urls: List[str]) -> Optional[str]:
    cleaned = [str(u).strip() for u in photo_urls if str(u).strip()]
    if not cleaned:
        return None
    canonical = json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalize_timestamp(ts: Optional[str]) -> str:
    if not ts:
        return datetime.now(timezone.utc).isoformat()
    s = str(ts).strip()
    if "T" not in s and " " in s:
        s = s.replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    except ValueError:
        return datetime.now(timezone.utc).isoformat()


def map_legacy_statuses(legacy_status: Optional[str]) -> Tuple[str, str]:
    status = (legacy_status or "NEW").upper().strip()
    if status == "PUBLISHED":
        return "DISPATCHED", "PUBLISHED"
    if status == "ARCHIVED":
        return "DISPATCHED", "ARCHIVED"
    if status == "DISPATCHED":
        return "DISPATCHED", "PENDING_REVIEW"
    if status == "FAILED":
        return "FAILED", "PENDING_REVIEW"
    return "NEW", "PENDING_REVIEW"


def map_render_status(legacy_status: Optional[str], is_latest: bool) -> str:
    status = (legacy_status or "COMPLETED").upper().strip()
    if status == "FAILED":
        return "FAILED"
    if status in ("COMPLETED", "DISPATCHED"):
        return "COMPLETED" if is_latest else "SUPERSEDED"
    if status in VALID_RENDER_STATUSES:
        return status
    return "COMPLETED" if is_latest else "SUPERSEDED"


def read_sqlite_records(sqlite_path: Path) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not sqlite_path.exists():
        raise FileNotFoundError(f"SQLite database not found: {sqlite_path}")
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    try:
        listings = [dict(r) for r in conn.execute("SELECT * FROM listings ORDER BY id ASC").fetchall()]
        videos = [dict(r) for r in conn.execute("SELECT * FROM generated_videos ORDER BY listing_id ASC, id ASC").fetchall()]
    finally:
        conn.close()
    return listings, videos


def build_migration_payloads(
    sqlite_listings: List[Dict[str, Any]],
    sqlite_videos: List[Dict[str, Any]],
    usd_rate: float = 1.70,
    eur_rate: float = 1.85,
) -> Tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]], List[Dict[str, Any]]]:
    """
    Transforms SQLite rows into validated Postgres payloads:
      - listing_payloads: list of dicts for public.listings
      - videos_by_bina_id: { bina_id: [render_version dicts without listing_id] }
      - event_payloads_by_bina: list of dicts (keyed with bina_id) for public.listing_events
    """
    videos_by_sqlite_id: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for v in sqlite_videos:
        videos_by_sqlite_id[int(v["listing_id"])].append(v)

    listing_payloads: List[Dict[str, Any]] = []
    videos_by_bina_id: Dict[str, List[Dict[str, Any]]] = {}
    event_specs: List[Dict[str, Any]] = []

    for row in sqlite_listings:
        bina_id = str(row["bina_id"]).strip()
        currency = str(row.get("currency") or "AZN").upper().strip()
        if currency not in VALID_CURRENCIES:
            currency = "AZN"

        raw_price = float(row["price"]) if row.get("price") is not None else 0.0
        price_azn = normalize_price_to_azn(raw_price, currency, usd_rate=usd_rate, eur_rate=eur_rate)

        try:
            photo_urls = json.loads(row.get("photo_urls") or "[]")
            if not isinstance(photo_urls, list):
                photo_urls = []
        except Exception:
            photo_urls = []

        pipeline_status, editorial_status = map_legacy_statuses(row.get("status"))
        archetype = detect_archetype(row, price_azn)
        phone_raw = str(row.get("owner_phone") or "").strip() or None
        phone_norm = normalize_phone(phone_raw)
        created_iso = normalize_timestamp(row.get("created_at"))
        updated_iso = normalize_timestamp(row.get("updated_at") or row.get("created_at"))

        sqlite_id = int(row["id"])
        linked_videos = videos_by_sqlite_id.get(sqlite_id, [])

        listing_doc: Dict[str, Any] = {
            "bina_id": bina_id,
            "url": str(row.get("url") or f"https://bina.az/items/{bina_id}"),
            "duplicate_resolution": "NONE",
            "photo_urls_hash": compute_photo_urls_hash(photo_urls),
            "content_revision": 1,
            "last_rendered_revision": 1 if linked_videos else None,
            "title": row.get("title") or None,
            "price": raw_price,
            "currency": currency,
            "price_azn_normalized": price_azn,
            "location": row.get("location") or None,
            "district_normalized": normalize_district(row.get("location"), row.get("address")),
            "address": row.get("address") or None,
            "rooms": int(row["rooms"]) if row.get("rooms") is not None else None,
            "area": float(row["area"]) if row.get("area") is not None else None,
            "floor": int(row["floor"]) if row.get("floor") is not None else None,
            "floors": int(row["floors"]) if row.get("floors") is not None else None,
            "has_bill_of_sale": bool(row.get("has_bill_of_sale")),
            "is_owner": bool(row.get("is_owner")),
            "contact_name": (row.get("contact_name") or "").strip() or None,
            "owner_phone_raw": phone_raw,
            "owner_phone_normalized": phone_norm,
            "photo_urls": photo_urls,
            "description": row.get("description") or None,
            "archetype": archetype,
            "source_availability": "ACTIVE",
            "first_seen_at": created_iso,
            "last_seen_at": updated_iso,
            "pipeline_status": pipeline_status,
            "editorial_status": editorial_status,
            "owner_outreach_status": "NOT_CONTACTED",
            "created_at": created_iso,
            "updated_at": updated_iso,
        }

        # Local constraint validation
        assert listing_doc["currency"] in VALID_CURRENCIES
        assert listing_doc["archetype"] in VALID_ARCHETYPES
        assert listing_doc["pipeline_status"] in VALID_PIPELINE_STATUSES
        assert listing_doc["editorial_status"] in VALID_EDITORIAL_STATUSES

        listing_payloads.append(listing_doc)

        # Build sequential render_versions for this listing
        version_docs: List[Dict[str, Any]] = []
        total_vids = len(linked_videos)
        for idx, vid in enumerate(linked_videos, start=1):
            is_latest = idx == total_vids
            v_status = map_render_status(vid.get("status"), is_latest=is_latest)
            v_created = normalize_timestamp(vid.get("created_at"))
            assert v_status in VALID_RENDER_STATUSES
            version_docs.append({
                "version_num": idx,
                "content_revision": 1,
                "trigger_reason": "AUTO_INITIAL" if idx == 1 else "MANUAL_RERENDER",
                "script_text": vid.get("script_text") or None,
                "local_video_path": vid.get("video_path") or None,
                "duration_seconds": (
                    round(float(vid["duration_seconds"]), 2)
                    if vid.get("duration_seconds") is not None
                    else None
                ),
                "status": v_status,
                "telegram_message_id": (
                    str(vid["telegram_message_id"]).strip()
                    if vid.get("telegram_message_id")
                    else None
                ),
                "created_at": v_created,
                "completed_at": v_created if v_status in ("COMPLETED", "SUPERSEDED") else None,
            })
        videos_by_bina_id[bina_id] = version_docs

        event_specs.append({
            "bina_id": bina_id,
            "event_type": "SCRAPED_NEW",
            "old_value_json": None,
            "new_value_json": {
                "price": raw_price,
                "currency": currency,
                "price_azn_normalized": price_azn,
                "legacy_status": row.get("status"),
                "migrated_from": "sqlite",
            },
            "actor": "migration",
            "created_at": created_iso,
        })

    return listing_payloads, videos_by_bina_id, event_specs


class PostgrestMigrator:
    def __init__(self, supabase_url: str, service_role_key: str) -> None:
        self.base_url = supabase_url.rstrip("/") + "/rest/v1"
        self.headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
        }

    def upsert_listings(self, rows: List[Dict[str, Any]]) -> Dict[str, str]:
        """Upserts listings by bina_id and returns { bina_id: uuid }."""
        if not rows:
            return {}
        url = f"{self.base_url}/listings?on_conflict=bina_id"
        headers = {**self.headers, "Prefer": "resolution=merge-duplicates,return=representation"}
        resp = requests.post(url, headers=headers, json=rows, timeout=30)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed upserting listings ({resp.status_code}): {resp.text}")
        data = resp.json()
        return {str(item["bina_id"]): str(item["id"]) for item in data}

    def upsert_render_versions(self, rows: List[Dict[str, Any]]) -> int:
        if not rows:
            return 0
        url = f"{self.base_url}/render_versions?on_conflict=listing_id,version_num"
        headers = {**self.headers, "Prefer": "resolution=merge-duplicates,return=representation"}
        resp = requests.post(url, headers=headers, json=rows, timeout=30)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed upserting render_versions ({resp.status_code}): {resp.text}")
        return len(resp.json())

    def fetch_existing_migration_events(self, listing_ids: List[str]) -> set[str]:
        if not listing_ids:
            return set()
        id_list = ",".join(listing_ids)
        url = (
            f"{self.base_url}/listing_events"
            f"?select=listing_id&event_type=eq.SCRAPED_NEW&listing_id=in.({id_list})"
        )
        resp = requests.get(url, headers=self.headers, timeout=30)
        if resp.status_code != 200:
            raise RuntimeError(f"Failed querying existing listing_events ({resp.status_code}): {resp.text}")
        return {str(r["listing_id"]) for r in resp.json()}

    def insert_events(self, rows: List[Dict[str, Any]]) -> int:
        if not rows:
            return 0
        url = f"{self.base_url}/listing_events"
        headers = {**self.headers, "Prefer": "return=representation"}
        resp = requests.post(url, headers=headers, json=rows, timeout=30)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Failed inserting listing_events ({resp.status_code}): {resp.text}")
        return len(resp.json())

    def count_rows(self, table: str) -> int:
        url = f"{self.base_url}/{table}?select=id"
        headers = {**self.headers, "Prefer": "count=exact", "Range": "0-0"}
        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code not in (200, 206):
            raise RuntimeError(f"Failed counting {table} ({resp.status_code}): {resp.text}")
        content_range = resp.headers.get("Content-Range", "")
        if "/" in content_range:
            total_part = content_range.split("/")[-1]
            if total_part.isdigit():
                return int(total_part)
        return len(resp.json())


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Idempotently migrate BakuEstate-AI SQLite data to Supabase Postgres."
    )
    parser.add_argument(
        "--sqlite-path",
        type=Path,
        default=PROJECT_ROOT / "data" / "database.sqlite",
        help="Path to legacy SQLite database (default: data/database.sqlite)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read, transform, and validate all records without writing to Supabase.",
    )
    parser.add_argument(
        "--usd-rate",
        type=float,
        default=float(os.getenv("USD_TO_AZN_RATE", "1.70")),
        help="USD to AZN conversion rate (default: 1.70)",
    )
    parser.add_argument(
        "--eur-rate",
        type=float,
        default=float(os.getenv("EUR_TO_AZN_RATE", "1.85")),
        help="EUR to AZN conversion rate (default: 1.85)",
    )
    args = parser.parse_args(argv)

    load_dotenv_into_env(PROJECT_ROOT / ".env")

    sqlite_listings, sqlite_videos = read_sqlite_records(args.sqlite_path)
    listing_payloads, videos_by_bina, event_specs = build_migration_payloads(
        sqlite_listings,
        sqlite_videos,
        usd_rate=args.usd_rate,
        eur_rate=args.eur_rate,
    )
    total_versions = sum(len(v) for v in videos_by_bina.values())

    print("=== BakuEstate-AI SQLite -> Supabase Postgres Migration ===")
    print(f"Source SQLite:   {args.sqlite_path}")
    print(f"Mode:            {'DRY-RUN (no remote writes)' if args.dry_run else 'LIVE UPSERT'}")
    print(f"Listings ready:  {len(listing_payloads)}")
    print(f"Renders ready:   {total_versions}")
    print(f"Events ready:    {len(event_specs)}")

    if args.dry_run:
        print("\n--- Dry-Run Validation Summary ---")
        for item in listing_payloads:
            vids = videos_by_bina.get(item["bina_id"], [])
            v_summary = ", ".join(f"v{v['version_num']}:{v['status']}" for v in vids) or "none"
            print(
                f"  bina_id={item['bina_id']:<8} | {item['price_azn_normalized']:>10.0f} AZN | "
                f"dist={str(item['district_normalized'] or '-'):<10} | "
                f"pipe={item['pipeline_status']:<10} | edit={item['editorial_status']:<14} | "
                f"renders=[{v_summary}]"
            )
        print("\n[OK] Dry-run completed cleanly. Zero schema constraint violations.")
        return 0

    supabase_url = (os.getenv("SUPABASE_URL") or "").strip()
    service_role_key = (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or ""
    ).strip()
    if not supabase_url or not service_role_key:
        print(
            "[ERROR] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) "
            "must be set in environment for live migration.",
            file=sys.stderr,
        )
        return 1

    migrator = PostgrestMigrator(supabase_url, service_role_key)

    bina_to_uuid = migrator.upsert_listings(listing_payloads)
    print(f"[OK] Upserted {len(bina_to_uuid)} listings into public.listings")

    render_rows: List[Dict[str, Any]] = []
    for bina_id, vids in videos_by_bina.items():
        listing_uuid = bina_to_uuid.get(bina_id)
        if not listing_uuid:
            continue
        for v in vids:
            render_rows.append({"listing_id": listing_uuid, **v})

    upserted_renders = migrator.upsert_render_versions(render_rows)
    print(f"[OK] Upserted {upserted_renders} render versions into public.render_versions")

    existing_event_listing_ids = migrator.fetch_existing_migration_events(list(bina_to_uuid.values()))
    new_event_rows: List[Dict[str, Any]] = []
    for spec in event_specs:
        listing_uuid = bina_to_uuid.get(spec["bina_id"])
        if not listing_uuid or listing_uuid in existing_event_listing_ids:
            continue
        new_event_rows.append({
            "listing_id": listing_uuid,
            "event_type": spec["event_type"],
            "old_value_json": spec["old_value_json"],
            "new_value_json": spec["new_value_json"],
            "actor": spec["actor"],
            "created_at": spec["created_at"],
        })

    inserted_events = migrator.insert_events(new_event_rows)
    print(
        f"[OK] Inserted {inserted_events} initial SCRAPED_NEW events "
        f"(skipped {len(event_specs) - inserted_events} already present)"
    )

    pg_listings = migrator.count_rows("listings")
    pg_renders = migrator.count_rows("render_versions")
    pg_events = migrator.count_rows("listing_events")
    print(
        f"[VERIFY] Postgres totals -> listings={pg_listings}, "
        f"render_versions={pg_renders}, listing_events={pg_events}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
