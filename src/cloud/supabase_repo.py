"""
Supabase Postgres REST & RPC Repository for BakuEstate-AI.
Single-source-of-truth data access layer for:
- Batch bina_id lookup & last_seen_at touch
- Phone-preserving listing upserts & updates
- Repost candidate lookup by owner_phone_normalized
- Immutable listing_events audit log inserts
- Versioned render_versions CRUD & superseding
- Idempotent pipeline_jobs queue + worker RPCs (claim, heartbeat, Baku daily count)
- Versioned Supabase Storage uploads (videos/{bina_id}/v{n}.mp4)
"""

from __future__ import annotations

import logging
import os
import re
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import requests

from config.settings import (
    BINA_BASE_URL,
    SUPABASE_BUCKET,
    SUPABASE_ENABLED,
    SUPABASE_KEY,
    SUPABASE_URL,
    WORKER_ID,
    WORKER_MODE,
    safe_parse_numeric,
)
from src.cloud.r2_storage import R2StorageClient
from src.dedup.change_detector import (
    compute_photo_urls_hash,
    normalize_district,
    normalize_price_to_azn,
)
from src.media.tts_service import detect_listing_archetype
from src.scraper.bina_scraper import clean_phone_number

logger = logging.getLogger("supabase_repo")

VALID_CURRENCIES = frozenset({"AZN", "USD", "EUR"})
VALID_ARCHETYPES = frozenset({"budget", "luxury", "villa", "commercial"})
CLOSED_LEAD_STAGES = frozenset({"WON_CLOSED", "LOST", "COLD"})
R2_WORKER_MODES = frozenset({"cloud", "railway", "r2"})


def build_versioned_storage_path(
    bina_id: str,
    version_num: int,
    target_account_handle: Optional[str] = None,
    *,
    agency_id: Optional[str] = None,
    listing_id: Optional[str] = None,
) -> str:
    """
    Returns canonical versioned storage object path:
    - Tenant-isolated R2 format when agency_id & listing_id are provided:
      `videos/{agency_id}/{listing_id}/v{n}.mp4` (or `v{n}__at_{clean_handle}.mp4`)
    - Legacy format when omitted:
      `videos/{bina_id}/v{n}.mp4` (or `v{n}__at_{clean_handle}.mp4`)
    """
    ver = max(1, int(version_num))
    suffix = ""
    if target_account_handle and str(target_account_handle).strip():
        clean_handle = re.sub(r'[^a-zA-Z0-9_.-]', '_', str(target_account_handle).strip().lstrip('@'))
        suffix = f"__at_{clean_handle}"

    clean_agency = str(agency_id or "").strip()
    clean_listing = str(listing_id or "").strip()
    if clean_agency and clean_listing:
        return f"videos/{clean_agency}/{clean_listing}/v{ver}{suffix}.mp4"

    clean_id = str(bina_id or clean_listing or "unknown").strip()
    return f"videos/{clean_id}/v{ver}{suffix}.mp4"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_valid_uuid(val: Any) -> bool:
    if not val:
        return False
    try:
        uuid.UUID(str(val).strip())
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _normalize_card_priority(raw_priority: Any) -> str:
    if isinstance(raw_priority, (int, float)):
        val = int(raw_priority)
        if val >= 90:
            return "URGENT"
        if val >= 70:
            return "HIGH"
        if val <= 35:
            return "LOW"
        return "NORMAL"
    s = str(raw_priority or "NORMAL").strip().upper()
    if s.isdigit():
        return _normalize_card_priority(int(s))
    priority_map = {
        "LOW": "LOW",
        "NORMAL": "NORMAL",
        "MEDIUM": "NORMAL",
        "HIGH": "HIGH",
        "URGENT": "URGENT",
        "CRITICAL": "URGENT",
    }
    return priority_map.get(s, "NORMAL")


def _normalize_currency(raw_currency: Optional[str]) -> str:
    cur = (raw_currency or "AZN").strip().upper()
    if cur in VALID_CURRENCIES:
        return cur
    if cur in ("$", "US$", "DOLLAR"):
        return "USD"
    if cur in ("€", "EURO"):
        return "EUR"
    return "AZN"


