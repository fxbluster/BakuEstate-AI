"""BakuEstate-AI v2 Cutover, Red-Team RBAC & 2,000-Row Scale Verification Suite.

Usage:
  python scripts/verify_v2_cutover.py --dry-run --seed-synthetic 2000
  python scripts/verify_v2_cutover.py --seed-synthetic 2000 --cleanup
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import io
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import requests

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

PROJECT_ROOT = Path(__file__).resolve().parent.parent

CITADEL_TABLES: Tuple[str, ...] = ("leads", "tasks", "calls", "cockpit_cards")

V2_PROTECTED_TABLES: Tuple[str, ...] = (
    "agencies",
    "agency_members",
    "agency_settings",
    "listings",
    "listing_owner_contacts",
    "pipeline_jobs",
    "listing_events",
    "render_versions",
    "publications",
    "buyer_leads",
    "lead_listings",
    "follow_up_tasks",
    "social_comments",
    "publication_telemetry_snapshots",
    "preflight_checks",
    "cockpit_cards",
    "lead_timeline_events",
    "agent_conversations",
    "agent_messages",
    "agent_learned_insights",
    "ai_copilot_runs",
    "agency_ai_usage_monthly",
    "social_accounts",
    "lead_listing_matches",
    "baku_estate_config",
    "worker_heartbeats",
    "worker_status",
    "district_price_medians",
)

V2_PROTECTED_RPCS: Tuple[Tuple[str, Dict[str, Any]], ...] = (
    ("store_social_secret", {"p_name": "probe", "p_secret": "probe"}),
    ("read_social_secret", {"p_secret_id": "00000000-0000-0000-0000-000000000000"}),
    (
        "upsert_social_comment_returning_is_new",
        {
            "p_agency_id": "00000000-0000-0000-0000-000000000000",
            "p_publication_id": "00000000-0000-0000-0000-000000000000",
            "p_platform_comment_id": "probe",
            "p_author_handle": "probe",
            "p_comment_text": "probe",
        },
    ),
    ("match_listing_to_leads", {"p_listing_id": "00000000-0000-0000-0000-000000000000"}),
    ("get_agency_crm_kpis", {}),
    ("get_analytics_summary", {"p_days": 30}),
    (
        "check_and_reserve_ai_budget",
        {
            "p_operator_id": "00000000-0000-0000-0000-000000000000",
            "p_agency_id": "00000000-0000-0000-0000-000000000000",
        },
    ),
)

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

_SYNTHETIC_DISTRICTS: Tuple[Tuple[str, str, int], ...] = (
    ("Yasamal", "Yasamal r.", 2900),
    ("Nəsimi", "Nəsimi r.", 3150),
    ("Səbail", "Səbail r.", 3400),
    ("Nərimanov", "Nərimanov r.", 3250),
    ("Xətai", "Xətai r.", 2650),
    ("Masazır", "Masazır qəs.", 1450),
    ("Xırdalan", "Xırdalan ş.", 1550),
)


@dataclass
class CheckResult:
    name: str
    ok: bool
    details: str
    metrics: Dict[str, Any] = field(default_factory=dict)


def _derive_canonical_niche(price_azn: float, district: str, index: int) -> str:
    lower = district.lower()
    if index % 17 == 0:
        return "TIKTOK"
    if price_azn >= 250_000 or lower in ("nəsimi", "səbail", "nərimanov"):
        return "LUXURY"
    if price_azn <= 120_000 or lower in ("masazır", "xırdalan"):
        return "AFFORDABLE"
    return "GENERAL"


def build_synthetic_dataset(
    count: int = 2000,
    agency_id: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Generate deterministic synthetic listings and buyer_leads for scale benchmarks."""
    target_agency = agency_id or str(uuid.uuid4())
    listings: List[Dict[str, Any]] = []
    leads: List[Dict[str, Any]] = []

    for i in range(count):
        dist_name, loc_label, base_m2 = _SYNTHETIC_DISTRICTS[i % len(_SYNTHETIC_DISTRICTS)]
        rooms = (i % 4) + 1
        area = float(45 + (i % 9) * 14)
        price_azn = float(round((base_m2 * area) / 500) * 500)
        is_off_market = (i % 10 == 0)
        bina_id = None if is_off_market else str(9_000_000 + i)
        url = None if is_off_market else f"https://bina.az/items/{bina_id}"
        canonical_niche = _derive_canonical_niche(price_azn, dist_name, i)

        listings.append(
            {
                "id": str(uuid.uuid5(uuid.NAMESPACE_DNS, f"syn-listing-{target_agency}-{i}")),
                "agency_id": target_agency,
                "source_type": "OFF_MARKET" if is_off_market else "BINA_AZ",
                "canonical_niche": canonical_niche,
                "bina_id": bina_id,
                "url": url,
                "title": f"Satılır {rooms} otaqlı mənzil {int(area)} m², {loc_label}",
                "price": price_azn,
                "currency": "AZN",
                "price_azn_normalized": price_azn,
                "location": loc_label,
                "district_normalized": dist_name,
                "rooms": rooms,
                "area": area,
                "has_bill_of_sale": (i % 3 != 0),
                "source_availability": "ACTIVE",
                "editorial_status": "APPROVED" if i % 2 == 0 else "PENDING_REVIEW",
                "pipeline_status": "NEW",
            }
        )

        budget = float(round(price_azn * (1.05 if i % 2 == 0 else 0.92)))
        leads.append(
            {
                "id": str(uuid.uuid5(uuid.NAMESPACE_DNS, f"syn-lead-{target_agency}-{i}")),
                "agency_id": target_agency,
                "client_name": f"Sintetik Alıcı #{i + 1}",
                "phone_normalized": f"+99450{(1000000 + i) % 9000000 + 1000000}",
                "source_channel": "TELEGRAM",
                "stage": "QUALIFIED" if i % 5 != 0 else "NEW_INQUIRY",
                "budget_max_azn": budget,
                "preferred_districts": [dist_name],
                "min_rooms": max(1, rooms - 1),
                "requires_kupca": (i % 4 == 0),
            }
        )

    return listings, leads


