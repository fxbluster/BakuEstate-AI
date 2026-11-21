"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Send,
  Loader2,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import type { AgentPersonaId } from "@/lib/agent-personas";
import type { AgentChatMessage } from "@/lib/ai-client";
import { invokeCopilot, getAgentConversation } from "@/lib/ai-client";
import { useCopilot } from "@/lib/copilot-context";
import { ChatStream } from "./ChatStream";
import { SpecialistRoomPills } from "./SpecialistRoomPills";

interface OmniChatRoomProps {
  onSwitchPersona: (persona: AgentPersonaId) => void;
}

const SPECIALIST_PREVIEWS: {
  id: AgentPersonaId;
  name: string;
  role: string;
  icon: string;
  badgeColor: string;
}[] = [
  {
    id: "analitika" as AgentPersonaId,
    name: "Analitika",
    role: "Bazar & Sosial Telemetriya",
    icon: "📊",
    badgeColor: "border-purple-500/30 text-purple-300 bg-purple-500/10",
  },
  {
    id: "musteri_psixologiyasi" as AgentPersonaId,
    name: "Müştəri Psixologiyası",
    role: "Danışıq & Etiraz Qalxanı",
    icon: "🛡️",
    badgeColor: "border-emerald-500/30 text-emerald-300 bg-emerald-500/10",
  },
];

export function OmniChatRoom({ onSwitchPersona }: OmniChatRoomProps) {
  const { selectedLeadId, selectedListingId, initialPrompt, setInitialPrompt } = useCopilot();
  
  // Local storage keys
  const storageMsgKey = "bakuestate_hub_mudir_messages";
  const storageConvKey = "bakuestate_hub_mudir_conv_id";

  // Initialize messages from localStorage for instant retention across toggles/reloads
  const [messages, setMessages] = useState<AgentChatMessage[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(storageMsgKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
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

  const initialPromptHandledRef = useRef(false);

  // Synchronize messages to localStorage
  useEffect(() => {
    if (typeof window !== "undefined" && messages.length > 0) {
      try {
        localStorage.setItem(storageMsgKey, JSON.stringify(messages));
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

  // Load latest OMNI conversation thread from server via copilot API
  const loadConversation = useCallback(async () => {
    try {
      const res = await getAgentConversation("mudir");
      if (res.conversation_id) {
        setConversationId(res.conversation_id);
      }
      if (Array.isArray(res.messages) && res.messages.length > 0) {
        setMessages(res.messages);
      }
    } catch (err) {
      console.debug("Notice loading omni conversation thread:", err);
    }
  }, []);

  useEffect(() => {
    loadConversation();
  }, [loadConversation]);

  // Handle initial prompt from context
  useEffect(() => {
    if (initialPrompt && !initialPromptHandledRef.current) {
      initialPromptHandledRef.current = true;
      setInputText(initialPrompt);
      setInitialPrompt(null);
    }
  }, [initialPrompt, setInitialPrompt]);

  // Send message to Müdir
  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputText).trim();
    if (!text || isLoading) return;

    setInputText("");
    setErrorMessage(null);

    // Optimistic user message
    const userMsg: AgentChatMessage = {
      id: `user-${Date.now()}`,
      sender_type: "USER",
      sender_name: "Operator",
      content: text,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const res = await invokeCopilot<{
        conversation_id?: string;
        message?: AgentChatMessage;
        agent_id?: AgentPersonaId;
      }>({
        action: "agent_chat",
        agent_id: "mudir",
        conversation_id: conversationId,
        message: text,
        context: {
          lead_id: selectedLeadId || undefined,
          listing_id: selectedListingId || undefined,
        },
      });

      if (!res.ok) {
        setErrorMessage(res.error || "Müdir cavabı hazırlayarkən xəta baş verdi.");
        return;
      }

      if (res.data?.conversation_id) {
        setConversationId(res.data.conversation_id);
      }

      if (res.data?.message) {
        setMessages((prev) => [...prev, res.data.message!]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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
      {/* Executive Command Radar & Council Status HUD */}
      <div className="border-b border-slate-800/80 bg-gradient-to-r from-obsidian-950 via-obsidian-900 to-obsidian-950 p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] font-bold tracking-wider uppercase text-gold-400">
              İcraçı Şura Mərkəzi (Executive Council)
            </span>
          </div>
          <span className="rounded bg-gold-500/10 border border-gold-500/20 px-2 py-0.5 text-[9px] font-mono text-gold-300">
            Müdir Dispetçeri
          </span>
        </div>

        {/* 2 Specialist Standby Pills */}
        <div className="grid grid-cols-2 gap-2">
          {SPECIALIST_PREVIEWS.map((spec) => (
            <button
              key={spec.id}
              type="button"
              onClick={() => onSwitchPersona(spec.id)}
              className={`flex items-center justify-between gap-1 rounded-lg border p-1.5 text-left transition hover:brightness-125 cursor-pointer ${spec.badgeColor}`}
              title={`${spec.name} otağına keç`}
            >
              <div className="truncate">
                <div className="flex items-center gap-1">
                  <span className="text-xs">{spec.icon}</span>
                  <span className="text-[11px] font-bold text-slate-100">{spec.name}</span>
                </div>
                <div className="text-[9px] text-slate-400 truncate">{spec.role}</div>
              </div>
              <ArrowRight className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          ))}
        </div>
      </div>

      {/* Omni Chat Message Feed */}
      <ChatStream
        messages={messages}
        isLoading={isLoading}
        currentAgentId="mudir"
        onSelectAgent={onSwitchPersona}
      />

      {/* Error Banner */}
      {errorMessage && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/40 p-2 text-xs text-rose-300">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
          <span className="flex-1">{errorMessage}</span>
        </div>
      )}

      {/* Contextual Quick-Action Pills */}
      <div className="border-t border-slate-800/60 bg-obsidian-900/40 px-3 pt-2">
        <SpecialistRoomPills
          persona="mudir"
          disabled={isLoading}
          onSelectPill={(pillText) => handleSendMessage(pillText)}
        />
      </div>

      {/* Input Box Footer */}
      <div className="p-3 bg-obsidian-900/80 border-t border-slate-800/80">
        <div className="relative flex items-center rounded-xl border border-gold-500/30 bg-obsidian-950 focus-within:border-gold-400/70 shadow-inner">
          <textarea
            rows={1}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Müdirə tapşırıq verin və ya vəziyyət sorğulayın... (Enter)"
            className="flex-1 resize-none bg-transparent py-2.5 pl-3 pr-10 text-xs text-slate-100 placeholder:text-slate-400 focus:outline-none"
          />
          <button
            type="button"
            disabled={!inputText.trim() || isLoading}
            onClick={() => handleSendMessage()}
            className="absolute right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-r from-gold-500 to-amber-500 hover:from-gold-400 hover:to-amber-400 text-obsidian-950 shadow-sm transition disabled:opacity-40"
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5 font-bold" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
