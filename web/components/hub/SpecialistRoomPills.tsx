"use client";

import React from "react";
import type { AgentPersonaId } from "@/lib/agent-personas";
import { AGENT_PERSONAS } from "@/lib/agent-personas";
import { Sparkles } from "lucide-react";

interface SpecialistRoomPillsProps {
  persona: AgentPersonaId;
  onSelectPill: (pillText: string) => void;
  disabled?: boolean;
}

const PERSONA_PILL_STYLES: Record<
  AgentPersonaId,
  {
    border: string;
    bg: string;
    text: string;
    hover: string;
    iconColor: string;
  }
> = {
  mudir: {
    border: "border-gold-500/30",
    bg: "bg-gold-500/10",
    text: "text-gold-300",
    hover: "hover:bg-gold-500/20 hover:border-gold-400/50",
    iconColor: "text-gold-400",
  },
  farabi: {
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/10",
    text: "text-emerald-300",
    hover: "hover:bg-emerald-500/20 hover:border-emerald-400/50",
    iconColor: "text-emerald-400",
  },
  usta: {
    border: "border-cyan-500/30",
    bg: "bg-cyan-500/10",
    text: "text-cyan-300",
    hover: "hover:bg-cyan-500/20 hover:border-cyan-400/50",
    iconColor: "text-cyan-400",
  },
  teymur: {
    border: "border-purple-500/30",
    bg: "bg-purple-500/10",
    text: "text-purple-300",
    hover: "hover:bg-purple-500/20 hover:border-purple-400/50",
    iconColor: "text-purple-400",
  },
};

export function SpecialistRoomPills({
  persona,
  onSelectPill,
  disabled = false,
}: SpecialistRoomPillsProps) {
  const config = AGENT_PERSONAS[persona];
  const pills = config?.quickPills || [];
  const styles = PERSONA_PILL_STYLES[persona] || PERSONA_PILL_STYLES.mudir;

  if (!pills.length) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-1 no-scrollbar text-xs">
      {pills.map((pill, idx) => (
        <button
          key={`${persona}-pill-${idx}`}
          type="button"
          disabled={disabled}
          onClick={() => onSelectPill(pill)}
          className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed ${styles.border} ${styles.bg} ${styles.text} ${styles.hover}`}
        >
          <Sparkles className={`h-2.5 w-2.5 ${styles.iconColor}`} />
          <span>{pill}</span>
        </button>
      ))}
    </div>
  );
}
