"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Film, TrendingUp, MessageSquare } from "lucide-react";
import { useCopilot, type StageCardInstance } from "@/lib/copilot-context";
import { FloatingCardWindow } from "./FloatingCardWindow";
import { VideoPipelineCard } from "./VideoPipelineCard";
import { AnalyticsTelemetryCard } from "./AnalyticsTelemetryCard";
import { CrmNegotiationCard } from "./CrmNegotiationCard";

export function FloatingCardStage() {
  const { stageCards, activeStageCardId, setActiveStageCardId, closeStageCard } = useCopilot();
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);

  // Sync active card from context or fallback to top card
  useEffect(() => {
    if (activeStageCardId) {
      setFocusedCardId(activeStageCardId);
    } else if (stageCards && stageCards.length > 0) {
      setFocusedCardId(stageCards[stageCards.length - 1].id);
    }
  }, [activeStageCardId, stageCards]);

  // Auto-pause media when cards change or stage unmounts
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
  }, [stageCards?.length]);

  const bringToFront = useCallback(
    (cardId: string) => {
      setFocusedCardId(cardId);
      setActiveStageCardId?.(cardId);
    },
    [setActiveStageCardId]
  );

  if (!stageCards || stageCards.length === 0) {
    return null;
  }

  const getCardTitle = (card: StageCardInstance) => {
    const entityId =
      card.targetEntityId ||
      (card.payload as { binaId?: string; listingId?: string; leadId?: string })?.binaId ||
      (card.payload as { binaId?: string; listingId?: string; leadId?: string })?.listingId ||
      "";

    switch (card.cardType) {
      case "VIDEO_INSPECTION":
        return `Video #${entityId}`;
      case "ANALYTICS_TELEMETRY":
        return `Sosial Telemetriya #${entityId}`;
      case "CRM_NEGOTIATION":
        return `WhatsApp #${entityId}`;
      default:
        return `Kart #${entityId}`;
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
      default:
        return null;
    }
  };

  const getCardBadge = (card: StageCardInstance) => {
    const payload = card.payload as unknown as Record<string, unknown> | undefined;
    switch (card.cardType) {
      case "VIDEO_INSPECTION": {
        const isRendered = Boolean(payload?.isRendered || payload?.videoCdnUrl);
        return (
          <span
            className={`px-1.5 py-0.2 rounded-full text-[10px] font-medium border ${
              isRendered
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                : "bg-amber-500/15 text-amber-300 border-amber-500/30"
            }`}
          >
            {isRendered ? "Hazır" : "Gözləyir"}
          </span>
        );
      }
      case "ANALYTICS_TELEMETRY":
        return (
          <span className="px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
            Telemetriya
          </span>
        );
      case "CRM_NEGOTIATION":
        return (
          <span className="px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            CRM
          </span>
        );
      default:
        return null;
    }
  };

  const renderCardContent = (card: StageCardInstance) => {
    switch (card.cardType) {
      case "VIDEO_INSPECTION":
        return (
          <VideoPipelineCard
            card={card}
            onClose={() => closeStageCard(card.id)}
            onRefresh={() => {}}
          />
        );
      case "ANALYTICS_TELEMETRY":
        return (
          <AnalyticsTelemetryCard
            card={card}
            onClose={() => closeStageCard(card.id)}
            onRefresh={() => {}}
          />
        );
      case "CRM_NEGOTIATION":
        return (
          <CrmNegotiationCard
            card={card}
            onClose={() => closeStageCard(card.id)}
            onRefresh={() => {}}
          />
        );
      default:
        return null;
    }
  };

  const getCardDefaultDimensions = (type: StageCardInstance["cardType"]) => {
    switch (type) {
      case "VIDEO_INSPECTION":
        return { defaultWidth: 580, defaultHeight: 510, minWidth: 460, minHeight: 400 };
      case "ANALYTICS_TELEMETRY":
        return { defaultWidth: 640, defaultHeight: 520, minWidth: 480, minHeight: 400 };
      case "CRM_NEGOTIATION":
        return { defaultWidth: 540, defaultHeight: 500, minWidth: 420, minHeight: 380 };
      default:
        return { defaultWidth: 620, defaultHeight: 520, minWidth: 360, minHeight: 320 };
    }
  };

  return (
    <div
      data-testid="floating-card-stage"
      className="fixed inset-0 pointer-events-none z-40 overflow-hidden"
    >
      {stageCards.map((card, index) => {
        const isFocused =
          focusedCardId === card.id || (!focusedCardId && index === stageCards.length - 1);
        const zIndex = isFocused ? 60 : 40 + index;
        const dims = getCardDefaultDimensions(card.cardType);

        return (
          <FloatingCardWindow
            key={card.id}
            id={card.id}
            title={getCardTitle(card)}
            icon={getCardIcon(card.cardType)}
            badge={getCardBadge(card)}
            initialOffsetIndex={index}
            onClose={() => closeStageCard(card.id)}
            onFocus={() => bringToFront(card.id)}
            zIndex={zIndex}
            isFocused={isFocused}
            defaultWidth={dims.defaultWidth}
            defaultHeight={dims.defaultHeight}
            minWidth={dims.minWidth}
            minHeight={dims.minHeight}
          >
            {renderCardContent(card)}
          </FloatingCardWindow>
        );
      })}
    </div>
  );
}
