"use client";

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import type { AgentPersonaId } from "@/lib/agent-personas";

export type CopilotTab = "shield" | "debrief";

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
  openCopilot: (tab?: CopilotTab, context?: CopilotOpenContext) => void;
  openAgentHub: (
    persona?: AgentPersonaId,
    context?: { leadId?: string; listingId?: string; initialPrompt?: string }
  ) => void;
  closeCopilot: () => void;
  setActiveTab: (tab: CopilotTab) => void;
  setActivePersona: (persona: AgentPersonaId) => void;
  setSelectedLeadId: (id: string | null) => void;
  setSelectedListingId: (id: string | null) => void;
  setInitialText: (text: string | null) => void;
  setInitialPrompt: (prompt: string | null) => void;
}

const CopilotContext = createContext<CopilotContextType | undefined>(undefined);

export function CopilotProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CopilotTab>("shield");
  const [activePersona, setActivePersona] = useState<AgentPersonaId>("mudir");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [initialText, setInitialText] = useState<string | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null);

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
        setActivePersona(context.persona);
      }
    }
    setIsOpen(true);
  }, []);

  const openAgentHub = useCallback((
    persona: AgentPersonaId = "mudir",
    context?: { leadId?: string; listingId?: string; initialPrompt?: string }
  ) => {
    setActivePersona(persona);
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

  const value = useMemo<CopilotContextType>(() => ({
    isOpen,
    activeTab,
    activePersona,
    selectedLeadId,
    selectedListingId,
    initialText,
    initialPrompt,
    openCopilot,
    openAgentHub,
    closeCopilot,
    setActiveTab,
    setActivePersona,
    setSelectedLeadId,
    setSelectedListingId,
    setInitialText,
    setInitialPrompt,
  }), [
    isOpen,
    activeTab,
    activePersona,
    selectedLeadId,
    selectedListingId,
    initialText,
    initialPrompt,
    openCopilot,
    openAgentHub,
    closeCopilot,
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
