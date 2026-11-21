// @vitest-environment happy-dom
import React, { useEffect } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CopilotProvider, useCopilot, type OpenStageCardInput } from "../../lib/copilot-context";
import { LeftCanvasStage } from "../../components/hub/LeftCanvasStage";

// Setup global mocks for DOM APIs not fully implemented in happy-dom
beforeEach(() => {
  if (typeof window !== "undefined") {
    window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.pause = vi.fn();
    Object.defineProperty(window.navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      writable: true,
      configurable: true,
    });
  }
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  if (typeof document !== "undefined") {
    document.body.innerHTML = "";
  }
  vi.restoreAllMocks();
});

// Helper component that consumes useCopilot to programmatically drive the stage
function TestStageRig({
  onMount,
}: {
  onMount?: (copilot: ReturnType<typeof useCopilot>) => void;
}) {
  const copilot = useCopilot();
  const mountedRef = React.useRef(false);

  useEffect(() => {
    if (onMount && !mountedRef.current) {
      mountedRef.current = true;
      onMount(copilot);
    }
  }, [onMount, copilot]);

  return (
    <div>
      <div data-testid="copilot-open-indicator">
        {copilot.isOpen ? "OPEN" : "CLOSED"}
      </div>
      <LeftCanvasStage />
    </div>
  );
}