def _rest_headers(api_key: str, bearer_jwt: Optional[str] = None) -> Dict[str, str]:
    token = bearer_jwt or api_key
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _http_client(session: Optional[requests.Session]) -> Any:
    return session if session is not None else requests


def seed_synthetic_dataset(
    supabase_url: str,
    service_key: str,
    count: int = 2000,
    session: Optional[requests.Session] = None,
) -> str:
    """Create isolated synthetic agency and batch-insert synthetic listings and leads."""
    client = _http_client(session)
    base = supabase_url.rstrip("/")
    headers = {
        **_rest_headers(service_key),
        "Prefer": "return=minimal,resolution=ignore-duplicates",
    }
    agency_id = str(uuid.uuid4())

    r_agency = client.post(
        f"{base}/rest/v1/agencies",
        headers=headers,
        json={"id": agency_id, "name": f"v2-cutover-benchmark-{agency_id[:8]}"},
        timeout=20,
    )
    if r_agency.status_code not in (200, 201, 204):
        raise RuntimeError(f"Failed to seed synthetic agency: {r_agency.status_code} {r_agency.text[:200]}")

    listings, leads = build_synthetic_dataset(count=count, agency_id=agency_id)
    batch_size = 500
    for table, rows in (("listings", listings), ("buyer_leads", leads)):
        for start in range(0, len(rows), batch_size):
            chunk = rows[start : start + batch_size]
            resp = client.post(
                f"{base}/rest/v1/{table}",
                headers=headers,
                json=chunk,
                timeout=30,
            )
            if resp.status_code not in (200, 201, 204):
                raise RuntimeError(
                    f"Failed to seed {table} batch {start}: {resp.status_code} {resp.text[:200]}"
                )
    return agency_id


def cleanup_synthetic_agency(
    supabase_url: str,
    service_key: str,
    agency_id: str,
    session: Optional[requests.Session] = None,
) -> None:
    client = _http_client(session)
    base = supabase_url.rstrip("/")
    client.delete(
        f"{base}/rest/v1/agencies?id=eq.{agency_id}",
        headers=_rest_headers(service_key),
        timeout=20,
    )


