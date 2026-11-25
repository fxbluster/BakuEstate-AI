import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// Mutable navigation state for AppShell tests
let mockPathname = "/";
const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

vi.mock("@/lib/supabase/env", () => ({
  isSupabaseConfigured: () => true,
}));

// Shared Supabase mock controls
const mockRpc = vi.fn();
const mockSignOut = vi.fn();
const mockFrom = vi.fn();
const mockChannelOn = vi.fn();
const mockChannelSubscribe = vi.fn();
const mockRemoveChannel = vi.fn();
const mockGetSession = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signOut: mockSignOut,
      getSession: mockGetSession,
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    rpc: mockRpc,
    from: mockFrom,
    channel: () => ({
      on: (...args: unknown[]) => {
        mockChannelOn(...args);
        return {
          on: (...args2: unknown[]) => {
            mockChannelOn(...args2);
            return { subscribe: mockChannelSubscribe };
          },
          subscribe: mockChannelSubscribe,
        };
      },
      subscribe: mockChannelSubscribe,
    }),
    removeChannel: mockRemoveChannel,
  }),
}));

const mockInvokeCopilot = vi.fn();
const mockGetAgentConversation = vi.fn();
const mockResetAgentConversation = vi.fn();

vi.mock("@/lib/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-client")>();
  return {
    ...actual,
    invokeCopilot: (...args: unknown[]) => mockInvokeCopilot(...args),
    getAgentConversation: (...args: unknown[]) => mockGetAgentConversation(...args),
    resetAgentConversation: (...args: unknown[]) => mockResetAgentConversation(...args),
  };
});

import { CopilotProvider } from "@/lib/copilot-context";
import { AppShell } from "@/components/AppShell";
import { CockpitCardHUD } from "@/components/CockpitCardHUD";
import { ActionCardView } from "@/components/hub/ActionCardView";
import { OmniChatRoom } from "@/components/hub/OmniChatRoom";
import { SpecialistRoom } from "@/components/hub/SpecialistRoom";
import { PreflightModal } from "@/components/PreflightModal";
import { JobsClient } from "@/components/JobsClient";
import { DashboardClient, type DuplicatePair } from "@/components/DashboardClient";
import { LeadsClient } from "@/components/LeadsClient";
import { CopilotDrawer } from "@/components/CopilotDrawer";
import type { PipelineJob, WorkerStatusRow } from "@/lib/types";

