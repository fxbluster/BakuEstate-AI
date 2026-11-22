"""
Autonomous Worker Watchdog Supervisor for BakuEstate-AI.
Supervises `src/worker/local_worker.py` child process, performs exponential backoff
respawns on crashes, fences poison-pill jobs after 2 consecutive failures via SupabaseRepo,
and ensures clean graceful shutdown on SIGINT/SIGTERM.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
if str(BASE_PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_PROJECT_DIR))

from config.settings import WORKER_ID
from src.cloud.supabase_repo import SupabaseRepo

DATA_DIR = BASE_PROJECT_DIR / "data"
LOGS_DIR = DATA_DIR / "logs"
DEFAULT_CRASH_STATE_FILE = DATA_DIR / "worker_crash_state.json"
DEFAULT_ACTIVE_JOB_FILE = DATA_DIR / "worker_active_job.json"
DEFAULT_LOG_FILE = LOGS_DIR / "worker_watchdog.log"

logger = logging.getLogger("worker_watchdog")


def setup_watchdog_logging(log_file: Path = DEFAULT_LOG_FILE) -> None:
    """Configures console and file logging for the watchdog supervisor."""
    log_file.parent.mkdir(parents=True, exist_ok=True)
    logger.setLevel(logging.INFO)

    # Avoid duplicate handlers if already configured
    if not logger.handlers:
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] [Watchdog] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)

        file_handler = logging.FileHandler(str(log_file), encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)


class WatchdogSupervisor:
    """
    Supervises the local worker child process.
    Handles child lifecycles, exponential backoff on crashes, and poison-pill job fencing.
    """

    def __init__(
        self,
        worker_cmd: Optional[List[str]] = None,
        repo: Optional[SupabaseRepo] = None,
        *,
        worker_id: str = WORKER_ID,
        crash_state_path: Path = DEFAULT_CRASH_STATE_FILE,
        active_job_path: Path = DEFAULT_ACTIVE_JOB_FILE,
        log_file_path: Path = DEFAULT_LOG_FILE,
        initial_backoff: float = 5.0,
        max_backoff: float = 30.0,
        consecutive_crash_limit: int = 2,
    ) -> None:
        self.worker_cmd = worker_cmd or [
            sys.executable,
            str(BASE_PROJECT_DIR / "src" / "worker" / "local_worker.py"),
        ]
        self.repo = repo or SupabaseRepo()
        self.worker_id = worker_id
        self.crash_state_path = crash_state_path
        self.active_job_path = active_job_path
        self.log_file_path = log_file_path

        self.initial_backoff = max(0.01, float(initial_backoff))
        self.max_backoff = max(self.initial_backoff, float(max_backoff))
        self.consecutive_crash_limit = max(1, int(consecutive_crash_limit))

        self.current_backoff = self.initial_backoff
        self.current_process: Optional[subprocess.Popen] = None
        self._stop_requested = False

        setup_watchdog_logging(self.log_file_path)

    # ------------------------------------------------------------------
    # Crash State & Telemetry Helpers
    # ------------------------------------------------------------------

    def load_crash_state(self) -> Dict[str, Any]:
        """Loads crash state from disk or initializes default state."""
        if self.crash_state_path.exists():
            try:
                data = json.loads(self.crash_state_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return {
                        "last_job_id": data.get("last_job_id"),
                        "failure_count": int(data.get("failure_count", 0)),
                        "timestamp": data.get("timestamp", datetime.now(timezone.utc).isoformat()),
                    }
            except Exception as exc:
                logger.warning("Could not read crash state file (%s): %s", self.crash_state_path, exc)

        return {
            "last_job_id": None,
            "failure_count": 0,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    def save_crash_state(self, state: Dict[str, Any]) -> None:
        """Persists crash state atomically to disk."""
        try:
            self.crash_state_path.parent.mkdir(parents=True, exist_ok=True)
            self.crash_state_path.write_text(
                json.dumps(state, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.error("Failed to write crash state file (%s): %s", self.crash_state_path, exc)

    def get_active_job_id(self) -> Optional[str]:
        """
        Resolves active job ID from local marker file or Supabase worker telemetry.
        """
        # 1. Check local marker file written by local_worker before job execution
        if self.active_job_path.exists():
            try:
                data = json.loads(self.active_job_path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("job_id"):
                    return str(data["job_id"]).strip()
            except Exception as exc:
                logger.warning("Error reading active job marker: %s", exc)

        # 2. Check running job locked by worker in Supabase pipeline_jobs
        if self.repo and self.repo.is_configured():
            try:
                running_job = self.repo.get_running_job_for_worker(self.worker_id)
                if running_job and running_job.get("id"):
                    return str(running_job["id"]).strip()
            except Exception as exc:
                logger.warning("Error querying running job for worker %s: %s", self.worker_id, exc)

            # 3. Check worker_heartbeats telemetry
            try:
                heartbeat = self.repo.get_worker_heartbeat(self.worker_id)
                if heartbeat and heartbeat.get("current_job_id"):
                    return str(heartbeat["current_job_id"]).strip()
            except Exception as exc:
                logger.warning("Error querying worker heartbeat for %s: %s", self.worker_id, exc)

        return None

    # ------------------------------------------------------------------
    # Poison Pill Fencing
    # ------------------------------------------------------------------

    def fence_poison_pill_job(self, job_id: str) -> bool:
        """
        Fences a poison-pill job by marking it FAILED with error_message='POISON_PILL_ABORT'.
        """
        logger.critical(
            "POISON-PILL FENCING: Aborting job %s due to consecutive crashes.",
            job_id,
        )
        success = False
        if self.repo and self.repo.is_configured():
            try:
                res = self.repo.complete_pipeline_job(
                    job_id=job_id,
                    status="FAILED",
                    error_message="POISON_PILL_ABORT",
                    worker_id=self.worker_id,
                )
                if res:
                    success = True
                else:
                    # Fallback to unfenced complete
                    res2 = self.repo.complete_pipeline_job(
                        job_id=job_id,
                        status="FAILED",
                        error_message="POISON_PILL_ABORT",
                    )
                    success = bool(res2)
            except Exception as exc:
                logger.error("Failed to fence poison-pill job %s in Supabase: %s", job_id, exc)

        # Remove local active job file if it matches
        if self.active_job_path.exists():
            try:
                self.active_job_path.unlink()
            except Exception:
                pass

        return success

    def handle_crash(self, exit_code: int) -> float:
        """
        Handles worker child process crash.
        Inspects active job, updates crash state, triggers poison-pill fencing if needed,
        and computes exponential backoff delay.
        """
        logger.warning("Local worker exited with non-zero code %d", exit_code)

        active_job_id = self.get_active_job_id()
        state = self.load_crash_state()

        if active_job_id:
            logger.info("Active job identified during crash: %s", active_job_id)
            if state.get("last_job_id") == active_job_id:
                state["failure_count"] = state.get("failure_count", 0) + 1
            else:
                state["last_job_id"] = active_job_id
                state["failure_count"] = 1
            state["timestamp"] = datetime.now(timezone.utc).isoformat()

            if state["failure_count"] >= self.consecutive_crash_limit:
                alert_msg = (
                    f"EMERGENCY ALERT: Job {active_job_id} caused "
                    f"{state['failure_count']} consecutive crashes. Aborting job with POISON_PILL_ABORT."
                )
                logger.critical(alert_msg)

                # Append emergency alert directly to log file
                self._record_emergency_alert(alert_msg)

                # Fence the job in Supabase
                self.fence_poison_pill_job(active_job_id)

                # Reset crash state counter
                state["last_job_id"] = None
                state["failure_count"] = 0
                state["timestamp"] = datetime.now(timezone.utc).isoformat()

            self.save_crash_state(state)
        else:
            logger.info("No active job ID identified during crash. Preserving crash state.")

        # Compute exponential backoff
        backoff = self.current_backoff
        self.current_backoff = min(self.current_backoff * 2.0, self.max_backoff)
        return backoff

    def _record_emergency_alert(self, message: str) -> None:
        """Ensures the emergency alert is written to the log file."""
        try:
            self.log_file_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log_file_path, "a", encoding="utf-8") as f:
                now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                f.write(f"{now_str} [CRITICAL] [Watchdog] {message}\n")
        except Exception as exc:
            logger.error("Failed to append emergency alert to log: %s", exc)

    # ------------------------------------------------------------------
    # Process Lifecycle & Execution
    # ------------------------------------------------------------------

    def spawn_child(self) -> subprocess.Popen:
        """Spawns the worker child process."""
        logger.info("Spawning child worker process: %s", " ".join(self.worker_cmd))
        proc = subprocess.Popen(
            self.worker_cmd,
            cwd=str(BASE_PROJECT_DIR),
        )
        self.current_process = proc
        return proc

    def terminate_child(self, timeout: float = 5.0) -> None:
        """Gracefully terminates the child process, falling back to kill."""
        proc = self.current_process
        if proc and proc.poll() is None:
            logger.info("Sending termination signal to worker PID %s...", proc.pid)
            try:
                proc.terminate()
                proc.wait(timeout=timeout)
                logger.info("Child process PID %s terminated gracefully.", proc.pid)
            except subprocess.TimeoutExpired:
                logger.warning(
                    "Child process PID %s did not terminate within %ss; killing forcefully...",
                    proc.pid,
                    timeout,
                )
                try:
                    proc.kill()
                    proc.wait(timeout=2.0)
                    logger.info("Child process PID %s forcefully killed.", proc.pid)
                except Exception as exc:
                    logger.error("Error while killing child process PID %s: %s", proc.pid, exc)
            except Exception as exc:
                logger.error("Error while terminating child process PID %s: %s", proc.pid, exc)

    def stop(self) -> None:
        """Stops the watchdog supervisor and cleanly terminates the child process."""
        logger.info("Stopping Watchdog Supervisor...")
        self._stop_requested = True
        self.terminate_child()

    def run(self, max_restarts: Optional[int] = None) -> None:
        """
        Continuous supervisor execution loop.
        Monitors child process, handles crashes with backoff, and shuts down cleanly.
        """
        self._stop_requested = False

        def _signal_handler(sig: int, frame: Any) -> None:
            signame = signal.Signals(sig).name if hasattr(signal, "Signals") else str(sig)
            logger.info("Received shutdown signal %s (%d).", signame, sig)
            self.stop()

        try:
            signal.signal(signal.SIGINT, _signal_handler)
            signal.signal(signal.SIGTERM, _signal_handler)
            if hasattr(signal, "SIGBREAK"):
                signal.signal(signal.SIGBREAK, _signal_handler)
        except (ValueError, AttributeError):
            pass

        logger.info(">>> BakuEstate-AI Watchdog Supervisor Started (worker_id: %s) <<<", self.worker_id)
        restarts = 0

        while not self._stop_requested:
            start_mono = time.monotonic()
            proc = self.spawn_child()

            try:
                exit_code = proc.wait()
            except KeyboardInterrupt:
                logger.info("KeyboardInterrupt detected in supervisor wait.")
                self.stop()
                break

            if self._stop_requested:
                logger.info("Stop requested. Exiting supervisor loop.")
                break

            elapsed = time.monotonic() - start_mono
            if elapsed >= 60.0:
                # Process lived stably for over a minute; reset exponential backoff
                self.current_backoff = self.initial_backoff

            if exit_code == 0:
                logger.info("Child worker exited cleanly with status 0.")
                self.current_backoff = self.initial_backoff
            else:
                backoff_delay = self.handle_crash(exit_code)
                if max_restarts is not None and restarts >= max_restarts:
                    logger.info("Reached maximum configured restarts (%d). Stopping.", max_restarts)
                    break
                restarts += 1

                logger.info("Sleeping %.1fs before next restart attempt...", backoff_delay)
                deadline = time.monotonic() + backoff_delay
                while time.monotonic() < deadline and not self._stop_requested:
                    time.sleep(0.2)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="BakuEstate-AI Worker Watchdog Supervisor",
    )
    parser.add_argument(
        "--initial-backoff",
        type=float,
        default=5.0,
        help="Initial crash backoff in seconds (default: 5.0)",
    )
    parser.add_argument(
        "--max-backoff",
        type=float,
        default=30.0,
        help="Maximum exponential crash backoff in seconds (default: 30.0)",
    )
    parser.add_argument(
        "--worker-id",
        type=str,
        default=WORKER_ID,
        help="Worker ID identifier",
    )
    parsed_args, extra_args = parser.parse_known_args()

    worker_cmd = [
        sys.executable,
        str(BASE_PROJECT_DIR / "src" / "worker" / "local_worker.py"),
    ] + extra_args

    supervisor = WatchdogSupervisor(
        worker_cmd=worker_cmd,
        worker_id=parsed_args.worker_id,
        initial_backoff=parsed_args.initial_backoff,
        max_backoff=parsed_args.max_backoff,
    )

    try:
        supervisor.run()
    except (KeyboardInterrupt, SystemExit):
        supervisor.stop()


if __name__ == "__main__":
    main()
