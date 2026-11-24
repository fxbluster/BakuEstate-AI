"use client";

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import {
  type AgentPersonaId,
  type SupportedPersonaId,
  resolvePersonaId,
} from "@/lib/agent-personas";

export type CopilotTab = "shield" | "debrief";

export type StageCardType = "VIDEO_INSPECTION" | "ANALYTICS_TELEMETRY" | "CRM_NEGOTIATION";

export type StageViewMode = "docked" | "maximized" | "split";

export interface VideoStagePayload {
  cardType: "VIDEO_INSPECTION";
  listingId: string;
  binaId?: string;
  title?: string;
  priceAzn?: number;
  rooms?: number;
  areaM2?: number;
  location?: string;
  nicheBadge?: string;
  buildingType?: string;
  videoCdnUrl?: string | null;
  isRendered?: boolean;
  photos?: string[];
  targetAccount?: string;
  renderVersionId?: string;
  caption?: string;
  specs?: {
    bina_id?: string;
    price_azn?: number;
    rooms?: number;
    area_m2?: number;
    location?: string;
    niche_badge?: string;
    building_type?: string;
  };
}

export interface AnalyticsStagePayload {
  cardType: "ANALYTICS_TELEMETRY";
  targetAccount?: string;
  publicationId?: string;
  listingId?: string;
  title?: string;
  specs?: {
    bina_id?: string;
    price_azn?: number;
    rooms?: number;
    area_m2?: number;
    location?: string;
    niche_badge?: string;
    building_type?: string;
  };
  viewsTrajectory?: { date: string; views: number }[];
  engagementRate?: number;
  nicheMedianEr?: number;
  channelMetrics?: {
    channel: "instagram" | "tiktok" | "youtube" | "facebook";
    views: number;
    likes: number;
    shares: number;
    er: number;
  }[];
}

export interface CrmNegotiationPayload {
  cardType: "CRM_NEGOTIATION";
  leadId: string;
  leadName?: string;
  phone?: string;
  dialogueHistory?: {
    id?: string;
    sender: "lead" | "agent" | "system";
    text: string;
    time?: string;
  }[];
  draftText?: string;
  waLink?: string;
  listingSpecs?: {
    listingId?: string;
    title?: string;
    price?: string | number;
    location?: string;
    hasKupca?: boolean;
  };
  extractedObjection?: {
    tag: string;
    domain: string;
    insightText: string;
    confidence?: number;
  };
}

export type StageCardPayload =
  | VideoStagePayload
  | AnalyticsStagePayload
  | CrmNegotiationPayload;

export interface StageCardInstance {
  id: string;
  cardType: StageCardType;
  originPersona?: AgentPersonaId | string;
  targetEntityId: string;
  payload: StageCardPayload;
  viewMode?: StageViewMode;
  isPaused?: boolean;
  createdAt?: number;
}

export interface OpenStageCardInput {
  id?: string;
  cardType: StageCardType;
  originPersona?: AgentPersonaId | string;
  targetEntityId?: string;
  payload?: StageCardPayload;
  viewMode?: StageViewMode;
  isPaused?: boolean;
  listingId?: string;
  binaId?: string;
  leadId?: string;
  publicationId?: string;
}

export interface CopilotOpenContext {
  leadId?: string | null;
  listingId?: string | null;
  initialText?: string | null;
  persona?: AgentPersonaId | null;
}

export interface AgentHubOpenContext {
  leadId?: string | null;
  listingId?: string | null;
  initialPrompt?: string | null;
}

export interface CopilotContextType {
  isOpen: boolean;
  activeTab: CopilotTab;
  activePersona: AgentPersonaId;
  selectedLeadId: string | null;
  selectedListingId: string | null;
  initialText: string | null;
  initialPrompt: string | null;

  // Stage cards state
  stageCards: StageCardInstance[];
  activeStageCardId: string | null;
  stageViewMode: StageViewMode;

