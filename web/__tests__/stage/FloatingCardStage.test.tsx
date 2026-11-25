import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FloatingCardStage } from "@/components/hub/stage/FloatingCardStage";

declare module "vitest" {
  interface Assertion {
    toBeInTheDocument(): void;
  }
}

// Register custom matcher if needed
expect.extend({
  toBeInTheDocument(received) {
    const pass = received !== null && received !== undefined && (received.ownerDocument?.contains(received) ?? true);
    return {
      pass,
      message: () => `expected element ${pass ? "not " : ""}to be in document`,
    };
  },
});

const mockCloseStageCard = vi.fn();
const mockSetActiveStageCardId = vi.fn();

let mockStageCards = [
  { id: "stage-video-1", cardType: "VIDEO_INSPECTION", targetEntityId: "6588858", payload: {} },
  { id: "stage-analytics-1", cardType: "ANALYTICS_TELEMETRY", targetEntityId: "6588858", payload: {} },
];

vi.mock("@/lib/copilot-context", () => ({
  useCopilot: () => ({
    isStageOpen: true,
    stageCards: mockStageCards,
    activeStageCardId: "stage-video-1",
    closeStageCard: mockCloseStageCard,
    setActiveStageCardId: mockSetActiveStageCardId,
    updateStageCardPayload: vi.fn(),
  }),
}));

// Mock child cards so unit test focuses on FloatingCardStage window orchestration
vi.mock("@/components/hub/stage/VideoPipelineCard", () => ({
  VideoPipelineCard: ({ card }: { card: any }) => (
    <div data-testid={`video-card-${card.id}`}>Video Pipeline Content</div>
  ),
}));

vi.mock("@/components/hub/stage/AnalyticsTelemetryCard", () => ({
  AnalyticsTelemetryCard: ({ card }: { card: any }) => (
    <div data-testid={`analytics-card-${card.id}`}>Analytics Telemetry Content</div>
  ),
}));

vi.mock("@/components/hub/stage/CrmNegotiationCard", () => ({
  CrmNegotiationCard: ({ card }: { card: any }) => (
    <div data-testid={`crm-card-${card.id}`}>CRM Negotiation Content</div>
  ),
}));

describe("FloatingCardStage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStageCards = [
      { id: "stage-video-1", cardType: "VIDEO_INSPECTION", targetEntityId: "6588858", payload: {} },
      { id: "stage-analytics-1", cardType: "ANALYTICS_TELEMETRY", targetEntityId: "6588858", payload: {} },
    ];
  });

  it("renders multiple floating card windows simultaneously", () => {
    render(<FloatingCardStage />);
    expect(screen.getByText("Video #6588858")).toBeInTheDocument();
    expect(screen.getByText("Sosial Telemetriya #6588858")).toBeInTheDocument();
    expect(screen.getByTestId("video-card-stage-video-1")).toBeInTheDocument();
    expect(screen.getByTestId("analytics-card-stage-analytics-1")).toBeInTheDocument();
  });

  it("invokes closeStageCard when closing a floating window", () => {
    render(<FloatingCardStage />);
    const closeButtons = screen.getAllByTitle("Bağla");
    expect(closeButtons.length).toBe(2);

    fireEvent.click(closeButtons[0]);
    expect(mockCloseStageCard).toHaveBeenCalledWith("stage-video-1");
  });

  it("renders null when stageCards is empty", () => {
    mockStageCards = [];
    const { container } = render(<FloatingCardStage />);
    expect(container.firstChild).toBeNull();
  });
});
