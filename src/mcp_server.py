"""
Baku Estate AI - Model Context Protocol (MCP) Server.
Exposes Google AI Pro (Gemini Advanced 4) real estate script generation
and pool management as native MCP tools over JSON-RPC 2.0 stdio.
Zero external dependencies, standard library only.
"""

import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import os
import json
import logging
from typing import Dict, Any, Optional
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.google_pool.pool_manager import GooglePoolManager
from src.google_pool.brave_gemini_client import BraveGeminiClient, get_keenable_market_comparison
from src.google_pool.setup_accounts import check_profile_login_status
from src.dispatcher.supabase_sync import SupabaseSync
from src.dispatcher.notion_crm import NotionCRMDispatcher
from config.settings import GOOGLE_ACCOUNT_PROFILES

# Logging to stderr so stdout remains clean for MCP JSON-RPC protocol
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s [MCP] [%(levelname)s] %(message)s"
)
logger = logging.getLogger("mcp_server")

pool_manager = GooglePoolManager()
gemini_client = BraveGeminiClient(pool_manager=pool_manager)
supabase_sync = SupabaseSync()
notion_crm = NotionCRMDispatcher()

TOOLS_METADATA = [
    {
        "name": "generate_real_estate_script",
        "description": (
            "Generates a viral, high-converting Azerbaijani real estate Reels/Shorts script "
            "using the user's active Google AI Pro (Gemini Advanced 4) accounts. "
            "Includes dynamic urgency hooks, clear price emphasis, Kupça statements, and strong CTA."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Title of the listing (e.g. '3 otaqlı mənzil')"},
                "price": {"type": ["number", "string"], "description": "Price of the property in AZN"},
                "currency": {"type": "string", "description": "Currency (default 'AZN')", "default": "AZN"},
                "location": {"type": "string", "description": "City district or metro (e.g. 'Nərimanov', 'Yasamal')"},
                "rooms": {"type": "number", "description": "Number of rooms"},
                "area": {"type": "number", "description": "Total area in square meters (m²)"},
                "floor": {"type": "number", "description": "Floor of the apartment"},
                "floors": {"type": "number", "description": "Total floors in building"},
                "has_bill_of_sale": {"type": "boolean", "description": "True if Kupça/Çıxarış is available"},
                "description": {"type": "string", "description": "Original description of property"}
            },
            "required": ["title"]
        }
    },
    {
        "name": "get_gemini_pool_status",
        "description": (
            "Returns operational status of all 6 Google AI Pro profiles, "
            "including persistent session state, cooldown timers, and daily quotas."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "rotate_gemini_account",
        "description": "Releases the specified account into cooldown and triggers rotation to the next available profile.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "profile_name": {"type": "string", "description": "Profile to rotate (e.g. 'acc_1')"},
                "cooldown_seconds": {"type": "number", "description": "Custom cooldown duration in seconds", "default": 600}
            },
            "required": ["profile_name"]
        }
    },
    {
        "name": "get_market_analysis",
        "description": (
            "Analyzes property pricing against real-time Keenable median m² prices across Baku districts. "
            "Returns calculated m² rate, matching administrative district, benchmark price, and discount percentage."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "District, metro station, or address in Baku"},
                "price": {"type": ["number", "string"], "description": "Property price in AZN"},
                "area": {"type": ["number", "string"], "description": "Property total area in m²"}
            },
            "required": ["location", "price", "area"]
        }
    },
    {
        "name": "sync_deal_to_supabase",
        "description": "Upserts a real estate deal record into Supabase PostgreSQL table 'baku_estate_deals'.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "listing": {"type": "object", "description": "Property listing data dictionary"},
                "video_cdn_url": {"type": "string", "description": "Public streaming CDN URL of generated MP4"},
                "video_duration": {"type": "number", "description": "Video duration in seconds"},
                "script_text": {"type": "string", "description": "Narration script text"}
            },
            "required": ["listing"]
        }
    },
    {
        "name": "sync_deal_to_notion",
        "description": "Builds and syncs deal lead payload into Notion CRM database & Kanban boards ('Baku Estate Deals').",
        "inputSchema": {
            "type": "object",
            "properties": {
                "listing": {"type": "object", "description": "Property listing data dictionary"},
                "video_cdn_url": {"type": "string", "description": "Public streaming CDN URL of generated MP4"},
                "script_text": {"type": "string", "description": "Narration script text"},
                "status": {"type": "string", "description": "Kanban pipeline status", "default": "Video Ready"}
            },
            "required": ["listing"]
        }
    }
]