describe("v2 Phase 1 P0 UI Components", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPathname = "/";
    mockSignOut.mockResolvedValue({ error: null });
    mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok-1" } } });
    mockGetAgentConversation.mockResolvedValue({ conversation_id: null, messages: [] });
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
    mockChannelSubscribe.mockImplementation((cb?: (status: string) => void) => {
      if (typeof cb === "function") cb("SUBSCRIBED");
      return {};
    });

    // Default safe Supabase table mock
    mockFrom.mockImplementation((table: string) => {
      if (table === "cockpit_cards") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }
      if (table === "worker_status") {
        return {
          select: () => ({
            order: () => ({
              limit: async () => ({
                data: [
                  {
                    worker_id: "railway-worker-1",
                    last_seen_at: new Date().toISOString(),
                    current_job_id: null,
                    current_job_type: null,
                    current_job_status: null,
                    metadata_json: { state: "IDLE" },
                    is_online: true,
                    seconds_since_heartbeat: 3,
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "pipeline_jobs") {
        return {
          select: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: null }),
          }),
        }),
        update: () => ({
          eq: async () => ({ error: null }),
        }),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("SpecialistRoom marks failed turn on 503 without writing to localStorage and retries cleanly via Yenidən Göndər", async () => {
    mockInvokeCopilot
      .mockResolvedValueOnce({
        ok: false,
        error: "Gemini əlçatan deyil (503)",
        code: "UPSTREAM_UNAVAILABLE",
        fallback_available: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        action: "agent_chat",
        model_served: "gemini-3.8-flash-high",
        run_id: "run-2",
        data: {
          conversation_id: "conv-1",
          agent_id: "analitika",
          message: {
            id: "agent-msg-1",
            sender_type: "AGENT",
            sender_name: "Analitika",
            content: "Bazar analizi hazırdır.",
            created_at: new Date().toISOString(),
          },
        },
      });

    render(
      <CopilotProvider>
        <SpecialistRoom persona="analitika" />
      </CopilotProvider>
    );

    const textarea = screen.getByPlaceholderText(/mesajınızı yazın/i);
    fireEvent.change(textarea, { target: { value: "Nəsimi qiymətləri?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(screen.getByText(/FAILED/i)).not.toBeNull();
    });
    expect(localStorage.getItem("bakuestate_hub_analitika_messages")).toBeNull();

    const retryBtn = screen.getByRole("button", { name: /Yenidən Göndər/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText("Bazar analizi hazırdır.")).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: /Yenidən Göndər/i })).toBeNull();
    const saved = JSON.parse(localStorage.getItem("bakuestate_hub_analitika_messages") || "[]");
    expect(saved.length).toBe(2);
  });

  it("OmniChatRoom surfaces FAILED + Yenidən Göndər on 503 without persisting failed turn to localStorage", async () => {
    mockInvokeCopilot.mockResolvedValueOnce({
      ok: false,
      error: "AI xidməti əlçatan deyil",
      code: "UPSTREAM_UNAVAILABLE",
      fallback_available: false,
    });

    render(
      <CopilotProvider>
        <OmniChatRoom onSwitchPersona={vi.fn()} />
      </CopilotProvider>
    );

    const textarea = screen.getByPlaceholderText(/Müdirə tapşırıq verin/i);
    fireEvent.change(textarea, { target: { value: "Bugünkü icmal" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(screen.getByText(/FAILED/i)).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: /Yenidən Göndər/i })).not.toBeNull();
    expect(localStorage.getItem("bakuestate_hub_mudir_messages")).toBeNull();
  });

  it("ActionCardView routes SAVE_INSIGHT through /api/ai/copilot instead of direct browser insert", async () => {
    mockInvokeCopilot.mockResolvedValueOnce({
      ok: true,
      action: "save_insight",
      model_served: "supabase-admin",
      run_id: "run-save",
      data: { id: "ins-1" },
    });

    const onComplete = vi.fn();
    render(
      <ActionCardView
        card={{
          type: "SAVE_INSIGHT",
          agent_id: "musteri_psixologiyasi",
          domain: "COMMISSION",
          insight_text: "Kupça arqumenti etirazı azaldır",
          confidence_score: 0.9,
        }}
        onActionComplete={onComplete}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Yaddaşa Saxla/i }));

    await waitFor(() => {
      expect(mockInvokeCopilot).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "save_insight",
          agent_id: "musteri_psixologiyasi",
          domain: "COMMISSION",
          insight_text: "Kupça arqumenti etirazı azaldır",
          confidence_score: 0.9,
        })
      );
    });
    expect(mockFrom).not.toHaveBeenCalledWith("agent_learned_insights");
    expect(onComplete).toHaveBeenCalledWith("SAVE_INSIGHT");
  });

  it("AppShell displays member info, mounts CockpitCardHUD only on '/', deduplicates worker polling, and purges bakuestate_* keys on Sign Out", async () => {
    localStorage.setItem("bakuestate_hub_mudir_messages", "[]");
    localStorage.setItem("bakuestate_cached_leads_v1", "[]");
    localStorage.setItem("unrelated_key", "keep_me");

    mockPathname = "/listings";
    const { rerender } = render(
      <AppShell
        member={{
          user_id: "u-1",
          agency_id: "ag-1",
          role: "ADMIN",
          display_name: "Kamran Əliyev",
          is_active: true,
        }}
      >
        <div>Listings Page</div>
      </AppShell>
    );

    expect(screen.getByText(/Kamran Əliyev/)).not.toBeNull();
    expect(screen.getAllByText(/ADMIN/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/AI Cockpit HUD/i)).toBeNull();

    // Even with 2 compact WorkerStatusBadges in AppShell, only 1 worker_status fetch happens via shared context
    await waitFor(() => {
      const workerStatusCalls = mockFrom.mock.calls.filter((c) => c[0] === "worker_status");
      expect(workerStatusCalls.length).toBe(1);
    });

    // Switching to '/' mounts CockpitCardHUD
    mockPathname = "/";
    rerender(
      <AppShell
        member={{
          user_id: "u-1",
          agency_id: "ag-1",
          role: "ADMIN",
          display_name: "Kamran Əliyev",
          is_active: true,
        }}
      >
        <div>Dashboard Page</div>
      </AppShell>
    );
    expect(screen.getByText(/AI Cockpit HUD/i)).not.toBeNull();

    // Sign Out purges bakuestate_* localStorage keys and signs out
    const signOutBtn = screen.getByRole("button", { name: /Çıxış|Sign Out/i });
    fireEvent.click(signOutBtn);

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
    expect(localStorage.getItem("bakuestate_hub_mudir_messages")).toBeNull();
    expect(localStorage.getItem("bakuestate_cached_leads_v1")).toBeNull();
    expect(localStorage.getItem("unrelated_key")).toBe("keep_me");
    expect(mockPush).toHaveBeenCalledWith("/login");
  });

  it("CockpitCardHUD does NOT auto-invoke strategist_cockpit from localStorage on mount and handles integer/lowercase priority safely", async () => {
    localStorage.setItem("bakuestate_cached_leads_v1", JSON.stringify([{ id: "l-1", client_name: "Test" }]));
    mockFrom.mockImplementation((table: string) => {
      if (table === "cockpit_cards") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: [
                    {
                      id: "card-1",
                      lead_id: null,
                      listing_id: null,
                      channel: "CRM",
                      priority: 95 as unknown as string,
                      headline: "Təhlükəsiz Kart",
                      draft_text: null,
                      reason: null,
                      sentinel_warning: null,
                      status: "pending",
                      created_at: new Date().toISOString(),
                      target_uri: null,
                      strategic_rationale: "Strateji əsaslandırma",
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      };
    });

    render(
      <CopilotProvider>
        <CockpitCardHUD />
      </CopilotProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Təhlükəsiz Kart")).not.toBeNull();
    });
    expect(screen.getByText(/Strateji əsaslandırma/)).not.toBeNull();
    expect(mockInvokeCopilot).not.toHaveBeenCalled();
  });

  it("PreflightModal aborts in-flight fetch on close and uses atomic /api/pipeline/queue-render on price drop rerender", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      if (String(url).includes("/preflight")) {
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  ok: false,
                  reason: "PRICE_CHANGED",
                  old_price: 150000,
                  new_price: 140000,
                  delta_pct: -6.7,
                }),
                { status: 200 }
              )
            );
          }, 50);
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, job_id: "job-rerender-1" }), { status: 200 })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const listing = {
      id: "list-1",
      bina_id: "6588858",
      url: "https://bina.az/items/6588858",
      duplicate_of_listing_id: null,
      duplicate_confidence: null,
      duplicate_resolution: "NONE" as const,
      photo_urls_hash: null,
      content_revision: 1,
      last_rendered_revision: 1,
      title: "Nəsimi 3 otaq",
      price: 150000,
      currency: "AZN" as const,
      price_azn_normalized: 150000,
      location: "Nəsimi",
      district_normalized: "Nəsimi",
      address: null,
      rooms: 3,
      area: 90,
      floor: 5,
      floors: 16,
      has_bill_of_sale: false,
      is_owner: true,
      contact_name: null,
      owner_phone_raw: null,
      owner_phone_normalized: null,
      photo_urls: [],
      description: null,
      archetype: "luxury" as const,
      source_availability: "ACTIVE" as const,
      first_seen_at: "",
      last_seen_at: "",
      last_checked_at: null,
      pipeline_status: "DRAFT_READY" as const,
      editorial_status: "PENDING_REVIEW" as const,
      owner_outreach_status: "NOT_CONTACTED" as const,
      commission_type: null,
      commission_value: null,
      owner_min_price_azn: null,
      owner_last_contacted_at: null,
      owner_next_checkin_at: null,
      owner_notes: null,
      last_auto_rendered_at: null,
      created_at: "",
      updated_at: "",
    };

    const { rerender } = render(
      <PreflightModal isOpen={true} onClose={vi.fn()} listing={listing} />
    );

    expect(signals.length).toBe(1);
    expect(signals[0].aborted).toBe(false);

    // Close modal before preflight finishes -> must abort
    rerender(<PreflightModal isOpen={false} onClose={vi.fn()} listing={listing} />);
    expect(signals[0].aborted).toBe(true);

    // Reopen and wait for PRICE_CHANGED, then click rerender -> must call /api/pipeline/queue-render
    rerender(<PreflightModal isOpen={true} onClose={vi.fn()} listing={listing} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Yeni Qiymətlə Təkrar Render Et/i })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /Yeni Qiymətlə Təkrar Render Et/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pipeline/queue-render",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(mockFrom).not.toHaveBeenCalledWith("pipeline_jobs");
  });

  it("JobsClient gates RETRY to FAILED/EXPIRED, uses retry_or_cancel_pipeline_job RPC for RETRY & CANCEL, and pauses polling when SUBSCRIBED", async () => {
    const runningJob: PipelineJob = {
      id: "job-running",
      idempotency_key: "k-run",
      job_type: "RENDER_INITIAL",
      listing_id: "list-1",
      trigger_source: "WEB_UI",
      params_json: { bina_id: "6588858" },
      status: "RUNNING",
      attempts: 1,
      max_attempts: 2,
      locked_by: "worker-1",
      lease_expires_at: null,
      expires_at: null,
      error_message: null,
      created_at: "2026-11-24T15:39:00Z",
      started_at: "2026-11-24T15:39:05Z",
      finished_at: null,
      listings: { id: "list-1", bina_id: "6588858", title: "Test Running" },
    };
    const failedJob: PipelineJob = {
      ...runningJob,
      id: "job-failed",
      idempotency_key: "k-fail",
      status: "FAILED",
      finished_at: "2026-11-24T15:40:00Z",
      listings: { id: "list-1", bina_id: "6588859", title: "Test Failed" },
    };

    const worker: WorkerStatusRow = {
      worker_id: "worker-1",
      last_seen_at: "2026-11-24T15:40:00Z",
      current_job_id: "job-running",
      current_job_type: "RENDER_INITIAL",
      current_job_status: "RUNNING",
      metadata_json: { state: "PROCESSING" },
      is_online: true,
      seconds_since_heartbeat: 5,
    };

    mockRpc.mockResolvedValue({ data: { ok: true, status: "QUEUED" }, error: null });

    render(<JobsClient initialJobs={[runningJob, failedJob]} initialWorkers={[worker]} />);

    // Only 1 RETRY button (for FAILED job, NOT for RUNNING job)
    const retryButtons = screen.getAllByRole("button", { name: /Yenidən Cəhd/i });
    expect(retryButtons.length).toBe(1);

    // CANCEL button exists for RUNNING job
    const cancelButtons = screen.getAllByRole("button", { name: /Ləğv Et/i });
    expect(cancelButtons.length).toBe(1);

    fireEvent.click(retryButtons[0]);
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("retry_or_cancel_pipeline_job", {
        p_job_id: "job-failed",
        p_action: "RETRY",
      });
    });

    fireEvent.click(cancelButtons[0]);
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("retry_or_cancel_pipeline_job", {
        p_job_id: "job-running",
        p_action: "CANCEL",
      });
    });
  });

  it("DashboardClient calls resolve_duplicate_listing_atomic RPC and LeadsClient calls create_buyer_lead_atomic RPC", async () => {
    const dupPair: DuplicatePair = {
      candidate: {
        id: "cand-1",
        bina_id: "7000001",
        url: "https://bina.az/items/7000001",
        duplicate_of_listing_id: "orig-1",
        duplicate_confidence: 0.92,
        duplicate_resolution: "PENDING_REVIEW",
        photo_urls_hash: null,
        content_revision: 1,
        last_rendered_revision: null,
        title: "Namizəd Elan",
        price: 120000,
        currency: "AZN",
        price_azn_normalized: 120000,
        location: "Yasamal",
        district_normalized: "Yasamal",
        address: null,
        rooms: 2,
        area: 65,
        floor: 4,
        floors: 12,
        has_bill_of_sale: false,
        is_owner: true,
        contact_name: null,
        owner_phone_raw: null,
        owner_phone_normalized: null,
        photo_urls: [],
        description: null,
        archetype: "budget",
        source_availability: "ACTIVE",
        first_seen_at: "",
        last_seen_at: "",
        last_checked_at: null,
        pipeline_status: "NEW",
        editorial_status: "PENDING_REVIEW",
        owner_outreach_status: "NOT_CONTACTED",
        commission_type: null,
        commission_value: null,
        owner_min_price_azn: null,
        owner_last_contacted_at: null,
        owner_next_checkin_at: null,
        owner_notes: null,
        last_auto_rendered_at: null,
        created_at: "",
        updated_at: "",
      },
      original: null,
    };

    render(
      <DashboardClient
        initialTasks={[
          {
            id: "task-1",
            entity_type: "BUYER_LEAD",
            lead_id: "lead-1",
            listing_id: null,
            title: "Müştəriyə zəng et",
            due_at: new Date().toISOString(),
            priority: "HIGH",
            status: "OPEN",
            reminder_sent_at: null,
            snooze_count: 0,
            completed_at: null,
            outcome_note: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ]}
        initialPriceAlerts={[]}
        initialDuplicates={[dupPair]}
        initialWorkers={[]}
        kpi={{ activeListings: 1, queuedJobs: 0, openLeads: 0 }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /\+3 saat/i }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "update_follow_up_task_atomic",
        expect.objectContaining({ p_task_id: "task-1", p_status: "SNOOZED" })
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /Təkrardır — Arxivlə/i }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "resolve_duplicate_listing_atomic",
        expect.objectContaining({ p_listing_id: "cand-1", p_decision: "CONFIRM" })
      );
    });

    mockRpc.mockResolvedValueOnce({
      data: {
        ok: true,
        lead: {
          id: "lead-new-1",
          client_name: "Elvin Test",
          phone_normalized: "994501112233",
          social_handle: null,
          source_channel: "IG_DM",
          stage: "NEW_INQUIRY",
          budget_max_azn: null,
          preferred_districts: [],
          expected_commission_azn: null,
          actual_commission_azn: null,
          lost_reason: null,
          notes: null,
          next_followup_at: null,
          attributed_publication_id: null,
          attributed_channel_niche: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
      error: null,
    });

    render(
      <CopilotProvider>
        <LeadsClient initialLeads={[]} listingOptions={[]} />
      </CopilotProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: /10-San Müştəri Əlavə Et/i }));
    fireEvent.change(screen.getByPlaceholderText("Elvin Məmmədov"), {
      target: { value: "Elvin Test" },
    });
    fireEvent.change(screen.getByPlaceholderText("+994501234567 və ya @elvin_baku"), {
      target: { value: "+994501112233" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Müştərini Yarat/i }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "create_buyer_lead_atomic",
        expect.objectContaining({
          p_client_name: "Elvin Test",
          p_task_priority: "NORMAL",
        })
      );
    });
  });

  it("CopilotDrawer queries buyer_leads with phone_normalized only (never phone_raw)", async () => {
    const selectMock = vi.fn().mockReturnValue({
      eq: () => ({
        maybeSingle: async () => ({ data: { phone_normalized: "994507778899" }, error: null }),
      }),
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === "buyer_leads") {
        return { select: selectMock };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    });

    // Helper component that opens CopilotDrawer with selectedLeadId
    const { useCopilot } = await import("@/lib/copilot-context");
    function DrawerOpener() {
      const { openCopilot } = useCopilot();
      React.useEffect(() => {
        openCopilot("shield", { leadId: "lead-uuid-1" });
      }, [openCopilot]);
      return <CopilotDrawer />;
    }

    render(
      <CopilotProvider>
        <DrawerOpener />
      </CopilotProvider>
    );

    await waitFor(() => {
      expect(selectMock).toHaveBeenCalled();
    });
    const selectedColumns = String(selectMock.mock.calls[0][0]);
    expect(selectedColumns).toContain("phone_normalized");
    expect(selectedColumns).not.toContain("phone_raw");
  });
});
