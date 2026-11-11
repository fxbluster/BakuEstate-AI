"""
Automated Background Scheduler and Daemon for Baku Estate AI.
Runs periodically or at specific daily times (e.g. 12:30 and 19:30)
to automatically scrape new listings, compose 9:16 videos, and dispatch to Telegram CRM.
"""

import sys
from pathlib import Path

# Add project root to sys.path
BASE_PROJECT_DIR = Path(__file__).resolve().parent.parent
if str(BASE_PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_PROJECT_DIR))

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import argparse
import logging
import signal
import threading
from datetime import datetime, timedelta, time as dt_time
from typing import List, Optional, Dict, Any

from config.settings import (
    SCHEDULE_TIMES,
    SCHEDULE_INTERVAL_HOURS,
    SCHEDULE_PAGES,
    SCHEDULE_LIMIT,
    SCHEDULE_RUN_ON_STARTUP,
    TELEGRAM_MOCK_DISPATCH,
    DB_PATH
)
from run_pipeline import BakuEstatePipeline

logger = logging.getLogger("estate_scheduler")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def parse_schedule_times(times_str: str) -> List[str]:
    """Parses comma/semicolon-separated time strings like '12:30,19:30' into validated, unique HH:MM strings."""
    if not times_str:
        return []
    import re
    valid_times = set()
    for item in re.split(r"[,;\s]+", times_str.strip()):
        t = item.strip()
        if not t:
            continue
        try:
            parts = t.split(":")
            if len(parts) != 2:
                raise ValueError("Invalid format")
            h, m = int(parts[0]), int(parts[1])
            if 0 <= h < 24 and 0 <= m < 60:
                valid_times.add(f"{h:02d}:{m:02d}")
        except Exception:
            logger.warning(f"Ignored invalid schedule time format: '{t}'. Expected HH:MM.")
    return sorted(list(valid_times))


def calculate_next_run(now: datetime, scheduled_times: List[str]) -> Optional[datetime]:
    """
    Given current datetime and list of HH:MM strings,
    returns the earliest upcoming datetime (either later today or tomorrow).
    """
    if not scheduled_times:
        return None

    candidates = []
    for t_str in scheduled_times:
        h, m = map(int, t_str.split(":"))
        run_today = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if run_today > now:
            candidates.append(run_today)
        else:
            candidates.append(run_today + timedelta(days=1))

    return min(candidates) if candidates else None


def calculate_next_run_interval(now: datetime, interval_hours: float) -> datetime:
    """Calculates next run timestamp based on an hourly interval."""
    return now + timedelta(hours=interval_hours)


