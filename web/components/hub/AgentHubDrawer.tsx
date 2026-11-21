"use client";

import React, { useState, useEffect } from "react";
import {
  X,
  RotateCcw,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { useCopilot } from "@/lib/copilot-context";
import type { AgentPersonaId } from "@/lib/agent-personas";
import { OmniChatRoom } from "./OmniChatRoom";
import { SpecialistRoom } from "./SpecialistRoom";
import { createClient } from "@/lib/supabase/client";

const PERSONA_TABS: {
  id: AgentPersonaId;
  label: string;
  avatar: string;
  badge: string;
  model: string;
}[] = [
  {
    id: "mudir",
    label: "Müdir",
    avatar: "👔",
    badge: "Omni Qərargah",
    model: "gemini-3.8-flash",
  },
  {
    id: "farabi",
    label: "Farabi",
    avatar: "🛡️",
    badge: "Danışıq & Qalxan",
    model: "gemini-3.8-flash",
  },
  {
    id: "usta",
    label: "Usta",
    avatar: "📐",
    badge: "Qiymət & Arbitraj",
    model: "gemini-3.8-flash",
  },
  {
    id: "teymur",
    label: "Teymur",
    avatar: "📱",
    badge: "Sosial & Reels",
    model: "gemini-3.1-flash-lite",
  },
];

export function AgentHubDrawer() {
  const { isOpen, closeCopilot, activePersona, setActivePersona } = useCopilot();
  const [resetConfirm, setResetConfirm] = useState(false);
  const [threadKey, setThreadKey] = useState(0);

  const currentTab = PERSONA_TABS.find((t) => t.id === activePersona) || PERSONA_TABS[0];

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        closeCopilot();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeCopilot]);

  // Reset thread handler
  const handleResetThread = async () => {
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        // Clear/archive thread for current persona
        await supabase
          .from("agent_conversations")
          .delete()
          .eq("operator_id", user.id)
          .eq("agent_id", activePersona);
      }
    } catch {
      // Ignore network errors on reset
    }

    // Force re-render of room components with fresh state
    setThreadKey((k) => k + 1);
    setResetConfirm(true);
    setTimeout(() => setResetConfirm(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity animate-fadeIn"
        onClick={closeCopilot}
        aria-hidden="true"
      />

      {/* Slide-over Drawer Container */}
      <div className="fixed inset-y-0 right-0 flex max-w-full pl-0 md:pl-10">
        <div className="w-screen max-w-2xl flex flex-col bg-obsidian-950 border-l border-slate-800/90 shadow-2xl animate-slideInRight">
          {/* Top Bar: Title, Model Badge, Thread Reset, Close */}
          <div className="flex items-center justify-between border-b border-slate-800/90 px-4 py-3 bg-obsidian-900/95">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-gold-400 to-amber-600 text-obsidian-950 shadow-md">
                <Zap className="h-4 w-4 fill-obsidian-950 text-obsidian-950" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-slate-100">
                    ⚡ AI İcraçı Qərargahı
                  </h2>
                  <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>Aktiv</span>
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 flex items-center gap-1.5">
                  <span>Model:</span>
                  <span className="font-mono text-gold-400">{currentTab.model}</span>
                  <span>•</span>
                  <span>{currentTab.badge}</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {/* Reset Thread Action */}
              <button
                type="button"
                onClick={handleResetThread}
                className="flex items-center gap-1 rounded-lg border border-slate-800 bg-obsidian-950 hover:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer"
                title="Söhbəti sıfırla və təmizlə"
              >
                {resetConfirm ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-emerald-400 text-[11px]">Sıfırlandı</span>
                  </>
                ) : (
                  <>
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span className="text-[11px] hidden sm:inline">Sıfırla</span>
                  </>
                )}
              </button>

              {/* Close Drawer Button */}
              <button
                type="button"
                onClick={closeCopilot}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition cursor-pointer"
                aria-label="Qərargahı Bağla"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Persona Switcher Tabs */}
          <div className="flex items-center border-b border-slate-800/80 bg-obsidian-900/60 px-3 overflow-x-auto no-scrollbar">
            {PERSONA_TABS.map((tab) => {
              const active = tab.id === activePersona;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActivePersona(tab.id)}
                  className={`flex items-center gap-2 border-b-2 py-2.5 px-3.5 text-xs font-semibold transition cursor-pointer whitespace-nowrap ${
                    active
                      ? "border-gold-400 text-gold-300 bg-gold-500/10"
                      : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/30"
                  }`}
                >
                  <span className="text-sm">{tab.avatar}</span>
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Room Content: Omni vs Specialist */}
          <div className="flex-1 overflow-hidden" key={`${activePersona}-${threadKey}`}>
            {activePersona === "mudir" ? (
              <OmniChatRoom onSwitchPersona={(p) => setActivePersona(p)} />
            ) : (
              <SpecialistRoom
                persona={activePersona}
                onSwitchPersona={(p) => setActivePersona(p)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