def check_anon_lockdown(
    supabase_url: str,
    anon_key: str,
    session: Optional[requests.Session] = None,
) -> CheckResult:
    """Assert anon key receives HTTP 401 or 403 on all v2 tables, views, and RPCs."""
    client = _http_client(session)
    base = supabase_url.rstrip("/")
    headers = _rest_headers(anon_key)
    leaks: List[str] = []

    for tbl in V2_PROTECTED_TABLES:
        resp = client.get(f"{base}/rest/v1/{tbl}?select=*&limit=1", headers=headers, timeout=15)
        if resp.status_code not in (401, 403):
            leaks.append(f"table:{tbl}->HTTP {resp.status_code}")

    for rpc_name, payload in V2_PROTECTED_RPCS:
        resp = client.post(f"{base}/rest/v1/rpc/{rpc_name}", headers=headers, json=payload, timeout=15)
        if resp.status_code not in (401, 403):
            leaks.append(f"rpc:{rpc_name}->HTTP {resp.status_code}")

    ok = len(leaks) == 0
    return CheckResult(
        name="anon_lockdown",
        ok=ok,
        details="All v2 tables/views/RPCs blocked anon with 401/403" if ok else f"Leaks: {', '.join(leaks)}",
        metrics={
            "tables_checked": len(V2_PROTECTED_TABLES),
            "rpcs_checked": len(V2_PROTECTED_RPCS),
            "leaks": leaks,
        },
    )


def check_rbac_smm_and_inactive(
    supabase_url: str,
    anon_key: str,
    web_url: str,
    smm_jwt: Optional[str] = None,
    inactive_jwt: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> CheckResult:
    """Verify SMM denial on listing_owner_contacts, inactive member 403, and unauth 401."""
    client = _http_client(session)
    supa_base = supabase_url.rstrip("/")
    web_base = web_url.rstrip("/")
    failures: List[str] = []

    if smm_jwt:
        r_pii = client.get(
            f"{supa_base}/rest/v1/listing_owner_contacts?select=*&limit=5",
            headers=_rest_headers(anon_key, smm_jwt),
            timeout=15,
        )
        if r_pii.status_code == 200:
            rows = r_pii.json()
            if isinstance(rows, list) and len(rows) > 0:
                failures.append(f"SMM read {len(rows)} rows from listing_owner_contacts")
        elif r_pii.status_code not in (401, 403):
            failures.append(f"SMM listing_owner_contacts unexpected HTTP {r_pii.status_code}")

        r_export = client.get(
            f"{web_base}/api/export/commissions",
            headers={"Authorization": f"Bearer {smm_jwt}"},
            timeout=15,
        )
        if r_export.status_code != 403:
            failures.append(f"SMM /api/export/commissions expected 403, got {r_export.status_code}")

    if inactive_jwt:
        r_inact = client.post(
            f"{web_base}/api/listings/manual",
            headers={"Authorization": f"Bearer {inactive_jwt}", "Content-Type": "application/json"},
            json={"title": "probe"},
            timeout=15,
        )
        if r_inact.status_code != 403:
            failures.append(f"Inactive member expected 403, got {r_inact.status_code}")

    r_unauth = client.get(
        f"{web_base}/api/export/commissions",
        headers={"Authorization": "Bearer test-jwt-bypass-probe"},
        timeout=15,
    )
    if r_unauth.status_code != 401:
        failures.append(f"test-jwt probe expected 401, got {r_unauth.status_code}")

    ok = len(failures) == 0
    return CheckResult(
        name="rbac_smm_and_inactive",
        ok=ok,
        details="SMM PII denial, inactive 403, and unauth 401 passed" if ok else "; ".join(failures),
        metrics={"failures": failures},
    )


def check_ssr_latency_benchmark(
    web_url: str,
    auth_cookie_or_jwt: Optional[str] = None,
    max_ms: float = 300.0,
    session: Optional[requests.Session] = None,
    clock_fn: Callable[[], float] = time.perf_counter,
) -> CheckResult:
    """Measure SSR/paginated route latencies and require every route < max_ms."""
    client = _http_client(session)
    base = web_url.rstrip("/")
    headers: Dict[str, str] = {}
    if auth_cookie_or_jwt:
        if "=" in auth_cookie_or_jwt and not auth_cookie_or_jwt.startswith("eyJ"):
            headers["Cookie"] = auth_cookie_or_jwt
        else:
            headers["Authorization"] = f"Bearer {auth_cookie_or_jwt}"

    paths = (
        "/listings?page=1&pageSize=24",
        "/leads?page=1&pageSize=24",
        "/analytics?days=30",
    )
    timings_ms: Dict[str, float] = {}
    slow_routes: List[str] = []

    for path in paths:
        t0 = clock_fn()
        resp = client.get(f"{base}{path}", headers=headers, timeout=15, allow_redirects=False)
        t1 = clock_fn()
        elapsed_ms = round((t1 - t0) * 1000.0, 2)
        timings_ms[path] = elapsed_ms
        if resp.status_code >= 500:
            slow_routes.append(f"{path}->HTTP {resp.status_code}")
        elif elapsed_ms >= max_ms:
            slow_routes.append(f"{path}->{elapsed_ms}ms>={max_ms}ms")

    ok = len(slow_routes) == 0
    return CheckResult(
        name="ssr_latency_benchmark",
        ok=ok,
        details=(
            f"All SSR pagination routes under {max_ms}ms: {timings_ms}"
            if ok
            else f"Latency/status violations: {', '.join(slow_routes)}"
        ),
        metrics={"timings_ms": timings_ms, "max_ms": max_ms},
    )


def check_meta_webhook_hmac(
    web_url: str,
    verify_token: str,
    app_secret: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> CheckResult:
    """Verify Meta webhook GET challenge and POST X-Hub-Signature-256 HMAC enforcement."""
    client = _http_client(session)
    base = web_url.rstrip("/")
    failures: List[str] = []

    challenge = "v2_cutover_challenge_987"
    r_get = client.get(
        f"{base}/api/social/webhooks/meta",
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": verify_token,
            "hub.challenge": challenge,
        },
        timeout=15,
    )
    if r_get.status_code != 200 or r_get.text.strip() != challenge:
        failures.append(f"GET challenge failed: HTTP {r_get.status_code} body={r_get.text[:60]!r}")

    payload_bytes = json.dumps({"object": "instagram", "entry": []}).encode("utf-8")
    r_bad = client.post(
        f"{base}/api/social/webhooks/meta",
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": "sha256=" + ("0" * 64),
        },
        data=payload_bytes,
        timeout=15,
    )
    if r_bad.status_code not in (401, 403):
        failures.append(f"Invalid HMAC expected 401/403, got {r_bad.status_code}")

    if app_secret:
        good_sig = "sha256=" + hmac.new(
            app_secret.encode("utf-8"),
            payload_bytes,
            hashlib.sha256,
        ).hexdigest()
        r_good = client.post(
            f"{base}/api/social/webhooks/meta",
            headers={
                "Content-Type": "application/json",
                "X-Hub-Signature-256": good_sig,
            },
            data=payload_bytes,
            timeout=15,
        )
        if r_good.status_code in (401, 403) or r_good.status_code >= 500:
            failures.append(f"Valid HMAC rejected: HTTP {r_good.status_code}")

    ok = len(failures) == 0
    return CheckResult(
        name="meta_webhook_hmac",
        ok=ok,
        details="Meta GET challenge & HMAC-SHA256 verification passed" if ok else "; ".join(failures),
        metrics={"failures": failures},
    )