class BakuEstateScheduler:
    """
    Autonomous Scheduler Daemon that runs the Baku Estate AI pipeline
    either at fixed times daily or on a repeating interval.
    """

    def __init__(
        self,
        scheduled_times: Optional[List[str]] = None,
        interval_hours: float = SCHEDULE_INTERVAL_HOURS,
        pages: int = SCHEDULE_PAGES,
        limit: int = SCHEDULE_LIMIT,
        run_on_startup: bool = SCHEDULE_RUN_ON_STARTUP,
        owner_only: bool = True,
        mock_dispatch: Optional[bool] = None,
        db_path: Path = DB_PATH
    ):
        if scheduled_times is None:
            self.scheduled_times = parse_schedule_times(SCHEDULE_TIMES)
        else:
            self.scheduled_times = scheduled_times

        self.interval_hours = interval_hours
        self.pages = pages
        self.limit = limit
        self.run_on_startup = run_on_startup
        self.owner_only = owner_only
        self.mock_dispatch = TELEGRAM_MOCK_DISPATCH if mock_dispatch is None else mock_dispatch
        self.db_path = db_path

        self._stop_event = threading.Event()
        self.pipeline: Optional[BakuEstatePipeline] = None
        self.total_runs_completed = 0
        self.last_run_time: Optional[datetime] = None

    def _init_pipeline(self) -> BakuEstatePipeline:
        if self.pipeline is None:
            self.pipeline = BakuEstatePipeline(
                owner_only=self.owner_only,
                mock_dispatch=self.mock_dispatch,
                db_path=self.db_path
            )
        return self.pipeline

    def run_job(self) -> List[Dict[str, Any]]:
        """Executes a single cycle of the pipeline and logs results."""
        logger.info("========================================================")
        logger.info(f" [SCHEDULER JOB START] Starting autonomous pipeline run")
        logger.info(f" Parameters: pages={self.pages}, limit={self.limit}, owner_only={self.owner_only}")
        logger.info("========================================================")

        pipeline = self._init_pipeline()
        try:
            results = pipeline.run_full_pipeline(pages=self.pages, limit=self.limit)
            self.total_runs_completed += 1
            self.last_run_time = datetime.now()
            logger.info(f" [SCHEDULER JOB FINISHED] Processed {len(results)} videos successfully.")
            return results
        except Exception as e:
            logger.error(f" [SCHEDULER ERROR] Error during pipeline execution: {e}", exc_info=True)
            return []

    def get_next_run_time(self, from_time: Optional[datetime] = None) -> Optional[datetime]:
        """Determines the next execution time based on mode (interval or fixed times)."""
        now = from_time or datetime.now()
        if self.interval_hours > 0:
            return calculate_next_run_interval(now, self.interval_hours)
        elif self.scheduled_times:
            return calculate_next_run(now, self.scheduled_times)
        else:
            # Fallback to 1 hour if neither was defined
            return calculate_next_run_interval(now, 1.0)

    def stop(self):
        """Signals the scheduler daemon to stop running."""
        logger.info("Scheduler daemon received stop request.")
        self._stop_event.set()

    @property
    def is_running(self) -> bool:
        return not self._stop_event.is_set()

    def start(self, max_runs: Optional[int] = None):
        """
        Runs the daemon loop until stopped or max_runs reached.
        Uses interruptible wait for graceful shutdown.
        """
        self._stop_event.clear()

        # Register OS signal handlers if running in main thread
        try:
            signal.signal(signal.SIGINT, lambda sig, frame: self.stop())
            signal.signal(signal.SIGTERM, lambda sig, frame: self.stop())
        except (ValueError, AttributeError):
            pass  # May fail if not in main thread (e.g. in test threads)

        logger.info(">>> Baku Estate AI Scheduler Daemon is running <<<")
        if self.interval_hours > 0:
            logger.info(f"Schedule mode: Repeating interval every {self.interval_hours} hours")
        else:
            logger.info(f"Schedule mode: Daily fixed times at {', '.join(self.scheduled_times)}")

        # Step 1: Run on startup if configured
        if self.run_on_startup:
            logger.info("Executing immediate startup run...")
            self.run_job()
            if max_runs is not None and self.total_runs_completed >= max_runs:
                logger.info(f"Reached max runs limit ({max_runs}). Exiting daemon.")
                return

        # Step 2: Main loop
        while not self._stop_event.is_set():
            next_run = self.get_next_run_time()
            if not next_run:
                logger.warning("No next run time could be calculated. Sleeping 60s...")
                if self._stop_event.wait(timeout=60):
                    break
                continue

            wait_seconds = max(0.0, (next_run - datetime.now()).total_seconds())
            logger.info(f"Next scheduled run at: {next_run.strftime('%Y-%m-%d %H:%M:%S')} (in {wait_seconds:.1f}s)")

            # Wait until next run time in interruptible increments
            if self._stop_event.wait(timeout=wait_seconds):
                logger.info("Daemon sleep interrupted by stop signal.")
                break

            # Execute job
            if not self._stop_event.is_set():
                self.run_job()
                # Ensure clock has advanced past next_run to prevent sub-second duplicate execution
                now = datetime.now()
                if now <= next_run:
                    delay = max(0.05, (next_run - now).total_seconds() + 0.1)
                    if self._stop_event.wait(timeout=delay):
                        break

            if max_runs is not None and self.total_runs_completed >= max_runs:
                logger.info(f"Reached max runs limit ({max_runs}). Exiting daemon.")
                break

        logger.info("Scheduler daemon stopped cleanly.")


def main():
    parser = argparse.ArgumentParser(description="Baku Estate AI Autonomous Scheduler Daemon")
    parser.add_argument("--times", type=str, default=SCHEDULE_TIMES,
                        help="Comma-separated fixed times (e.g. '12:30,19:30')")
    parser.add_argument("--interval", type=float, default=SCHEDULE_INTERVAL_HOURS,
                        help="Repeat interval in hours (overrides --times if > 0)")
    parser.add_argument("--pages", type=int, default=SCHEDULE_PAGES,
                        help="Number of pages to scrape per scheduled run")
    parser.add_argument("--limit", type=int, default=SCHEDULE_LIMIT,
                        help="Max listings to process into videos per run")
    parser.add_argument("--no-startup-run", action="store_true",
                        help="Do not execute immediately upon starting daemon")
    parser.add_argument("--once", action="store_true",
                        help="Execute single run immediately and exit")
    parser.add_argument("--live-dispatch", action="store_true",
                        help="Dispatch videos live to Telegram instead of mock")
    parser.add_argument("--allow-agents", action="store_true",
                        help="Allow agent listings (defaults to owner only)")

    args = parser.parse_args()

    parsed_times = parse_schedule_times(args.times)

    scheduler = BakuEstateScheduler(
        scheduled_times=parsed_times,
        interval_hours=args.interval,
        pages=args.pages,
        limit=args.limit,
        run_on_startup=not args.no_startup_run,
        owner_only=not args.allow_agents,
        mock_dispatch=not args.live_dispatch,
        db_path=DB_PATH
    )

    if args.once:
        logger.info("Running single tick (--once)...")
        scheduler.run_job()
        return

    try:
        scheduler.start()
    except KeyboardInterrupt:
        scheduler.stop()


if __name__ == "__main__":
    main()
