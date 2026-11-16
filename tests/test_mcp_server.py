"""
Unit tests for Baku Estate AI MCP Server (JSON-RPC 2.0).
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json
import unittest
from unittest.mock import patch, MagicMock

from src.mcp_server import process_jsonrpc_message, handle_tool_call, TOOLS_METADATA


class TestMCPServer(unittest.TestCase):

    def test_initialize(self):
        req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        }
        res = process_jsonrpc_message(req)
        self.assertEqual(res["id"], 1)
        self.assertEqual(res["result"]["serverInfo"]["name"], "baku-estate-gemini-mcp")
        self.assertIn("tools", res["result"]["capabilities"])

    def test_tools_list(self):
        req = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }
        res = process_jsonrpc_message(req)
        self.assertEqual(res["id"], 2)
        tool_names = [t["name"] for t in res["result"]["tools"]]
        self.assertIn("generate_real_estate_script", tool_names)
        self.assertIn("get_gemini_pool_status", tool_names)
        self.assertIn("rotate_gemini_account", tool_names)
        self.assertIn("get_market_analysis", tool_names)
        self.assertIn("sync_deal_to_supabase", tool_names)
        self.assertIn("sync_deal_to_notion", tool_names)

    def test_ping(self):
        req = {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "ping"
        }
        res = process_jsonrpc_message(req)
        self.assertEqual(res["id"], 3)
        self.assertEqual(res["result"], {})

    def test_initialized_notification_no_response(self):
        req = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }
        res = process_jsonrpc_message(req)
        self.assertIsNone(res)

    def test_unknown_method(self):
        req = {
            "jsonrpc": "2.0",
            "id": 99,
            "method": "unknown_action"
        }
        res = process_jsonrpc_message(req)
        self.assertEqual(res["error"]["code"], -32601)

    def test_get_gemini_pool_status_tool(self):
        res = handle_tool_call("get_gemini_pool_status", {})
        self.assertIn("content", res)
        data = json.loads(res["content"][0]["text"])
        self.assertIn("accounts", data)
        self.assertGreaterEqual(len(data["accounts"]), 1)

    def test_rotate_gemini_account_tool(self):
        res = handle_tool_call("rotate_gemini_account", {"profile_name": "acc_1", "cooldown_seconds": 60})
        self.assertIn("content", res)
        self.assertIn("Successfully put acc_1 in cooldown", res["content"][0]["text"])

    @patch("src.mcp_server.gemini_client.generate_script", return_value="Xətai rayonunda 2 otaqlı super mənzil! Cəmi 120 min manat.")
    def test_generate_real_estate_script_tool(self, mock_gen):
        args = {
            "title": "2 otaqlı mənzil",
            "price": 120000,
            "location": "Xətai",
            "rooms": 2,
            "area": 70,
            "has_bill_of_sale": True
        }
        res = handle_tool_call("generate_real_estate_script", args)
        self.assertIn("content", res)
        data = json.loads(res["content"][0]["text"])
        self.assertTrue(data["success"])
        self.assertIn("Xətai rayonunda", data["script"])
        self.assertFalse(data["is_fallback"])

    def test_get_market_analysis_tool(self):
        args = {
            "location": "Nərimanov",
            "price": "165.000 AZN",
            "area": "65 m²"
        }
        res = handle_tool_call("get_market_analysis", args)
        self.assertIn("content", res)
        data = json.loads(res["content"][0]["text"])
        self.assertTrue(data["success"])
        self.assertEqual(data["analysis"]["district"], "Nərimanov")
        self.assertEqual(data["analysis"]["m2_price"], 2538)
        self.assertTrue(data["analysis"]["is_below_market"])

    @patch("src.mcp_server.supabase_sync.sync_deal", return_value={"success": True, "bina_id": "777"})
    def test_sync_deal_to_supabase_tool(self, mock_sync):
        args = {"listing": {"bina_id": "777", "title": "Test"}}
        res = handle_tool_call("sync_deal_to_supabase", args)
        data = json.loads(res["content"][0]["text"])
        self.assertTrue(data["success"])
        self.assertEqual(data["bina_id"], "777")

    @patch("src.mcp_server.notion_crm.sync_deal", return_value={"success": True, "mode": "mcp_ready"})
    def test_sync_deal_to_notion_tool(self, mock_notion):
        args = {"listing": {"bina_id": "777", "title": "Test"}}
        res = handle_tool_call("sync_deal_to_notion", args)
        data = json.loads(res["content"][0]["text"])
        self.assertTrue(data["success"])
        self.assertEqual(data["mode"], "mcp_ready")


if __name__ == "__main__":
    unittest.main()
