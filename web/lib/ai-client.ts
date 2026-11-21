/**
 * Standalone Web CRM AI Engine - Copilot API Client
 *
 * Provides type-safe methods to invoke /api/ai/copilot from Web CRM components
 * with built-in Supabase session injection, error handling, and wire contracts.
 */

export type AgentPersonaId = "mudir" | "farabi" | "teymur" | "usta";

export type ActionCardPayload =
  | {
      type: "UPDATE_LEAD_STAGE";
      lead_id: string;
      current_stage: string;
      recommended_stage: string;
      rationale: string;
    }
  | {
      type: "DISPATCH_WHATSAPP";
      phone_number: string;
      draft_text: string;
      listing_code?: string;
      wa_link: string;
    }
  | {
      type: "SAVE_INSIGHT";
      agent_id: AgentPersonaId;
      domain: string;
      insight_text: string;
      confidence_score: number;
    };

export interface AgentChatMessage {
  id: string;
  sender_type: "USER" | "AGENT" | "SYSTEM";
  sender_name: string;
  content: string;
  action_payload?: ActionCardPayload | null;
  created_at: string;
}

export interface AgentChatResult {
  conversation_id: string;
  agent_id: AgentPersonaId;
  message: AgentChatMessage;
  suggested_followups?: string[];
}

export type CopilotActionPayload =
  | {
      action: "agent_chat";
      conversation_id?: string;
      agent_id: AgentPersonaId;
      message: string;
      context?: {
        lead_id?: string;
        listing_id?: string;
        initial_text?: string;
      };
    }
  | {
      action: "get_conversation";
      agent_id: AgentPersonaId;
    }
  | {
      action: "reset_conversation";
      agent_id: AgentPersonaId;
    }
  | {
      action: "scribe_response";
      prompt: string;
      lead_id?: string;
      listing_id?: string;
      language_style?: "baku_colloquial";
    }
  | {
      action: "sentinel_audit";
      text: string;
      listing_id?: string;
      deal_type?: "SALE" | "RENT";
    }
  | {
      action: "voice_debrief";
      audio_base64: string;
      mime_type: "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/aac";
      listing_id?: string;
      lead_id?: string;
    }
  | {
      action: "strategist_cockpit";
      limit?: number;
    };

export type CopilotErrorCode =
  | "UNAUTHORIZED"
  | "BUDGET_EXCEEDED"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR";

export type CopilotApiResponse<T = unknown> =
  | {
      ok: true;
      action: string;
      model_served: string;
      run_id: string;
      data: T;
    }
  | {
      ok: false;
      error: string;
      code: CopilotErrorCode;
      fallback_available: boolean;
    };

export interface SentinelAuditResult {
  has_leak: boolean;
  leaked_tokens: string[];
  sanitized_text: string;
  sentinel_warning: string | null;
  commission_defense_rebuttal: string | null;
}

export interface ScribeTemplateResult {
  headline: string;
  draft_text: string;
  wa_link: string;
  listing_code: string;
}

export interface VoiceDebriefResult {
  transcript_az: string;
  extracted_stage: string;
  extracted_offer_azn: number | null;
  extracted_objections: string[];
  next_action: string;
}

export interface StrategistCockpitResult {
  briefing_title?: string;
  total_candidates?: number;
  top_cards: Record<string, unknown>[];
  executive_summary?: string;
}

/**
 * Invokes the serverless /api/ai/copilot endpoint.
 * Automatically extracts Supabase JWT access token if executed in browser client.
 */
export async function invokeCopilot<T = unknown>(
  payload: CopilotActionPayload
): Promise<CopilotApiResponse<T>> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (typeof window !== "undefined") {
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers["Authorization"] = `Bearer ${session.access_token}`;
        }
      } catch {
        // Fallback to cookie-based authentication handled by browser
      }
    }

    const response = await fetch("/api/ai/copilot", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON response
    }

    if (!response.ok) {
      let code: CopilotErrorCode = "UPSTREAM_ERROR";
      if (response.status === 401) {
        code = "UNAUTHORIZED";
      } else if (response.status === 429) {
        code =
          data?.code === "BUDGET_EXCEEDED"
            ? "BUDGET_EXCEEDED"
            : "RATE_LIMITED";
      } else if (
        typeof data?.code === "string" &&
        ["UNAUTHORIZED", "BUDGET_EXCEEDED", "RATE_LIMITED", "UPSTREAM_ERROR"].includes(
          data.code
        )
      ) {
        code = data.code as CopilotErrorCode;
      }

      return {
        ok: false,
        error:
          (typeof data?.error === "string" && data.error) ||
          `Server error (HTTP ${response.status})`,
        code,
        fallback_available:
          typeof data?.fallback_available === "boolean"
            ? data.fallback_available
            : true,
      };
    }

    return data as unknown as CopilotApiResponse<T>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message || "Şəbəkə və ya gözlənilməz xəta baş verdi.",
      code: "UPSTREAM_ERROR",
      fallback_available: true,
    };
  }
}

/**
 * Loads the latest active conversation thread for a given agent persona.
 */
export async function getAgentConversation(
  agentId: AgentPersonaId
): Promise<{ conversation_id: string | null; messages: AgentChatMessage[] }> {
  try {
    const res = await invokeCopilot<{
      conversation_id: string | null;
      messages: AgentChatMessage[];
    }>({
      action: "get_conversation",
      agent_id: agentId,
    });
    if (res.ok && res.data) {
      return res.data;
    }
  } catch (err) {
    console.debug("Failed to get agent conversation:", err);
  }
  return { conversation_id: null, messages: [] };
}

/**
 * Resets / clears the conversation history for a given agent persona.
 */
export async function resetAgentConversation(
  agentId: AgentPersonaId
): Promise<boolean> {
  try {
    const res = await invokeCopilot<{ reset: boolean }>({
      action: "reset_conversation",
      agent_id: agentId,
    });
    return res.ok;
  } catch (err) {
    console.debug("Failed to reset agent conversation:", err);
    return false;
  }
}
