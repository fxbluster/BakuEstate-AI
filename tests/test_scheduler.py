"""
Unit and integration tests for Baku Estate AI Scheduler Daemon.
"""

import unittest
from unittest.mock import MagicMock, patch
from datetime import datetime, timedelta
import sys
from pathlib import Path
import tempfile
import shutil
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.scheduler import (
    parse_schedule_times,
    calculate_next_run,
    calculate_next_run_interval,
    BakuEstateScheduler
)


class TestSchedulerModule(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_path = Path(self.test_dir) / "test_scheduler.sqlite"

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_parse_schedule_times(self):
        # Valid cases with deduplication & chronological sorting
        res = parse_schedule_times("12:30, 19:30, 08:00, 12:30")
        self.assertEqual(res, ["08:00", "12:30", "19:30"])

        # Semicolon and whitespace separators
        res_semi = parse_schedule_times("12:30; 19:30")
        self.assertEqual(res_semi, ["12:30", "19:30"])

        # Edge cases & invalid formats filtered out
        res2 = parse_schedule_times("25:00, abc, 14:75, 12:05, , :40")
        self.assertEqual(res2, ["12:05"])

        # Empty string
        self.assertEqual(parse_schedule_times(""), [])

    def test_calculate_next_run_later_today(self):
        now = datetime(2026, 11, 3, 10, 0, 0)
        times = ["12:30", "19:30"]
        next_run = calculate_next_run(now, times)
        self.assertEqual(next_run, datetime(2026, 11, 3, 12, 30, 0))

    def test_calculate_next_run_tomorrow(self):
        now = datetime(2026, 11, 3, 21, 0, 0)
        times = ["12:30", "19:30"]
        next_run = calculate_next_run(now, times)
        self.assertEqual(next_run, datetime(2026, 11, 4, 12, 30, 0))

    def test_calculate_next_run_multiple_picks_earliest(self):
        now = datetime(2026, 11, 3, 15, 0, 0)
        times = ["12:30", "19:30", "16:00"]
        next_run = calculate_next_run(now, times)
        self.assertEqual(next_run, datetime(2026, 11, 3, 16, 0, 0))

    def test_calculate_next_run_empty(self):
        now = datetime.now()
        self.assertIsNone(calculate_next_run(now, []))

    def test_calculate_next_run_interval(self):
        now = datetime(2026, 11, 3, 12, 0, 0)
        next_run = calculate_next_run_interval(now, 2.5)
        self.assertEqual(next_run, datetime(2026, 11, 3, 14, 30, 0))

    def test_scheduler_init_and_properties(self):
        scheduler = BakuEstateScheduler(
            scheduled_times=["12:30"],
            interval_hours=0.0,
            pages=2,
            limit=5,
            run_on_startup=False,
            db_path=self.db_path
        )
        self.assertTrue(scheduler.is_running)
        self.assertEqual(scheduler.pages, 2)
        self.assertEqual(scheduler.limit, 5)
        self.assertEqual(scheduler.scheduled_times, ["12:30"])
        self.assertEqual(scheduler.total_runs_completed, 0)
        self.assertIsNone(scheduler.last_run_time)
        # Verify mock_dispatch defaults to configured settings value
        from config.settings import TELEGRAM_MOCK_DISPATCH
        self.assertEqual(scheduler.mock_dispatch, TELEGRAM_MOCK_DISPATCH)

        scheduler.stop()
        self.assertFalse(scheduler.is_running)

    @patch("src.scheduler.BakuEstatePipeline")
    def test_scheduler_run_job_success(self, mock_pipeline_cls):
        mock_pipeline_inst = MagicMock()
        mock_pipeline_inst.run_full_pipeline.return_value = [
            {"bina_id": "12345", "video_path": "path/to/video.mp4", "duration": 25.0}
        ]
        mock_pipeline_cls.return_value = mock_pipeline_inst

        scheduler = BakuEstateScheduler(
            pages=1,
            limit=1,
            run_on_startup=False,
            db_path=self.db_path
        )
        results = scheduler.run_job()

        self.assertEqual(len(results), 1)
        self.assertEqual(scheduler.total_runs_completed, 1)
        self.assertIsNotNone(scheduler.last_run_time)
        mock_pipeline_inst.run_full_pipeline.assert_called_once_with(pages=1, limit=1)

    @patch("sentry_sdk.capture_exception")
    @patch("src.scheduler.BakuEstatePipeline")
    def test_scheduler_run_job_exception_handling(self, mock_pipeline_cls, mock_capture_exc):
        mock_pipeline_inst = MagicMock()
        mock_pipeline_inst.run_full_pipeline.side_effect = RuntimeError("Scraper network timeout")
        mock_pipeline_cls.return_value = mock_pipeline_inst

        scheduler = BakuEstateScheduler(
            pages=1,
            limit=1,
            run_on_startup=False,
            db_path=self.db_path
        )
        # Should catch error, log it, capture in Sentry, and return empty list instead of crashing
        results = scheduler.run_job()
        self.assertEqual(results, [])
        self.assertEqual(scheduler.total_runs_completed, 0)
        mock_capture_exc.assert_called_once()

    @patch("src.scheduler.BakuEstatePipeline")
    def test_scheduler_start_max_runs(self, mock_pipeline_cls):
        mock_pipeline_inst = MagicMock()
        mock_pipeline_inst.run_full_pipeline.return_value = []
        mock_pipeline_cls.return_value = mock_pipeline_inst

        scheduler = BakuEstateScheduler(
            scheduled_times=["12:30"],
            interval_hours=0.0,
            run_on_startup=True,
            db_path=self.db_path
        )
        # Should execute startup run and immediately exit because max_runs=1
        scheduler.start(max_runs=1)
        self.assertEqual(scheduler.total_runs_completed, 1)


if __name__ == "__main__":
    unittest.main()
