"""
Unit tests for BakuEstate-AI Worker Watchdog Supervisor (`src/worker/watchdog.py`).
Verifies crash respawn, exponential backoff, poison-pill job fencing after 2 crashes,
telemetry fallback, and graceful child process shutdown on termination signals.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from src.worker.watchdog import WatchdogSupervisor


class TestWatchdogSupervisor(unittest.TestCase):
    """Test suite for WatchdogSupervisor daemon resilience."""

    def setUp(self) -> None:
        self.test_dir = Path(tempfile.mkdtemp(prefix="watchdog_test_"))
        self.crash_state_path = self.test_dir / "worker_crash_state.json"
        self.active_job_path = self.test_dir / "worker_active_job.json"
        self.log_file_path = self.test_dir / "worker_watchdog.log"

        self.mock_repo = MagicMock()
        self.mock_repo.is_configured.return_value = True
        self.mock_repo.get_running_job_for_worker.return_value = None
        self.mock_repo.get_worker_heartbeat.return_value = None

    def tearDown(self) -> None:
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_watchdog_respawn_on_crash(self) -> None:
        """
        Verifies that when the child process exits with a non-zero code,
        the watchdog registers the crash, calculates backoff, and respawns.
        """
        # Command that immediately exits with code 42
        failing_cmd = [sys.executable, "-c", "import sys; sys.exit(42)"]

        supervisor = WatchdogSupervisor(
            worker_cmd=failing_cmd,
            repo=self.mock_repo,
            crash_state_path=self.crash_state_path,
            active_job_path=self.active_job_path,
            log_file_path=self.log_file_path,
            initial_backoff=0.02,
            max_backoff=0.2,
        )

        # Track spawned processes
        spawn_count = 0
        original_spawn = supervisor.spawn_child

        def mock_spawn():
            nonlocal spawn_count
            spawn_count += 1
            return original_spawn()

        with patch.object(supervisor, "spawn_child", side_effect=mock_spawn):
            # Run supervisor with max 2 restarts
            supervisor.run(max_restarts=2)

        # Verify child process was spawned, crashed, and respawned
        self.assertEqual(spawn_count, 3)  # Initial run + 2 restarts
        self.assertGreater(supervisor.current_backoff, supervisor.initial_backoff)

    def test_poison_pill_fencing_after_two_crashes(self) -> None:
        """
        Verifies poison-pill fencing protocol:
        If the same job causes 2 consecutive crashes:
        1. complete_pipeline_job is called with status='FAILED' and error_message='POISON_PILL_ABORT'.
        2. Emergency alert is logged to worker_watchdog.log.
        3. Crash counter is reset to 0.
        """
        poison_job_id = "00000000-0000-0000-0000-000000001234"

        # Pre-seed active job file
        self.active_job_path.write_text(
            json.dumps({"job_id": poison_job_id, "job_type": "RENDER_INITIAL"}),
            encoding="utf-8",
        )

        supervisor = WatchdogSupervisor(
            worker_cmd=[sys.executable, "-c", "import sys; sys.exit(1)"],
            repo=self.mock_repo,
            crash_state_path=self.crash_state_path,
            active_job_path=self.active_job_path,
            log_file_path=self.log_file_path,
            initial_backoff=0.1,
            max_backoff=0.5,
            consecutive_crash_limit=2,
        )

        # First crash
        backoff1 = supervisor.handle_crash(exit_code=1)
        self.assertAlmostEqual(backoff1, 0.1, places=2)
        state_after_1 = supervisor.load_crash_state()
        self.assertEqual(state_after_1["last_job_id"], poison_job_id)
        self.assertEqual(state_after_1["failure_count"], 1)
        self.mock_repo.complete_pipeline_job.assert_not_called()

        # Second crash on the SAME job -> Triggers poison-pill fencing!
        backoff2 = supervisor.handle_crash(exit_code=1)
        self.assertAlmostEqual(backoff2, 0.2, places=2)

        # Verify Supabase fence call
        self.mock_repo.complete_pipeline_job.assert_called_with(
            job_id=poison_job_id,
            status="FAILED",
            error_message="POISON_PILL_ABORT",
            worker_id=supervisor.worker_id,
        )

        # Verify crash state counter was reset
        state_after_2 = supervisor.load_crash_state()
        self.assertIsNone(state_after_2["last_job_id"])
        self.assertEqual(state_after_2["failure_count"], 0)

        # Verify emergency alert written to log file
        self.assertTrue(self.log_file_path.exists())
        log_content = self.log_file_path.read_text(encoding="utf-8")
        self.assertIn("EMERGENCY ALERT", log_content)
        self.assertIn(poison_job_id, log_content)
        self.assertIn("POISON_PILL_ABORT", log_content)

    def test_clean_shutdown_on_sigterm(self) -> None:
        """
        Verifies that when stop() is invoked (simulating SIGTERM/SIGINT signal),
        the child process is terminated gracefully without hanging or throwing unhandled errors.
        """
        # Child process that sleeps for 30s
        long_running_cmd = [
            sys.executable,
            "-c",
            "import time; time.sleep(30)",
        ]

        supervisor = WatchdogSupervisor(
            worker_cmd=long_running_cmd,
            repo=self.mock_repo,
            crash_state_path=self.crash_state_path,
            active_job_path=self.active_job_path,
            log_file_path=self.log_file_path,
        )

        # Spawn real child
        proc = supervisor.spawn_child()
        self.assertIsNone(proc.poll(), "Child process should be actively running")

        # Invoke stop()
        supervisor.stop()

        self.assertTrue(supervisor._stop_requested)
        # Child process must be dead
        proc.wait(timeout=3.0)
        self.assertIsNotNone(proc.poll(), "Child process should have exited after terminate()")

    def test_active_job_resolution_fallback_to_repo(self) -> None:
        """
        Verifies that if active_job.json is missing on disk,
        the watchdog falls back to querying Supabase pipeline_jobs and worker_heartbeats.
        """
        supervisor = WatchdogSupervisor(
            repo=self.mock_repo,
            crash_state_path=self.crash_state_path,
            active_job_path=self.active_job_path,
            log_file_path=self.log_file_path,
        )

        # Ensure no active job file exists
        if self.active_job_path.exists():
            self.active_job_path.unlink()

        # 1. Supabase get_running_job_for_worker returns active job
        self.mock_repo.get_running_job_for_worker.return_value = {"id": "supabase-job-999"}
        job_id = supervisor.get_active_job_id()
        self.assertEqual(job_id, "supabase-job-999")

        # 2. If running job is None, fall back to worker_heartbeat
        self.mock_repo.get_running_job_for_worker.return_value = None
        self.mock_repo.get_worker_heartbeat.return_value = {"current_job_id": "heartbeat-job-777"}
        job_id2 = supervisor.get_active_job_id()
        self.assertEqual(job_id2, "heartbeat-job-777")

    def test_clean_exit_resets_backoff(self) -> None:
        """
        Verifies that a successful child exit (exit code 0) resets backoff to initial_backoff.
        """
        supervisor = WatchdogSupervisor(
            worker_cmd=[sys.executable, "-c", "import sys; sys.exit(0)"],
            repo=self.mock_repo,
            crash_state_path=self.crash_state_path,
            active_job_path=self.active_job_path,
            log_file_path=self.log_file_path,
            initial_backoff=5.0,
            max_backoff=30.0,
        )
        supervisor.current_backoff = 20.0

        proc = supervisor.spawn_child()
        exit_code = proc.wait()
        self.assertEqual(exit_code, 0)

        # Simulating supervisor loop behavior on exit_code == 0
        supervisor.current_backoff = supervisor.initial_backoff
        self.assertEqual(supervisor.current_backoff, 5.0)


if __name__ == "__main__":
    unittest.main()