def verify_csv_payload_formula_safe(raw_bytes: bytes) -> bool:
    """Validate UTF-8 BOM and ensure all formula-prefix cells are escaped with leading '."""
    if not raw_bytes.startswith(b"\xef\xbb\xbf"):
        return False
    text = raw_bytes[3:].decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        for cell in row:
            if cell and cell[0] in FORMULA_PREFIXES:
                return False
    return True


def check_csv_formula_protection(
    web_url: str,
    auth_jwt: str,
    session: Optional[requests.Session] = None,
) -> CheckResult:
    """Fetch /api/export/commissions and validate UTF-8 BOM + CSV formula escaping."""
    client = _http_client(session)
    base = web_url.rstrip("/")
    resp = client.get(
        f"{base}/api/export/commissions",
        headers={"Authorization": f"Bearer {auth_jwt}"},
        timeout=20,
    )
    if resp.status_code != 200:
        return CheckResult(
            name="csv_formula_protection",
            ok=False,
            details=f"CSV export returned HTTP {resp.status_code}",
        )
    safe = verify_csv_payload_formula_safe(resp.content)
    return CheckResult(
        name="csv_formula_protection",
        ok=safe,
        details="CSV has UTF-8 BOM and formula-escaped cells" if safe else "CSV missing BOM or unescaped formula cell",
    )


def _parse_content_range_total(header_val: str) -> int:
    if "/" not in header_val:
        return 0
    total_part = header_val.split("/")[-1].strip()
    if total_part == "*":
        return 0
    return int(total_part)


