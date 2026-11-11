"""Unit tests for google_pool module."""

import unittest
import tempfile
from pathlib import Path
from datetime import datetime, timezone, timedelta

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.google_pool.setup_accounts import setup_all_profiles
from src.google_pool.pool_manager import GooglePoolManager
from src.database import get_connection

class TestGooglePool(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.profiles_dir = Path(self.temp_dir.name) / "profiles"
        self.db_path = Path(self.temp_dir.name) / "test_pool.sqlite"
        setup_all_profiles(self.profiles_dir, self.db_path)
        self.manager = GooglePoolManager(
            profiles_dir=self.profiles_dir,
            db_path=self.db_path,
            cooldown_seconds=600,
            daily_quota=5
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_setup_created_folders(self):
        for i in range(1, 7):
            folder = self.profiles_dir / f"acc_{i}"
            self.assertTrue(folder.exists() and folder.is_dir())

    def test_round_robin_acquisition_and_cooldown(self):
        acc1 = self.manager.acquire_account()
        self.assertIsNotNone(acc1)
        self.assertEqual(acc1["profile_name"], "acc_1")

        # Release acc1 with cooldown
        self.manager.release_account("acc_1", success=True, custom_cooldown=600)

        # Next acquisition should be acc_2 (round-robin)
        acc2 = self.manager.acquire_account()
        self.assertIsNotNone(acc2)
        self.assertEqual(acc2["profile_name"], "acc_2")

        # acc_1 should not be acquired again while in cooldown
        pool_status = self.manager.get_pool_status()
        acc1_status = next(a for a in pool_status if a["profile_name"] == "acc_1")
        self.assertFalse(acc1_status["is_available"])
        self.assertGreater(acc1_status["cooldown_remaining_seconds"], 0)
        self.assertEqual(acc1_status["quota_used_today"], 1)

    def test_quota_limit_and_reset(self):
        conn = get_connection(self.db_path)
        # Set acc_1 quota to max
        with conn:
            conn.execute("UPDATE google_accounts SET quota_used_today = max_daily_quota WHERE profile_name = 'acc_1'")
        conn.close()

        status = self.manager.get_pool_status()
        acc1_status = next(a for a in status if a["profile_name"] == "acc_1")
        self.assertFalse(acc1_status["is_available"])

        # Reset quotas
        self.manager.reset_daily_quotas()
        status_after = self.manager.get_pool_status()
        acc1_after = next(a for a in status_after if a["profile_name"] == "acc_1")
        self.assertEqual(acc1_after["quota_used_today"], 0)

if __name__ == "__main__":
    unittest.main()
