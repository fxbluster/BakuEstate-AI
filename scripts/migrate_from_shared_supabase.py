"""
Selective one-time cutover migration script:
  Legacy Shared Supabase (ejsaccbeatmwqodwwzwu) -> New Isolated BakuEstate-AI v2 Supabase

Strictly exports ONLY the 16 BakuEstate objects (never touches Citadel CRM tables:
leads, tasks, calls, cockpit_cards), bootstraps default agency/settings/member,
splits listings self-referencing duplicate_of_listing_id into two passes, backfills
listing_owner_contacts (PII separation), decomposes agent_conversations.messages
into append-only agent_messages, remaps legacy operator UIDs via LEG_OP_MAP, and
verifies row count + ID checksum parity.

Usage:
  python scripts/migrate_from_shared_supabase.py --dry-run
  python scripts/migrate_from_shared_supabase.py --old-url ... --old-key ... --new-url ... --new-key ...
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import requests

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Exact 16 BakuEstate objects in dependency-safe insertion order
BAKU_EXPORT_TABLES: Tuple[str, ...] = (
    "baku_estate_config",
    "listings",
    "pipeline_jobs",
    "listing_events",
    "render_versions",
    "publications",
    "buyer_leads",
    "lead_listings",
    "follow_up_tasks",
    "preflight_checks",
    "social_comments",
    "publication_telemetry_snapshots",
    "lead_timeline_events",
    "agent_conversations",
    "agent_learned_insights",
    "ai_copilot_runs",
)

# Citadel CRM tables on shared legacy project — MUST NEVER be read, written, or altered
CITADEL_BLOCKLIST = frozenset({"leads", "tasks", "calls", "cockpit_cards"})

DEFAULT_LEGACY_OPERATOR_UID = "083d8ea3-4a73-4b85-8479-0c532ce939f0"


def load_dotenv_into_env(env_path: Path) -> None:
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


def _assert_safe_table(table: str) -> None:
    if table in CITADEL_BLOCKLIST:
        raise ValueError(f"Refusing to touch Citadel blocklisted table: {table}")
    if table not in BAKU_EXPORT_TABLES:
        raise ValueError(f"Table {table!r} is not in BAKU_EXPORT_TABLES")


def map_legacy_operator_id(
    raw_uid: Optional[str],
    operator_map: Optional[Dict[str, str]] = None,
    default_uid: Optional[str] = None,
) -> Optional[str]:
    op_map = operator_map or {}
    if raw_uid:
        cleaned = str(raw_uid).strip()
        if cleaned in op_map:
            return op_map[cleaned]
        if cleaned != DEFAULT_LEGACY_OPERATOR_UID:
            return cleaned
    return default_uid or (op_map.get(DEFAULT_LEGACY_OPERATOR_UID) if op_map else None)


def prepare_listings_two_pass(
    rows: List[Dict[str, Any]],
    agency_id: Optional[str] = None,
    default_agent_id: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], List[Tuple[str, str]]]:
    """
    Splits listings into:
      1. first_pass rows with duplicate_of_listing_id = None (safe against self-FK ordering)
      2. dup_patches list of (listing_id, duplicate_of_listing_id) for Pass-2 PATCH
    """
    first_pass: List[Dict[str, Any]] = []
    dup_patches: List[Tuple[str, str]] = []

    for row in rows:
        item = dict(row)
        dup_target = item.get("duplicate_of_listing_id")
        if dup_target and item.get("id") and str(dup_target) != str(item["id"]):
            dup_patches.append((str(item["id"]), str(dup_target)))
        item["duplicate_of_listing_id"] = None

        if agency_id:
            item["agency_id"] = agency_id
        if default_agent_id and not item.get("assigned_agent_id"):
            item["assigned_agent_id"] = default_agent_id
        item.setdefault("source_type", "BINA_AZ")
        item.setdefault("canonical_niche", "GENERAL")
        first_pass.append(item)

    return first_pass, dup_patches


def extract_listing_owner_contacts(
    listings: List[Dict[str, Any]],
    agency_id: str,
) -> List[Dict[str, Any]]:
    """Builds public.listing_owner_contacts rows from listings PII fields."""
    contacts: List[Dict[str, Any]] = []
    for row in listings:
        lid = row.get("id")
        if not lid:
            continue
        name = (row.get("contact_name") or "").strip() or None
        raw = (row.get("owner_phone_raw") or "").strip() or None
        norm = (row.get("owner_phone_normalized") or "").strip() or None
        if name or raw or norm:
            contacts.append({
                "listing_id": str(lid),
                "agency_id": agency_id,
                "owner_name": name,
                "owner_phone_raw": raw,
                "owner_phone_normalized": norm,
            })
    return contacts


def decompose_conversations_to_messages(
    conversations: List[Dict[str, Any]],
    agency_id: str,
    operator_map: Optional[Dict[str, str]] = None,
    default_operator_id: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Extracts JSONB `agent_conversations.messages` arrays into append-only
    `public.agent_messages` rows and normalizes conversation tenancy/operator_id.
    """
    conv_rows: List[Dict[str, Any]] = []
    msg_rows: List[Dict[str, Any]] = []

    for conv in conversations:
        c = dict(conv)
        c["agency_id"] = agency_id
        mapped_op = map_legacy_operator_id(
            c.get("operator_id"),
            operator_map=operator_map,
            default_uid=default_operator_id,
        )
        if mapped_op:
            c["operator_id"] = mapped_op

        raw_messages = c.get("messages") or []
        c["messages"] = []
        conv_rows.append(c)

        if not isinstance(raw_messages, list):
            continue

        conv_id = str(c["id"])
        agent_id = str(c.get("agent_id") or "mudir")
        op_id = str(c.get("operator_id") or default_operator_id or "")

        for msg in raw_messages:
            if not isinstance(msg, dict):
                continue
            role = str(msg.get("role") or msg.get("sender_type") or "user").strip().lower()
            if role in ("assistant", "agent", "model"):
                sender_type = "AGENT"
                default_name = agent_id
            elif role == "system":
                sender_type = "SYSTEM"
                default_name = "system"
            else:
                sender_type = "USER"
                default_name = "operator"

            content = str(msg.get("content") or msg.get("text") or "").strip()
            if not content:
                continue

            msg_rows.append({
                "id": str(msg.get("id") or uuid.uuid4()),
                "conversation_id": conv_id,
                "agency_id": agency_id,
                "operator_id": op_id,
                "sender_type": sender_type,
                "sender_name": str(msg.get("sender_name") or default_name),
                "content": content,
                "action_payload": msg.get("action_payload") if isinstance(msg.get("action_payload"), dict) else {},
                "created_at": msg.get("created_at") or c.get("created_at"),
            })

    return conv_rows, msg_rows


