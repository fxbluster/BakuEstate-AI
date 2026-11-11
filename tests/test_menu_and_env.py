"""
Unit and integration tests for zero-dependency .env loader, database query helpers,
and interactive terminal menu operations.
"""

import unittest
from unittest.mock import MagicMock, patch
import sys
from pathlib import Path
import tempfile
import shutil
import os

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["TEST_MODE"] = "1"

from config.settings import load_env, save_env_value
from src.database import (
    init_db,
    save_listing,
    record_generated_video,
    mark_video_dispatched,
    get_recent_listings,
    get_recent_videos,
    get_google_accounts
)
from interactive_menu import (
    action_run_pipeline_now,
    action_process_specific_id,
    action_google_accounts_setup,
    action_telegram_env_setup,
    action_start_scheduler_daemon,
    action_view_leads_and_videos,
    main_loop
)


class TestMenuAndEnvModule(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.env_file = Path(self.test_dir) / ".env.test"
        self.db_path = Path(self.test_dir) / "test_menu.sqlite"
        init_db(self.db_path)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_load_env_parser(self):
        # Write test .env content with quotes, comments, escapes
        test_content = (
            "# This is a comment\n"
            "TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11\n"
            "TELEGRAM_CHAT_ID=-100987654321\n"
            "TELEGRAM_MOCK_DISPATCH=\"false\"\n"
            "MIN_PRICE='150000'\n"
            "MAX_PRICE=500000\n"
            "CITY_ID=1\n"
            "INVALID_LINE_NO_EQUALS\n"
            "   \n"
        )
        with open(self.env_file, "w", encoding="utf-8") as f:
            f.write(test_content)

        parsed = load_env(self.env_file, override=True)

        self.assertEqual(parsed.get("TELEGRAM_BOT_TOKEN"), "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11")
        self.assertEqual(parsed.get("TELEGRAM_CHAT_ID"), "-100987654321")
        self.assertEqual(parsed.get("TELEGRAM_MOCK_DISPATCH"), "false")
        self.assertEqual(parsed.get("MIN_PRICE"), "150000")
        self.assertEqual(parsed.get("MAX_PRICE"), "500000")
        self.assertEqual(parsed.get("CITY_ID"), "1")
        self.assertNotIn("INVALID_LINE_NO_EQUALS", parsed)

    def test_load_env_nonexistent(self):
        non_existent = Path(self.test_dir) / "does_not_exist.env"
        parsed = load_env(non_existent)
        self.assertEqual(parsed, {})

    def test_save_env_value_and_update(self):
        # Save new values
        save_env_value("TEST_KEY_1", "InitialValue", self.env_file)
        save_env_value("TEST_KEY_2", "SecondValue", self.env_file)

        parsed = load_env(self.env_file)
        self.assertEqual(parsed.get("TEST_KEY_1"), "InitialValue")
        self.assertEqual(parsed.get("TEST_KEY_2"), "SecondValue")

        # Update existing value
        save_env_value("TEST_KEY_1", "UpdatedValue", self.env_file)
        parsed2 = load_env(self.env_file)
        self.assertEqual(parsed2.get("TEST_KEY_1"), "UpdatedValue")
        self.assertEqual(parsed2.get("TEST_KEY_2"), "SecondValue")

    def test_database_recent_helpers(self):
        # Insert mock listing
        item = {
            "bina_id": "778899",
            "title": "3 otaqlı mənzil Nərimanovda",
            "price": 245000,
            "currency": "AZN",
            "owner_phone": "+994501234567",
            "is_owner": True,
            "status": "NEW"
        }
        listing_id = save_listing(item, self.db_path)

        recent_listings = get_recent_listings(limit=5, db_path=self.db_path)
        self.assertTrue(len(recent_listings) >= 1)
        self.assertEqual(recent_listings[0]["bina_id"], "778899")

        # Insert mock video
        vid_id = record_generated_video(
            listing_id=listing_id,
            video_path="/mock/path/video_778899.mp4",
            duration_seconds=22.5,
            db_path=self.db_path
        )
        mark_video_dispatched(listing_id, telegram_message_id="998811", db_path=self.db_path)

        recent_videos = get_recent_videos(limit=5, db_path=self.db_path)
        self.assertTrue(len(recent_videos) >= 1)
        self.assertEqual(recent_videos[0]["bina_id"], "778899")
        self.assertEqual(recent_videos[0]["telegram_message_id"], "998811")

        # Accounts
        accounts = get_google_accounts(self.db_path)
        self.assertEqual(len(accounts), 6)

    @patch("interactive_menu.BakuEstatePipeline")
    def test_action_run_pipeline_now(self, mock_pipe_cls):
        mock_pipe_inst = MagicMock()
        mock_pipe_inst.run_full_pipeline.return_value = [
            {"bina_id": "111", "video_path": "v1.mp4", "duration": 15.0}
        ]
        mock_pipe_cls.return_value = mock_pipe_inst

        # Run action in test_mode
        action_run_pipeline_now(test_mode=True, limit_input=2)
        mock_pipe_inst.run_full_pipeline.assert_called_once_with(pages=1, limit=2)

    @patch("interactive_menu.BakuEstatePipeline")
    def test_action_process_specific_id(self, mock_pipe_cls):
        mock_pipe_inst = MagicMock()
        mock_pipe_inst.run_full_pipeline.return_value = [
            {"bina_id": "555666", "video_path": "v555.mp4", "duration": 18.0}
        ]
        mock_pipe_cls.return_value = mock_pipe_inst

        action_process_specific_id(test_mode=True, id_input="555666")
        mock_pipe_inst.run_full_pipeline.assert_called_once_with(pages=1, limit=1, specific_id="555666")

    def test_action_process_specific_id_empty(self):
        # With empty ID, it should not crash and should exit early
        action_process_specific_id(test_mode=True, id_input="")

    @patch("interactive_menu.setup_all_profiles")
    def test_action_google_accounts_setup(self, mock_setup):
        mock_setup.return_value = [f"acc_{i+1}" for i in range(6)]
        action_google_accounts_setup(test_mode=True, choice_input="1")
        mock_setup.assert_called_once()

    def test_action_telegram_env_setup(self):
        # Test updating configuration via action with isolated env file
        with patch("interactive_menu.ENV_PATH", self.env_file):
            action_telegram_env_setup(test_mode=True, inputs={
                "token": "999888:TESTTOKEN",
                "chat_id": "-100222333444",
                "mock": "false",
                "min_price": "80000",
                "max_price": "300000",
                "city_id": "1"
            })
            self.assertEqual(os.environ.get("TELEGRAM_BOT_TOKEN"), "999888:TESTTOKEN")
            self.assertEqual(os.environ.get("TELEGRAM_CHAT_ID"), "-100222333444")
            self.assertEqual(os.environ.get("TELEGRAM_MOCK_DISPATCH"), "false")

    @patch("interactive_menu.BakuEstateScheduler")
    def test_action_start_scheduler_daemon_tick(self, mock_sched_cls):
        mock_sched_inst = MagicMock()
        mock_sched_cls.return_value = mock_sched_inst

        # Subchoice 3: single tick
        action_start_scheduler_daemon(test_mode=True, subchoice_input="3")
        mock_sched_inst.run_job.assert_called_once()

    def test_action_view_leads_and_videos(self):
        action_view_leads_and_videos(test_mode=True, subaction="0")

    def test_load_env_inline_comments_and_hashes(self):
        # Verify that inline comments are stripped and # inside quotes or values is preserved
        test_content = (
            "CITY_ID=1 # Baku city code\n"
            "MIN_PRICE=\"200000\" # Azerbaijani Manat\n"
            "TELEGRAM_BOT_TOKEN='bot123456:ABC-DEF' # Active bot\n"
            "BANNER_COLOR=#10B981\n"
            "HASH_IN_QUOTES=\"secret#token#val\" # Trailing comment\n"
            "EMPTY_VAL=\n"
        )
        with open(self.env_file, "w", encoding="utf-8") as f:
            f.write(test_content)

        parsed = load_env(self.env_file, override=True)
        self.assertEqual(parsed.get("CITY_ID"), "1")
        self.assertEqual(parsed.get("MIN_PRICE"), "200000")
        self.assertEqual(parsed.get("TELEGRAM_BOT_TOKEN"), "bot123456:ABC-DEF")
        self.assertEqual(parsed.get("BANNER_COLOR"), "#10B981")
        self.assertEqual(parsed.get("HASH_IN_QUOTES"), "secret#token#val")
        self.assertEqual(parsed.get("EMPTY_VAL"), "")

    @patch("interactive_menu.BakuEstatePipeline")
    def test_action_process_specific_id_url(self, mock_pipe_cls):
        mock_pipe_inst = MagicMock()
        mock_pipe_inst.run_full_pipeline.return_value = [
            {"bina_id": "6525612", "video_path": "v652.mp4", "duration": 18.0}
        ]
        mock_pipe_cls.return_value = mock_pipe_inst

        # User pastes full URL instead of raw ID
        action_process_specific_id(test_mode=True, id_input="https://bina.az/items/6525612")
        mock_pipe_inst.run_full_pipeline.assert_called_once_with(pages=1, limit=1, specific_id="6525612")

    @patch("interactive_menu.launch_account_for_login")
    def test_action_google_accounts_setup_manual_login(self, mock_launch):
        action_google_accounts_setup(test_mode=True, choice_input="2", acc_input="3")
        mock_launch.assert_called_once_with("acc_3", headless=True)

    @patch("interactive_menu.subprocess.run")
    def test_action_run_tests_success_and_failure(self, mock_run):
        # Case 1: Success
        mock_res_ok = MagicMock()
        mock_res_ok.returncode = 0
        mock_run.return_value = mock_res_ok

        from interactive_menu import action_run_tests
        res = action_run_tests(test_mode=True)
        self.assertTrue(res)

        # Case 2: Failure
        mock_res_fail = MagicMock()
        mock_res_fail.returncode = 1
        mock_run.return_value = mock_res_fail
        res_fail = action_run_tests(test_mode=True)
        self.assertFalse(res_fail)

    @patch("interactive_menu.os.system")
    def test_action_view_leads_and_videos_explorer(self, mock_sys):
        action_view_leads_and_videos(test_mode=True, subaction="1")
        if sys.platform == "win32":
            mock_sys.assert_called_once()

    def test_main_loop_non_interactive(self):
        # Non-interactive loop simply prints the banner and menu and returns
        main_loop(interactive=False)

    @patch("interactive_menu.BakuEstatePipeline")
    @patch("src.google_pool.brave_gemini_client.is_brave_debugging_open", return_value=True)
    def test_action_run_gemini_brave_mode(self, mock_debug, mock_pipe_cls):
        from interactive_menu import action_run_gemini_brave_mode
        mock_pipe_inst = MagicMock()
        mock_pipe_cls.return_value = mock_pipe_inst
        action_run_gemini_brave_mode(test_mode=True, limit_input=2)
        mock_pipe_cls.assert_called_once()
        mock_pipe_inst.run_full_pipeline.assert_called_once_with(pages=1, limit=2)


if __name__ == "__main__":
    unittest.main()
