# BakuEstate-AI Autonomous Executive Agent Hub & Living Memory Architecture

* **Author:** fxbluster
* **Date:** 2026-11-21

## Overview

Transition BakuEstate-AI's CRM assistant from a static form-based drawer into an **Autonomous Executive Agent Hub**. The user interacts directly with a specialized council of 5 autonomous agents possessing partitioned memory buffers, living episodic learning ("Learned Insights"), an Omni-Chat central dispatcher (`Müdir`), and dedicated agent channel rooms. All agents adopt an authentic, non-corporate Baku real estate dialect, rejecting sycophancy and robotic phrasing.

## Analysis

1. **Context Window vs. Memory Saturation**: LLMs exhibit context degradation when stuffed with unbounded multi-turn conversation logs. Storing full raw transcripts causes hallucinations and violates the $10/month budget ceiling. Memory must be decoupled into immutable core business rules (`agent_core_rules`) and synthesized episodic takeaways (`agent_learned_insights`).
2. **Omni-Chat Router vs. Direct Specialist Rooms**: Dual-mode interaction allows both top-down dispatching via a Chief of Staff (`Müdir`) and focused 1-on-1 strategic deep dives in dedicated agent rooms (`Farabi`, `Teymur`, `Usta`, `Maliyyəçi`).
3. **Conversational Tool-Calling**: Agents must not merely chat; they must be capable of dispatching structured CRM actions (stage transitions, note commits, WhatsApp dispatch links) directly from the conversation.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * 5 specialized personas: `Müdir` (Dispatcher/Synthesizer), `Farabi` (Deal Strategy & Commission Shield), `Teymur` (Media & Video Analytics), `Usta` (Pricing, Kupça & Market Arbitrage), `Maliyyəçi` (Revenue & Scaler).
  * Web CRM UI: Omni-Chat command center + dedicated agent sidebar tabs.
  * Supabase Living Memory schema: `agent_conversations`, `agent_messages`, `agent_core_rules`, `agent_learned_insights`.
  * Conversational tool execution: Agents can trigger actions directly within the chat stream.
  * Anti-corporate Baku street-smart voice standards across all system prompts.
* **Out-of-Scope Non-Goals:**
  * Verbatim persistent storage of every raw chat transcript in active LLM context (must use compressed insights).
  * Decommissioning existing 0ms client-side regex address leak protection (remains active as an offline deterministic safety net).

## Alternatives Weighed

* **Monolithic Single Agent**: Rejected by author. Single generalist models suffer from persona bleeding, context dilution, and fail to provide specialized depth across disparate domains (video analytics vs. notary legalities).
* **Pure Telegram External Bot Team**: Rejected by author. Disconnecting the agents from the Web CRM eliminates real-time UI interaction, instant listing inspection, and lead pipeline sync.
* **Static Form Tools (Current V1 Copilot)**: Rejected by author. The form-based drawer lacks conversational intelligence, iterative brainstorming capability, and organizational memory.

## Key Decisions & Staging for Next Steps

* Storage: Supabase tables for session history, core rules, and synthesized lessons learned.
* Serverless Gateway: Expand `/api/ai/copilot` or add `/api/ai/hub` supporting multi-turn chat and tool-calling with Gemini 3.8 Flash and Gemini 3.1 Flash-Lite.
* Dialect Standard: Explicit anti-robotic system instructions enforcing authentic Azerbaijani Baku business communication.
