"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Send,
  Loader2,
  AlertCircle,
  Building2,
  User,
} from "lucide-react";
import type { AgentPersonaId } from "@/lib/agent-personas";
import { AGENT_PERSONAS } from "@/lib/agent-personas";
import type { AgentChatMessage } from "@/lib/ai-client";
import { invokeCopilot, getAgentConversation } from "@/lib/ai-client";
import { useCopilot } from "@/lib/copilot-context";
import { ChatStream } from "./ChatStream";
import { SpecialistRoomPills } from "./SpecialistRoomPills";

type LocalChatMessage = AgentChatMessage & {
  delivery_status?: "SENDING" | "SENT" | "FAILED";
};

interface SpecialistRoomProps {
  persona: AgentPersonaId;
  onSwitchPersona?: (newPersona: AgentPersonaId) => void;
}

export function SpecialistRoom({ persona, onSwitchPersona }: SpecialistRoomProps) {
  const { selectedLeadId, selectedListingId, initialPrompt, setInitialPrompt } = useCopilot();
  
  // Local storage keys
  const storageMsgKey = `bakuestate_hub_${persona}_messages`;
  const storageConvKey = `bakuestate_hub_${persona}_conv_id`;

  // Initialize confirmed messages from localStorage for instant retention across toggles/reloads
  const [messages, setMessages] = useState<LocalChatMessage[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(storageMsgKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.filter(
              (m: LocalChatMessage) => m.delivery_status !== "FAILED"
            );
          }
        }
      } catch {
        // ignore
      }
    }
    return [];
  });

  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(storageConvKey);
        if (saved) return saved;
      } catch {
        // ignore
      }
    }
    return undefined;
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [failedTurn, setFailedTurn] = useState<{ id: string; text: string } | null>(null);

  const personaConfig = AGENT_PERSONAS[persona] || AGENT_PERSONAS.farabi;
  const initialPromptHandledRef = useRef(false);

  // Synchronize only confirmed (non-failed, non-sending) messages to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const confirmed = messages.filter(
          (m) => m.delivery_status !== "FAILED" && m.delivery_status !== "SENDING"
        );
        if (confirmed.length > 0) {
          localStorage.setItem(storageMsgKey, JSON.stringify(confirmed));
        }
      } catch {
        // ignore
      }
    }
  }, [messages, storageMsgKey]);

  // Synchronize conversationId to localStorage
  useEffect(() => {
    if (typeof window !== "undefined" && conversationId) {
      try {
        localStorage.setItem(storageConvKey, conversationId);
      } catch {
        // ignore
      }
    }
  }, [conversationId, storageConvKey]);

  // Load latest conversation thread from server (agent_messages) via copilot API
  const loadConversation = useCallback(async () => {
    try {
      const res = await getAgentConversation(persona);
      if (res.conversation_id) {
        setConversationId(res.conversation_id);
      }
      if (Array.isArray(res.messages) && res.messages.length > 0) {
        setMessages(res.messages.map((m) => ({ ...m, delivery_status: "SENT" })));
      }
    } catch (err) {
      console.debug("Notice loading conversation thread:", err);
    }
  }, [persona]);

  useEffect(() => {
    loadConversation();
  }, [loadConversation]);

  // Handle initial prompt from context if passed from lead card or cockpit
  useEffect(() => {
    if (initialPrompt && !initialPromptHandledRef.current) {
      initialPromptHandledRef.current = true;
      setInputText(initialPrompt);
      setInitialPrompt(null);
    }
  }, [initialPrompt, setInitialPrompt]);

  // Send message to API
  const handleSendMessage = async (textToSend?: string, retryId?: string) => {
    const text = (textToSend || inputText).trim();
    if (!text || isLoading) return;

    if (!retryId) {
      setInputText("");
    }
    setErrorMessage(null);
    setFailedTurn(null);

    const msgId = retryId || `user-${Date.now()}`;
    const userMsg: LocalChatMessage = {
      id: msgId,
      sender_type: "USER",
      sender_name: "Operator",
      content: text,
      created_at: new Date().toISOString(),
      delivery_status: "SENDING",
    };

    setMessages((prev) => [
      ...prev.filter((m) => m.id !== msgId),
      userMsg,
    ]);
    setIsLoading(true);

    try {
      const res = await invokeCopilot<{
        conversation_id?: string;
        message?: AgentChatMessage;
        agent_id?: AgentPersonaId;
      }>({
        action: "agent_chat",
        agent_id: persona,
        conversation_id: conversationId,
        message: text,
        context: {
          lead_id: selectedLeadId || undefined,
          listing_id: selectedListingId || undefined,
        },
      });

      if (!res.ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? { ...m, delivery_status: "FAILED" } : m
          )
        );
        setFailedTurn({ id: msgId, text });
        const errMsg =
          (res.code as string) === "UPSTREAM_UNAVAILABLE"
            ? res.error || "AI xidməti müvəqqəti əlçatan deyil (503)."
            : res.error || "AI cavabı alınarkən xəta baş verdi.";
        setErrorMessage(errMsg);
        return;
      }

      if (res.data?.conversation_id) {
        setConversationId(res.data.conversation_id);
      }

      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.id === msgId ? { ...m, delivery_status: "SENT" as const } : m
        );
        if (res.data?.message) {
          updated.push({ ...res.data.message, delivery_status: "SENT" });
        }
        return updated;
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, delivery_status: "FAILED" } : m
        )
      );
      setFailedTurn({ id: msgId, text });
      setErrorMessage(msg || "Şəbəkə xətası baş verdi.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="flex h-full flex-col bg-obsidian-950">
      {/* Context & Domain Header */}
      <div className="flex items-center justify-between border-b border-slate-800/80 bg-obsidian-900/60 px-4 py-2 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-300">
            <span>{personaConfig.avatarIcon}</span>
            <span>{personaConfig.title}</span>
          </span>

          {selectedLeadId && (
            <span className="inline-flex items-center gap-1 rounded bg-gold-500/15 border border-gold-500/30 px-1.5 py-0.5 text-[10px] text-gold-300 font-mono">
              <User className="h-2.5 w-2.5" />
              <span>Lid #{selectedLeadId.slice(0, 6)}</span>
            </span>
          )}

          {selectedListingId && (
            <span className="inline-flex items-center gap-1 rounded bg-cyan-500/15 border border-cyan-500/30 px-1.5 py-0.5 text-[10px] text-cyan-300 font-mono">
              <Building2 className="h-2.5 w-2.5" />
              <span>Mənzil #{selectedListingId.slice(0, 6)}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {personaConfig.memoryDomains.slice(0, 2).map((dom) => (
            <span
              key={dom}
              className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[9px] font-mono text-slate-400"
            >
              {dom}
            </span>
          ))}
        </div>
      </div>

      {/* Main Chat Messages Stream */}
      <ChatStream
        messages={messages}
        isLoading={isLoading}
        currentAgentId={persona}
        onSelectAgent={onSwitchPersona}
      />

      {/* Error Banner with FAILED state + retry */}
      {errorMessage && (
        <div className="mx-4 mb-2 flex items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-950/40 p-2 text-xs text-rose-300">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
            {failedTurn && (
              <span className="rounded bg-rose-500/20 border border-rose-500/40 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-200">
                FAILED
              </span>
            )}
            <span className="flex-1 truncate">{errorMessage}</span>
          </div>
          {failedTurn && (
            <button
              type="button"
              onClick={() => handleSendMessage(failedTurn.text, failedTurn.id)}
              disabled={isLoading}
              className="shrink-0 rounded-md border border-rose-400/50 bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/30 transition"
            >
              Yenidən Göndər
            </button>
          )}
        </div>
      )}

      {/* Contextual Quick-Action Pills */}
      <div className="border-t border-slate-800/60 bg-obsidian-900/40 px-3 pt-2">
        <SpecialistRoomPills
          persona={persona}
          disabled={isLoading}
          onSelectPill={(pillText) => handleSendMessage(pillText)}
        />
      </div>

      {/* Input Box Footer */}
      <div className="p-3 bg-obsidian-900/80 border-t border-slate-800/80">
        <div className="relative flex items-center rounded-xl border border-slate-800 bg-obsidian-950 focus-within:border-gold-500/50 shadow-inner">
          <textarea
            rows={1}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`${personaConfig.title} üçün mesajınızı yazın... (Enter ilə göndər)`}
            className="flex-1 resize-none bg-transparent py-2.5 pl-3 pr-10 text-xs text-slate-100 placeholder:text-slate-400 focus:outline-none"
          />
          <button
            type="button"
            disabled={!inputText.trim() || isLoading}
            onClick={() => handleSendMessage()}
            className="absolute right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-gold-500 hover:bg-gold-400 text-obsidian-950 shadow-sm transition disabled:opacity-40 disabled:hover:bg-gold-500"
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
