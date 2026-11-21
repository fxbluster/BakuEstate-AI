import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  invokeCopilot,
  type ActionCardPayload,
  type AgentChatMessage,
  type AgentChatResult,
  type AgentPersonaId,
  type CopilotActionPayload,
  type CopilotApiResponse,
} from "../lib/ai-client";
import type { SupportedPersonaId } from "../lib/agent-personas";
import { buildWhatsAppUrl } from "../lib/format";

describe("Agent Hub Routing & Context Management", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Sliding Context Window Assembly (last 8 messages)
  // =========================================================================
  describe("Sliding Context Window Assembly", () => {
    function assembleContextWindow(messages: AgentChatMessage[], maxWindow: number = 8): AgentChatMessage[] {
      if (!Array.isArray(messages)) return [];
      return messages.slice(-maxWindow);
    }

    it("returns empty array when conversation has 0 messages", () => {
      const empty: AgentChatMessage[] = [];
      const window = assembleContextWindow(empty);
      expect(window).toHaveLength(0);
    });

    it("preserves all messages when conversation has fewer than 8 messages (e.g. 4)", () => {
      const messages: AgentChatMessage[] = [
        { id: "1", sender_type: "USER", sender_name: "Broker", content: "Salam", created_at: "2026-11-21T10:00:00Z" },
        { id: "2", sender_type: "AGENT", sender_name: "Müdir", content: "Salam, xidmətinizdəyəm.", created_at: "2026-11-21T10:00:05Z" },
        { id: "3", sender_type: "USER", sender_name: "Broker", content: "Nəsimidə mənzil var?", created_at: "2026-11-21T10:00:10Z" },
        { id: "4", sender_type: "AGENT", sender_name: "Usta", content: "Bəli, 3 otaqlı təmirli var.", created_at: "2026-11-21T10:00:15Z" },
      ];

      const window = assembleContextWindow(messages);
      expect(window).toHaveLength(4);
      expect(window.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
    });

    it("preserves all messages when exactly 8 messages are present", () => {
      const messages: AgentChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
        id: `msg-${i + 1}`,
        sender_type: i % 2 === 0 ? "USER" : "AGENT",
        sender_name: i % 2 === 0 ? "Broker" : "Farabi",
        content: `Məzmun ${i + 1}`,
        created_at: `2026-11-21T10:0${i}:00Z`,
      }));

      const window = assembleContextWindow(messages);
      expect(window).toHaveLength(8);
      expect(window[0].id).toBe("msg-1");
      expect(window[7].id).toBe("msg-8");
    });

    it("slices strictly the last 8 messages when conversation exceeds 8 messages (e.g. 15 messages)", () => {
      const messages: AgentChatMessage[] = Array.from({ length: 15 }, (_, i) => ({
        id: `msg-${i + 1}`,
        sender_type: i % 2 === 0 ? "USER" : "AGENT",
        sender_name: i % 2 === 0 ? "Broker" : "Müdir",
        content: `Söhbət mətni ${i + 1}`,
        created_at: `2026-11-21T10:${i < 10 ? "0" + i : i}:00Z`,
      }));

      const window = assembleContextWindow(messages);
      expect(window).toHaveLength(8);
      // Messages 1..7 must be dropped; messages 8..15 must be retained in order
      expect(window[0].id).toBe("msg-8");
      expect(window[7].id).toBe("msg-15");
      expect(window.map((m) => m.id)).toEqual([
        "msg-8",
        "msg-9",
        "msg-10",
        "msg-11",
        "msg-12",
        "msg-13",
        "msg-14",
        "msg-15",
      ]);
    });
  });

  // =========================================================================
  // 2. Rate Limiting (25 req/min Threshold)
  // =========================================================================
  describe("Rate Limiting (25 req/min Threshold)", () => {
    function simulateRateLimitCheck(recentRequestCount: number, threshold: number = 25): boolean {
      return recentRequestCount < threshold;
    }

    it("permits request when recent requests in past minute are below 25 (e.g. 0, 10, 24)", () => {
      expect(simulateRateLimitCheck(0, 25)).toBe(true);
      expect(simulateRateLimitCheck(10, 25)).toBe(true);
      expect(simulateRateLimitCheck(24, 25)).toBe(true);
    });

    it("rejects request when recent requests in past minute reach or exceed 25", () => {
      expect(simulateRateLimitCheck(25, 25)).toBe(false);
      expect(simulateRateLimitCheck(26, 25)).toBe(false);
      expect(simulateRateLimitCheck(50, 25)).toBe(false);
    });

    it("handles 429 RATE_LIMITED response from serverless gateway correctly", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          error: "Dəqiqəlik sorğu limiti (25 req/min) aşıldı.",
          code: "RATE_LIMITED",
          fallback_available: true,
        }),
      });

      const payload: CopilotActionPayload = {
        action: "agent_chat",
        agent_id: "mudir",
        message: "Salam, vəziyyət necədir?",
      };

      const res = await invokeCopilot<AgentChatResult>(payload);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("RATE_LIMITED");
        expect(res.error).toContain("25 req/min");
        expect(res.fallback_available).toBe(true);
      }
    });
  });

  // =========================================================================
  // 3. Budget Ceiling Check ($10.00 hard cap -> 429)
  // =========================================================================
  describe("Budget Ceiling Enforcement ($10.00 Limit)", () => {
    function simulateBudgetCheck(monthlySpendUsd: number, budgetCap: number = 10.0): boolean {
      return monthlySpendUsd < budgetCap;
    }

    it("permits execution when monthly spend is below $10.00 (e.g. $2.50, $8.00)", () => {
      expect(simulateBudgetCheck(0.0)).toBe(true);
      expect(simulateBudgetCheck(2.5)).toBe(true);
      expect(simulateBudgetCheck(7.99)).toBe(true);
      expect(simulateBudgetCheck(9.99)).toBe(true);
    });

    it("blocks execution when monthly spend reaches or exceeds $10.00 cap", () => {
      expect(simulateBudgetCheck(10.0)).toBe(false);
      expect(simulateBudgetCheck(10.05)).toBe(false);
      expect(simulateBudgetCheck(15.0)).toBe(false);
    });

    it("handles 429 BUDGET_EXCEEDED response from serverless gateway", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          error: "Aylıq AI büdcə limiti ($10.00) aşıldı.",
          code: "BUDGET_EXCEEDED",
          fallback_available: true,
        }),
      });

      const payload: CopilotActionPayload = {
        action: "agent_chat",
        agent_id: "farabi",
        message: "Müştəri komissiyanı kəsmək istəyir.",
      };

      const res = await invokeCopilot<AgentChatResult>(payload);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("BUDGET_EXCEEDED");
        expect(res.error).toContain("$10.00");
        expect(res.fallback_available).toBe(true);
      }
    });

    it("verifies model downgrade to fast tier when monthly spend reaches 80% ($8.00)", () => {
      function resolveTargetModel(
        agentId: SupportedPersonaId,
        monthlySpend: number
      ): "gemini-3.8-flash" | "gemini-3.1-flash-lite" {
        if (agentId === "teymur" || agentId === "analitika" || monthlySpend >= 8.0) {
          return "gemini-3.1-flash-lite";
        }
        return "gemini-3.8-flash";
      }

      // Normal conditions
      expect(resolveTargetModel("mudir", 2.0)).toBe("gemini-3.8-flash");
      expect(resolveTargetModel("farabi", 5.0)).toBe("gemini-3.8-flash");
      expect(resolveTargetModel("usta", 7.5)).toBe("gemini-3.8-flash");
      expect(resolveTargetModel("teymur", 1.0)).toBe("gemini-3.1-flash-lite");

      // Budget stress condition (>= $8.00) -> automatically downgrades mudir, farabi, usta
      expect(resolveTargetModel("mudir", 8.0)).toBe("gemini-3.1-flash-lite");
      expect(resolveTargetModel("farabi", 8.5)).toBe("gemini-3.1-flash-lite");
      expect(resolveTargetModel("usta", 9.5)).toBe("gemini-3.1-flash-lite");
    });
  });

  // =========================================================================
  // 4. ActionCardPayload Discriminated Union Serialization
  // =========================================================================
  describe("ActionCardPayload Discriminated Union Serialization", () => {
    it("serializes and deserializes UPDATE_LEAD_STAGE payload correctly", () => {
      const card: ActionCardPayload = {
        type: "UPDATE_LEAD_STAGE",
        lead_id: "lead-789-uuid",
        current_stage: "NEW_INQUIRY",
        recommended_stage: "VIEWING_SCHEDULED",
        rationale: "Müştəri həftəsonu mənzilə baxış keçirməyə razılaşdı.",
      };

      const serialized = JSON.stringify(card);
      const parsed: ActionCardPayload = JSON.parse(serialized);

      expect(parsed.type).toBe("UPDATE_LEAD_STAGE");
      if (parsed.type === "UPDATE_LEAD_STAGE") {
        expect(parsed.lead_id).toBe("lead-789-uuid");
        expect(parsed.current_stage).toBe("NEW_INQUIRY");
        expect(parsed.recommended_stage).toBe("VIEWING_SCHEDULED");
        expect(parsed.rationale).toContain("həftəsonu mənzilə baxış");
      }
    });

    it("serializes and deserializes DISPATCH_WHATSAPP payload with buildWhatsAppUrl", () => {
      const phone = "994501234567";
      const draft = "Salam! Yasamal mənzili üzrə baxış saatını təsdiqləyək? kod:5616503";
      const waLink = buildWhatsAppUrl(phone, draft);

      const card: ActionCardPayload = {
        type: "DISPATCH_WHATSAPP",
        phone_number: phone,
        draft_text: draft,
        listing_code: "kod:5616503",
        wa_link: waLink || "",
      };

      const serialized = JSON.stringify(card);
      const parsed: ActionCardPayload = JSON.parse(serialized);

      expect(parsed.type).toBe("DISPATCH_WHATSAPP");
      if (parsed.type === "DISPATCH_WHATSAPP") {
        expect(parsed.phone_number).toBe("994501234567");
        expect(parsed.draft_text).toBe(draft);
        expect(parsed.listing_code).toBe("kod:5616503");
        expect(parsed.wa_link).toContain("https://wa.me/994501234567?text=");
      }
    });

    it("serializes and deserializes SAVE_INSIGHT payload for episodic memory", () => {
      const card: ActionCardPayload = {
        type: "SAVE_INSIGHT",
        agent_id: "usta",
        domain: "DISTRICT_VALUATION",
        insight_text: "Nəsimi rayonunda m² qiymət meyarı 2300-2800 AZN aralığındadır.",
        confidence_score: 0.95,
      };

      const serialized = JSON.stringify(card);
      const parsed: ActionCardPayload = JSON.parse(serialized);

      expect(parsed.type).toBe("SAVE_INSIGHT");
      if (parsed.type === "SAVE_INSIGHT") {
        expect(parsed.agent_id).toBe("usta");
        expect(parsed.domain).toBe("DISTRICT_VALUATION");
        expect(parsed.insight_text).toContain("Nəsimi rayonunda");
        expect(parsed.confidence_score).toBe(0.95);
      }
    });

    it("dispatches discriminated union safely across all action types in exhaustive switch", () => {
      const cards: ActionCardPayload[] = [
        {
          type: "UPDATE_LEAD_STAGE",
          lead_id: "lead-1",
          current_stage: "NEW",
          recommended_stage: "WON_CLOSED",
          rationale: "Alqı-satqı bağlandı",
        },
        {
          type: "DISPATCH_WHATSAPP",
          phone_number: "994551112233",
          draft_text: "Salam",
          wa_link: "https://wa.me/994551112233",
        },
        {
          type: "SAVE_INSIGHT",
          agent_id: "teymur",
          domain: "VIDEO_HOOKS",
          insight_text: "İlk 3 saniyədə qiymət verildikdə baxış retention 40% artır.",
          confidence_score: 0.88,
        },
        {
          type: "OPEN_STAGE_CARD",
          cardType: "VIDEO_INSPECTION",
          targetEntityId: "5616503",
        },
      ];

      const handledTypes: string[] = [];

      for (const card of cards) {
        switch (card.type) {
          case "UPDATE_LEAD_STAGE":
            handledTypes.push(card.type);
            expect(card.recommended_stage).toBe("WON_CLOSED");
            break;
          case "DISPATCH_WHATSAPP":
            handledTypes.push(card.type);
            expect(card.phone_number).toBe("994551112233");
            break;
          case "SAVE_INSIGHT":
            handledTypes.push(card.type);
            expect(card.agent_id).toBe("teymur");
            break;
          case "OPEN_STAGE_CARD":
            handledTypes.push(card.type);
            expect(card.targetEntityId).toBe("5616503");
            break;
          default: {
            const exhaustiveCheck: never = card;
            throw new Error(`Unhandled action card variant: ${exhaustiveCheck}`);
          }
        }
      }

      expect(handledTypes).toEqual([
        "UPDATE_LEAD_STAGE",
        "DISPATCH_WHATSAPP",
        "SAVE_INSIGHT",
        "OPEN_STAGE_CARD",
      ]);
    });
  });

  // =========================================================================
  // 5. Successful Agent Chat Wire Contract via invokeCopilot
  // =========================================================================
  describe("Agent Chat Wire Contract via invokeCopilot", () => {
    it("successfully sends agent_chat action and returns AgentChatResult", async () => {
      const mockResult: AgentChatResult = {
        conversation_id: "conv-101",
        agent_id: "farabi",
        message: {
          id: "msg-202",
          sender_type: "AGENT",
          sender_name: "Farabi",
          content: "Komissiyadan imtina yolverilməzdir. Alıcıya 3000 AZN endirim qazancını vurğula.",
          action_payload: {
            type: "DISPATCH_WHATSAPP",
            phone_number: "994509998877",
            draft_text: "Biz sizin üçün 3000 AZN endirim danışmışıq. 50 AZN xidmət haqqı rəsmi sənəd təminatıdır.",
            wa_link: "https://wa.me/994509998877?text=...",
          },
          created_at: "2026-11-21T12:00:00Z",
        },
        suggested_followups: [
          "Beh razılaşması hazırla",
          "Kupça riskini yoxla",
        ],
      };

      const mockResponse: CopilotApiResponse<AgentChatResult> = {
        ok: true,
        action: "agent_chat",
        model_served: "gemini-3.8-flash",
        run_id: "run-uuid-456",
        data: mockResult,
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const payload: CopilotActionPayload = {
        action: "agent_chat",
        conversation_id: "conv-101",
        agent_id: "farabi",
        message: "Müştəri 50 manat az vermək istəyir.",
        context: {
          lead_id: "lead-442",
          listing_id: "5616503",
        },
      };

      const res = await invokeCopilot<AgentChatResult>(payload);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.action).toBe("agent_chat");
        expect(res.model_served).toBe("gemini-3.8-flash");
        expect(res.data.conversation_id).toBe("conv-101");
        expect(res.data.agent_id).toBe("farabi");
        expect(res.data.message.content).toContain("Komissiyadan imtina yolverilməzdir");
        expect(res.data.message.action_payload?.type).toBe("DISPATCH_WHATSAPP");
        expect(res.data.suggested_followups?.length).toBe(2);
      }
    });
  });
});
