/**
 * Standalone Web CRM AI Engine - Copilot API Client
 *
 * Provides type-safe methods to invoke /api/ai/copilot from Web CRM components
 * with built-in Supabase session injection, error handling, and wire contracts.
 */

import type { AgentPersonaId } from "./agent-personas";
export type { AgentPersonaId } from "./agent-personas";

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
      agent_id: AgentPersonaId | string;
      domain: string;
      insight_text: string;
      confidence_score: number;
    }
  | {
      type: "OPEN_STAGE_CARD";
      cardType: "VIDEO_INSPECTION" | "ANALYTICS_TELEMETRY" | "CRM_NEGOTIATION";
      targetEntityId: string;
      payload?: Record<string, unknown>;
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
  agent_id: AgentPersonaId | string;
  message: AgentChatMessage;
  suggested_followups?: string[];
}

export type CopilotActionPayload =
  | {
      action: "agent_chat";
      conversation_id?: string;
      agent_id: AgentPersonaId | string;
      message: string;
      context?: {
        lead_id?: string;
        listing_id?: string;
        initial_text?: string;
      };
    }
  | {
      action: "get_conversation";
      agent_id: AgentPersonaId | string;
    }
  | {
      action: "reset_conversation";
      agent_id: AgentPersonaId | string;
    }
  | {
      action: "save_insight";
      agent_id: AgentPersonaId | string;
      domain: string;
      insight_text: string;
      confidence_score?: number;
      persona_scope?: "crm" | "analytics" | "general" | string;
      metadata?: Record<string, unknown>;
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
  | "FORBIDDEN"
  | "BUDGET_EXCEEDED"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_UNAVAILABLE";

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

export interface TelegramDispatchPayload {
  listing_id: string;
  render_version_id?: string;
  target_account?: string;
  custom_caption?: string;
  force_queue?: boolean;
}

export interface TelegramDispatchResponse {
  success: boolean;
  dispatch_mode: "DIRECT_URL" | "QUEUED_WORKER";
  telegram_message_id?: number;
  job_id?: string;
  target_chat_id: string;
  error?: string;
}

export interface QueueRenderPayload {
  listing_id: string;
  bina_id?: string;
  job_type?: "RENDER_INITIAL" | "RERENDER";
  target_account?: string;
  voice_preset?: string;
  selected_photo_urls?: string[];
  custom_script_text?: string;
}

export interface QueueRenderResponse {
  success: boolean;
  job_id?: string;
  already_queued?: boolean;
  message?: string;
  error?: string;
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
      } else if (response.status === 403) {
        code = "FORBIDDEN";
      } else if (response.status === 429) {
        code =
          data?.code === "BUDGET_EXCEEDED"
            ? "BUDGET_EXCEEDED"
            : "RATE_LIMITED";
      } else if (
        typeof data?.code === "string" &&
        [
          "UNAUTHORIZED",
          "FORBIDDEN",
          "BUDGET_EXCEEDED",
          "RATE_LIMITED",
          "UPSTREAM_ERROR",
          "UPSTREAM_UNAVAILABLE",
        ].includes(data.code)
      ) {
        code = data.code as CopilotErrorCode;
      } else if (response.status === 503) {
        code = "UPSTREAM_UNAVAILABLE";
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
            : code !== "UPSTREAM_UNAVAILABLE" &&
              code !== "UNAUTHORIZED" &&
              code !== "FORBIDDEN",
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
  agentId: AgentPersonaId | string
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
  agentId: AgentPersonaId | string
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

/**
 * Dispatches a rendered video to Telegram via /api/telegram/dispatch-video.
 */
export async function dispatchTelegramVideo(
  listingId: string,
  renderVersionId?: string,
  customCaption?: string,
  targetAccount?: string
): Promise<TelegramDispatchResponse> {
  const payload: TelegramDispatchPayload = {
    listing_id: listingId,
    render_version_id: renderVersionId,
    custom_caption: customCaption,
    target_account: targetAccount,
  };

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
        // Fallback to cookie-based auth
      }
    }

    const response = await fetch("/api/telegram/dispatch-video", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    return data as TelegramDispatchResponse;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      dispatch_mode: "DIRECT_URL",
      target_chat_id: "",
      error: message || "Telegram göndəriş xətası baş verdi.",
    };
  }
}

/**
 * Enqueues an unrendered listing for background video rendering.
 */
export async function queueRenderInitial(
  listingId: string,
  binaId?: string,
  targetAccount?: string,
  voicePreset?: string
): Promise<QueueRenderResponse> {
  const payload: QueueRenderPayload = {
    listing_id: listingId,
    bina_id: binaId,
    target_account: targetAccount,
    voice_preset: voicePreset,
  };

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
        // Fallback to cookie-based auth
      }
    }

    const response = await fetch("/api/pipeline/queue-render", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    return data as QueueRenderResponse;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message || "Montaj növbəsinə əlavə edilərkən xəta baş verdi.",
    };
  }
}
