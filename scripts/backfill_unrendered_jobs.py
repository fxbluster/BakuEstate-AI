#!/usr/bin/env python3
"""
BakuEstate-AI Unrendered Listings Backfill Utility.
Identifies unrendered listings in Supabase (pipeline_status in ('NEW', 'QUEUED') and no completed video),
checks for existing active pipeline_jobs, and enqueues missing RENDER_INITIAL jobs with
trigger_source='WEB_UI' to bypass the daily auto-render limit.

Supports both --dry-run (default / inspection) and --commit (live enqueueing).
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Any

BASE_PROJECT_DIR = Path(__file__).resolve().parent.parent
if str(BASE_PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_PROJECT_DIR))

from src.cloud.supabase_repo import SupabaseRepo

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [Backfill] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("backfill_unrendered")


def get_unrendered_candidates(repo: SupabaseRepo, limit: int = 100) -> list[dict[str, Any]]:
    """
    Finds listings in Supabase where pipeline_status IN ('NEW', 'QUEUED')
    and no completed video render exists.
    """
    candidates = repo.get_unrendered_listings(limit=limit)
    if not candidates:
        # Fallback to direct rest query if needed
        try:
            resp = repo.session.get(
                repo._rest_url("listings"),
                headers=repo._headers(),
                params={
                    "select": "id,bina_id,title,pipeline_status,content_revision,created_at",
                    "pipeline_status": "in.(NEW,QUEUED)",
                    "order": "created_at.asc",
                    "limit": str(limit),
                },
                timeout=repo.timeout,
            )
            if resp.status_code == 200:
                candidates = resp.json() or []
        except Exception as exc:  # noqa: BLE001
            logger.error("Error querying listings table: %s", exc)

    unrendered: list[dict[str, Any]] = []
    for item in candidates:
        listing_id = item.get("id")
        if not listing_id:
            continue

        # Check render_versions to ensure no COMPLETED video already exists
        has_completed = False
        try:
            rv_resp = repo.session.get(
                repo._rest_url("render_versions"),
                headers=repo._headers(),
                params={
                    "listing_id": f"eq.{listing_id}",
                    "status": "eq.COMPLETED",
                    "select": "id,video_cdn_url,status",
                    "limit": "1",
                },
                timeout=repo.timeout,
            )
            if rv_resp.status_code == 200 and rv_resp.json():
                has_completed = True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Error checking render_versions for listing %s: %s", listing_id, exc)

        if not has_completed:
            unrendered.append(item)

    return unrendered


def check_active_job_for_listing(repo: SupabaseRepo, listing_id: str) -> dict[str, Any] | None:
    """
    Queries pipeline_jobs to see if a QUEUED or RUNNING job already exists for listing_id.
    """
    try:
        resp = repo.session.get(
            repo._rest_url("pipeline_jobs"),
            headers=repo._headers(),
            params={
                "listing_id": f"eq.{listing_id}",
                "status": "in.(QUEUED,RUNNING)",
                "select": "id,job_type,status,created_at",
                "order": "created_at.desc",
                "limit": "1",
            },
            timeout=repo.timeout,
        )
        if resp.status_code == 200:
            rows = resp.json() or []
            return rows[0] if rows else None
    except Exception as exc:  # noqa: BLE001
        logger.error("Error checking active pipeline jobs for listing %s: %s", listing_id, exc)
    return None


def run_backfill(
    commit: bool = False,
    limit: int = 100,
    repo: SupabaseRepo | None = None,
) -> dict[str, Any]:
    """
    Executes backfill reconciliation.
    If commit=False, performs dry-run only.
    If commit=True, enqueues RENDER_INITIAL jobs with trigger_source='WEB_UI'.
    """
    repo = repo or SupabaseRepo()
    if not repo.is_configured():
        logger.error("SupabaseRepo is not configured with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")
        sys.exit(1)

    logger.info("Scanning Supabase for unrendered listings (commit=%s, limit=%d)...", commit, limit)
    candidates = get_unrendered_candidates(repo, limit=limit)
    logger.info("Found %d candidate listings needing rendering.", len(candidates))

    results = {
        "total_candidates": len(candidates),
        "already_queued": 0,
        "enqueued": 0,
        "details": [],
    }

    print("\n" + "=" * 80)
    print(f"  BakuEstate-AI Unrendered Listings Backfill ({'LIVE COMMIT' if commit else 'DRY RUN'})")
    print("=" * 80)
    print(f"{'Bina ID':<10} | {'Listing ID':<36} | {'Status':<8} | {'Action Taken'}")
    print("-" * 80)

    for item in candidates:
        listing_id = item["id"]
        bina_id = item.get("bina_id", "N/A")
        pipeline_status = item.get("pipeline_status", "NEW")
        content_rev = item.get("content_revision", 1)

        active_job = check_active_job_for_listing(repo, listing_id)
        if active_job:
            action = f"SKIP (Job {active_job['id'][:8]} already {active_job['status']})"
            results["already_queued"] += 1
            results["details"].append({
                "bina_id": bina_id,
                "listing_id": listing_id,
                "status": pipeline_status,
                "action": "SKIPPED_EXISTING",
                "job_id": active_job["id"],
            })
        else:
            idempotency_key = f"RENDER_INITIAL:{listing_id}:{content_rev}"
            if commit:
                job_record = repo.enqueue_pipeline_job(
                    idempotency_key=idempotency_key,
                    job_type="RENDER_INITIAL",
                    listing_id=listing_id,
                    trigger_source="WEB_UI",
                    params_json={
                        "bina_id": bina_id,
                        "trigger_source": "WEB_UI",
                        "content_revision": content_rev,
                        "enqueued_by": "backfill_unrendered_jobs.py",
                    },
                )
                if job_record and job_record.get("id"):
                    action = f"ENQUEUED (Job {job_record['id'][:8]})"
                else:
                    action = "ENQUEUED (Submitted via idempotency)"

                # Transition listing from NEW to QUEUED if needed
                if pipeline_status == "NEW":
                    repo.update_listing(listing_id, {"pipeline_status": "QUEUED"})

                results["enqueued"] += 1
                results["details"].append({
                    "bina_id": bina_id,
                    "listing_id": listing_id,
                    "status": "QUEUED",
                    "action": "ENQUEUED",
                })
            else:
                action = f"WOULD ENQUEUE (Key: {idempotency_key})"
                results["enqueued"] += 1
                results["details"].append({
                    "bina_id": bina_id,
                    "listing_id": listing_id,
                    "status": pipeline_status,
                    "action": "WOULD_ENQUEUE",
                })

        print(f"{bina_id:<10} | {listing_id:<36} | {pipeline_status:<8} | {action}")

    print("-" * 80)
    print(
        f"Summary: Candidates: {results['total_candidates']} | "
        f"Already Active: {results['already_queued']} | "
        f"{'Enqueued' if commit else 'Would Enqueue'}: {results['enqueued']}"
    )
    print("=" * 80 + "\n")

    return results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill missing RENDER_INITIAL jobs for unrendered listings in Supabase.",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        default=False,
        help="Commit and enqueue pipeline jobs into Supabase (default: False / dry-run)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Run without modifying database (default)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=100,
        help="Maximum number of listings to evaluate (default: 100)",
    )
    args = parser.parse_args()

    commit_mode = args.commit and not args.dry_run
    run_backfill(commit=commit_mode, limit=args.limit)


if __name__ == "__main__":
    main()
