"""
Unit tests for Brave Gemini Client and Human-in-the-Loop Account Switcher.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import unittest
from unittest.mock import patch, MagicMock
from src.google_pool.brave_gemini_client import (
    clean_gemini_response,
    is_brave_debugging_open,
    BraveGeminiClient
)
from src.ui.account_switcher_dialog import prompt_account_switch


class TestBraveGemini(unittest.TestCase):

    def test_clean_gemini_response_removes_intro_and_formatting(self):
        raw = """
        Əlbəttə! Sosial media üçün hazırladığım 25 saniyəlik ssenari:
        **Nərimanovda möhtəşəm 3 otaqlı mənzil!**
        [Dinamik musiqi başlayır]
        Ümumi sahəsi 110 kvadrat metrdir. Çıxarış və kupça tam qaydasındadır.
        (Ekranda nömrə görünür)
        Qiyməti 175 min manat. WhatsApp-la dərhal əlaqə saxlayın!
        Ümid edirəm bəyəndiniz, uğurlar!
        """
        cleaned = clean_gemini_response(raw)
        self.assertNotIn("Əlbəttə", cleaned)
        self.assertNotIn("Dinamik musiqi", cleaned)
        self.assertNotIn("Ekranda nömrə", cleaned)
        self.assertNotIn("uğurlar", cleaned)
        self.assertNotIn("**", cleaned)
        self.assertIn("Nərimanovda möhtəşəm 3 otaqlı mənzil!", cleaned)
        self.assertIn("Qiyməti 175 min manat", cleaned)

    def test_build_real_estate_prompt(self):
        client = BraveGeminiClient()
        listing = {
            "title": "3 otaqlı bina evi",
            "price": 120000,
            "currency": "AZN",
            "location": "Yasamal",
            "rooms": 3,
            "area": 95,
            "floor": 4,
            "floors": 9,
            "has_bill_of_sale": True,
            "description": "Əla təmirli mənzil."
        }
        prompt = client.build_real_estate_prompt(listing)
        self.assertIn("Yasamal", prompt)
        self.assertIn("120000 AZN", prompt)
        self.assertIn("Kupça", prompt)
        self.assertIn("Azərbaycan dilində", prompt)

    @patch("src.google_pool.brave_gemini_client.is_brave_debugging_open", return_value=False)
    def test_fallback_when_brave_not_connected(self, mock_conn):
        client = BraveGeminiClient()
        result = client.generate_script({"title": "Test", "bina_id": 123})
        self.assertIsNone(result)

    @patch("ctypes.windll.user32.MessageBoxW", return_value=1)
    @patch("winsound.MessageBeep")
    def test_prompt_account_switch_confirmed(self, mock_beep, mock_msgbox):
        res = prompt_account_switch(account_number=1, videos_completed=5, reason="Batch done")
        self.assertTrue(res)
        mock_msgbox.assert_called_once()
        mock_beep.assert_called_once()

    @patch("ctypes.windll.user32.MessageBoxW", return_value=2)
    @patch("winsound.MessageBeep")
    def test_prompt_account_switch_cancelled(self, mock_beep, mock_msgbox):
        res = prompt_account_switch(account_number=1, videos_completed=5, reason="User stop")
        self.assertFalse(res)

    def test_clean_gemini_response_gemini_said_and_bullets(self):
        raw = """
        Gemini said
        * Nərimanov metrosu yanında 2 otaqlı əla təmirli mənzil!
        - Qiyməti cəmi 115 min manat.
        Tələsin, fürsəti qaçırmayın!
        """
        cleaned = clean_gemini_response(raw)
        self.assertNotIn("Gemini said", cleaned)
        self.assertFalse(cleaned.startswith("*"))
        self.assertIn("Nərimanov metrosu yanında", cleaned)
        self.assertIn("115 min manat", cleaned)

    @patch("src.google_pool.brave_gemini_client.check_profile_login_status", return_value={"has_session": True})
    @patch("src.google_pool.brave_gemini_client.is_brave_debugging_open", return_value=True)
    def test_generate_script_with_account_rotation_on_quota(self, mock_open, mock_status):
        mock_pool = MagicMock()
        # First account hits quota, second account succeeds
        mock_pool.acquire_account.side_effect = [
            {"profile_name": "acc_1", "id": 1},
            {"profile_name": "acc_2", "id": 2}
        ]

        client = BraveGeminiClient(pool_manager=mock_pool)
        # Mock _execute_gemini_prompt
        client._execute_gemini_prompt = MagicMock(side_effect=[
            {"success": False, "quota_hit": True},
            {"success": True, "text": "Möhtəşəm dəniz mənzərəli 3 otaqlı ev! Cəmi 150 min manat."}
        ])

        result = client.generate_script({"title": "Test listing", "price": 150000})
        self.assertIsNotNone(result)
        self.assertIn("Möhtəşəm dəniz mənzərəli", result)

        # Verify acc_1 was released with cooldown, and acc_2 with success
        mock_pool.release_account.assert_any_call("acc_1", success=False, custom_cooldown=3600)
        mock_pool.release_account.assert_any_call("acc_2", success=True)

    @patch("src.google_pool.brave_gemini_client.check_profile_login_status")
    @patch("src.google_pool.brave_gemini_client.is_brave_debugging_open", return_value=True)
    def test_generate_script_skips_unauthenticated_profile(self, mock_open, mock_status):
        mock_pool = MagicMock()
        mock_pool.acquire_account.side_effect = [
            {"profile_name": "acc_3", "id": 3},
            {"profile_name": "acc_1", "id": 1}
        ]
        # acc_3 has no session, acc_1 has session
        mock_status.side_effect = [
            {"has_session": False},
            {"has_session": True}
        ]

        client = BraveGeminiClient(pool_manager=mock_pool)
        client._execute_gemini_prompt = MagicMock(return_value={
            "success": True,
            "text": "Yasamalda çıxarışlı 2 otaqlı ev satılır!"
        })

        result = client.generate_script({"title": "Yasamal ev", "price": 95000})
        self.assertIsNotNone(result)
        self.assertIn("Yasamalda çıxarışlı", result)
        mock_pool.release_account.assert_any_call("acc_3", success=False, custom_cooldown=3600)
        mock_pool.release_account.assert_any_call("acc_1", success=True)


if __name__ == "__main__":
    unittest.main()
