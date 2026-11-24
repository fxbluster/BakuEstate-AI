"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Film,
  TrendingUp,
  MessageSquare,
  Maximize2,
  Minimize2,
  X,
  Layers,
  SlidersHorizontal,
} from "lucide-react";
import { useCopilot, type StageCardInstance } from "@/lib/copilot-context";
import { VideoPipelineCard } from "./stage/VideoPipelineCard";
import { AnalyticsTelemetryCard } from "./stage/AnalyticsTelemetryCard";
import { CrmNegotiationCard } from "./stage/CrmNegotiationCard";

export function LeftCanvasStage() {
  const {
    stageCards,
    activeStageCardId,
    setActiveStageCardId,
    stageViewMode,
    setStageViewMode,
    closeStageCard,
    clearStageCards,
  } = useCopilot();

  const [widthPreset, setWidthPreset] = useState<"compact" | "standard" | "wide">("standard");

  // Auto-pause cleanup effect: pause all media streams when stage unmounts or active card switches
  useEffect(() => {
    return () => {
      if (typeof document !== "undefined") {
        const media = document.querySelectorAll<HTMLMediaElement>("video, audio");
        media.forEach((el) => {
          try {
            if (!el.paused) {
              el.pause();
            }
          } catch {
            // Ignore pause errors
          }
        });
      }
    };
  }, [stageCards?.length, activeStageCardId]);

  // Resolve active card (fallback to first card)
  const activeCard = useMemo(() => {
    if (!stageCards || stageCards.length === 0) return null;
    return stageCards.find((c) => c.id === activeStageCardId) || stageCards[0];
  }, [stageCards, activeStageCardId]);

  // Invariant: If no cards are open, render nothing so left canvas is 100% click-through
  if (!stageCards || stageCards.length === 0) {
    return null;
  }

  const toggleMaximize = (cardId: string) => {
    if (stageViewMode === "maximized") {
      setStageViewMode("docked");
    } else {
      setActiveStageCardId(cardId);
      setStageViewMode("maximized");
    }
  };

  const getCardIcon = (type: StageCardInstance["cardType"]) => {
    switch (type) {
      case "VIDEO_INSPECTION":
        return <Film className="w-3.5 h-3.5 text-amber-400" />;
      case "ANALYTICS_TELEMETRY":
        return <TrendingUp className="w-3.5 h-3.5 text-indigo-400" />;
      case "CRM_NEGOTIATION":
        return <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />;
    }
  };

  const getCardLabel = (card: StageCardInstance) => {
    switch (card.cardType) {
      case "VIDEO_INSPECTION":
        return `Video #${card.targetEntityId}`;
      case "ANALYTICS_TELEMETRY":
        return `Telemetriya #${card.targetEntityId}`;
      case "CRM_NEGOTIATION":
        return `WhatsApp #${card.targetEntityId}`;
    }
  };

  const renderCard = (card: StageCardInstance, isMaximized: boolean) => {
    switch (card.cardType) {
      case "VIDEO_INSPECTION":
        return (
          <VideoPipelineCard
            key={card.id}
            card={card}
            isMaximized={isMaximized}
            onMaximizeToggle={() => toggleMaximize(card.id)}
            onClose={() => closeStageCard(card.id)}
            onRefresh={() => {}}
          />
        );
      case "ANALYTICS_TELEMETRY":
        return (
          <AnalyticsTelemetryCard
            key={card.id}
            card={card}
            isMaximized={isMaximized}
            onMaximizeToggle={() => toggleMaximize(card.id)}
            onClose={() => closeStageCard(card.id)}
            onRefresh={() => {}}
          />
        );
      case "CRM_NEGOTIATION":
        return (
          <CrmNegotiationCard
            key={card.id}
            card={card}
            isMaximized={isMaximized}
            onMaximizeToggle={() => toggleMaximize(card.id)}
            onClose={() => closeStageCard(card.id)}
            onRefresh={() => {}}
          />
        );
      default:
        return null;
    }
  };

  const maxWidthStyle =
    stageViewMode === "maximized"
      ? "100%"
      : widthPreset === "compact"
      ? "560px"
      : widthPreset === "standard"
      ? "860px"
      : "1240px";

  return (
    <div
      data-testid="left-canvas-stage"
      className="pointer-events-auto h-full flex flex-col p-3 sm:p-4 md:p-6 overflow-hidden w-full mx-auto bg-obsidian-950/85 backdrop-blur-xl border-r border-slate-800/80 shadow-2xl transition-all duration-300"
      style={{ maxWidth: maxWidthStyle }}
    >
      {/* Stage Header / Switcher Bar */}
      <div className="flex items-center justify-between gap-3 mb-3 shrink-0">
        <div className="flex items-center gap-2 overflow-x-auto py-1">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-obsidian-900/90 border border-slate-800 text-[11px] font-semibold text-slate-300 shrink-0">
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            <span>Fəaliyyət Arenası</span>
            <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-amber-300 text-[10px] font-mono">
              {stageCards.length}
            </span>
          </div>

          {/* Tab Selector for Cards */}
          {stageCards.map((card) => {
            const isActive = activeCard?.id === card.id;
            return (
              <button
                key={card.id}
                onClick={() => setActiveStageCardId(card.id)}
                className={`flex items-center gap-2 px-3 py-1 rounded-xl text-xs font-medium whitespace-nowrap transition-all duration-200 border ${
                  isActive
                    ? "bg-slate-800/95 text-slate-100 border-amber-500/40 shadow-sm"
                    : "bg-obsidian-900/60 text-slate-400 border-slate-800/80 hover:text-slate-200 hover:bg-slate-800/60"
                }`}
              >
                {getCardIcon(card.cardType)}
                <span>{getCardLabel(card)}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeStageCard(card.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      closeStageCard(card.id);
                    }
                  }}
                  title="Kartı bağla"
                  className="hover:text-rose-400 p-0.5 rounded transition-colors"
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            );
          })}
        </div>

        {/* Global Controls & Width Sizing Presets */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Width Adjuster Pill ("boyunu ayarlamaq / genişləndirmək") */}
          <div className="hidden sm:flex items-center gap-1 bg-obsidian-900/90 border border-slate-800 rounded-lg p-0.5 text-[10px]">
            <span className="px-1.5 text-slate-500 flex items-center gap-1">
              <SlidersHorizontal className="w-3 h-3 text-gold-400" />
              <span className="hidden xl:inline">Ölçü:</span>
            </span>
            <button
              type="button"
              onClick={() => setWidthPreset("compact")}
              className={`px-2 py-0.5 rounded transition ${
                widthPreset === "compact"
                  ? "bg-slate-700 text-gold-300 font-semibold shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              title="Kompakt en (560px)"
            >
              560px
            </button>
            <button
              type="button"
              onClick={() => setWidthPreset("standard")}
              className={`px-2 py-0.5 rounded transition ${
                widthPreset === "standard"
                  ? "bg-slate-700 text-gold-300 font-semibold shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              title="Standart en (860px)"
            >
              860px
            </button>
            <button
              type="button"
              onClick={() => setWidthPreset("wide")}
              className={`px-2 py-0.5 rounded transition ${
                widthPreset === "wide"
                  ? "bg-slate-700 text-gold-300 font-semibold shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              title="Geniş en (1240px)"
            >
              Geniş
            </button>
          </div>

          <button
            onClick={() => setStageViewMode(stageViewMode === "maximized" ? "docked" : "maximized")}
            title={stageViewMode === "maximized" ? "Standart Rejim" : "Tam Ekrana Böyüt"}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-obsidian-900/80 border border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
          >
            {stageViewMode === "maximized" ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Kiçilt</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Böyüt</span>
              </>
            )}
          </button>
          <button
            onClick={clearStageCards}
            title="Hamısını Bağla"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-obsidian-900/80 border border-slate-800 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Hamısını Bağla</span>
          </button>
        </div>
      </div>

      {/* Stage Body - Responsive Multi-Card Layout */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {stageViewMode === "maximized" && activeCard ? (
          /* Maximized Mode: Active card takes full stage width */
          <div className="h-full w-full">
            {renderCard(activeCard, true)}
          </div>
        ) : stageCards.length === 1 ? (
          /* Single Card: Occupies the full stage width cleanly */
          <div className="h-full w-full min-h-0">
            {renderCard(stageCards[0], false)}
          </div>
        ) : (
          /* Multi-Card Layout: Dual-column on wide screens, tabbed active card otherwise */
          <>
            {/* Viewport >= 1440px or wide preset: Dual-card Horizontal Split */}
            <div
              className={`hidden ${
                widthPreset === "compact" ? "" : "2xl:grid 2xl:grid-cols-2"
              } gap-4 h-full`}
            >
              {stageCards.slice(0, 2).map((card) => (
                <div key={card.id} className="h-full min-h-0">
                  {renderCard(card, false)}
                </div>
              ))}
            </div>

            {/* Viewport < 1440px or Compact preset: Single-Card Focus with Tab Selector */}
            <div className={`h-full ${widthPreset === "compact" ? "block" : "2xl:hidden"}`}>
              {activeCard && (
                <div className="h-full min-h-0">
                  {renderCard(activeCard, false)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
export default LeftCanvasStage;