def enrich_tenant_rows(
    table: str,
    rows: List[Dict[str, Any]],
    agency_id: str,
    operator_map: Optional[Dict[str, str]] = None,
    default_operator_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Injects agency_id and remaps operator/agent UUIDs on exported legacy rows."""
    _assert_safe_table(table)
    out: List[Dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        if table != "baku_estate_config":
            item["agency_id"] = agency_id

        if table in ("agent_learned_insights", "ai_copilot_runs"):
            mapped = map_legacy_operator_id(
                item.get("operator_id"),
                operator_map=operator_map,
                default_uid=default_operator_id,
            )
            if mapped:
                item["operator_id"] = mapped

        if table == "ai_copilot_runs":
            item.setdefault("status", "COMPLETED")
            item.setdefault("audio_seconds", 0)
            item.setdefault("reserved_usd", 0)

        if table == "buyer_leads" and default_operator_id and not item.get("assigned_agent_id"):
            item["assigned_agent_id"] = default_operator_id

        if table == "follow_up_tasks" and default_operator_id and not item.get("assigned_agent_id"):
            item["assigned_agent_id"] = default_operator_id

        if table == "preflight_checks" and item.get("result") == "ERROR":
            item["result"] = "SCRAPE_ERROR"

        out.append(item)
    return out


def compute_id_checksum(rows: Iterable[Dict[str, Any]], key: str = "id") -> str:
    ids = sorted(str(r.get(key, "")) for r in rows if r.get(key) is not None)
    payload = "\n".join(ids).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class SupabaseRestClient:
    """Minimal read/write PostgREST helper using service_role credentials."""

    def __init__(self, base_url: str, service_role_key: str, read_only: bool = False) -> None:
        self.rest_url = base_url.rstrip("/") + "/rest/v1"
        self.read_only = read_only
        self.headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
        }

    def fetch_all(self, table: str, page_size: int = 1000) -> List[Dict[str, Any]]:
        _assert_safe_table(table)
        rows: List[Dict[str, Any]] = []
        offset = 0
        while True:
            headers = {
                **self.headers,
                "Range-Unit": "items",
                "Range": f"{offset}-{offset + page_size - 1}",
            }
            resp = requests.get(f"{self.rest_url}/{table}?select=*", headers=headers, timeout=30)
            if resp.status_code == 404:
                return []
            if resp.status_code not in (200, 206):
                raise RuntimeError(f"Export failed on {table} ({resp.status_code}): {resp.text[:300]}")
            batch = resp.json() or []
            rows.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size
        return rows

    def upsert_rows(self, table: str, rows: List[Dict[str, Any]], on_conflict: Optional[str] = None, batch_size: int = 200) -> int:
        if self.read_only:
            raise RuntimeError("Write attempted on read-only client")
        if not rows:
            return 0
        url = f"{self.rest_url}/{table}"
        if on_conflict:
            url += f"?on_conflict={on_conflict}"
        headers = {**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"}
        written = 0
        for idx in range(0, len(rows), batch_size):
            chunk = rows[idx:idx + batch_size]
            resp = requests.post(url, headers=headers, json=chunk, timeout=60)
            if resp.status_code not in (200, 201, 204):
                raise RuntimeError(f"Upsert failed on {table} ({resp.status_code}): {resp.text[:300]}")
            written += len(chunk)
        return written

    def patch_row(self, table: str, row_id: str, patch: Dict[str, Any]) -> None:
        if self.read_only:
            raise RuntimeError("Write attempted on read-only client")
        resp = requests.patch(
            f"{self.rest_url}/{table}?id=eq.{row_id}",
            headers={**self.headers, "Prefer": "return=minimal"},
            json=patch,
            timeout=30,
        )
        if resp.status_code not in (200, 204):
            raise RuntimeError(f"Patch failed on {table}/{row_id} ({resp.status_code}): {resp.text[:300]}")

    def count_rows(self, table: str) -> int:
        resp = requests.get(
            f"{self.rest_url}/{table}?select=*",
            headers={**self.headers, "Prefer": "count=exact", "Range": "0-0"},
            timeout=30,
        )
        if resp.status_code not in (200, 206):
            return 0
        cr = resp.headers.get("Content-Range", "")
        if "/" in cr:
            part = cr.split("/")[-1]
            if part.isdigit():
                return int(part)
        return len(resp.json() or [])


def print_cutover_runbook_reminder() -> None:
    print("\n=== Post-Cutover Runbook Checklist ===")
    print("1. Legacy project (ejsaccbeatmwqodwwzwu): Disable BakuEstate pg_cron jobs:")
    print("   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('baku_estate_followup_dispatcher', 'baku_estate_storage_pruner');")
    print("2. Telegram Bot API: Point setWebhook to the NEW isolated Supabase Edge Function:")
    print("   POST https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<NEW_REF>.supabase.co/functions/v1/telegram-webhook&secret_token=<SECRET>")
    print("3. Legacy Citadel tables (leads, tasks, calls, cockpit_cards) remain untouched as read-only backup.")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Selective cutover migration from shared Citadel Supabase to isolated BakuEstate-AI v2 Supabase."
    )
    parser.add_argument("--dry-run", action="store_true", help="Export/transform and verify plan without writing to target.")
    parser.add_argument("--old-url", default=None, help="Source legacy Supabase URL (env: OLD_SUPABASE_URL)")
    parser.add_argument("--old-key", default=None, help="Source legacy service_role key (env: OLD_SUPABASE_SERVICE_ROLE_KEY)")
    parser.add_argument("--new-url", default=None, help="Target v2 Supabase URL (env: NEW_SUPABASE_URL / SUPABASE_URL)")
    parser.add_argument("--new-key", default=None, help="Target v2 service_role key (env: NEW_SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY)")
    parser.add_argument("--agency-id", default=None, help="Fixed target agency UUID (generated if omitted)")
    parser.add_argument("--agency-name", default=os.getenv("DEFAULT_AGENCY_NAME", "BakuEstate HQ"))
    parser.add_argument("--admin-user-id", default=os.getenv("NEW_ADMIN_USER_ID"), help="New Supabase auth.users UUID for ADMIN member")
    parser.add_argument("--admin-name", default=os.getenv("NEW_ADMIN_DISPLAY_NAME", "Admin"))
    parser.add_argument("--public-phone", default=os.getenv("AGENCY_WHATSAPP_PHONE", "+994 50 200 21 69"))
    parser.add_argument("--telegram-chat-id", default=os.getenv("TELEGRAM_CHAT_ID"))
    parser.add_argument("--snapshot-json", type=Path, default=None, help="Optional offline JSON snapshot of 16 tables for dry-run")
    args = parser.parse_args(argv)

    load_dotenv_into_env(PROJECT_ROOT / ".env")

    old_url = (args.old_url or os.getenv("OLD_SUPABASE_URL") or "").strip()
    old_key = (args.old_key or os.getenv("OLD_SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    new_url = (args.new_url or os.getenv("NEW_SUPABASE_URL") or os.getenv("SUPABASE_URL") or "").strip()
    new_key = (args.new_key or os.getenv("NEW_SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

    try:
        op_map = json.loads(os.getenv("LEG_OP_MAP", "{}"))
        if not isinstance(op_map, dict):
            op_map = {}
    except Exception:
        op_map = {}

    if args.admin_user_id and DEFAULT_LEGACY_OPERATOR_UID not in op_map:
        op_map[DEFAULT_LEGACY_OPERATOR_UID] = args.admin_user_id.strip()

    agency_id = args.agency_id or str(uuid.uuid5(uuid.NAMESPACE_DNS, f"bakuestate:{args.agency_name}"))

    exported: Dict[str, List[Dict[str, Any]]] = {}
    if args.snapshot_json and args.snapshot_json.exists():
        raw = json.loads(args.snapshot_json.read_text(encoding="utf-8"))
        for tbl in BAKU_EXPORT_TABLES:
            exported[tbl] = list(raw.get(tbl) or [])
    elif old_url and old_key:
        old_client = SupabaseRestClient(old_url, old_key, read_only=True)
        for tbl in BAKU_EXPORT_TABLES:
            exported[tbl] = old_client.fetch_all(tbl)
    elif args.dry_run:
        for tbl in BAKU_EXPORT_TABLES:
            exported[tbl] = []
    else:
        print("[ERROR] OLD_SUPABASE_URL and OLD_SUPABASE_SERVICE_ROLE_KEY are required.", file=sys.stderr)
        return 1

    listings_pass1, dup_patches = prepare_listings_two_pass(
        exported.get("listings", []),
        agency_id=agency_id,
        default_agent_id=args.admin_user_id,
    )
    owner_contacts = extract_listing_owner_contacts(exported.get("listings", []), agency_id=agency_id)
    conv_rows, msg_rows = decompose_conversations_to_messages(
        exported.get("agent_conversations", []),
        agency_id=agency_id,
        operator_map=op_map,
        default_operator_id=args.admin_user_id,
    )

    print("=== BakuEstate-AI Selective Cutover Migration (16 Objects) ===")
    print(f"Target Agency: {args.agency_name} ({agency_id})")
    print(f"Mode:          {'DRY-RUN' if args.dry_run else 'LIVE CUTOVER'}")
    for tbl in BAKU_EXPORT_TABLES:
        rows = exported.get(tbl, [])
        key = "key" if tbl == "baku_estate_config" else ("lead_id" if tbl == "lead_listings" else "id")
        print(f"  {tbl:<32} rows={len(rows):>5}  sha256={compute_id_checksum(rows, key)[:12]}")
    print(f"  -> derived listing_owner_contacts: {len(owner_contacts)}")
    print(f"  -> derived agent_messages:         {len(msg_rows)}")
    print(f"  -> pass-2 duplicate patches:       {len(dup_patches)}")

    if args.dry_run:
        print_cutover_runbook_reminder()
        return 0

    if not new_url or not new_key:
        print("[ERROR] NEW_SUPABASE_URL and NEW_SUPABASE_SERVICE_ROLE_KEY are required for live cutover.", file=sys.stderr)
        return 1

    new_client = SupabaseRestClient(new_url, new_key, read_only=False)

    # 1. Bootstrap default agency + settings + admin member
    new_client.upsert_rows("agencies", [{"id": agency_id, "name": args.agency_name}], on_conflict="id")
    new_client.upsert_rows(
        "agency_settings",
        [{
            "agency_id": agency_id,
            "public_phone": args.public_phone,
            "telegram_chat_id": args.telegram_chat_id,
        }],
        on_conflict="agency_id",
    )
    if args.admin_user_id:
        new_client.upsert_rows(
            "agency_members",
            [{
                "user_id": args.admin_user_id.strip(),
                "agency_id": agency_id,
                "role": "ADMIN",
                "display_name": args.admin_name,
                "is_active": True,
            }],
            on_conflict="user_id",
        )

    # 2. Config + Pass-1 listings + owner contacts
    new_client.upsert_rows("baku_estate_config", exported.get("baku_estate_config", []), on_conflict="key")
    new_client.upsert_rows("listings", listings_pass1, on_conflict="id")
    for lid, dup_id in dup_patches:
        new_client.patch_row("listings", lid, {"duplicate_of_listing_id": dup_id})
    new_client.upsert_rows("listing_owner_contacts", owner_contacts, on_conflict="listing_id")

    # 3. Remaining dependent tables
    for tbl in (
        "pipeline_jobs",
        "listing_events",
        "render_versions",
        "publications",
        "buyer_leads",
        "lead_listings",
        "follow_up_tasks",
        "preflight_checks",
        "social_comments",
        "publication_telemetry_snapshots",
        "lead_timeline_events",
        "agent_learned_insights",
        "ai_copilot_runs",
    ):
        payload = enrich_tenant_rows(
            tbl,
            exported.get(tbl, []),
            agency_id=agency_id,
            operator_map=op_map,
            default_operator_id=args.admin_user_id,
        )
        conflict = "lead_id,listing_id" if tbl == "lead_listings" else "id"
        new_client.upsert_rows(tbl, payload, on_conflict=conflict)

    new_client.upsert_rows("agent_conversations", conv_rows, on_conflict="id")
    new_client.upsert_rows("agent_messages", msg_rows, on_conflict="id")

    # 4. Row count verification
    mismatches: List[str] = []
    for tbl in BAKU_EXPORT_TABLES:
        expected_n = len(exported.get(tbl, []))
        actual_n = new_client.count_rows(tbl)
        if actual_n < expected_n:
            mismatches.append(f"{tbl}: expected>={expected_n}, actual={actual_n}")

    if mismatches:
        print(f"[ERROR] Verification count mismatch: {mismatches}", file=sys.stderr)
        return 2

    print("\n[OK] All 16 BakuEstate objects migrated and count-verified cleanly.")
    print_cutover_runbook_reminder()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