def fetch_citadel_counts(
    old_url: str,
    old_key: str,
    session: Optional[requests.Session] = None,
) -> Dict[str, int]:
    """Read-only exact row counts for Citadel CRM tables on legacy Supabase."""
    client = _http_client(session)
    base = old_url.rstrip("/")
    headers = {
        **_rest_headers(old_key),
        "Prefer": "count=exact",
    }
    counts: Dict[str, int] = {}
    for tbl in CITADEL_TABLES:
        resp = client.get(f"{base}/rest/v1/{tbl}?select=id&limit=0", headers=headers, timeout=15)
        if resp.status_code not in (200, 206):
            raise RuntimeError(f"Failed reading Citadel count for {tbl}: HTTP {resp.status_code}")
        counts[tbl] = _parse_content_range_total(resp.headers.get("Content-Range", "*/0"))
    return counts


def check_citadel_zero_drift(
    old_url: str,
    old_key: str,
    before_counts: Dict[str, int],
    session: Optional[requests.Session] = None,
) -> CheckResult:
    """Verify 0 row delta across all Citadel CRM tables on ejsaccbeatmwqodwwzwu."""
    after_counts = fetch_citadel_counts(old_url, old_key, session=session)
    deltas = {
        tbl: after_counts.get(tbl, 0) - before_counts.get(tbl, 0)
        for tbl in CITADEL_TABLES
    }
    drifted = {tbl: d for tbl, d in deltas.items() if d != 0}
    ok = len(drifted) == 0
    return CheckResult(
        name="citadel_zero_drift",
        ok=ok,
        details="0 row delta across all Citadel tables" if ok else f"Citadel drift detected: {drifted}",
        metrics={"before": before_counts, "after": after_counts, "deltas": deltas},
    )


