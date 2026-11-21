import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  invokeCopilot,
  getAgentConversation,
  resetAgentConversation,
  type CopilotActionPayload,
  type SentinelAuditResult,
  type ScribeTemplateResult,
  type VoiceDebriefResult,
} from "../lib/ai-client";

describe("AI Client & Wire Contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("successfully invokes copilot and returns parsed payload", async () => {
    const mockData: ScribeTemplateResult = {
      headline: "WhatsApp İsmarış Qaralaması",
      draft_text: "Salam! Mənzil satışdadır.",
      wa_link: "https://wa.me/994501234567?text=Salam",
      listing_code: "kod:5616503",
    };

    const mockResponse = {
      ok: true,
      action: "scribe_response",
      model_served: "gemini-3.1-flash-lite",
      run_id: "test-run-123",
      data: mockData,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const payload: CopilotActionPayload = {
      action: "scribe_response",
      prompt: "Salam, mənzil aktivdir?",
      listing_id: "5616503",
    };

    const res = await invokeCopilot<ScribeTemplateResult>(payload);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.action).toBe("scribe_response");
      expect(res.model_served).toBe("gemini-3.1-flash-lite");
      expect(res.data.listing_code).toBe("kod:5616503");
    }
  });

  it("handles 401 Unauthorized correctly", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        ok: false,
        error: "Unauthorized",
        code: "UNAUTHORIZED",
        fallback_available: true,
      }),
    });

    const res = await invokeCopilot({
      action: "sentinel_audit",
      text: "bina 45",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("UNAUTHORIZED");
      expect(res.fallback_available).toBe(true);
    }
  });

  it("handles 429 Budget Exceeded correctly", async () => {
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

    const res = await invokeCopilot({
      action: "scribe_response",
      prompt: "test",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("BUDGET_EXCEEDED");
      expect(res.fallback_available).toBe(true);
    }
  });

  it("catches network errors and returns fallback UPSTREAM_ERROR", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network connection dropped"));

    const res = await invokeCopilot({
      action: "voice_debrief",
      audio_base64: "AAAA",
      mime_type: "audio/webm",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("UPSTREAM_ERROR");
      expect(res.fallback_available).toBe(true);
      expect(res.error).toContain("Network connection dropped");
    }
  });

  it("validates SentinelAuditResult interface structure", () => {
    const audit: SentinelAuditResult = {
      has_leak: true,
      leaked_tokens: ["bina 45", "mənzil 12"],
      sanitized_text: "Təbriz küçəsi [DƏQİQ ÜNVAN GİZLƏDİLDİ - BAXIŞDA VERİLƏCƏK]",
      sentinel_warning: "Dəqiq ünvan detalı aşkarlandı!",
      commission_defense_rebuttal: "Bizim xidmət haqqımız standartdır...",
    };
    expect(audit.has_leak).toBe(true);
    expect(audit.leaked_tokens.length).toBe(2);
  });

  it("validates VoiceDebriefResult interface structure", () => {
    const voice: VoiceDebriefResult = {
      transcript_az: "Müştəri bəyəndi",
      extracted_stage: "OFFER",
      extracted_offer_azn: 175000,
      extracted_objections: ["qiymət"],
      next_action: "Mülkiyyətçi ilə danış",
    };
    expect(voice.extracted_offer_azn).toBe(175000);
    expect(voice.extracted_stage).toBe("OFFER");
  });

  it("fetches agent conversation thread via getAgentConversation", async () => {
    const mockThread = {
      ok: true,
      action: "get_conversation",
      model_served: "supabase",
      run_id: "run-get-1",
      data: {
        conversation_id: "conv-farabi-123",
        messages: [
          {
            id: "msg-1",
            sender_type: "USER",
            sender_name: "Operator",
            content: "Salam Farabi",
            created_at: "2026-11-21T10:00:00Z",
          },
          {
            id: "msg-2",
            sender_type: "AGENT",
            sender_name: "Farabi",
            content: "Aleykum salam. Eşidirəm sizi.",
            created_at: "2026-11-21T10:00:02Z",
          },
        ],
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockThread,
    });

    const thread = await getAgentConversation("farabi");
    expect(thread.conversation_id).toBe("conv-farabi-123");
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0].content).toBe("Salam Farabi");
  });

  it("resets agent conversation thread via resetAgentConversation", async () => {
    const mockReset = {
      ok: true,
      action: "reset_conversation",
      model_served: "supabase",
      run_id: "run-reset-1",
      data: {
        reset: true,
        agent_id: "mudir",
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockReset,
    });

    const success = await resetAgentConversation("mudir");
    expect(success).toBe(true);
  });
});
