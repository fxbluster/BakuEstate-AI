"use client";

import React from "react";
import { User, ArrowRight, CornerDownRight } from "lucide-react";
import type { AgentChatMessage } from "@/lib/ai-client";
import type { AgentPersonaId } from "@/lib/agent-personas";
import { AGENT_PERSONAS } from "@/lib/agent-personas";
import { ActionCardView } from "./ActionCardView";

interface ChatMessageItemProps {
  message: AgentChatMessage;
  onActionComplete?: (type: string) => void;
  onSelectAgent?: (agentId: AgentPersonaId) => void;
}

const AGENT_THEMES: Record<
  AgentPersonaId,
  {
    border: string;
    bg: string;
    avatarBg: string;
    badgeText: string;
    badgeBg: string;
    badgeBorder: string;
    icon: string;
  }
> = {
  mudir: {
    border: "border-gold-500/30",
    bg: "bg-obsidian-950/90",
    avatarBg: "bg-gradient-to-br from-gold-400 to-amber-600 text-obsidian-950",
    badgeText: "text-gold-300",
    badgeBg: "bg-gold-500/15",
    badgeBorder: "border-gold-500/30",
    icon: "👔",
  },
  farabi: {
    border: "border-emerald-500/30",
    bg: "bg-obsidian-950/90",
    avatarBg: "bg-gradient-to-br from-emerald-400 to-teal-600 text-obsidian-950",
    badgeText: "text-emerald-300",
    badgeBg: "bg-emerald-500/15",
    badgeBorder: "border-emerald-500/30",
    icon: "🛡️",
  },
  usta: {
    border: "border-cyan-500/30",
    bg: "bg-obsidian-950/90",
    avatarBg: "bg-gradient-to-br from-cyan-400 to-blue-600 text-obsidian-950",
    badgeText: "text-cyan-300",
    badgeBg: "bg-cyan-500/15",
    badgeBorder: "border-cyan-500/30",
    icon: "📐",
  },
  teymur: {
    border: "border-purple-500/30",
    bg: "bg-obsidian-950/90",
    avatarBg: "bg-gradient-to-br from-purple-400 to-violet-600 text-obsidian-950",
    badgeText: "text-purple-300",
    badgeBg: "bg-purple-500/15",
    badgeBorder: "border-purple-500/30",
    icon: "📱",
  },
};

/**
 * Basic markdown renderer supporting paragraphs, bolding, bullet points and numbered lists.
 */
function MarkdownContent({ content }: { content: string }) {
  if (!content) return null;

  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];

  lines.forEach((line, lineIdx) => {
    const trimmed = line.trim();

    // Empty line -> spacing
    if (!trimmed) {
      elements.push(<div key={`empty-${lineIdx}`} className="h-2" />);
      return;
    }

    // Bullet points
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const rawText = trimmed.replace(/^[-*]\s+/, "");
      elements.push(
        <div key={`bullet-${lineIdx}`} className="flex items-start gap-2 my-0.5 pl-1">
          <span className="text-gold-400 font-bold select-none">•</span>
          <span className="flex-1">{formatInline(rawText)}</span>
        </div>
      );
      return;
    }

    // Numbered lists
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      elements.push(
        <div key={`num-${lineIdx}`} className="flex items-start gap-2 my-0.5 pl-1">
          <span className="font-mono text-gold-400 font-semibold select-none">
            {numMatch[1]}.
          </span>
          <span className="flex-1">{formatInline(numMatch[2])}</span>
        </div>
      );
      return;
    }

    // Quotes / Callout
    if (trimmed.startsWith("> ")) {
      elements.push(
        <blockquote
          key={`quote-${lineIdx}`}
          className="my-1.5 border-l-2 border-gold-400/60 bg-gold-500/5 px-2.5 py-1 text-xs italic text-slate-300 rounded-r"
        >
          {formatInline(trimmed.replace(/^>\s*/, ""))}
        </blockquote>
      );
      return;
    }

    // Normal paragraph
    elements.push(
      <p key={`p-${lineIdx}`} className="my-0.5 leading-relaxed">
        {formatInline(trimmed)}
      </p>
    );
  });

  return <div className="space-y-0.5 text-xs text-slate-200">{elements}</div>;
}