class SupabaseRepo:
    """
    Clean REST/RPC repository for Supabase Postgres and Storage.
    Uses service_role credentials exclusively from environment/constructor (fail-closed).
    """

    def __init__(
        self,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
        bucket_name: Optional[str] = None,
        enabled: Optional[bool] = None,
        session: Optional[requests.Session] = None,
        timeout: int = 20,
        r2_storage: Optional[R2StorageClient] = None,
        worker_mode: Optional[str] = None,
    ):
        resolved_url = (
            supabase_url
            if supabase_url is not None
            else (os.getenv("SUPABASE_URL") or SUPABASE_URL)
        )
        resolved_key = (
            supabase_key
            if supabase_key is not None
            else (
                os.getenv("SUPABASE_SERVICE_ROLE_KEY")
                or os.getenv("SUPABASE_KEY")
                or SUPABASE_KEY
            )
        )
        self.supabase_url = (resolved_url or "").strip().rstrip("/")
        self.supabase_key = (resolved_key or "").strip()
        self.bucket_name = (bucket_name or SUPABASE_BUCKET or "baku-estate-media").strip()
        base_enabled = SUPABASE_ENABLED if enabled is None else bool(enabled)
        self.enabled = base_enabled and bool(self.supabase_url) and bool(self.supabase_key)
        self.session = session or requests.Session()
        self.timeout = int(timeout)
        self.worker_mode = (
            worker_mode
            if worker_mode is not None
            else (os.getenv("WORKER_MODE") or WORKER_MODE or "local")
        ).strip().lower()
        self._explicit_r2_storage = r2_storage is not None
        if r2_storage is not None:
            self.r2_storage: Optional[R2StorageClient] = r2_storage
        elif self.worker_mode in R2_WORKER_MODES:
            candidate_r2 = R2StorageClient()
            self.r2_storage = candidate_r2 if candidate_r2.is_configured() else None
        else:
            self.r2_storage = None
        self.last_upload_storage_provider: str = "r2" if self.should_use_r2_storage() else "supabase"

    def should_use_r2_storage(self, storage_provider: Optional[str] = None) -> bool:
        """
        Determines whether media uploads should route to private Cloudflare R2
        versus legacy Supabase Storage (dual-path Phase 2 rollout).
        """
        if storage_provider is not None:
            prov = str(storage_provider).strip().lower()
            if prov == "supabase":
                return False
            if prov == "r2":
                return self.r2_storage is not None and self.r2_storage.is_configured()
        if self.r2_storage is None or not self.r2_storage.is_configured():
            return False
        return self._explicit_r2_storage or (self.worker_mode in R2_WORKER_MODES)

    def get_agency_settings(self, agency_id: str) -> Optional[Dict[str, Any]]:
        """Fetches public.agency_settings row for an agency UUID (service_role)."""
        if not self.enabled or not agency_id or not _is_valid_uuid(agency_id):
            return None
        try:
            resp = self.session.get(
                self._rest_url("agency_settings"),
                headers=self._headers(),
                params={
                    "agency_id": f"eq.{str(agency_id).strip()}",
                    "select": "*",
                    "limit": "1",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("get_agency_settings failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_agency_settings: %s", exc)
        return None

    def is_configured(self) -> bool:
        """Returns True when cloud repo is enabled and has non-empty URL and key."""
        return self.enabled

    def _headers(
        self,
        content_type: str = "application/json",
        prefer: Optional[str] = None,
    ) -> Dict[str, str]:
        headers = {
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
            "Content-Type": content_type,
        }
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def _rest_url(self, table: str) -> str:
        return f"{self.supabase_url}/rest/v1/{table}"

    def _rpc_url(self, fn_name: str) -> str:
        return f"{self.supabase_url}/rest/v1/rpc/{fn_name}"

    @staticmethod
    def _postgrest_in_list(values: Sequence[str]) -> str:
        quoted = []
        for v in values:
            s = str(v).strip()
            if not s:
                continue
            escaped = s.replace("\\", "\\\\").replace('"', '\\"')
            quoted.append(f'"{escaped}"')
        return f"in.({','.join(quoted)})"

    # ------------------------------------------------------------------
    # Listings CRUD & Pre-Scrape / Repost Queries
    # ------------------------------------------------------------------

    def get_listings_by_bina_ids(
        self,
        bina_ids: Sequence[str],
        select: str = "*",
        chunk_size: int = 100,
    ) -> Dict[str, Dict[str, Any]]:
        """
        Batch-fetches existing listings keyed by bina_id in chunked REST queries.
        Used for pre-scrape filtering to eliminate page-1 starvation.
        """
        if not self.enabled or not bina_ids:
            return {}

        unique_ids = list(dict.fromkeys(str(bid).strip() for bid in bina_ids if str(bid).strip()))
        result: Dict[str, Dict[str, Any]] = {}

        for i in range(0, len(unique_ids), chunk_size):
            chunk = unique_ids[i : i + chunk_size]
            params = {
                "select": select,
                "bina_id": self._postgrest_in_list(chunk),
            }
            try:
                resp = self.session.get(
                    self._rest_url("listings"),
                    headers=self._headers(),
                    params=params,
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    rows = resp.json() or []
                    for row in rows:
                        bid = str(row.get("bina_id") or "").strip()
                        if bid:
                            result[bid] = row
                else:
                    logger.error(
                        "get_listings_by_bina_ids failed (%s): %s",
                        resp.status_code,
                        resp.text[:300],
                    )
            except Exception as exc:
                logger.error("Exception in get_listings_by_bina_ids: %s", exc)

        return result

    def get_listing_by_bina_id(self, bina_id: str) -> Optional[Dict[str, Any]]:
        """Fetches a single canonical listing row by bina_id."""
        clean_id = str(bina_id or "").strip()
        if not clean_id:
            return None
        found = self.get_listings_by_bina_ids([clean_id])
        return found.get(clean_id)

    def get_listing_by_id(self, listing_id: str) -> Optional[Dict[str, Any]]:
        """Fetches a single canonical listing row by UUID primary key."""
        if not self.enabled or not listing_id:
            return None
        try:
            resp = self.session.get(
                self._rest_url("listings"),
                headers=self._headers(),
                params={"id": f"eq.{listing_id}", "select": "*", "limit": "1"},
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("get_listing_by_id failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_listing_by_id: %s", exc)
        return None

    def touch_listings_last_seen(self, bina_ids: Sequence[str]) -> bool:
        """Batch-updates last_seen_at = NOW() for unchanged listings seen on bina.az."""
        if not self.enabled or not bina_ids:
            return False

        unique_ids = list(dict.fromkeys(str(bid).strip() for bid in bina_ids if str(bid).strip()))
        if not unique_ids:
            return False

        try:
            resp = self.session.patch(
                self._rest_url("listings"),
                headers=self._headers(prefer="return=minimal"),
                params={"bina_id": self._postgrest_in_list(unique_ids)},
                json={"last_seen_at": _utc_now_iso()},
                timeout=self.timeout,
            )
            if resp.status_code in (200, 204):
                return True
            logger.error(
                "touch_listings_last_seen failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in touch_listings_last_seen: %s", exc)
        return False

    def build_listing_upsert_payload(
        self,
        listing: Dict[str, Any],
        *,
        existing: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Builds a schema-compliant payload for public.listings upsert.
        Preserves any existing non-empty owner phone if incoming phone is empty/missing.
        """
        bina_id = str(listing.get("bina_id") or "").strip()
        if not bina_id:
            raise ValueError("listing must contain a non-empty 'bina_id'")

        currency = _normalize_currency(listing.get("currency"))
        price_val = safe_parse_numeric(listing.get("price"), default=0.0, is_price=True)
        price_azn = listing.get("price_azn_normalized")
        if price_azn is None or price_azn == "":
            price_azn = normalize_price_to_azn(price_val, currency)
        else:
            price_azn = round(safe_parse_numeric(price_azn, default=0.0, is_price=True), 2)

        location = str(listing.get("location") or "").strip()
        address = str(listing.get("address") or "").strip()
        district_norm = str(listing.get("district_normalized") or "").strip() or normalize_district(
            location, address
        )

        photo_urls = listing.get("photo_urls") or []
        if not isinstance(photo_urls, list):
            photo_urls = list(photo_urls)
        photo_hash = str(listing.get("photo_urls_hash") or "").strip() or compute_photo_urls_hash(
            photo_urls
        )

        raw_archetype = str(listing.get("archetype") or "").strip().lower()
        if raw_archetype not in VALID_ARCHETYPES:
            raw_archetype = detect_listing_archetype(listing)

        def _opt_int(val: Any) -> Optional[int]:
            if val is None or val == "":
                return None
            try:
                return int(safe_parse_numeric(val, default=0.0, is_price=False))
            except Exception:
                return None

        def _opt_float(val: Any) -> Optional[float]:
            if val is None or val == "":
                return None
            try:
                return round(safe_parse_numeric(val, default=0.0, is_price=False), 2)
            except Exception:
                return None

        payload: Dict[str, Any] = {
            "bina_id": bina_id,
            "url": str(listing.get("url") or f"{BINA_BASE_URL}/items/{bina_id}"),
            "title": str(listing.get("title") or f"Mənzil {bina_id}"),
            "price": round(price_val, 2),
            "currency": currency,
            "price_azn_normalized": price_azn,
            "location": location or None,
            "district_normalized": district_norm or None,
            "address": address or None,
            "rooms": _opt_int(listing.get("rooms")),
            "area": _opt_float(listing.get("area")),
            "floor": _opt_int(listing.get("floor")),
            "floors": _opt_int(listing.get("floors")),
            "has_bill_of_sale": bool(listing.get("has_bill_of_sale", False)),
            "is_owner": bool(listing.get("is_owner", False)),
            "contact_name": (str(listing.get("contact_name") or "").strip() or None),
            "photo_urls": photo_urls,
            "photo_urls_hash": photo_hash or None,
            "description": str(listing.get("description") or "") or None,
            "archetype": raw_archetype,
            "last_seen_at": listing.get("last_seen_at") or _utc_now_iso(),
        }

        # Phone preservation rule: NEVER overwrite an existing non-empty phone with empty string/None.
        incoming_raw = str(
            listing.get("owner_phone_raw") or listing.get("owner_phone") or ""
        ).strip()
        incoming_norm = clean_phone_number(
            str(listing.get("owner_phone_normalized") or incoming_raw)
        )
        if incoming_norm:
            payload["owner_phone_raw"] = incoming_raw or incoming_norm
            payload["owner_phone_normalized"] = incoming_norm
        elif existing:
            existing_norm = str(existing.get("owner_phone_normalized") or "").strip()
            existing_raw = str(existing.get("owner_phone_raw") or "").strip()
            if existing_norm:
                payload["owner_phone_normalized"] = existing_norm
            if existing_raw:
                payload["owner_phone_raw"] = existing_raw
        # When incoming phone is empty and `existing` is not supplied, we deliberately OMIT
        # owner_phone_raw and owner_phone_normalized from the payload so PostgREST merge-duplicates
        # leaves any stored phone untouched on conflict.

        # Pass through optional workflow/dedup fields only when explicitly provided
        optional_passthrough = (
            "duplicate_of_listing_id",
            "duplicate_confidence",
            "duplicate_resolution",
            "content_revision",
            "last_rendered_revision",
            "source_availability",
            "last_checked_at",
            "pipeline_status",
            "editorial_status",
            "owner_outreach_status",
            "commission_type",
            "commission_value",
            "owner_min_price_azn",
            "owner_last_contacted_at",
            "owner_next_checkin_at",
            "owner_notes",
            "last_auto_rendered_at",
        )
        for key in optional_passthrough:
            if key in listing and listing[key] is not None:
                payload[key] = listing[key]

        return payload

    def upsert_listing(
        self,
        listing: Dict[str, Any],
        *,
        existing: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Upserts a canonical listing into public.listings without ON CONFLICT
        (compatible with partial unique index uq_listings_agency_bina_id),
        strictly preserving any non-empty owner_phone_normalized.
        Returns the saved row dict or None on failure/disabled.
        """
        if not self.enabled:
            logger.info("SupabaseRepo disabled or unconfigured. Skipping upsert_listing.")
            return None

        payload = self.build_listing_upsert_payload(listing, existing=existing)
        try:
            existing_id = str((existing or {}).get("id") or "").strip()
            if existing_id:
                resp = self.session.patch(
                    self._rest_url("listings"),
                    headers=self._headers(prefer="return=representation"),
                    params={"id": f"eq.{existing_id}"},
                    json=payload,
                    timeout=self.timeout,
                )
                if resp.status_code in (200, 201, 204):
                    rows = resp.json() if resp.status_code != 204 else []
                    return rows[0] if rows else payload
                logger.error(
                    "upsert_listing PATCH failed for bina_id=%s (%s): %s",
                    payload["bina_id"],
                    resp.status_code,
                    resp.text[:300],
                )
                return None

            resp = self.session.post(
                self._rest_url("listings"),
                headers=self._headers(prefer="return=representation"),
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else payload
            if resp.status_code == 409:
                patch_resp = self.session.patch(
                    self._rest_url("listings"),
                    headers=self._headers(prefer="return=representation"),
                    params={"bina_id": f"eq.{payload['bina_id']}"},
                    json=payload,
                    timeout=self.timeout,
                )
                if patch_resp.status_code in (200, 201, 204):
                    rows = patch_resp.json() if patch_resp.status_code != 204 else []
                    return rows[0] if rows else payload
                logger.error(
                    "upsert_listing 409->PATCH fallback failed for bina_id=%s (%s): %s",
                    payload["bina_id"],
                    patch_resp.status_code,
                    patch_resp.text[:300],
                )
                return None
            logger.error(
                "upsert_listing failed for bina_id=%s (%s): %s",
                payload["bina_id"],
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in upsert_listing: %s", exc)
        return None

    def update_listing(
        self,
        identifier: str,
        fields: Dict[str, Any],
        *,
        by_bina_id: bool = False,
        allow_clear_phone: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Patches specific fields on public.listings by UUID id (default) or bina_id."""
        if not self.enabled or not identifier or not fields:
            return None

        patch_data = dict(fields)
        if not allow_clear_phone:
            for phone_col in ("owner_phone_normalized", "owner_phone_raw"):
                if phone_col in patch_data and not str(patch_data[phone_col] or "").strip():
                    patch_data.pop(phone_col, None)

        if not patch_data:
            return None

        filter_col = "bina_id" if by_bina_id else "id"
        try:
            resp = self.session.patch(
                self._rest_url("listings"),
                headers=self._headers(prefer="return=representation"),
                params={filter_col: f"eq.{identifier}"},
                json=patch_data,
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("update_listing failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in update_listing: %s", exc)
        return None

    def find_repost_candidates(
        self,
        owner_phone_normalized: Optional[str],
        *,
        exclude_bina_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """
        Queries existing listings sharing the same non-empty normalized owner phone
        for null-safe repost scoring via score_repost_candidate().
        Returns [] immediately when phone is empty (never auto-flags without phone).
        """
        if not self.enabled:
            return []

        norm_phone = clean_phone_number(owner_phone_normalized)
        if not norm_phone:
            return []

        params: Dict[str, str] = {
            "select": (
                "id,bina_id,title,price,currency,price_azn_normalized,"
                "location,district_normalized,address,rooms,area,floor,floors,"
                "owner_phone_normalized,source_availability,editorial_status,"
                "pipeline_status,duplicate_resolution,created_at"
            ),
            "owner_phone_normalized": f"eq.{norm_phone}",
            "order": "created_at.asc",
            "limit": str(max(1, int(limit))),
        }
        if exclude_bina_id:
            params["bina_id"] = f"neq.{str(exclude_bina_id).strip()}"

        try:
            resp = self.session.get(
                self._rest_url("listings"),
                headers=self._headers(),
                params=params,
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                return resp.json() or []
            logger.error("find_repost_candidates failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in find_repost_candidates: %s", exc)
        return []

    def get_active_listings_for_liveness(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Returns ACTIVE listings ordered by oldest last_checked_at for liveness polling."""
        if not self.enabled:
            return []
        try:
            resp = self.session.get(
                self._rest_url("listings"),
                headers=self._headers(),
                params={
                    "select": "id,bina_id,url,title,source_availability,editorial_status,owner_outreach_status,last_checked_at",
                    "source_availability": "eq.ACTIVE",
                    "order": "last_checked_at.asc.nullsfirst",
                    "limit": str(max(1, int(limit))),
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                return resp.json() or []
            logger.error(
                "get_active_listings_for_liveness failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in get_active_listings_for_liveness: %s", exc)
        return []

    # ------------------------------------------------------------------
    # Immutable Audit Events (public.listing_events)
    # ------------------------------------------------------------------

    def insert_listing_event(
        self,
        listing_id: str,
        event_type: str,
        *,
        old_value: Optional[Dict[str, Any]] = None,
        new_value: Optional[Dict[str, Any]] = None,
        price_delta_pct: Optional[float] = None,
        triggered_job_id: Optional[str] = None,
        actor: str = "scraper",
    ) -> Optional[Dict[str, Any]]:
        """Inserts a single immutable change/audit event into public.listing_events."""
        if not self.enabled or not listing_id or not event_type:
            return None

        payload: Dict[str, Any] = {
            "listing_id": listing_id,
            "event_type": event_type,
            "old_value_json": old_value,
            "new_value_json": new_value,
            "price_delta_pct": price_delta_pct,
            "triggered_job_id": triggered_job_id,
            "actor": actor,
        }
        try:
            resp = self.session.post(
                self._rest_url("listing_events"),
                headers=self._headers(prefer="return=representation"),
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else payload
            logger.error("insert_listing_event failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in insert_listing_event: %s", exc)
        return None

    def insert_listing_events(
        self,
        listing_id: str,
        events: Sequence[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Batch-inserts multiple event dicts (e.g. from detect_listing_changes) into public.listing_events."""
        if not self.enabled or not listing_id or not events:
            return []

        rows_to_insert = []
        for ev in events:
            rows_to_insert.append({
                "listing_id": listing_id,
                "event_type": ev["event_type"],
                "old_value_json": ev.get("old_value_json"),
                "new_value_json": ev.get("new_value_json"),
                "price_delta_pct": ev.get("price_delta_pct"),
                "triggered_job_id": ev.get("triggered_job_id"),
                "actor": ev.get("actor", "scraper"),
            })

        try:
            resp = self.session.post(
                self._rest_url("listing_events"),
                headers=self._headers(prefer="return=representation"),
                json=rows_to_insert,
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                return resp.json() or []
            logger.error("insert_listing_events failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in insert_listing_events: %s", exc)
        return []

    # ------------------------------------------------------------------
    # Versioned Render History (public.render_versions)
    # ------------------------------------------------------------------

    def get_latest_render_version(self, listing_id: str) -> Optional[Dict[str, Any]]:
        """Fetches the highest version_num row from public.render_versions for a listing."""
        if not self.enabled or not listing_id:
            return None
        try:
            resp = self.session.get(
                self._rest_url("render_versions"),
                headers=self._headers(),
                params={
                    "listing_id": f"eq.{listing_id}",
                    "select": "*",
                    "order": "version_num.desc",
                    "limit": "1",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("get_latest_render_version failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_latest_render_version: %s", exc)
        return None

    def get_render_version_by_id(self, render_version_id: str) -> Optional[Dict[str, Any]]:
        """Fetches a single render_version row from public.render_versions by UUID primary key."""
        if not self.enabled or not render_version_id:
            return None
        try:
            resp = self.session.get(
                self._rest_url("render_versions"),
                headers=self._headers(),
                params={
                    "id": f"eq.{str(render_version_id).strip()}",
                    "select": "*",
                    "limit": "1",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("get_render_version_by_id failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_render_version_by_id: %s", exc)
        return None

    def get_next_render_version_num(self, listing_id: str) -> int:
        """Computes the next sequential version_num (1, 2, 3...) for a listing."""
        latest = self.get_latest_render_version(listing_id)
        if latest and latest.get("version_num"):
            try:
                return int(latest["version_num"]) + 1
            except (TypeError, ValueError):
                pass
        return 1

    def create_render_version(
        self,
        listing_id: str,
        version_num: int,
        *,
        content_revision: int = 1,
        trigger_reason: str = "AUTO_INITIAL",
        script_angle: Optional[str] = None,
        voice_engine: Optional[str] = None,
        voice_id: Optional[str] = None,
        model_id: Optional[str] = None,
        script_text: Optional[str] = None,
        local_video_path: Optional[str] = None,
        storage_object_path: Optional[str] = None,
        storage_provider: Optional[str] = None,
        video_cdn_url: Optional[str] = None,
        duration_seconds: Optional[float] = None,
        status: str = "RUNNING",
        telegram_message_id: Optional[str] = None,
        hook_type: Optional[str] = None,
        duration_bucket: Optional[str] = None,
        ab_metadata: Optional[Dict[str, Any]] = None,
        rendered_price: Optional[float] = None,
        rendered_currency: str = "AZN",
    ) -> Optional[Dict[str, Any]]:
        """Creates a new versioned row in public.render_versions (never overwrites prior versions)."""
        if not self.enabled or not listing_id:
            return None

        payload: Dict[str, Any] = {
            "listing_id": listing_id,
            "version_num": max(1, int(version_num)),
            "content_revision": max(1, int(content_revision)),
            "trigger_reason": trigger_reason,
            "script_angle": script_angle,
            "voice_engine": voice_engine,
            "voice_id": voice_id,
            "model_id": model_id,
            "script_text": script_text,
            "local_video_path": local_video_path,
            "storage_object_path": storage_object_path,
            "video_cdn_url": video_cdn_url,
            "duration_seconds": duration_seconds,
            "status": status,
            "telegram_message_id": str(telegram_message_id) if telegram_message_id else None,
        }
        if storage_provider is not None:
            norm_prov = str(storage_provider).strip().lower()
            if norm_prov in ("supabase", "r2"):
                payload["storage_provider"] = norm_prov
        if hook_type is not None:
            payload["hook_type"] = hook_type
        if duration_bucket is not None:
            payload["duration_bucket"] = duration_bucket
        if ab_metadata is not None:
            payload["ab_metadata"] = ab_metadata
        if rendered_price is not None:
            payload["rendered_price"] = safe_parse_numeric(rendered_price)
        if rendered_currency is not None:
            payload["rendered_currency"] = _normalize_currency(rendered_currency)
        if status == "COMPLETED":
            payload["completed_at"] = _utc_now_iso()

        try:
            resp = self.session.post(
                self._rest_url("render_versions"),
                headers=self._headers(prefer="return=representation"),
                json=payload,
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if (isinstance(rows, list) and rows) else (rows if isinstance(rows, dict) else payload)
            logger.error("create_render_version failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in create_render_version: %s", exc)
        return None

    def update_render_version(
        self,
        render_version_id: str,
        fields: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """Updates fields on an existing public.render_versions row by UUID."""
        if not self.enabled or not render_version_id or not fields:
            return None

        patch_data = dict(fields)
        if patch_data.get("status") == "COMPLETED" and "completed_at" not in patch_data:
            patch_data["completed_at"] = _utc_now_iso()

        try:
            resp = self.session.patch(
                self._rest_url("render_versions"),
                headers=self._headers(prefer="return=representation"),
                params={"id": f"eq.{render_version_id}"},
                json=patch_data,
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("update_render_version failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in update_render_version: %s", exc)
        return None

    def mark_previous_versions_superseded(
        self,
        listing_id: str,
        keep_version_num: int,
    ) -> bool:
        """Marks all prior COMPLETED render_versions (< keep_version_num) as SUPERSEDED."""
        if not self.enabled or not listing_id:
            return False
        try:
            resp = self.session.patch(
                self._rest_url("render_versions"),
                headers=self._headers(prefer="return=minimal"),
                params={
                    "listing_id": f"eq.{listing_id}",
                    "version_num": f"lt.{int(keep_version_num)}",
                    "status": "eq.COMPLETED",
                },
                json={"status": "SUPERSEDED"},
                timeout=self.timeout,
            )
            if resp.status_code in (200, 204):
                return True
            logger.error(
                "mark_previous_versions_superseded failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in mark_previous_versions_superseded: %s", exc)
        return False

    # ------------------------------------------------------------------
    # Follow-Up Tasks (e.g. DUPLICATE_REVIEW / OWNER_OUTREACH)
    # ------------------------------------------------------------------

    def create_follow_up_task(
        self,
        entity_type: str,
        title: str,
        due_at: Optional[str] = None,
        *,
        priority: str = "NORMAL",
        lead_id: Optional[str] = None,
        listing_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Inserts a task into public.follow_up_tasks."""
        if not self.enabled or not entity_type or not title:
            return None

        payload: Dict[str, Any] = {
            "entity_type": entity_type,
            "lead_id": lead_id,
            "listing_id": listing_id,
            "title": title.strip(),
            "due_at": due_at or _utc_now_iso(),
            "priority": priority,
            "status": "OPEN",
        }
        try:
            resp = self.session.post(
                self._rest_url("follow_up_tasks"),
                headers=self._headers(prefer="return=representation"),
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else payload
            logger.error("create_follow_up_task failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in create_follow_up_task: %s", exc)
        return None

    def create_sold_listing_lead_alerts(
        self,
        listing_id: str,
        bina_id: str,
    ) -> List[Dict[str, Any]]:
        """
        Queries public.lead_listings joined with open public.buyer_leads
        (stage NOT IN ('WON_CLOSED', 'LOST', 'COLD')) for a sold/removed listing,
        and creates a HIGH priority follow_up_tasks alert (due_at = NOW()) for
        each open linked buyer lead.
        """
        if not self.enabled or not listing_id:
            return []

        clean_listing_id = str(listing_id).strip()
        clean_bina_id = str(bina_id or "").strip() or clean_listing_id

        try:
            resp = self.session.get(
                self._rest_url("lead_listings"),
                headers=self._headers(),
                params={
                    "select": "lead_id,buyer_leads!inner(id,client_name,stage)",
                    "listing_id": f"eq.{clean_listing_id}",
                    "buyer_leads.stage": "not.in.(WON_CLOSED,LOST,COLD)",
                },
                timeout=self.timeout,
            )
            if resp.status_code != 200:
                logger.error(
                    "create_sold_listing_lead_alerts query failed (%s): %s",
                    resp.status_code,
                    resp.text[:300],
                )
                return []
            rows = resp.json() or []
        except Exception as exc:
            logger.error("Exception querying open leads for sold listing %s: %s", clean_listing_id, exc)
            return []

        created: List[Dict[str, Any]] = []
        seen_lead_ids: set[str] = set()
        now_iso = _utc_now_iso()

        for row in rows:
            lead_obj = row.get("buyer_leads")
            if isinstance(lead_obj, list):
                lead_obj = lead_obj[0] if lead_obj else None
            if not isinstance(lead_obj, dict):
                continue

            stage = str(lead_obj.get("stage") or "").strip().upper()
            if stage in CLOSED_LEAD_STAGES:
                continue

            lead_id = str(lead_obj.get("id") or row.get("lead_id") or "").strip()
            if not lead_id or lead_id in seen_lead_ids:
                continue
            seen_lead_ids.add(lead_id)

            client_name = str(lead_obj.get("client_name") or "Müştəri").strip()
            title = f"⚠️ #{clean_bina_id} satılıb — {client_name} üçün alternativ mənzil təklif et"
            task = self.create_follow_up_task(
                entity_type="BUYER_LEAD",
                title=title,
                due_at=now_iso,
                priority="HIGH",
                lead_id=lead_id,
                listing_id=clean_listing_id,
            )
            if task:
                created.append(task)

        return created

    # ------------------------------------------------------------------
    # Social Publications, Telemetry, and Inbound Lead Pipeline
    # ------------------------------------------------------------------

    def get_publication_by_id(self, publication_id: str) -> Optional[Dict[str, Any]]:
        """Queries a publication record from public.publications by UUID."""
        if not self.enabled or not publication_id:
            return None
        try:
            resp = self.session.get(
                self._rest_url("publications"),
                headers=self._headers(),
                params={"id": f"eq.{str(publication_id).strip()}", "select": "*", "limit": "1"},
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("get_publication_by_id failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_publication_by_id: %s", exc)
        return None

    def create_or_update_publication(
        self,
        listing_id: str,
        status: str = "DRAFT_READY",
        *,
        channel: str = "INSTAGRAM_REELS",
        render_version_id: Optional[str] = None,
        post_url: Optional[str] = None,
        caption_used: Optional[str] = None,
        published_at: Optional[str] = None,
        notes: Optional[str] = None,
        external_post_id: Optional[str] = None,
        telemetry_status: Optional[str] = None,
        next_poll_at: Optional[str] = None,
        publication_id: Optional[str] = None,
        preflight_status: Optional[str] = None,
        target_account_handle: Optional[str] = None,
        channel_niche: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Creates or updates a publication record in public.publications,
        supporting both DRAFT_READY and PUBLISHED states, as well as
        multi-account distribution and channel niches.
        """
        if not self.enabled or not listing_id:
            return None

        clean_listing_id = str(listing_id).strip()
        clean_status = str(status).strip().upper()
        clean_channel = str(channel).strip().upper()

        existing_row = None
        if publication_id:
            existing_row = self.get_publication_by_id(publication_id)
        else:
            try:
                query_params: Dict[str, str] = {
                    "listing_id": f"eq.{clean_listing_id}",
                    "select": "*",
                    "order": "created_at.desc",
                    "limit": "1",
                }
                if target_account_handle:
                    query_params["target_account_handle"] = f"eq.{str(target_account_handle).strip()}"
                else:
                    query_params["channel"] = f"eq.{clean_channel}"

                resp = self.session.get(
                    self._rest_url("publications"),
                    headers=self._headers(),
                    params=query_params,
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    rows = resp.json() or []
                    if rows:
                        existing_row = rows[0]
            except Exception as exc:
                logger.error("Exception checking existing publication: %s", exc)

        if existing_row:
            target_id = existing_row.get("id")
            patch_data: Dict[str, Any] = {
                "status": clean_status,
            }
            if target_account_handle is not None:
                patch_data["target_account_handle"] = str(target_account_handle).strip()
            if channel_niche is not None:
                patch_data["channel_niche"] = str(channel_niche).strip().upper()
            if preflight_status is not None:
                patch_data["preflight_status"] = str(preflight_status).strip().upper()
            if render_version_id is not None:
                patch_data["render_version_id"] = str(render_version_id).strip() if render_version_id else None
            if post_url is not None:
                patch_data["post_url"] = str(post_url).strip() if post_url else None
            if caption_used is not None:
                patch_data["caption_used"] = caption_used
            if notes is not None:
                patch_data["notes"] = notes
            if external_post_id is not None:
                patch_data["external_post_id"] = external_post_id

            if clean_status == "PUBLISHED":
                pub_time = published_at or existing_row.get("published_at") or _utc_now_iso()
                patch_data["published_at"] = pub_time
                patch_data["telemetry_status"] = telemetry_status or existing_row.get("telemetry_status") or "ACTIVE"
                if next_poll_at is not None:
                    patch_data["next_poll_at"] = next_poll_at
                elif not existing_row.get("next_poll_at"):
                    from datetime import timedelta
                    patch_data["next_poll_at"] = (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat()
            else:
                if telemetry_status is not None:
                    patch_data["telemetry_status"] = telemetry_status
                elif "telemetry_status" not in existing_row or existing_row.get("telemetry_status") == "ACTIVE":
                    patch_data["telemetry_status"] = "PENDING"
                if next_poll_at is not None:
                    patch_data["next_poll_at"] = next_poll_at

            try:
                resp = self.session.patch(
                    self._rest_url("publications"),
                    headers=self._headers(prefer="return=representation"),
                    params={"id": f"eq.{target_id}"},
                    json=patch_data,
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    rows = resp.json() or []
                    return rows[0] if rows else dict(existing_row, **patch_data)
                logger.error("Failed to patch publication (%s): %s", resp.status_code, resp.text[:300])
            except Exception as exc:
                logger.error("Exception updating publication: %s", exc)
            return None

        # Create new publication row
        payload: Dict[str, Any] = {
            "listing_id": clean_listing_id,
            "channel": clean_channel,
            "target_account_handle": (
                str(target_account_handle).strip()
                if target_account_handle
                else "@bakuestate.official"
            ),
            "channel_niche": (
                str(channel_niche).strip().upper()
                if channel_niche
                else "GENERAL"
            ),
            "status": clean_status,
            "preflight_status": (
                str(preflight_status).strip().upper()
                if preflight_status is not None
                else "UNCHECKED"
            ),
            "render_version_id": str(render_version_id).strip() if render_version_id else None,
            "post_url": str(post_url).strip() if post_url else None,
            "caption_used": caption_used,
            "notes": notes,
            "external_post_id": external_post_id,
        }
        if clean_status == "PUBLISHED":
            from datetime import timedelta
            payload["published_at"] = published_at or _utc_now_iso()
            payload["telemetry_status"] = telemetry_status or "ACTIVE"
            payload["next_poll_at"] = next_poll_at or (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat()
        else:
            payload["telemetry_status"] = telemetry_status or "PENDING"
            payload["next_poll_at"] = next_poll_at

        try:
            resp = self.session.post(
                self._rest_url("publications"),
                headers=self._headers(prefer="return=representation"),
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else payload
            logger.error("Failed to insert publication (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception inserting publication: %s", exc)
        return None

    def update_preflight_status(
        self,
        publication_id: str,
        status: str,
        error: Optional[str] = None,
        telegram_msg_id: Optional[Union[int, str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Updates preflight verification status and timestamps on a publication record.
        Status should be one of ('UNCHECKED', 'PASSED', 'PRICE_MISMATCH', 'REMOVED_ON_BINA')
        or publication state ('READY_TO_PUBLISH').
        """
        if not self.enabled or not publication_id:
            return None

        clean_pub_id = str(publication_id).strip()
        clean_status = str(status).strip().upper()

        patch_data: Dict[str, Any] = {}
        if clean_status in ("UNCHECKED", "PASSED", "PRICE_MISMATCH", "REMOVED_ON_BINA"):
            patch_data["preflight_status"] = clean_status
            if clean_status == "PASSED":
                patch_data["status"] = "READY_TO_PUBLISH"
                patch_data["verified_at"] = _utc_now_iso()
        elif clean_status == "READY_TO_PUBLISH":
            patch_data["status"] = "READY_TO_PUBLISH"
            patch_data["preflight_status"] = "PASSED"
            patch_data["verified_at"] = _utc_now_iso()
        else:
            patch_data["preflight_status"] = clean_status

        if error is not None:
            patch_data["last_preflight_error"] = str(error)

        if telegram_msg_id is not None:
            try:
                patch_data["telegram_message_id"] = int(telegram_msg_id)
            except (ValueError, TypeError):
                patch_data["telegram_message_id"] = None
            patch_data["telegram_dispatched_at"] = _utc_now_iso()

        try:
            resp = self.session.patch(
                self._rest_url("publications"),
                headers=self._headers(prefer="return=representation"),
                params={"id": f"eq.{clean_pub_id}"},
                json=patch_data,
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else patch_data
            logger.error("update_preflight_status failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in update_preflight_status: %s", exc)
        return None

    def log_preflight_check(
        self,
        listing_id: str,
        bina_id: Union[int, str],
        result: str,
        portal_price: Optional[float] = None,
        video_price: Optional[float] = None,
        price_delta_pct: Optional[float] = None,
        response_time_ms: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Inserts an audit log entry into public.preflight_checks.
        Result must be one of: ('PASSED', 'PRICE_CHANGED', 'REMOVED_ON_BINA', 'SCRAPE_ERROR')
        """
        if not self.enabled or not listing_id:
            return None

        clean_listing_id = str(listing_id).strip()
        try:
            clean_bina_id = int(str(bina_id).strip())
        except (ValueError, TypeError):
            clean_bina_id = 0

        clean_result = str(result).strip().upper()
        payload: Dict[str, Any] = {
            "listing_id": clean_listing_id,
            "bina_id": clean_bina_id,
            "result": clean_result,
            "portal_price": safe_parse_numeric(portal_price) if portal_price is not None else None,
            "video_price": safe_parse_numeric(video_price) if video_price is not None else None,
            "price_delta_pct": float(price_delta_pct) if price_delta_pct is not None else None,
            "response_time_ms": int(response_time_ms) if response_time_ms is not None else None,
            "checked_at": _utc_now_iso(),
        }

        try:
            resp = self.session.post(
                self._rest_url("preflight_checks"),
                headers=self._headers(prefer="return=representation"),
                json=payload,
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if (isinstance(rows, list) and rows) else (rows if isinstance(rows, dict) else payload)
            logger.error("log_preflight_check failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in log_preflight_check: %s", exc)
        return None

    def get_active_telemetry_publications(
        self,
        now: Optional[datetime] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """
        Queries publications where status='PUBLISHED' AND telemetry_status='ACTIVE'
        AND next_poll_at <= NOW() AND post_url IS NOT NULL.
        """
        if not self.enabled:
            return []
        current_iso = (now or datetime.now(timezone.utc)).isoformat()
        try:
            resp = self.session.get(
                self._rest_url("publications"),
                headers=self._headers(),
                params={
                    "status": "eq.PUBLISHED",
                    "telemetry_status": "eq.ACTIVE",
                    "next_poll_at": f"lte.{current_iso}",
                    "post_url": "not.is.null",
                    "order": "next_poll_at.asc",
                    "limit": str(max(1, limit)),
                    "select": "*",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                return resp.json() or []
            logger.error("get_active_telemetry_publications failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_active_telemetry_publications: %s", exc)
        return []

    def update_publication_telemetry(
        self,
        publication_id: str,
        views: int,
        likes: int,
        comments: int,
        poll_count: int,
        next_poll_at: Optional[str],
        telemetry_status: str = "ACTIVE",
        error_info: Optional[str] = None,
        *,
        shares: int = 0,
        scrape_error_count: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Updates public.publications with scraped metrics, poll count, next_poll_at,
        telemetry status ('ACTIVE', 'FROZEN', 'ERROR'), and optional scrape error details.
        """
        if not self.enabled or not publication_id:
            return None

        clean_id = str(publication_id).strip()
        patch_data: Dict[str, Any] = {
            "views_count": max(0, int(views)),
            "likes_count": max(0, int(likes)),
            "comments_count": max(0, int(comments)),
            "shares_count": max(0, int(shares)),
            "poll_count": max(0, int(poll_count)),
            "telemetry_status": telemetry_status,
            "last_scraped_at": _utc_now_iso(),
            "next_poll_at": next_poll_at,
        }
        if error_info is not None:
            patch_data["last_scrape_error"] = str(error_info)
            if scrape_error_count is not None:
                patch_data["scrape_error_count"] = max(0, int(scrape_error_count))
        else:
            patch_data["last_scrape_error"] = None
            patch_data["scrape_error_count"] = 0

        try:
            resp = self.session.patch(
                self._rest_url("publications"),
                headers=self._headers(prefer="return=representation"),
                params={"id": f"eq.{clean_id}"},
                json=patch_data,
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else patch_data
            logger.error("update_publication_telemetry failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in update_publication_telemetry: %s", exc)
        return None

    def record_telemetry_snapshot(
        self,
        publication_id: str,
        phase: str,
        views: int,
        likes: int,
        comments: int,
        ner_score: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Records a telemetry milestone snapshot in public.publication_telemetry_snapshots.
        """
        if not self.enabled or not publication_id or not phase:
            return None

        payload: Dict[str, Any] = {
            "publication_id": str(publication_id).strip(),
            "snapshot_phase": str(phase).strip(),
            "views_count": max(0, int(views)),
            "likes_count": max(0, int(likes)),
            "comments_count": max(0, int(comments)),
            "ner_score": float(ner_score) if ner_score is not None else None,
            "captured_at": _utc_now_iso(),
        }
        try:
            resp = self.session.post(
                self._rest_url("publication_telemetry_snapshots"),
                headers=self._headers(prefer="return=representation"),
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else payload
            logger.error("record_telemetry_snapshot failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in record_telemetry_snapshot: %s", exc)
        return None

    def upsert_social_comment(
        self,
        publication_id: str,
        platform_comment_id: str,
        author_handle: str,
        comment_text: str,
        is_intent_lead: bool,
        intent_category: Optional[str],
        suggested_reply: Optional[str],
        buyer_lead_id: Optional[str] = None,
        *,
        like_count: int = 0,
        intent_confidence: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Idempotently upserts a comment row in public.social_comments
        constrained on (publication_id, platform_comment_id).
        """
        if not self.enabled or not publication_id or not platform_comment_id:
            return None

        payload: Dict[str, Any] = {
            "publication_id": str(publication_id).strip(),
            "platform_comment_id": str(platform_comment_id).strip(),
            "author_handle": str(author_handle).strip(),
            "comment_text": str(comment_text or ""),
            "like_count": max(0, int(like_count)),
            "is_intent_lead": bool(is_intent_lead),
            "intent_category": intent_category,
            "intent_confidence": float(intent_confidence) if intent_confidence is not None else None,
            "suggested_reply": suggested_reply,
            "buyer_lead_id": str(buyer_lead_id).strip() if buyer_lead_id else None,
        }
        try:
            resp = self.session.post(
                self._rest_url("social_comments"),
                headers=self._headers(prefer="resolution=merge-duplicates,return=representation"),
                params={"on_conflict": "publication_id,platform_comment_id"},
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else payload
            logger.error("upsert_social_comment failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in upsert_social_comment: %s", exc)
        return None

    def create_social_buyer_lead(
        self,
        author_handle: str,
        listing_id: Optional[str],
        suggested_reply: Optional[str] = None,
        platform: str = "INSTAGRAM",
    ) -> Optional[Dict[str, Any]]:
        """
        Converts an inbound qualified social inquiry into a CRM buyer lead:
        1. Inserts into public.buyer_leads with client_name=author_handle,
           source_channel='IG_DM' (or 'TIKTOK_DM'), social_handle=author_handle.
        2. Links public.lead_listings with relation='INQUIRED'.
        3. Inserts public.follow_up_tasks with priority='HIGH', due_at=NOW() + INTERVAL '30 minutes',
           entity_type='BUYER_LEAD'.
        """
        if not self.enabled or not author_handle:
            return None

        from datetime import timedelta

        clean_handle = str(author_handle).strip()
        channel = "TIKTOK_DM" if str(platform).upper() in ("TIKTOK", "TIKTOK_DM") else "IG_DM"
        clean_listing_id = str(listing_id).strip() if listing_id else None

        # Check if an existing buyer lead already exists for this handle + source_channel (idempotency)
        lead_id = None
        lead_row = None
        try:
            resp = self.session.get(
                self._rest_url("buyer_leads"),
                headers=self._headers(),
                params={
                    "social_handle": f"eq.{clean_handle}",
                    "source_channel": f"eq.{channel}",
                    "select": "id,client_name,stage",
                    "order": "created_at.desc",
                    "limit": "1",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                if rows:
                    lead_row = rows[0]
                    lead_id = lead_row.get("id")
        except Exception as exc:
            logger.error("Exception checking existing buyer lead for %s: %s", clean_handle, exc)

        if not lead_id:
            lead_payload = {
                "client_name": clean_handle,
                "social_handle": clean_handle,
                "source_channel": channel,
                "stage": "NEW_INQUIRY",
                "notes": f"Sosial şəbəkə sorğusu ({channel}): {suggested_reply}" if suggested_reply else None,
            }
            try:
                resp = self.session.post(
                    self._rest_url("buyer_leads"),
                    headers=self._headers(prefer="return=representation"),
                    json=[lead_payload],
                    timeout=self.timeout,
                )
                if resp.status_code in (200, 201):
                    rows = resp.json() or []
                    lead_row = rows[0] if rows else lead_payload
                    lead_id = lead_row.get("id")
                else:
                    logger.error("Failed to insert buyer_lead (%s): %s", resp.status_code, resp.text[:300])
                    return None
            except Exception as exc:
                logger.error("Exception inserting buyer lead: %s", exc)
                return None

        # Link lead_listings
        if clean_listing_id and lead_id:
            link_payload = {
                "lead_id": str(lead_id).strip(),
                "listing_id": clean_listing_id,
                "relation": "INQUIRED",
                "notes": suggested_reply,
            }
            try:
                self.session.post(
                    self._rest_url("lead_listings"),
                    headers=self._headers(prefer="resolution=merge-duplicates,return=representation"),
                    params={"on_conflict": "lead_id,listing_id"},
                    json=[link_payload],
                    timeout=self.timeout,
                )
            except Exception as exc:
                logger.error("Exception linking lead_listings: %s", exc)

        # Insert follow_up_tasks (30 minutes high priority)
        due_at = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        bina_str = f" #{clean_listing_id}" if clean_listing_id else ""
        task_title = f"📱 Sosial sorğu: {clean_handle}{bina_str} ilə əlaqə saxla"
        self.create_follow_up_task(
            entity_type="BUYER_LEAD",
            title=task_title,
            due_at=due_at,
            priority="HIGH",
            lead_id=str(lead_id).strip() if lead_id else None,
            listing_id=clean_listing_id,
        )

        return lead_row

    def trip_social_circuit_breaker(self, backoff_hours: int = 4) -> int:
        """
        Sets next_poll_at = NOW() + backoff_hours for all active published publications.
        Returns the number of updated publications.
        """
        if not self.enabled:
            return 0
        from datetime import timedelta
        new_next_poll = (datetime.now(timezone.utc) + timedelta(hours=backoff_hours)).isoformat()
        try:
            resp = self.session.patch(
                self._rest_url("publications"),
                headers=self._headers(prefer="return=representation"),
                params={"status": "eq.PUBLISHED", "telemetry_status": "eq.ACTIVE"},
                json={"next_poll_at": new_next_poll},
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return len(rows)
            logger.error("trip_social_circuit_breaker failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in trip_social_circuit_breaker: %s", exc)
        return 0

    # ------------------------------------------------------------------
    # Pipeline Job Queue & Worker RPCs
    # ------------------------------------------------------------------

    def enqueue_pipeline_job(
        self,
        idempotency_key: str,
        job_type: str,
        *,
        listing_id: Optional[str] = None,
        trigger_source: str = "AUTO_SCHEDULER",
        params_json: Optional[Dict[str, Any]] = None,
        expires_at: Optional[str] = None,
        max_attempts: int = 2,
    ) -> Optional[Dict[str, Any]]:
        """
        Idempotently enqueues a job into public.pipeline_jobs.
        Duplicate idempotency_keys are ignored without error (returns None if already existed).
        """
        if not self.enabled or not idempotency_key or not job_type:
            return None

        payload: Dict[str, Any] = {
            "idempotency_key": idempotency_key.strip(),
            "job_type": job_type,
            "listing_id": listing_id,
            "trigger_source": trigger_source,
            "params_json": params_json or {},
            "status": "QUEUED",
            "max_attempts": max(1, int(max_attempts)),
            "expires_at": expires_at,
        }
        try:
            resp = self.session.post(
                self._rest_url("pipeline_jobs"),
                headers=self._headers(prefer="return=representation"),
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else None
            if resp.status_code == 409:
                logger.info(
                    "enqueue_pipeline_job idempotent duplicate skipped (key=%s, type=%s)",
                    payload["idempotency_key"],
                    job_type,
                )
                return None
            logger.error("enqueue_pipeline_job failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in enqueue_pipeline_job: %s", exc)
        return None

    def claim_next_pipeline_job(
        self,
        worker_id: str = WORKER_ID,
        lease_minutes: int = 5,
    ) -> Optional[Dict[str, Any]]:
        """
        Calls public.claim_next_pipeline_job(p_worker_id, p_lease_minutes) RPC.
        Expires stale AUTO jobs, recovers timed-out leases, claims 1 job via FOR UPDATE SKIP LOCKED.
        """
        if not self.enabled:
            return None
        try:
            resp = self.session.post(
                self._rpc_url("claim_next_pipeline_job"),
                headers=self._headers(),
                json={
                    "p_worker_id": worker_id,
                    "p_lease_minutes": max(1, int(lease_minutes)),
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list):
                    return data[0] if data else None
                if isinstance(data, dict) and data.get("id"):
                    return data
                return None
            logger.error("claim_next_pipeline_job RPC failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in claim_next_pipeline_job: %s", exc)
        return None

    def heartbeat_pipeline_job(
        self,
        job_id: str,
        worker_id: str = WORKER_ID,
        lease_minutes: int = 5,
    ) -> bool:
        """Calls public.heartbeat_pipeline_job(p_job_id, p_worker_id, p_lease_minutes) RPC."""
        if not self.enabled or not job_id:
            return False
        try:
            resp = self.session.post(
                self._rpc_url("heartbeat_pipeline_job"),
                headers=self._headers(),
                json={
                    "p_job_id": job_id,
                    "p_worker_id": worker_id,
                    "p_lease_minutes": max(1, int(lease_minutes)),
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                return bool(resp.json())
            logger.error("heartbeat_pipeline_job RPC failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in heartbeat_pipeline_job: %s", exc)
        return False

    def complete_pipeline_job(
        self,
        job_id: str,
        status: str = "SUCCEEDED",
        error_message: Optional[str] = None,
        worker_id: Optional[str] = None,
    ) -> Any:
        """
        Completes (or transiently requeues) a claimed pipeline_job and releases its lease.
        - When `worker_id` is passed: calls fenced RPC
          `complete_pipeline_job(p_job_id, p_worker_id, p_status, p_error_message)`
          returning bool (falls back to filtered PATCH
          `id=eq.<id>&locked_by=eq.<worker_id>&status=eq.RUNNING` if RPC returns 404).
        - When `worker_id` is None: preserves backward-compatible unfiltered PATCH
          returning the updated row dict or None.
        """
        clean_worker_id = str(worker_id).strip() if worker_id is not None and str(worker_id).strip() else None
        if not self.enabled or not job_id:
            return False if clean_worker_id else None

        norm_status = str(status or "SUCCEEDED").strip().upper()
        truncated_error = str(error_message)[:2000] if error_message is not None else None

        patch_data: Dict[str, Any] = {
            "status": norm_status,
            "locked_by": None,
            "lease_expires_at": None,
        }
        if norm_status != "QUEUED":
            patch_data["finished_at"] = _utc_now_iso()
        if truncated_error is not None:
            patch_data["error_message"] = truncated_error
        elif norm_status == "SUCCEEDED":
            patch_data["error_message"] = None

        if clean_worker_id:
            try:
                resp = self.session.post(
                    self._rpc_url("complete_pipeline_job"),
                    headers=self._headers(),
                    json={
                        "p_job_id": job_id,
                        "p_worker_id": clean_worker_id,
                        "p_status": norm_status,
                        "p_error_message": truncated_error,
                    },
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    return bool(resp.json())
                if resp.status_code == 404:
                    logger.info(
                        "complete_pipeline_job RPC returned 404; falling back to fenced PATCH for job %s.",
                        job_id,
                    )
                    patch_resp = self.session.patch(
                        self._rest_url("pipeline_jobs"),
                        headers=self._headers(prefer="return=representation"),
                        params={
                            "id": f"eq.{job_id}",
                            "locked_by": f"eq.{clean_worker_id}",
                            "status": "eq.RUNNING",
                        },
                        json=patch_data,
                        timeout=self.timeout,
                    )
                    if patch_resp.status_code == 200:
                        rows = patch_resp.json() or []
                        return bool(rows)
                    logger.error(
                        "complete_pipeline_job fenced PATCH fallback failed (%s): %s",
                        patch_resp.status_code,
                        patch_resp.text[:300],
                    )
                    return False
                logger.error(
                    "complete_pipeline_job RPC failed (%s): %s",
                    resp.status_code,
                    resp.text[:300],
                )
            except Exception as exc:
                logger.error("Exception in fenced complete_pipeline_job: %s", exc)
            return False

        try:
            resp = self.session.patch(
                self._rest_url("pipeline_jobs"),
                headers=self._headers(prefer="return=representation"),
                params={"id": f"eq.{job_id}"},
                json=patch_data,
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("complete_pipeline_job failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in complete_pipeline_job: %s", exc)
        return None

    def is_job_cancel_requested(self, job_id: str) -> bool:
        """Checks if a pipeline_job has cancel_requested_at set or status='CANCELLED'."""
        if not self.enabled or not job_id:
            return False
        try:
            resp = self.session.get(
                self._rest_url("pipeline_jobs"),
                headers=self._headers(),
                params={
                    "id": f"eq.{str(job_id).strip()}",
                    "select": "id,status,cancel_requested_at",
                    "limit": "1",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                if not rows:
                    return False
                row = rows[0]
                return (
                    bool(row.get("cancel_requested_at"))
                    or str(row.get("status") or "").strip().upper() == "CANCELLED"
                )
            logger.error("is_job_cancel_requested failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in is_job_cancel_requested: %s", exc)
        return False

    def count_today_auto_renders_baku(self) -> int:
        """Calls public.count_today_auto_renders_baku() RPC to enforce daily Rejim 3 cap."""
        if not self.enabled:
            return 0
        try:
            resp = self.session.post(
                self._rpc_url("count_today_auto_renders_baku"),
                headers=self._headers(),
                json={},
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                data = resp.json()
                return int(data) if data is not None else 0
            logger.error(
                "count_today_auto_renders_baku RPC failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in count_today_auto_renders_baku: %s", exc)
        return 0

    def record_worker_heartbeat(
        self,
        worker_id: str = WORKER_ID,
        current_job_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        """Calls public.record_worker_heartbeat(p_worker_id, p_current_job_id, p_metadata) RPC."""
        if not self.enabled:
            return None
        try:
            resp = self.session.post(
                self._rpc_url("record_worker_heartbeat"),
                headers=self._headers(),
                json={
                    "p_worker_id": worker_id,
                    "p_current_job_id": current_job_id,
                    "p_metadata": metadata or {},
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                val = resp.json()
                return str(val) if val is not None else None
            logger.error(
                "record_worker_heartbeat RPC failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in record_worker_heartbeat: %s", exc)
        return None

    def get_worker_heartbeat(self, worker_id: str = WORKER_ID) -> Optional[Dict[str, Any]]:
        """Queries public.worker_heartbeats for worker telemetry."""
        if not self.enabled or not worker_id:
            return None
        try:
            resp = self.session.get(
                self._rest_url("worker_heartbeats"),
                headers=self._headers(),
                params={
                    "worker_id": f"eq.{worker_id}",
                    "select": "worker_id,last_seen_at,current_job_id,metadata_json",
                    "limit": "1",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("get_worker_heartbeat failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_worker_heartbeat: %s", exc)
        return None

    def get_running_job_for_worker(self, worker_id: str = WORKER_ID) -> Optional[Dict[str, Any]]:
        """Queries public.pipeline_jobs for active RUNNING job locked by worker_id."""
        if not self.enabled or not worker_id:
            return None
        try:
            resp = self.session.get(
                self._rest_url("pipeline_jobs"),
                headers=self._headers(),
                params={
                    "locked_by": f"eq.{worker_id}",
                    "status": "eq.RUNNING",
                    "order": "created_at.desc",
                    "limit": "1",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else None
            logger.error("get_running_job_for_worker failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_running_job_for_worker: %s", exc)
        return None

    def get_unrendered_listings(self, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Fetches listings where pipeline_status IN ('NEW', 'QUEUED').
        """
        if not self.enabled:
            return []
        try:
            resp = self.session.get(
                self._rest_url("listings"),
                headers=self._headers(),
                params={
                    "select": "id,bina_id,title,pipeline_status,content_revision,created_at",
                    "pipeline_status": "in.(NEW,QUEUED)",
                    "order": "created_at.asc",
                    "limit": str(max(1, int(limit))),
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                return resp.json() or []
            logger.error("get_unrendered_listings failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in get_unrendered_listings: %s", exc)
        return []

    def get_unrendered_backlog_listings(self, limit: int = 20) -> List[Dict[str, Any]]:
        """
        Fetches active, non-duplicate listings that have no COMPLETED render_version
        and no active QUEUED/RUNNING pipeline_job so the worker clears its video backlog
        before scraping ordinary new listings.
        """
        if not self.enabled:
            return []
        try:
            fetch_limit = max(1, int(limit)) * 2
            resp = self.session.get(
                self._rest_url("listings"),
                headers=self._headers(),
                params={
                    "select": "id,bina_id,title,pipeline_status,editorial_status,content_revision,created_at",
                    "source_availability": "eq.ACTIVE",
                    "duplicate_resolution": "in.(NONE,FALSE_POSITIVE)",
                    "pipeline_status": "in.(NEW,FAILED)",
                    "editorial_status": "not.in.(ARCHIVED,REJECTED,PUBLISHED)",
                    "order": "created_at.asc",
                    "limit": str(fetch_limit),
                },
                timeout=self.timeout,
            )
            if resp.status_code != 200:
                logger.error(
                    "get_unrendered_backlog_listings failed (%s): %s",
                    resp.status_code,
                    resp.text[:300],
                )
                return []

            candidates = resp.json() or []
            backlog: List[Dict[str, Any]] = []
            for row in candidates:
                lid = str(row.get("id") or "").strip()
                if not lid:
                    continue
                latest = self.get_latest_render_version(lid)
                if latest and str(latest.get("status") or "").upper() == "COMPLETED":
                    continue
                if self.has_active_pipeline_job(lid):
                    continue
                backlog.append(row)
                if len(backlog) >= max(1, int(limit)):
                    break
            return backlog
        except Exception as exc:
            logger.error("Exception in get_unrendered_backlog_listings: %s", exc)
        return []

    def has_active_pipeline_job(self, listing_id: str) -> bool:
        """Checks if a QUEUED or RUNNING pipeline job already exists for listing_id."""
        if not self.enabled or not listing_id:
            return False
        try:
            resp = self.session.get(
                self._rest_url("pipeline_jobs"),
                headers=self._headers(),
                params={
                    "listing_id": f"eq.{listing_id}",
                    "status": "in.(QUEUED,RUNNING)",
                    "select": "id,job_type,status",
                    "limit": "1",
                },
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return bool(rows)
        except Exception as exc:
            logger.error("Exception in has_active_pipeline_job: %s", exc)
        return False

    # ------------------------------------------------------------------
    # Cockpit Cards & Lead Timeline Events (AI Advisor & Sales Squad)
    # ------------------------------------------------------------------

    def get_default_operator_uid(self) -> Optional[str]:
        """
        Resolves default CRM operator user UUID from environment or baku_estate_config.
        Fail-closed: returns None when unconfigured (zero hardcoded fallback UUIDs).
        """
        cached = getattr(self, "_cached_operator_uid", None)
        if cached:
            return cached
        env_uid = os.getenv("CRM_OPERATOR_UID") or os.getenv("OPERATOR_UID")
        if env_uid and _is_valid_uuid(env_uid):
            self._cached_operator_uid = env_uid.strip()
            return self._cached_operator_uid
        if self.enabled:
            try:
                resp = self.session.get(
                    self._rest_url("baku_estate_config"),
                    headers=self._headers(),
                    params={"key": "eq.operator_uid", "select": "value", "limit": "1"},
                    timeout=self.timeout,
                )
                if resp.status_code == 200:
                    rows = resp.json() or []
                    if rows and rows[0].get("value") and _is_valid_uuid(rows[0]["value"]):
                        self._cached_operator_uid = rows[0]["value"].strip()
                        return self._cached_operator_uid
            except Exception as exc:
                logger.debug("Failed to query operator_uid config: %s", exc)
        return None

    def append_lead_timeline_event(
        self,
        lead_id: Optional[str] = None,
        listing_id: Optional[str] = None,
        actor: str = "OPERATOR",
        event_type: str = "INQUIRY",
        summary: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Appends an immutable event to public.lead_timeline_events.
        Validates actors and event types, safely linking to buyer_leads and listings.
        """
        if not self.enabled:
            logger.debug("append_lead_timeline_event skipped (cloud repo disabled)")
            return None

        clean_actor = str(actor).strip().upper() if actor else "OPERATOR"
        valid_actors = {
            "OPERATOR",
            "BUYER",
            "SELLER",
            "AI_SENTINEL",
            "AI_SCRIBE",
            "AI_STRATEGIST",
            "AI_JANITOR",
        }
        if clean_actor not in valid_actors:
            clean_actor = "OPERATOR"

        clean_event_type = str(event_type).strip().upper() if event_type else "INQUIRY"
        valid_events = {
            "INQUIRY",
            "OBJECTION",
            "CALL_LOG",
            "OFFER",
            "COMMISSION_AGREED",
            "SHOWING_SCHEDULED",
            "DEAL_CLOSED",
            "DEAL_LOST",
        }
        if clean_event_type not in valid_events:
            clean_event_type = "INQUIRY"

        clean_summary = str(summary or "").strip()
        payload_metadata: Dict[str, Any] = dict(metadata or {})

        # Resolve lead_id
        resolved_lead_id: Optional[str] = None
        if lead_id:
            s_lead = str(lead_id).strip()
            if _is_valid_uuid(s_lead):
                resolved_lead_id = s_lead
            else:
                payload_metadata.setdefault("raw_lead_id", s_lead)

        # Resolve listing_id
        resolved_listing_id: Optional[str] = None
        if listing_id:
            s_list = str(listing_id).strip()
            if _is_valid_uuid(s_list):
                resolved_listing_id = s_list
            else:
                # Try bina_id resolution
                lst = self.get_listing_by_bina_id(s_list)
                if lst and lst.get("id"):
                    resolved_listing_id = lst["id"]
                else:
                    payload_metadata.setdefault("raw_listing_id", s_list)

        payload: Dict[str, Any] = {
            "actor": clean_actor,
            "event_type": clean_event_type,
            "summary": clean_summary,
            "metadata": payload_metadata,
        }
        if resolved_lead_id:
            payload["lead_id"] = resolved_lead_id
        if resolved_listing_id:
            payload["listing_id"] = resolved_listing_id

        try:
            resp = self.session.post(
                self._rest_url("lead_timeline_events"),
                headers=self._headers(prefer="return=representation"),
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else payload
            logger.error(
                "append_lead_timeline_event failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in append_lead_timeline_event: %s", exc)
        return None

    def queue_cockpit_card(
        self,
        lead_id: Optional[str] = None,
        listing_id: Optional[str] = None,
        channel: str = "WHATSAPP",
        priority: Any = "NORMAL",
        headline: str = "",
        draft_text: str = "",
        target_uri: Optional[str] = None,
        strategic_rationale: Optional[str] = None,
        owner_id: Optional[str] = None,
        *,
        agency_id: Optional[str] = None,
        assigned_agent_id: Optional[str] = None,
        reason: Optional[str] = None,
        sentinel_warning: Optional[str] = None,
        bina_id: Optional[Any] = None,
        buyer_lead_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Creates an actionable advisory card in public.cockpit_cards using the v2 uppercase schema.
        """
        if not self.enabled:
            logger.debug("queue_cockpit_card skipped (cloud repo disabled)")
            return None

        # Resolve lead_id
        actual_lead = lead_id or buyer_lead_id
        clean_lead_id = str(actual_lead).strip() if actual_lead and _is_valid_uuid(actual_lead) else None

        # Resolve listing_id and optional agency_id
        actual_listing = listing_id or bina_id
        clean_listing_id: Optional[str] = None
        resolved_agency_id: Optional[str] = (
            str(agency_id).strip() if agency_id and _is_valid_uuid(agency_id) else None
        )
        if actual_listing:
            s_lst = str(actual_listing).strip()
            if _is_valid_uuid(s_lst):
                clean_listing_id = s_lst
            else:
                lst = self.get_listing_by_bina_id(s_lst)
                if lst and lst.get("id"):
                    clean_listing_id = lst["id"]
                    if not resolved_agency_id and lst.get("agency_id") and _is_valid_uuid(lst["agency_id"]):
                        resolved_agency_id = str(lst["agency_id"]).strip()

        if not resolved_agency_id:
            env_agency = os.getenv("DEFAULT_AGENCY_ID") or os.getenv("AGENCY_ID")
            if env_agency and _is_valid_uuid(env_agency):
                resolved_agency_id = env_agency.strip()

        # Resolve assigned_agent_id
        candidate_agent = assigned_agent_id or owner_id or self.get_default_operator_uid()
        resolved_agent_id = (
            str(candidate_agent).strip()
            if candidate_agent and _is_valid_uuid(candidate_agent)
            else None
        )

        clean_channel = str(channel or "WHATSAPP").strip().upper()
        norm_priority = _normalize_card_priority(priority)
        clean_headline = str(headline or "Cockpit Task").strip()[:180]
        actual_reason = strategic_rationale or reason or clean_headline
        clean_reason = str(actual_reason).strip()[:500]
        clean_rationale = str(strategic_rationale or actual_reason).strip()[:500]
        clean_draft = str(draft_text or "").strip()[:2000]
        clean_warning = str(sentinel_warning or "").strip()[:500]
        clean_uri = str(target_uri).strip() if target_uri else None

        payload: Dict[str, Any] = {
            "channel": clean_channel,
            "priority": norm_priority,
            "headline": clean_headline,
            "reason": clean_reason,
            "strategic_rationale": clean_rationale,
            "draft_text": clean_draft or None,
            "sentinel_warning": clean_warning or None,
            "status": "PENDING",
        }
        if resolved_agency_id:
            payload["agency_id"] = resolved_agency_id
        if resolved_agent_id:
            payload["assigned_agent_id"] = resolved_agent_id
        if clean_lead_id:
            payload["lead_id"] = clean_lead_id
        if clean_listing_id:
            payload["listing_id"] = clean_listing_id
        if clean_uri:
            payload["target_uri"] = clean_uri

        try:
            resp = self.session.post(
                self._rest_url("cockpit_cards"),
                headers=self._headers(prefer="return=representation"),
                json=[payload],
                timeout=self.timeout,
            )
            if resp.status_code in (200, 201):
                rows = resp.json() or []
                return rows[0] if rows else payload
            logger.error("queue_cockpit_card failed (%s): %s", resp.status_code, resp.text[:300])
        except Exception as exc:
            logger.error("Exception in queue_cockpit_card: %s", exc)
        return None

    def get_pending_cockpit_cards(
        self,
        limit: int = 10,
        agency_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Queries all actionable PENDING cards in public.cockpit_cards ordered by created_at DESC.
        """
        if not self.enabled:
            return []
        params: Dict[str, str] = {
            "status": "eq.PENDING",
            "order": "created_at.desc",
            "limit": str(max(1, int(limit))),
            "select": "*",
        }
        if agency_id and _is_valid_uuid(agency_id):
            params["agency_id"] = f"eq.{str(agency_id).strip()}"
        try:
            resp = self.session.get(
                self._rest_url("cockpit_cards"),
                headers=self._headers(),
                params=params,
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                return resp.json() or []
            logger.error(
                "get_pending_cockpit_cards failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in get_pending_cockpit_cards: %s", exc)
        return []

    def update_cockpit_card_status(
        self,
        card_id: str,
        status: str,
    ) -> Optional[Dict[str, Any]]:
        """
        Updates the status of a cockpit card using uppercase v2 enum values
        ('PENDING', 'EXECUTED', 'DISMISSED', 'SNOOZED').
        """
        if not self.enabled or not card_id:
            return None

        clean_id = str(card_id).strip()
        raw_status = str(status).strip().upper()
        if raw_status == "SENT":
            raw_status = "EXECUTED"
        if raw_status not in ("PENDING", "EXECUTED", "DISMISSED", "SNOOZED"):
            raw_status = "DISMISSED"

        patch_data: Dict[str, Any] = {
            "status": raw_status,
            "updated_at": _utc_now_iso(),
        }
        if raw_status in ("EXECUTED", "DISMISSED"):
            patch_data["acted_at"] = _utc_now_iso()

        if not _is_valid_uuid(clean_id):
            # Graceful simulation fallback for non-UUID mock/test IDs
            return {"id": clean_id, **patch_data}

        try:
            resp = self.session.patch(
                self._rest_url("cockpit_cards"),
                headers=self._headers(prefer="return=representation"),
                params={"id": f"eq.{clean_id}"},
                json=patch_data,
                timeout=self.timeout,
            )
            if resp.status_code == 200:
                rows = resp.json() or []
                return rows[0] if rows else patch_data
            logger.error(
                "update_cockpit_card_status failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception in update_cockpit_card_status: %s", exc)
        return None

    # ------------------------------------------------------------------
    # Versioned Storage Uploads (videos/{bina_id}/v{n}.mp4)
    # ------------------------------------------------------------------

    def upload_versioned_video(
        self,
        video_path: str,
        bina_id: str,
        version_num: int,
        target_account_handle: Optional[str] = None,
        *,
        agency_id: Optional[str] = None,
        listing_id: Optional[str] = None,
        storage_provider: Optional[str] = None,
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Uploads an MP4 render using dual-path storage:
        - Private Cloudflare R2 (`storage_provider='r2'`) when `WORKER_MODE` is
          `railway`/`cloud`/`r2` or `r2_storage` is injected & configured.
        - Legacy Supabase Storage (`storage_provider='supabase'`) otherwise.
        Never overwrites prior versions.
        Returns: (storage_object_path, cdn_url) on success, or (None, None) on error.
        """
        if not self.enabled:
            logger.info("SupabaseRepo disabled or unconfigured. Skipping versioned video upload.")
            return None, None

        path = Path(video_path)
        if not path.is_file():
            logger.warning("Video file does not exist for upload: %s", video_path)
            return None, None

        use_r2 = self.should_use_r2_storage(storage_provider=storage_provider)
        object_path = build_versioned_storage_path(
            bina_id,
            version_num,
            target_account_handle=target_account_handle,
            agency_id=agency_id if use_r2 else None,
            listing_id=listing_id if use_r2 else None,
        )

        if use_r2 and self.r2_storage is not None:
            try:
                res = self.r2_storage.upload_video(path, object_path)
                self.last_upload_storage_provider = "r2"
                return res.object_path, res.cdn_url
            except Exception as exc:
                logger.error("R2 versioned video upload failed for %s: %s", object_path, exc)
                return None, None

        encoded_path = urllib.parse.quote(object_path, safe="/")
        upload_url = f"{self.supabase_url}/storage/v1/object/{self.bucket_name}/{encoded_path}"
        public_cdn_url = (
            f"{self.supabase_url}/storage/v1/object/public/{self.bucket_name}/{encoded_path}"
        )

        headers = self._headers(content_type="video/mp4")
        headers["x-upsert"] = "true"

        try:
            with open(path, "rb") as f:
                video_bytes = f.read()

            logger.info(
                "Uploading versioned video %s (%d bytes) to bucket '%s'...",
                object_path,
                len(video_bytes),
                self.bucket_name,
            )
            resp = self.session.post(
                upload_url,
                headers=headers,
                data=video_bytes,
                timeout=max(60, self.timeout),
            )
            if resp.status_code in (200, 201):
                self.last_upload_storage_provider = "supabase"
                logger.info("Versioned upload successful: %s", public_cdn_url)
                return object_path, public_cdn_url
            logger.error(
                "Versioned storage upload failed (%s): %s",
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception uploading versioned video %s: %s", object_path, exc)

        return None, None

    def delete_storage_object(
        self,
        object_path: str,
        *,
        storage_provider: Optional[str] = None,
    ) -> bool:
        """
        Deletes a storage object (e.g. partial upload cleanup on cooperative cancel)
        routing to private R2 or legacy Supabase Storage based on `storage_provider`.
        """
        clean_path = str(object_path or "").strip().lstrip("/")
        if not clean_path:
            return False

        provider = (
            str(storage_provider).strip().lower()
            if storage_provider is not None
            else self.last_upload_storage_provider
        )
        if provider == "r2":
            r2 = self.r2_storage or R2StorageClient()
            if r2.is_configured():
                return r2.delete_object(clean_path)
            logger.warning("Cannot delete R2 object '%s': R2StorageClient not configured.", clean_path)
            return False

        if not self.enabled:
            return False

        try:
            resp = self.session.delete(
                f"{self.supabase_url}/storage/v1/object/{self.bucket_name}",
                headers=self._headers(),
                json={"prefixes": [clean_path]},
                timeout=self.timeout,
            )
            if resp.status_code in (200, 204):
                logger.info("Deleted Supabase Storage object '%s'.", clean_path)
                return True
            logger.error(
                "delete_storage_object failed for '%s' (%s): %s",
                clean_path,
                resp.status_code,
                resp.text[:300],
            )
        except Exception as exc:
            logger.error("Exception deleting Supabase Storage object '%s': %s", clean_path, exc)
        return False
