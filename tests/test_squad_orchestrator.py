"""
Unit tests for Baku Estate Autonomous Sales Squad Orchestrator and Personas.
Decoupled pure Python test suite - zero MCP server dependencies.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.ai.squad_orchestrator import (
    SentinelPersona,
    ScribePersona,
    StrategistPersona,
    JanitorPersona,
    SquadOrchestrator,
)
from src.dispatcher.telegram_crm import (
    format_cockpit_card_telegram,
    TelegramCRMDispatcher,
)
from src.dispatcher.telegram_bot_service import TelegramBotService


class TestSentinelPersona(unittest.TestCase):
    """Tests for SentinelPersona address leak detection and commission margin defense."""

    def setUp(self):
        self.sentinel = SentinelPersona()

    def test_address_leak_detection_positive(self):
        """Detects explicit building, apartment, and street numbers to protect agency margin."""
        test_cases = [
            ("Mənzil bina 45 ünvanında yerləşir.", "bina 45"),
            ("Zəhmət olmasa mənzil 12 qapısını döyün.", "mənzil 12"),
            ("Blok 3, 4-cü mərtəbəyə qalxın.", "Blok 3"),
            ("Təbriz küçəsi 45 ünvanında gözləyirəm.", "Təbriz küçəsi 45"),
            ("Nizami küç. 12/14 yaxınlığında.", "Nizami küç. 12/14"),
            ("Ev 10 qarşısında görüşək.", "Ev 10"),
            ("Bina: 88, mənz. 5", "Bina: 88"),
        ]
        for text, expected_match in test_cases:
            with self.subTest(text=text):
                res = self.sentinel.check_address_leak(text)
                self.assertTrue(res["has_leak"])
                self.assertTrue(len(res["leaked_tokens"]) > 0)
                self.assertIsNotNone(res["warning"])
                self.assertIn("SENTINEL XƏBƏRDARLIĞI", res["warning"])
                self.assertIn("[DƏQİQ ÜNVAN GİZLƏDİLDİ - BAXIŞDA VERİLƏCƏK]", res["sanitized_text"])
                self.assertNotIn(expected_match, res["sanitized_text"])

    def test_address_leak_detection_negative_safe_landmarks(self):
        """Allows general district, metro, and street names without specific building numbers."""
        safe_messages = [
            "Mənzil Nərimanov metrosunun çıxışında yerləşir.",
            "Təbriz küçəsi ərazisində 3 otaqlı əla təmirli mənzil.",
            "Xətai rayonu, Ağ Şəhər bulvarına 5 dəqiqəlik məsafədə.",
            "Gənclik m. yaxınlığında prestijli yeni tikili.",
            "Koroğlu metrosu ətrafı, geniş həyəti və parkinqi var.",
        ]
        for msg in safe_messages:
            with self.subTest(msg=msg):
                res = self.sentinel.check_address_leak(msg)
                self.assertFalse(res["has_leak"])
                self.assertEqual(res["leaked_tokens"], [])
                self.assertIsNone(res["warning"])
                self.assertEqual(res["sanitized_text"], msg)

    def test_address_leak_edge_cases(self):
        """Handles empty strings, whitespace, and None gracefully."""
        self.assertFalse(self.sentinel.check_address_leak("")["has_leak"])
        self.assertFalse(self.sentinel.check_address_leak(None)["has_leak"])

    def test_commission_shaving_defense_margin_threat(self):
        """Flags 50-100 AZN commission shaving or zero-fee demands as margin threats."""
        threat_cases = [
            (0.0, 100.0),    # Refused to pay
            (50.0, 100.0),   # Shaving 50 AZN
            (20.0, 100.0),   # Lowball
            (0.0, None),     # Default expected
        ]
        for offered, expected in threat_cases:
            with self.subTest(offered=offered, expected=expected):
                defense = self.sentinel.defend_commission(offered_amount=offered, expected_amount=expected)
                self.assertTrue(defense["is_margin_threat"])
                self.assertEqual(defense["strategy"], "DEFEND_FULL_COMMISSION")
                self.assertIn("Kupça", defense["defense_script"])
                self.assertIn("notarial", defense["defense_script"])
                self.assertGreaterEqual(len(defense["talking_points"]), 3)

    def test_commission_shaving_defense_no_threat(self):
        """Accepts full commission agreement without flagging margin threat."""
        defense = self.sentinel.defend_commission(offered_amount=100.0, expected_amount=100.0)
        self.assertFalse(defense["is_margin_threat"])
        self.assertEqual(defense["margin_delta_azn"], 0.0)


class TestScribePersona(unittest.TestCase):
    """Tests for ScribePersona WhatsApp templates and objection battlecards."""

    def setUp(self):
        self.scribe = ScribePersona()
        self.listing = {
            "bina_id": "5616503",
            "title": "3 otaqlı mənzil",
            "price": 250000,
            "currency": "AZN",
            "location": "Nərimanov m.",
            "rooms": 3,
            "old_price": "270 000"
        }
        self.lead = {"name": "Kamran bəy"}

    def test_whatsapp_template_owner_first_contact(self):
        text = self.scribe.generate_whatsapp_template("OWNER_FIRST_CONTACT", self.listing)
        self.assertIn("bina.az-dakı #5616503", text)
        self.assertIn("Nərimanov m.", text)
        self.assertIn("real alıcımız var", text)
        self.assertIn("satışdadırmı", text)

    def test_whatsapp_template_buyer_inquiry_reply(self):
        text = self.scribe.generate_whatsapp_template("BUYER_INQUIRY_REPLY", self.listing, self.lead)
        self.assertIn("Kamran bəy", text)
        self.assertIn("250 000 AZN", text)
        self.assertIn("3 otaqlı", text)
        self.assertIn("Kupçalıdır", text)
        self.assertIn("video-turunu", text)

    def test_whatsapp_template_price_drop_alert(self):
        text = self.scribe.generate_whatsapp_template("PRICE_DROP_ALERT", self.listing, self.lead)
        self.assertIn("🔥 Şad xəbər", text)
        self.assertIn("Kamran bəy", text)
        self.assertIn("#5616503", text)
        self.assertIn("270 000 AZN", text)
        self.assertIn("250 000 AZN", text)

    def test_whatsapp_template_showing_confirmation(self):
        text = self.scribe.generate_whatsapp_template("SHOWING_CONFIRMATION", self.listing, self.lead, custom_note="19:30")
        self.assertIn("Kamran bəy", text)
        self.assertIn("19:30", text)
        self.assertIn("baxışımız", text)

    def test_whatsapp_template_default_fallback(self):
        text = self.scribe.generate_whatsapp_template("UNKNOWN_TYPE", self.listing, self.lead)
        self.assertIn("Kamran bəy", text)
        self.assertIn("250 000 AZN", text)

    def test_objection_battlecards(self):
        objections = ["PRICE_TOO_HIGH", "NO_KUPCHA", "DIRECT_OWNER_ONLY", "COMMISSION_REFUSAL"]
        for obj in objections:
            with self.subTest(objection=obj):
                card = self.scribe.get_objection_battlecard(obj)
                self.assertEqual(card["objection_key"], obj)
                self.assertTrue(len(card["label"]) > 0)
                self.assertTrue(len(card["core_argument"]) > 0)
                self.assertTrue(len(card["baku_rebuttal"]) > 0)
                self.assertTrue(len(card["closing_question"]) > 0)


class TestStrategistPersona(unittest.TestCase):
    """Tests for StrategistPersona pre-call blueprints and daily Top 5 scoring."""

    def setUp(self):
        self.strategist = StrategistPersona()

    def test_generate_pre_call_blueprint(self):
        listing = {
            "bina_id": "5616503",
            "price": 320000,
            "location": "Gənclik",
            "has_bill_of_sale": True
        }
        blueprint = self.strategist.generate_pre_call_blueprint(listing)
        self.assertIn("objective", blueprint)
        self.assertIn("#5616503", blueprint["objective"])
        self.assertEqual(len(blueprint["call_structure"]), 4)
        self.assertGreaterEqual(len(blueprint["key_hooks"]), 3)
        self.assertGreaterEqual(len(blueprint["pitfalls_to_avoid"]), 3)

    def test_select_daily_top_5_cards_scoring_and_ranking(self):
        cards = [
            {"id": "card-1", "priority": "LOW", "headline": "Adi elan"},
            {"id": "card-2", "priority": "NORMAL", "headline": "Standart baxış"},
            {"id": "card-3", "priority": "HIGH", "headline": "Lüks villa satılır"},
            {"id": "card-4", "priority": "URGENT", "headline": "Təcili qiymət endirimi!"},
            {"id": "card-5", "priority": "NORMAL", "headline": "Bina 45 mənzil baxışı"},
            {"id": "card-6", "priority": "HIGH", "headline": "Sahibindən endirimi olan mənzil"},
            {"id": "card-7", "priority": "NORMAL", "headline": "Xalqlar m."},
        ]
        res = self.strategist.select_daily_top_5_cards(cards)
        self.assertEqual(len(res["top_cards"]), 5)
        self.assertEqual(res["total_candidates"], 7)
        # card-4 (URGENT 100 + təcili 20 = 120) must be top 1
        self.assertEqual(res["top_cards"][0]["id"], "card-4")
        self.assertIn("briefing_title", res)
        self.assertIn("executive_summary", res)


class TestJanitorPersona(unittest.TestCase):
    """Tests for JanitorPersona E.164 phone normalization and voice debrief analyzer."""

    def setUp(self):
        self.janitor = JanitorPersona()

    def test_normalize_phone_e164_azercell(self):
        self.assertEqual(self.janitor.normalize_phone_e164("050 123 45 67"), "+994501234567")
        self.assertEqual(self.janitor.normalize_phone_e164("(051) 987-65-43"), "+994519876543")
        self.assertEqual(self.janitor.normalize_phone_e164("010 333 22 11"), "+994103332211")
        self.assertEqual(self.janitor.normalize_phone_e164("+994 50 111 22 33"), "+994501112233")
        self.assertEqual(self.janitor.normalize_phone_e164("994501112233"), "+994501112233")

    def test_normalize_phone_e164_bakcell(self):
        self.assertEqual(self.janitor.normalize_phone_e164("055 765 43 21"), "+994557654321")
        self.assertEqual(self.janitor.normalize_phone_e164("099 300 40 50"), "+994993004050")
        self.assertEqual(self.janitor.normalize_phone_e164("557654321"), "+994557654321")

    def test_normalize_phone_e164_nar(self):
        self.assertEqual(self.janitor.normalize_phone_e164("070 200 30 40"), "+994702003040")
        self.assertEqual(self.janitor.normalize_phone_e164("077 500 60 70"), "+994775006070")

    def test_normalize_phone_e164_landlines(self):
        self.assertEqual(self.janitor.normalize_phone_e164("012 400 12 34"), "+994124001234")
        self.assertEqual(self.janitor.normalize_phone_e164("400 12 34"), "+994124001234")

    def test_normalize_phone_e164_invalid_inputs(self):
        self.assertIsNone(self.janitor.normalize_phone_e164("12345"))
        self.assertIsNone(self.janitor.normalize_phone_e164("033 123 45 67"))  # Invalid prefix
        self.assertIsNone(self.janitor.normalize_phone_e164(""))
        self.assertIsNone(self.janitor.normalize_phone_e164(None))
        self.assertIsNone(self.janitor.normalize_phone_e164("abcdefgh"))

    def test_is_valid_azerbaijani_phone(self):
        self.assertTrue(self.janitor.is_valid_azerbaijani_phone("050 123 45 67"))
        self.assertFalse(self.janitor.is_valid_azerbaijani_phone("12345"))

    def test_analyze_post_call_debrief_comprehensive(self):
        transcript = (
            "Müştəri ilə danışdım. Büdcəsi 180 min manatdır. "
            "İpoteka ilə almaq istəyir. Qiymət bir az bahadır dedi amma sabah saat 18:00-da baxışa razılaşdıq."
        )
        listing = {"id": "listing-uuid-1", "bina_id": "5616503", "location": "Nərimanov"}
        debrief = self.janitor.analyze_post_call_debrief(transcript, listing=listing, lead_id="lead-uuid-1")
        self.assertEqual(debrief["budget_azn"], 180000.0)
        self.assertEqual(debrief["payment_mode"], "IPOTEKA")
        self.assertEqual(debrief["deal_stage"], "SHOWING_SCHEDULED")
        self.assertIn("PRICE_TOO_HIGH", debrief["detected_objections"])
        self.assertIsNotNone(debrief["suggested_cockpit_card"])
        card = debrief["suggested_cockpit_card"]
        self.assertEqual(card["channel"], "WHATSAPP")
        self.assertEqual(card["priority"], "HIGH")
        self.assertEqual(card["bina_id"], "5616503")
        self.assertEqual(card["buyer_lead_id"], "lead-uuid-1")

        tl = debrief["timeline_event"]
        self.assertEqual(tl["actor"], "AI_JANITOR")
        self.assertEqual(tl["event_type"], "CALL_LOG")
        self.assertEqual(tl["lead_id"], "lead-uuid-1")


class TestSquadOrchestratorDecoupled(unittest.TestCase):
    """Tests for master SquadOrchestrator execution without MCP server dependencies."""

    def setUp(self):
        self.squad = SquadOrchestrator()

    def test_guard_and_format_outreach_leak_detected(self):
        listing = {"bina_id": "5616503", "location": "Nərimanov", "price": 150000}
        custom_note = "Mənzil bina 45 mənzil 12 ünvanındadır."
        res = self.squad.guard_and_format_outreach("SHOWING_CONFIRMATION", listing, custom_note=custom_note)
        self.assertTrue(res["has_leak"])
        self.assertIn("bina 45", res["leaked_tokens"])
        self.assertIn("mənzil 12", res["leaked_tokens"])
        self.assertNotIn("mənzil 12", res["sanitized_draft"])

    def test_guard_and_format_outreach_clean(self):
        listing = {"bina_id": "5616503", "location": "Nərimanov m.", "price": 150000}
        res = self.squad.guard_and_format_outreach("BUYER_INQUIRY_REPLY", listing)
        self.assertFalse(res["has_leak"])
        self.assertEqual(res["original_draft"], res["sanitized_draft"])

    def test_process_call_audio_debrief_without_auto_queue(self):
        transcript = "Müştəri nağd 200 min təklif etdi, razılaşdıq."
        res = self.squad.process_call_audio_debrief(transcript, auto_queue_card=False)
        self.assertIn("analysis", res)
        self.assertIsNone(res["queued_card_result"])

    def test_process_call_audio_debrief_with_auto_queue_mock_repo(self):
        mock_repo = MagicMock()
        mock_repo.queue_cockpit_card.return_value = {"id": "queued-card-1", "status": "PENDING"}
        mock_repo.append_lead_timeline_event.return_value = {"id": "event-1", "status": "RECORDED"}

        orchestrator = SquadOrchestrator(repo=mock_repo)
        transcript = "Müştəri sabah saat 18:00 üçün baxış istəyir. Büdcəsi 250 min manatdır."
        res = orchestrator.process_call_audio_debrief(
            transcript,
            listing={"id": "listing-uuid-abc", "bina_id": "777888"},
            lead_id="lead-uuid-xyz",
            auto_queue_card=True
        )
        self.assertIsNotNone(res["queued_card_result"])
        self.assertEqual(res["queued_card_result"]["id"], "queued-card-1")
        mock_repo.queue_cockpit_card.assert_called_once()
        mock_repo.append_lead_timeline_event.assert_called_once()


class TestTelegramCockpitIntegration(unittest.TestCase):
    """Tests for Telegram Cockpit Card formatting, mock dispatch, and callback handling."""

    def test_format_cockpit_card_telegram(self):
        card = {
            "id": "card-test-abc",
            "headline": "Təcili Qiymət Fürsəti",
            "channel": "WHATSAPP",
            "priority": "HIGH",
            "reason": "Mülkiyyətçi 15 000 AZN endirim etdi",
            "draft_text": "Salam, mənzilə baxış təyin edək?",
            "sentinel_warning": "Dəqiq ünvan gizlədildi",
            "owner_phone": "+994501234567"
        }
        res = format_cockpit_card_telegram(card)
        self.assertIn("AI SATIŞ MƏŞVƏRƏT KARTI", res.text)
        self.assertIn("Təcili Qiymət Fürsəti", res.text)
        self.assertIn("<code>Salam, mənzilə baxış təyin edək?</code>", res.text)
        self.assertIn("Sentinel Qoruyucu", res.text)

        kb = res.reply_markup["inline_keyboard"]
        self.assertEqual(len(kb), 2)
        self.assertEqual(kb[0][0]["text"], "💬 WhatsApp Sahibinə")
        self.assertIn("wa.me/994501234567", kb[0][0]["url"])
        self.assertEqual(kb[1][0]["text"], "🚀 Təsdiqlə")
        self.assertEqual(kb[1][0]["callback_data"], "cockpit_act_card-test-abc")
        self.assertEqual(kb[1][1]["text"], "❌ Ləğv Et")
        self.assertEqual(kb[1][1]["callback_data"], "cockpit_dismiss_card-test-abc")

    def test_telegram_crm_send_cockpit_card_mock(self):
        dispatcher = TelegramCRMDispatcher(mock_mode=True)
        res = dispatcher.send_cockpit_card({
            "id": "card-dispatch-1",
            "headline": "Mock Dispatch Test",
            "channel": "WHATSAPP",
            "draft_text": "Salam mock",
            "reason": "Sınaq"
        })
        self.assertEqual(res["status"], "MOCK_SUCCESS")
        self.assertEqual(res["card_id"], "card-dispatch-1")

    def test_telegram_bot_service_cockpit_callbacks(self):
        bot = TelegramBotService(bot_token="mock_token", chat_id="12345")

        cb_act = {
            "id": "cb_1",
            "data": "cockpit_act_card-999",
            "message": {"chat": {"id": 12345}, "message_id": 401}
        }
        res_act = bot.handle_callback_query(cb_act)
        self.assertEqual(res_act["action"], "cockpit_act")
        self.assertEqual(res_act["card_id"], "card-999")
        self.assertEqual(res_act["status"], "EXECUTED")

        cb_dismiss = {
            "id": "cb_2",
            "data": "cockpit_dismiss_card-999",
            "message": {"chat": {"id": 12345}, "message_id": 401}
        }
        res_dismiss = bot.handle_callback_query(cb_dismiss)
        self.assertEqual(res_dismiss["action"], "cockpit_dismiss")
        self.assertEqual(res_dismiss["card_id"], "card-999")
        self.assertEqual(res_dismiss["status"], "DISMISSED")


if __name__ == "__main__":
    unittest.main()