  // Handlers
  openCopilot: (tab?: CopilotTab, context?: CopilotOpenContext) => void;
  openAgentHub: (
    persona?: SupportedPersonaId | string,
    context?: { leadId?: string; listingId?: string; initialPrompt?: string }
  ) => void;
  closeCopilot: () => void;
  setActiveTab: (tab: CopilotTab) => void;
  setActivePersona: (persona: SupportedPersonaId | string) => void;
  setSelectedLeadId: (id: string | null) => void;
  setSelectedListingId: (id: string | null) => void;
  setInitialText: (text: string | null) => void;
  setInitialPrompt: (prompt: string | null) => void;

  // Left canvas stage handlers
  openStageCard: (card: OpenStageCardInput) => void;
  closeStageCard: (cardId: string) => void;
  setActiveStageCardId: (cardId: string | null) => void;
  setStageViewMode: (mode: StageViewMode) => void;
  clearStageCards: () => void;
  updateStageCardPayload: (cardId: string, partialPayload: Partial<StageCardPayload>) => void;
}

const CopilotContext = createContext<CopilotContextType | undefined>(undefined);

export function CopilotProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CopilotTab>("shield");
  const [activePersona, setActivePersonaState] = useState<AgentPersonaId>("mudir");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [initialText, setInitialText] = useState<string | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);

  const setActivePersona = useCallback((persona: SupportedPersonaId | string) => {
    setActivePersonaState(resolvePersonaId(persona));
  }, []);

  // Stage Cards State
  const [stageCards, setStageCards] = useState<StageCardInstance[]>([]);
  const [activeStageCardId, setActiveStageCardId] = useState<string | null>(null);
  const [stageViewMode, setStageViewMode] = useState<StageViewMode>("docked");

  const openCopilot = useCallback((tab: CopilotTab = "shield", context?: CopilotOpenContext) => {
    setActiveTab(tab);
    if (context) {
      if (context.leadId !== undefined) {
        setSelectedLeadId(context.leadId ?? null);
      }
      if (context.listingId !== undefined) {
        setSelectedListingId(context.listingId ?? null);
      }
      if (context.initialText !== undefined) {
        setInitialText(context.initialText ?? null);
        setInitialPrompt(context.initialText ?? null);
      }
      if (context.persona) {
        setActivePersonaState(resolvePersonaId(context.persona));
      }
    }
    setIsOpen(true);
  }, []);

  const openAgentHub = useCallback((
    persona: SupportedPersonaId | string = "mudir",
    context?: { leadId?: string; listingId?: string; initialPrompt?: string }
  ) => {
    setActivePersonaState(resolvePersonaId(persona));
    if (context) {
      if (context.leadId !== undefined) {
        setSelectedLeadId(context.leadId ?? null);
      }
      if (context.listingId !== undefined) {
        setSelectedListingId(context.listingId ?? null);
      }
      if (context.initialPrompt !== undefined) {
        setInitialPrompt(context.initialPrompt ?? null);
        setInitialText(context.initialPrompt ?? null);
      }
    }
    setIsOpen(true);
  }, []);

  const closeCopilot = useCallback(() => {
    setIsOpen(false);
  }, []);

  const openStageCard = useCallback((cardInput: OpenStageCardInput) => {
    const targetEntityId =
      cardInput.targetEntityId ||
      (cardInput.payload && "listingId" in cardInput.payload ? cardInput.payload.listingId : undefined) ||
      (cardInput.payload && "leadId" in cardInput.payload ? cardInput.payload.leadId : undefined) ||
      cardInput.listingId ||
      cardInput.leadId ||
      cardInput.binaId ||
      cardInput.publicationId ||
      `entity_${Date.now()}`;

    const resolvedId = cardInput.id || `${cardInput.cardType}_${targetEntityId}`;

    let resolvedPayload: StageCardPayload;
    if (cardInput.payload) {
      resolvedPayload = cardInput.payload;
    } else if (cardInput.cardType === "VIDEO_INSPECTION") {
      resolvedPayload = {
        cardType: "VIDEO_INSPECTION",
        listingId: cardInput.listingId || targetEntityId,
        binaId: cardInput.binaId,
        isRendered: false,
      };
    } else if (cardInput.cardType === "ANALYTICS_TELEMETRY") {
      resolvedPayload = {
        cardType: "ANALYTICS_TELEMETRY",
        listingId: cardInput.listingId || targetEntityId,
        publicationId: cardInput.publicationId,
      };
    } else {
      resolvedPayload = {
        cardType: "CRM_NEGOTIATION",
        leadId: cardInput.leadId || targetEntityId,
      };
    }

    setStageCards((prev) => {
      // Deduplication: match by exact id or by same cardType AND same targetEntityId
      const existingIndex = prev.findIndex(
        (c) =>
          c.id === resolvedId ||
          (c.cardType === cardInput.cardType && c.targetEntityId === targetEntityId)
      );

      if (existingIndex >= 0) {
        // Focus existing card, merge payload
        const updated = [...prev];
        const existing = updated[existingIndex];
        const mergedPayload = { ...existing.payload, ...resolvedPayload } as StageCardPayload;
        updated[existingIndex] = {
          ...existing,
          payload: mergedPayload,
          isPaused: cardInput.isPaused ?? false,
        };
        setActiveStageCardId(existing.id);
        return updated;
      }

      // Maximum 5 cards in the stage tab deck
      const maxStageCards = 5;

      const newCard: StageCardInstance = {
        id: resolvedId,
        cardType: cardInput.cardType,
        originPersona: cardInput.originPersona,
        targetEntityId,
        payload: resolvedPayload,
        viewMode: cardInput.viewMode || "docked",
        isPaused: cardInput.isPaused ?? false,
        createdAt: Date.now(),
      };

      let nextCards = [...prev, newCard];
      if (nextCards.length > maxStageCards) {
        nextCards = nextCards.slice(nextCards.length - maxStageCards);
      }
      setActiveStageCardId(newCard.id);
      return nextCards;
    });

    setIsOpen(true);
  }, []);

  const closeStageCard = useCallback((cardId: string) => {
    setStageCards((prev) => {
      const next = prev.filter((c) => c.id !== cardId);
      setActiveStageCardId((curr) => {
        if (curr === cardId) {
          return next.length > 0 ? next[next.length - 1].id : null;
        }
        return curr;
      });
      return next;
    });
  }, []);

  const clearStageCards = useCallback(() => {
    setStageCards([]);
    setActiveStageCardId(null);
  }, []);

  const updateStageCardPayload = useCallback((cardId: string, partialPayload: Partial<StageCardPayload>) => {
    setStageCards((prev) =>
      prev.map((card) => {
        if (card.id === cardId) {
          return {
            ...card,
            payload: { ...card.payload, ...partialPayload } as StageCardPayload,
          };
        }
        return card;
      })
    );
  }, []);

  const value = useMemo<CopilotContextType>(() => ({
    isOpen,
    activeTab,
    activePersona,
    selectedLeadId,
    selectedListingId,
    initialText,
    initialPrompt,
    stageCards,
    activeStageCardId,
    stageViewMode,
    openCopilot,
    openAgentHub,
    closeCopilot,
    setActiveTab,
    setActivePersona,
    setSelectedLeadId,
    setSelectedListingId,
    setInitialText,
    setInitialPrompt,
    openStageCard,
    closeStageCard,
    setActiveStageCardId,
    setStageViewMode,
    clearStageCards,
    updateStageCardPayload,
  }), [
    isOpen,
    activeTab,
    activePersona,
    selectedLeadId,
    selectedListingId,
    initialText,
    initialPrompt,
    stageCards,
    activeStageCardId,
    stageViewMode,
    openCopilot,
    openAgentHub,
    closeCopilot,
    setActivePersona,
    openStageCard,
    closeStageCard,
    clearStageCards,
    updateStageCardPayload,
  ]);

  return (
    <CopilotContext.Provider value={value}>
      {children}
    </CopilotContext.Provider>
  );
}

export function useCopilot(): CopilotContextType {
  const context = useContext(CopilotContext);
  if (!context) {
    throw new Error("useCopilot must be used within a CopilotProvider");
  }
  return context;
}