describe("LeftCanvasStage Integration Tests", () => {
  it("renders null when stageCards is empty (100% click-through invariant)", () => {
    const { container } = render(
      <CopilotProvider>
        <TestStageRig />
      </CopilotProvider>
    );

    // Left canvas stage should not exist in DOM
    expect(screen.queryByTestId("left-canvas-stage")).toBeNull();
    expect(container.querySelector("[data-testid='left-canvas-stage']")).toBeNull();
  });

  it("mounts LeftCanvasStage when a card is opened", async () => {
    render(
      <CopilotProvider>
        <TestStageRig
          onMount={(copilot) => {
            copilot.openStageCard({
              cardType: "VIDEO_INSPECTION",
              listingId: "6572383",
              payload: {
                cardType: "VIDEO_INSPECTION",
                listingId: "6572383",
                title: "Səbail r., 4 otaqlı premium mənzil",
                priceAzn: 385000,
                isRendered: true,
                videoCdnUrl: "https://example.com/video.mp4",
                targetAccount: "@bakuestate.premium",
              },
            });
          }}
        />
      </CopilotProvider>
    );

    // Stage must be mounted
    await waitFor(() => {
      expect(screen.getByTestId("left-canvas-stage")).not.toBeNull();
    });

    // Header badge and tabs
    expect(screen.getByText("Fəaliyyət Arenası")).not.toBeNull();
    expect(screen.getByText("Video #6572383")).not.toBeNull();
    expect(screen.getAllByText(/6572383/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/385.*AZN/).length).toBeGreaterThan(0);
  });

  it("handles responsive dual-card layout and tab switching", async () => {
    if (typeof window !== "undefined") {
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 1920,
      });
    }
    let copilotApi: ReturnType<typeof useCopilot> | undefined;

    render(
      <CopilotProvider>
        <TestStageRig
          onMount={(copilot) => {
            copilotApi = copilot;
            copilot.openStageCard({
              cardType: "VIDEO_INSPECTION",
              listingId: "101",
              payload: {
                cardType: "VIDEO_INSPECTION",
                listingId: "101",
                title: "Lüks Mənzil 101",
                isRendered: true,
              },
            });
            copilot.openStageCard({
              cardType: "CRM_NEGOTIATION",
              leadId: "lead_202",
              payload: {
                cardType: "CRM_NEGOTIATION",
                leadId: "lead_202",
                leadName: "Kamran Qasımov",
                phone: "994503332211",
              },
            });
          }}
        />
      </CopilotProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("left-canvas-stage")).not.toBeNull();
    });

    // Check tabs
    expect(screen.getByText("Video #101")).not.toBeNull();
    expect(screen.getByText("WhatsApp #lead_202")).not.toBeNull();

    // Verify card count badge
    expect(screen.getByText("2")).not.toBeNull();

    // Maximize button toggles mode
    const maximizeBtn = screen.getByTitle("Tam Ekrana Böyüt");
    expect(maximizeBtn).not.toBeNull();
    fireEvent.click(maximizeBtn);

    // After clicking maximize, title changes to "Standart Rejim"
    await waitFor(() => {
      expect(screen.getByTitle("Standart Rejim")).not.toBeNull();
      expect(screen.getByText("Kiçilt")).not.toBeNull();
    });

    // Clicking restore returns to standard mode
    fireEvent.click(screen.getByTitle("Standart Rejim"));
    await waitFor(() => {
      expect(screen.getByTitle("Tam Ekrana Böyüt")).not.toBeNull();
    });
  });

  it("dismisses cards with (X) button and unmounts stage when empty", async () => {
    let copilotApi: ReturnType<typeof useCopilot> | undefined;

    render(
      <CopilotProvider>
        <TestStageRig
          onMount={(copilot) => {
            copilotApi = copilot;
            copilot.openStageCard({
              cardType: "VIDEO_INSPECTION",
              listingId: "303",
              payload: {
                cardType: "VIDEO_INSPECTION",
                listingId: "303",
                isRendered: true,
              },
            });
          }}
        />
      </CopilotProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("left-canvas-stage")).not.toBeNull();
    });

    // Click tab dismiss (X)
    const dismissTabBtn = screen.getByTitle("Kartı bağla");
    fireEvent.click(dismissTabBtn);

    // All cards are now dismissed; stage must return null
    await waitFor(() => {
      expect(screen.queryByTestId("left-canvas-stage")).toBeNull();
    });
  });

  it("executes global 'Hamısını Bağla' clear button", async () => {
    render(
      <CopilotProvider>
        <TestStageRig
          onMount={(copilot) => {
            copilot.openStageCard({
              cardType: "VIDEO_INSPECTION",
              listingId: "401",
              payload: {
                cardType: "VIDEO_INSPECTION",
                listingId: "401",
                isRendered: true,
              },
            });
            copilot.openStageCard({
              cardType: "ANALYTICS_TELEMETRY",
              listingId: "402",
              payload: {
                cardType: "ANALYTICS_TELEMETRY",
                listingId: "402",
              },
            });
          }}
        />
      </CopilotProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("left-canvas-stage")).not.toBeNull();
    });

    const clearAllBtn = screen.getByTitle("Hamısını Bağla");
    fireEvent.click(clearAllBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("left-canvas-stage")).toBeNull();
    });
  });

  it("handles [ ✈️ Teleqramıma Göndər ] action on rendered VideoPipelineCard", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        dispatch_mode: "DIRECT_URL",
        telegram_message_id: 8492,
        target_chat_id: "6238843776",
      }),
    });
    global.fetch = fetchMock;

    render(
      <CopilotProvider>
        <TestStageRig
          onMount={(copilot) => {
            copilot.openStageCard({
              cardType: "VIDEO_INSPECTION",
              listingId: "501",
              payload: {
                cardType: "VIDEO_INSPECTION",
                listingId: "501",
                binaId: "501",
                isRendered: true,
                videoCdnUrl: "https://example.com/video501.mp4",
                targetAccount: "@bakuestate.premium",
                caption: "Lüks mənzil satışda",
              },
            });
          }}
        />
      </CopilotProvider>
    );

    await waitFor(() => {
      expect(screen.getAllByText("✈️ Teleqramıma Göndər").length).toBeGreaterThan(0);
    });

    const dispatchBtn = screen.getAllByText("✈️ Teleqramıma Göndər")[0];
    fireEvent.click(dispatchBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/telegram/dispatch-video",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            listing_id: "501",
            render_version_id: undefined,
            target_account: "@bakuestate.premium",
            custom_caption: "Lüks mənzil satışda",
          }),
        })
      );
    });

    // Success confirmation banner
    await waitFor(() => {
      expect(screen.getAllByText("Video Teleqrama göndərildi!").length).toBeGreaterThan(0);
    });
  });

  it("handles [ 🚀 Montaj Boru Xəttinə Göndər ] action on unrendered VideoPipelineCard", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        job_id: "job_render_601",
        status: "QUEUED",
      }),
    });
    global.fetch = fetchMock;

    render(
      <CopilotProvider>
        <TestStageRig
          onMount={(copilot) => {
            copilot.openStageCard({
              cardType: "VIDEO_INSPECTION",
              listingId: "601",
              payload: {
                cardType: "VIDEO_INSPECTION",
                listingId: "601",
                binaId: "601",
                isRendered: false,
                targetAccount: "@bakuestate.premium",
              },
            });
          }}
        />
      </CopilotProvider>
    );

    await waitFor(() => {
      expect(screen.getAllByText("Montaj Gözləyir").length).toBeGreaterThan(0);
      expect(screen.getAllByText("🚀 Montaj Boru Xəttinə Göndər").length).toBeGreaterThan(0);
    });

    const queueBtn = screen.getAllByText("🚀 Montaj Boru Xəttinə Göndər")[0];
    fireEvent.click(queueBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pipeline/queue-render",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            listing_id: "601",
            bina_id: "601",
            target_account: "@bakuestate.premium",
            voice_preset: "Arif",
          }),
        })
      );
    });

    // Confirmation text
    await waitFor(() => {
      expect(screen.getAllByText("⏳ Növbəyə Əlavə Edildi").length).toBeGreaterThan(0);
    });
  });

  it("handles authentic Baku WhatsApp negotiation & [ 💾 Təsdiqlə və Yaddaşa Yaz ] on CrmNegotiationCard", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "success",
        insight_id: "insight_701",
      }),
    });
    global.fetch = fetchMock;

    render(
      <CopilotProvider>
        <TestStageRig
          onMount={(copilot) => {
            copilot.openStageCard({
              cardType: "CRM_NEGOTIATION",
              leadId: "lead_701",
              payload: {
                cardType: "CRM_NEGOTIATION",
                leadId: "lead_701",
                leadName: "Tofiq Məmmədov",
                phone: "994509998877",
                draftText: "Salam, xeyr, ev tam kupçalıdır, ipotekaya da yararlıdır.",
                extractedObjection: {
                  tag: "İmtina: Kupça Şübhəsi",
                  domain: "OBJECTION_KUPCA_TRUST",
                  insightText: "Alıcı Badamdar evində kupçanın olmadığını düşünür.",
                  confidence: 0.95,
                },
              },
            });
          }}
        />
      </CopilotProvider>
    );

    await waitFor(() => {
      expect(screen.getAllByText(/Tofiq Məmmədov/).length).toBeGreaterThan(0);
      expect(screen.getAllByText("💬 WhatsApp-da Aç").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Kupça Şübhəsi/).length).toBeGreaterThan(0);
      expect(screen.getAllByText("💾 Təsdiqlə və Yaddaşa Yaz").length).toBeGreaterThan(0);
    });

    // Verify WhatsApp launcher link has correct wa.me URL
    const waLink = screen.getAllByText("💬 WhatsApp-da Aç")[0].closest("a");
    expect(waLink).not.toBeNull();
    expect(waLink?.getAttribute("href")).toContain("https://wa.me/994509998877?text=");

    // Click confirm insight button
    const saveBtn = screen.getAllByText("💾 Təsdiqlə və Yaddaşa Yaz")[0];
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ai/copilot",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "save_insight",
            agent_id: "musteri_psixologiyasi",
            domain: "OBJECTION_KUPCA_TRUST",
            insight_text: "Alıcı Badamdar evində kupçanın olmadığını düşünür.",
            confidence_score: 0.95,
          }),
        })
      );
    });

    // Button updates to confirmed state
    await waitFor(() => {
      expect(screen.getAllByText("✅ Yaddaşa Yazıldı").length).toBeGreaterThan(0);
    });
  });
});