/**
 * Handles bolding **text** within text lines.
 */
function formatInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-bold text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

export function ChatMessageItem({
  message,
  onActionComplete,
  onSelectAgent,
}: ChatMessageItemProps) {
  // Normalize user vs assistant
  const isUser =
    message.sender_type === "USER" ||
    (message as unknown as { role?: string }).role === "user";

  const timeFormatted = message.created_at
    ? new Date(message.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  if (isUser) {
    return (
      <div className="flex justify-end gap-2.5 my-2.5 px-2">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-gradient-to-br from-gold-500/20 via-gold-600/10 to-obsidian-900 border border-gold-500/30 p-3 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-1 text-[10px] text-gold-300 font-semibold">
            <span>Siz (Operator)</span>
            {timeFormatted && <span className="opacity-70 font-mono">{timeFormatted}</span>}
          </div>
          <p className="text-xs text-slate-100 whitespace-pre-wrap leading-relaxed">
            {message.content}
          </p>
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gold-500/20 text-gold-300 border border-gold-500/30 mt-0.5">
          <User className="h-4 w-4" />
        </div>
      </div>
    );
  }

  // Determine Agent Identity
  const rawMsg = message as { agent_id?: AgentPersonaId };
  const agentId: AgentPersonaId =
    rawMsg.agent_id ||
    (message.sender_name?.toLowerCase().includes("farabi")
      ? "farabi"
      : message.sender_name?.toLowerCase().includes("usta")
        ? "usta"
        : message.sender_name?.toLowerCase().includes("teymur")
          ? "teymur"
          : "mudir");

  const theme = AGENT_THEMES[agentId] || AGENT_THEMES.mudir;
  const personaConfig = AGENT_PERSONAS[agentId];
  const agentTitle = personaConfig?.title || message.sender_name || "Müdir";
  const roleSubtitle = personaConfig?.roleSubtitle || "";

  // Check delegation
  const delegation = (message as unknown as { delegation?: { target_agent: AgentPersonaId; rationale: string } })
    .delegation;

  return (
    <div className="flex items-start gap-2.5 my-2.5 px-2">
      {/* Agent Avatar */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl shadow-md text-sm select-none ${theme.avatarBg}`}
        title={`${agentTitle} - ${roleSubtitle}`}
      >
        <span>{personaConfig?.avatarIcon || theme.icon}</span>
      </div>

      {/* Message Container */}
      <div className={`flex-1 max-w-[88%] rounded-2xl rounded-tl-sm border p-3.5 shadow-sm ${theme.border} ${theme.bg}`}>
        {/* Header: Title, Role, Timestamp */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-1.5 mb-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-bold text-slate-100">{agentTitle}</span>
            <span
              className={`rounded-full border px-2 py-0.2 text-[9px] font-semibold tracking-wider uppercase ${theme.badgeBg} ${theme.badgeText} ${theme.badgeBorder}`}
            >
              {roleSubtitle || "Executive"}
            </span>
          </div>
          {timeFormatted && (
            <span className="text-[10px] text-slate-400 font-mono">{timeFormatted}</span>
          )}
        </div>

        {/* Delegation Banner if present */}
        {delegation && (
          <div className="mb-2.5 flex items-center justify-between gap-2 rounded-lg border border-gold-500/40 bg-gold-500/10 p-2 text-xs">
            <div className="flex items-center gap-1.5 text-gold-300">
              <CornerDownRight className="h-3.5 w-3.5 text-gold-400" />
              <span>
                Yönləndirmə: <strong className="text-gold-200">@{delegation.target_agent}</strong>
              </span>
            </div>
            {onSelectAgent && (
              <button
                type="button"
                onClick={() => onSelectAgent(delegation.target_agent)}
                className="inline-flex items-center gap-1 rounded bg-gold-500/20 hover:bg-gold-500/30 px-2 py-0.5 text-[10px] font-bold text-gold-300 transition"
              >
                <span>Otağa Keç</span>
                <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {/* Message Body */}
        <MarkdownContent content={message.content} />

        {/* Executable Action Card */}
        {message.action_payload && (
          <ActionCardView
            card={message.action_payload}
            onActionComplete={onActionComplete}
          />
        )}
      </div>
    </div>
  );
}
