"use client";

import React, { useEffect, useRef } from "react";
import type { AgentChatMessage } from "@/lib/ai-client";
import type { AgentPersonaId, SupportedPersonaId } from "@/lib/agent-personas";
import { AGENT_PERSONAS } from "@/lib/agent-personas";
import { ChatMessageItem } from "./ChatMessageItem";
import { Sparkles } from "lucide-react";

interface ChatStreamProps {
  messages: AgentChatMessage[];
  isLoading: boolean;
  currentAgentId: AgentPersonaId;
  onActionComplete?: (type: string) => void;
  onSelectAgent?: (agentId: AgentPersonaId) => void;
}

const TYPING_LABELS: Record<SupportedPersonaId, string> = {
  mudir: "Müdir orkestrasiyanı icra edir və təhlil aparır...",
  analitika: "Analitika bazar tendensiyalarını və sosial metrikanı araşdırır...",
  musteri_psixologiyasi: "Müştəri Psixologiyası danışıq və etiraz strategiyasını qurur...",
  farabi: "Farabi komissiya və danışıq strategiyasını qurur...",
  usta: "Usta m² bazar qiymətini və arbitrajı hesablayır...",
  teymur: "Teymur sosial kanal metrikanı və hook-u araşdırır...",
};

export function ChatStream({
  messages,
  isLoading,
  currentAgentId,
  onActionComplete,
  onSelectAgent,
}: ChatStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const personaConfig = AGENT_PERSONAS[currentAgentId] || AGENT_PERSONAS.mudir;

  // Auto-scroll to bottom whenever messages change or loading triggers
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading]);

  return (
    <div className="flex-1 overflow-y-auto px-2 py-4 space-y-2">
      {/* Empty State Welcome */}
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-gold-500/20 via-obsidian-900 to-obsidian-950 border border-gold-500/30 text-2xl shadow-lg mb-3">
            <span>{personaConfig.avatarIcon}</span>
          </div>

          <h3 className="text-sm font-bold text-slate-100">
            {personaConfig.title} ilə Canlı Məsləhətləşmə
          </h3>
          <p className="mt-1 text-xs text-gold-400 font-medium">
            {personaConfig.roleSubtitle}
          </p>

          <p className="mt-2 max-w-sm text-xs text-slate-400 leading-relaxed">
            {currentAgentId === "mudir"
              ? "Bütün agentliyin əməliyyatlarını, prioritetlərini və sahə ekspertlərini vahid komanda mərkəzindən koordinasiya edin."
              : currentAgentId === "analitika" || (currentAgentId as string) === "teymur"
                ? "Bazar qiymət dinamikası, m² analitikası və sosial media / Reels baxış telemetriyası."
                : currentAgentId === "musteri_psixologiyasi" || (currentAgentId as string) === "farabi"
                  ? "50–100 ₼ komissiya müdafiəsi, Kupça hüquqi zəmanəti, Beh müqavilələri və müştəri etirazları üzrə küçə strategiyası."
                  : (currentAgentId as string) === "usta"
                    ? "Bakı rayonları üzrə real m² qiymətləndirməsi, bina layihələri, təmir maya dəyəri və bina.az arbitraj təhlili."
                    : "Sualınızı yazın və ya yuxarıdakı hazır şablonlardan istifadə edin."}
          </p>

          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-obsidian-900/90 px-3 py-1 text-[11px] text-slate-400">
            <Sparkles className="h-3 w-3 text-gold-400" />
            <span>Sualınızı yazın və ya yuxarıdakı hazır şablonlardan istifadə edin</span>
          </div>
        </div>
      )}

      {/* Render All Messages */}
      {messages.map((msg) => (
        <ChatMessageItem
          key={msg.id}
          message={msg}
          onActionComplete={onActionComplete}
          onSelectAgent={onSelectAgent}
        />
      ))}

      {/* Simulated Typing Indicator */}
      {isLoading && (
        <div className="flex items-start gap-2.5 my-2.5 px-2 animate-fadeIn">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-obsidian-900 border border-gold-500/30 shadow-md text-sm">
            <span>{personaConfig.avatarIcon}</span>
          </div>
          <div className="rounded-2xl rounded-tl-sm border border-gold-500/20 bg-obsidian-950/80 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-gold-400 animate-bounce [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-gold-400 animate-bounce [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-gold-400 animate-bounce" />
              </div>
              <span className="text-[11px] text-slate-400 italic">
                {TYPING_LABELS[currentAgentId] || "AI cavabı hazırlayır..."}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Target for smooth scrolling */}
      <div ref={scrollRef} />
    </div>
  );
}
