"""Unit tests for telegram_bot_service module."""

import unittest
from unittest.mock import patch, MagicMock
import tempfile
import json
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.dispatcher.telegram_crm import build_inline_keyboard
from src.dispatcher.telegram_bot_service import (
    TelegramBotService,
    get_main_keyboard,
    get_script_menu_keyboard,
    get_voice_menu_keyboard,
    get_published_keyboard,
    get_archived_keyboard
)
from src.database import init_db, save_listing, get_listing_by_bina_id


class TestTelegramBotService(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp())
        self.db_path = self.temp_dir / "test_bot.sqlite"
        init_db(self.db_path)

        self.sample_listing = {
            "bina_id": "777888",
            "title": "3 otaqlı mənzil",
            "price": 180000,
            "currency": "AZN",
            "location": "Xalqlar Dostluğu m.",
            "rooms": 3,
            "area": 85,
            "has_bill_of_sale": True,
            "is_owner": True,
            "owner_phone": "+994509998877",
            "status": "DISPATCHED"
        }
        save_listing(self.sample_listing, self.db_path)
        self.service = TelegramBotService(bot_token="test_token", chat_id="12345", db_path=self.db_path)

    def test_build_inline_keyboard(self):
        kb = build_inline_keyboard(self.sample_listing)
        self.assertIn("inline_keyboard", kb)
        rows = kb["inline_keyboard"]
        self.assertEqual(len(rows), 4)

        # Row 1: Rerender & Script
        self.assertEqual(rows[0][0]["callback_data"], "rerender_777888")
        self.assertEqual(rows[0][1]["callback_data"], "scriptmenu_777888")

        # Row 2: Voice & Keenable
        self.assertEqual(rows[1][0]["callback_data"], "voicemenu_777888")
        self.assertEqual(rows[1][1]["callback_data"], "keenable_777888")

        # Row 3: WhatsApp & Bina.az links
        self.assertIn("wa.me/994509998877", rows[2][0]["url"])
        self.assertIn("bina.az/items/777888", rows[2][1]["url"])

        # Row 4: Publish & Archive
        self.assertEqual(rows[3][0]["callback_data"], "publish_777888")
        self.assertEqual(rows[3][1]["callback_data"], "archive_777888")

    def test_submenus(self):
        script_kb = get_script_menu_keyboard("777888")
        self.assertEqual(len(script_kb["inline_keyboard"]), 3)
        self.assertIn("scriptset_777888_family", script_kb["inline_keyboard"][0][0]["callback_data"])

        voice_kb = get_voice_menu_keyboard("777888")
        self.assertEqual(len(voice_kb["inline_keyboard"]), 3)
        self.assertIn("voiceset_777888_eleven_male", voice_kb["inline_keyboard"][0][0]["callback_data"])

        pub_kb = get_published_keyboard("777888")
        self.assertIn("Paylaşıldı", pub_kb["inline_keyboard"][0][0]["text"])

        arch_kb = get_archived_keyboard("777888")
        self.assertIn("Arxivləşdirilib", arch_kb["inline_keyboard"][0][0]["text"])

    @patch.object(TelegramBotService, "answer_callback_query")
    def test_handle_keenable_callback(self, mock_answer):
        mock_answer.return_value = True
        cb_query = {
            "id": "cb_123",
            "data": "keenable_777888",
            "message": {"message_id": 100, "chat": {"id": 12345}}
        }
        res = self.service.handle_callback_query(cb_query)
        self.assertEqual(res["action"], "keenable")
        self.assertEqual(res["bina_id"], "777888")
        mock_answer.assert_called_once()
        self.assertTrue(mock_answer.call_args[1]["show_alert"])
        self.assertIn("KEENABLE BAZAR ANALİTİKASI", mock_answer.call_args[1]["text"])

    @patch.object(TelegramBotService, "answer_callback_query")
    @patch.object(TelegramBotService, "edit_message_reply_markup")
    def test_handle_scriptmenu_callback(self, mock_edit_markup, mock_answer):
        mock_answer.return_value = True
        mock_edit_markup.return_value = True
        cb_query = {
            "id": "cb_456",
            "data": "scriptmenu_777888",
            "message": {"message_id": 100, "chat": {"id": 12345}}
        }
        res = self.service.handle_callback_query(cb_query)
        self.assertEqual(res["action"], "scriptmenu")
        mock_edit_markup.assert_called_once()

    @patch.object(TelegramBotService, "answer_callback_query")
    @patch.object(TelegramBotService, "edit_message_reply_markup")
    def test_handle_voicemenu_callback(self, mock_edit_markup, mock_answer):
        mock_answer.return_value = True
        mock_edit_markup.return_value = True
        cb_query = {
            "id": "cb_789",
            "data": "voicemenu_777888",
            "message": {"message_id": 100, "chat": {"id": 12345}}
        }
        res = self.service.handle_callback_query(cb_query)
        self.assertEqual(res["action"], "voicemenu")
        mock_edit_markup.assert_called_once()

    @patch.object(TelegramBotService, "answer_callback_query")
    @patch.object(TelegramBotService, "edit_message_reply_markup")
    @patch.object(TelegramBotService, "send_message")
    def test_handle_publish_callback(self, mock_send, mock_edit_markup, mock_answer):
        mock_answer.return_value = True
        mock_edit_markup.return_value = True
        mock_send.return_value = 101
        cb_query = {
            "id": "cb_pub",
            "data": "publish_777888",
            "message": {"message_id": 100, "chat": {"id": 12345}}
        }
        res = self.service.handle_callback_query(cb_query)
        self.assertEqual(res["action"], "publish")
        self.assertEqual(res["status"], "PUBLISHED")

        # Verify DB status updated
        item = get_listing_by_bina_id("777888", self.db_path)
        self.assertEqual(item["status"], "PUBLISHED")
        mock_send.assert_called_once()

    @patch.object(TelegramBotService, "answer_callback_query")
    @patch.object(TelegramBotService, "edit_message_reply_markup")
    def test_handle_archive_callback(self, mock_edit_markup, mock_answer):
        mock_answer.return_value = True
        mock_edit_markup.return_value = True
        cb_query = {
            "id": "cb_arch",
            "data": "archive_777888",
            "message": {"message_id": 100, "chat": {"id": 12345}}
        }
        res = self.service.handle_callback_query(cb_query)
        self.assertEqual(res["action"], "archive")
        item = get_listing_by_bina_id("777888", self.db_path)
        self.assertEqual(item["status"], "ARCHIVED")

    @patch.object(TelegramBotService, "answer_callback_query")
    @patch.object(TelegramBotService, "edit_message_reply_markup")
    def test_handle_mainmenu_callback(self, mock_edit_markup, mock_answer):
        mock_answer.return_value = True
        mock_edit_markup.return_value = True
        cb_query = {
            "id": "cb_main",
            "data": "mainmenu_777888",
            "message": {"message_id": 100, "chat": {"id": 12345}}
        }
        res = self.service.handle_callback_query(cb_query)
        self.assertEqual(res["action"], "mainmenu")
        mock_edit_markup.assert_called_once()

    @patch.object(TelegramBotService, "send_message")
    def test_process_update_command(self, mock_send):
        mock_send.return_value = 200
        update = {
            "update_id": 10,
            "message": {
                "message_id": 5,
                "text": "/start",
                "chat": {"id": 12345}
            }
        }
        res = self.service.process_update(update)
        self.assertEqual(res["type"], "command")
        self.assertEqual(res["command"], "/start")
        mock_send.assert_called_once()


if __name__ == "__main__":
    unittest.main()