def handle_tool_call(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatches tool execution and formats JSON-RPC content response."""
    if tool_name == "generate_real_estate_script":
        listing = {
            "title": arguments.get("title", "Daşınmaz əmlak"),
            "price": arguments.get("price", 0),
            "currency": arguments.get("currency", "AZN"),
            "location": arguments.get("location", "Bakı"),
            "rooms": arguments.get("rooms", ""),
            "area": arguments.get("area", ""),
            "floor": arguments.get("floor", ""),
            "floors": arguments.get("floors", ""),
            "has_bill_of_sale": arguments.get("has_bill_of_sale", True),
            "description": arguments.get("description", "")
        }

        logger.info(f"Generating AI script for listing: {listing.get('title')} ({listing.get('location')})")
        script = gemini_client.generate_script(listing)
        if not script:
            # Fallback to local script generator
            from src.media.tts_service import generate_azerbaijani_script
            script = generate_azerbaijani_script(listing)
            is_fallback = True
        else:
            is_fallback = False

        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps({
                        "success": True,
                        "script": script,
                        "is_fallback": is_fallback,
                        "char_count": len(script)
                    }, ensure_ascii=False, indent=2)
                }
            ]
        }

    elif tool_name == "get_gemini_pool_status":
        pool_status = pool_manager.get_pool_status()
        for acc in pool_status:
            pname = acc.get("profile_name", "")
            disk_info = check_profile_login_status(pname)
            acc["disk_has_session"] = disk_info.get("has_session", False)
            acc["disk_size_mb"] = disk_info.get("size_mb", 0.0)

        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps({
                        "accounts": pool_status,
                        "total_configured": len(pool_status)
                    }, ensure_ascii=False, indent=2)
                }
            ]
        }

    elif tool_name == "rotate_gemini_account":
        profile_name = arguments.get("profile_name")
        cooldown = arguments.get("cooldown_seconds", 600)
        pool_manager.release_account(profile_name, success=False, custom_cooldown=cooldown)
        return {
            "content": [
                {
                    "type": "text",
                    "text": f"Successfully put {profile_name} in cooldown for {cooldown}s."
                }
            ]
        }

    elif tool_name == "get_market_analysis":
        loc = arguments.get("location", "")
        pr = arguments.get("price", 0)
        ar = arguments.get("area", 0)
        stats = get_keenable_market_comparison(loc, pr, ar)
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps({
                        "success": bool(stats),
                        "analysis": stats
                    }, ensure_ascii=False, indent=2)
                }
            ]
        }

    elif tool_name == "sync_deal_to_supabase":
        listing = arguments.get("listing", {})
        video_cdn = arguments.get("video_cdn_url")
        dur = arguments.get("video_duration")
        script = arguments.get("script_text")
        status = arguments.get("status", "COMPLETED")
        res = supabase_sync.sync_deal(
            listing=listing,
            video_cdn_url=video_cdn,
            video_duration=dur,
            script_text=script,
            status=status
        )
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(res, ensure_ascii=False, indent=2)
                }
            ]
        }

    elif tool_name == "sync_deal_to_notion":
        listing = arguments.get("listing", {})
        video_cdn = arguments.get("video_cdn_url")
        script = arguments.get("script_text")
        status = arguments.get("status", "Video Ready")
        res = notion_crm.sync_deal(
            listing=listing,
            video_cdn_url=video_cdn,
            script_text=script,
            status=status
        )
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(res, ensure_ascii=False, indent=2)
                }
            ]
        }

    else:
        raise ValueError(f"Unknown tool: {tool_name}")


def process_jsonrpc_message(msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Processes incoming JSON-RPC 2.0 messages from MCP client."""
    msg_id = msg.get("id")
    method = msg.get("method")
    params = msg.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "baku-estate-gemini-mcp",
                    "version": "1.0.0"
                }
            }
        }

    elif method == "notifications/initialized":
        # Notification: no response needed
        return None

    elif method == "ping":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {}
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "tools": TOOLS_METADATA
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        try:
            result = handle_tool_call(tool_name, arguments)
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": result
            }
        except Exception as e:
            logger.error(f"Error handling tool call {tool_name}: {e}")
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {
                    "code": -32603,
                    "message": str(e)
                }
            }

    else:
        if msg_id is not None:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {
                    "code": -32601,
                    "message": f"Method not found: {method}"
                }
            }
        return None


def run_stdio_server():
    """Runs standard input/output loop for MCP protocol."""
    logger.info("Starting Baku Estate AI Gemini MCP Server (stdio)...")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            res = process_jsonrpc_message(req)
            if res is not None:
                out = json.dumps(res, ensure_ascii=False)
                sys.stdout.write(out + "\n")
                sys.stdout.flush()
        except json.JSONDecodeError as err:
            logger.warning(f"Malformed JSON: {err}")
        except Exception as err:
            logger.error(f"Unexpected error in server loop: {err}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        print("Testing MCP tools directly...")
        status = handle_tool_call("get_gemini_pool_status", {})
        print("Pool Status:\n", status["content"][0]["text"])
    else:
        run_stdio_server()