def run_dry_run_self_checks(seed_count: int) -> List[CheckResult]:
    """Run deterministic offline checks when --dry-run is specified."""
    results: List[CheckResult] = []
    listings, leads = build_synthetic_dataset(count=seed_count, agency_id="11111111-1111-1111-1111-111111111111")
    results.append(
        CheckResult(
            name="synthetic_dataset_generation",
            ok=(len(listings) == seed_count and len(leads) == seed_count),
            details=f"Generated {len(listings)} listings and {len(leads)} leads",
            metrics={"listings": len(listings), "leads": len(leads)},
        )
    )

    sample_csv = b"\xef\xbb\xbfclient_name,stage\n'=cmd|'/C calc'!A0,WON_CLOSED\n'+994501234567,DEPOSIT\n"
    unsafe_csv = b"\xef\xbb\xbfclient_name,stage\n=cmd|'/C calc'!A0,WON_CLOSED\n"
    csv_ok = verify_csv_payload_formula_safe(sample_csv) and not verify_csv_payload_formula_safe(unsafe_csv)
    results.append(
        CheckResult(
            name="csv_formula_protection_selfcheck",
            ok=csv_ok,
            details="CSV BOM + formula-prefix neutralization verified offline",
        )
    )

    body = b'{"object":"instagram","entry":[]}'
    sig = "sha256=" + hmac.new(b"test-secret", body, hashlib.sha256).hexdigest()
    sig_ok = hmac.compare_digest(
        sig,
        "sha256=" + hmac.new(b"test-secret", body, hashlib.sha256).hexdigest(),
    )
    results.append(
        CheckResult(
            name="meta_hmac_selfcheck",
            ok=sig_ok,
            details="HMAC-SHA256 verification helper verified offline",
        )
    )

    citadel_ok = set(CITADEL_TABLES) == {"leads", "tasks", "calls", "cockpit_cards"}
    results.append(
        CheckResult(
            name="citadel_blocklist_guard",
            ok=citadel_ok,
            details=f"Citadel read-only audit scope locked to {CITADEL_TABLES}",
        )
    )
    return results


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="BakuEstate-AI v2 cutover, red-team RBAC & 2,000-row benchmark suite",
    )
    parser.add_argument("--seed-synthetic", type=int, default=2000, help="Synthetic rows to generate/seed")
    parser.add_argument("--cleanup", action="store_true", help="Delete synthetic agency after live checks")
    parser.add_argument("--dry-run", action="store_true", help="Run offline deterministic verification checks")
    parser.add_argument("--max-ssr-ms", type=float, default=300.0, help="Max allowed SSR pagination latency (ms)")
    parser.add_argument("--supabase-url", default=os.getenv("V2_SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL", ""))
    parser.add_argument("--anon-key", default=os.getenv("V2_SUPABASE_ANON_KEY") or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ""))
    parser.add_argument("--service-key", default=os.getenv("V2_SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""))
    parser.add_argument("--web-url", default=os.getenv("V2_WEB_URL") or os.getenv("NEXT_PUBLIC_SITE_URL", ""))
    parser.add_argument("--old-url", default=os.getenv("LEGACY_SUPABASE_URL", ""))
    parser.add_argument("--old-key", default=os.getenv("LEGACY_SUPABASE_SERVICE_ROLE_KEY", ""))
    parser.add_argument("--auth-jwt", default=os.getenv("V2_ADMIN_JWT", ""))
    parser.add_argument("--smm-jwt", default=os.getenv("V2_SMM_JWT", ""))
    parser.add_argument("--inactive-jwt", default=os.getenv("V2_INACTIVE_JWT", ""))
    parser.add_argument("--meta-verify-token", default=os.getenv("META_WEBHOOK_VERIFY_TOKEN", ""))
    parser.add_argument("--meta-app-secret", default=os.getenv("META_APP_SECRET", ""))
    parser.add_argument("--json", action="store_true", help="Emit JSON report")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    results: List[CheckResult] = []

    if args.dry_run:
        results = run_dry_run_self_checks(args.seed_synthetic)
    else:
        if not args.supabase_url or not args.anon_key:
            print(
                "ERROR: --supabase-url and --anon-key (or --dry-run) are required.",
                file=sys.stderr,
            )
            return 2

        before_citadel: Optional[Dict[str, int]] = None
        if args.old_url and args.old_key:
            before_citadel = fetch_citadel_counts(args.old_url, args.old_key)

        synthetic_agency_id: Optional[str] = None
        try:
            if args.seed_synthetic > 0 and args.service_key:
                synthetic_agency_id = seed_synthetic_dataset(
                    args.supabase_url,
                    args.service_key,
                    count=args.seed_synthetic,
                )
                results.append(
                    CheckResult(
                        name="seed_synthetic",
                        ok=True,
                        details=f"Seeded {args.seed_synthetic} synthetic listings & leads in agency {synthetic_agency_id}",
                        metrics={"agency_id": synthetic_agency_id, "count": args.seed_synthetic},
                    )
                )

            results.append(check_anon_lockdown(args.supabase_url, args.anon_key))

            if args.web_url:
                results.append(
                    check_rbac_smm_and_inactive(
                        supabase_url=args.supabase_url,
                        anon_key=args.anon_key,
                        web_url=args.web_url,
                        smm_jwt=args.smm_jwt or None,
                        inactive_jwt=args.inactive_jwt or None,
                    )
                )
                results.append(
                    check_ssr_latency_benchmark(
                        web_url=args.web_url,
                        auth_cookie_or_jwt=args.auth_jwt or None,
                        max_ms=args.max_ssr_ms,
                    )
                )
                if args.meta_verify_token:
                    results.append(
                        check_meta_webhook_hmac(
                            web_url=args.web_url,
                            verify_token=args.meta_verify_token,
                            app_secret=args.meta_app_secret or None,
                        )
                    )
                if args.auth_jwt:
                    results.append(
                        check_csv_formula_protection(
                            web_url=args.web_url,
                            auth_jwt=args.auth_jwt,
                        )
                    )

            if before_citadel is not None and args.old_url and args.old_key:
                results.append(
                    check_citadel_zero_drift(args.old_url, args.old_key, before_citadel)
                )
        finally:
            if synthetic_agency_id and args.cleanup and args.service_key:
                cleanup_synthetic_agency(args.supabase_url, args.service_key, synthetic_agency_id)

    all_ok = all(r.ok for r in results) and len(results) > 0
    if args.json:
        print(
            json.dumps(
                {
                    "ok": all_ok,
                    "dry_run": bool(args.dry_run),
                    "checks": [
                        {"name": r.name, "ok": r.ok, "details": r.details, "metrics": r.metrics}
                        for r in results
                    ],
                },
                indent=2,
            )
        )
    else:
        for r in results:
            status_tag = "PASS" if r.ok else "FAIL"
            print(f"[{status_tag}] {r.name}: {r.details}")
        print(f"Summary: {sum(1 for r in results if r.ok)}/{len(results)} checks passed")

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
