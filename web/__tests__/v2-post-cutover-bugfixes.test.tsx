import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockRange = vi.fn();
const mockLimit = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signOut: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } }, error: null }),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    channel: () => ({
      on: function () {
        return this;
      },
      subscribe: () => ({}),
    }),
    removeChannel: vi.fn(),
  }),
}));

import { CopilotProvider } from "@/lib/copilot-context";
import { AppShell } from "@/components/AppShell";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import { JobsClient } from "@/components/JobsClient";
import { DashboardClient, type DuplicatePair } from "@/components/DashboardClient";
import { LeadsClient } from "@/components/LeadsClient";
import { ListingsClient, type ListingWithLatestRender } from "@/components/ListingsClient";
import { SettingsClient } from "@/components/SettingsClient";
import type {
  AgencySettings,
  FollowUpTask,
  Listing,
  PipelineJob,
  WorkerStatusRow,
} from "@/lib/types";

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "list-1",
    bina_id: "6588858",
    url: "https://bina.az/items/6588858",
    duplicate_of_listing_id: null,
    duplicate_confidence: null,
    duplicate_resolution: "NONE",
    photo_urls_hash: null,
    content_revision: 1,
    last_rendered_revision: null,
    title: "Nəsimi 3 otaqlı mənzil",
    price: 250000,
    currency: "AZN",
    price_azn_normalized: 250000,
    location: "Nəsimi",
    district_normalized: "Nəsimi",
    address: null,
    rooms: 3,
    area: 110,
    floor: 7,
    floors: 16,
    has_bill_of_sale: true,
    is_owner: true,
    contact_name: null,
    owner_phone_raw: null,
    owner_phone_normalized: null,
    photo_urls: [],
    description: null,
    archetype: "luxury",
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
    ...overrides,
  };
}

describe("v2 Post-Cutover Bugfixes (YOL C TDD)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/";
    mockRange.mockResolvedValue({ data: [], count: 86, error: null });
    mockLimit.mockResolvedValue({ data: [], error: null });

    mockFrom.mockImplementation((table: string) => {
      if (table === "pipeline_jobs") {
        return {
          select: () => ({
            order: () => ({
              range: mockRange,
              limit: mockLimit,
            }),
          }),
        };
      }
      if (table === "worker_status") {
        return {
          select: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === "cockpit_cards") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. AppShell shows /settings (Ayarlar) link for ADMIN and hides it for BROKER", () => {
    const { rerender } = render(
      <AppShell
        member={{
          user_id: "u-admin",
          agency_id: "ag-1",
          role: "ADMIN",
          display_name: "Elvin Admin",
          is_active: true,
        }}
      >
        <div>Admin View</div>
      </AppShell>
    );

    const settingsLinks = screen.getAllByRole("link", { name: /Ayarlar/i });
    expect(settingsLinks.length).toBeGreaterThan(0);
    expect(settingsLinks[0].getAttribute("href")).toBe("/settings");

    rerender(
      <AppShell
        member={{
          user_id: "u-broker",
          agency_id: "ag-1",
          role: "BROKER",
          display_name: "Broker User",
          is_active: true,
        }}
      >
        <div>Broker View</div>
      </AppShell>
    );

    expect(screen.queryByRole("link", { name: /Ayarlar/i })).toBeNull();
  });

  it("2. WorkerStatusBadge uses cloud-accurate 'Bulud Worker (Railway)' and 'Worker Monitoru' labels", () => {
    const worker: WorkerStatusRow = {
      worker_id: "rep-3fd56ad9-0-0",
      last_seen_at: new Date().toISOString(),
      current_job_id: null,
      current_job_type: null,
      current_job_status: null,
      metadata_json: { state: "IDLE" },
      is_online: true,
      seconds_since_heartbeat: 5,
    };

    render(<WorkerStatusBadge initialWorkers={[worker]} showMonitorLink={true} />);

    expect(screen.getByText("Bulud Worker (Railway)")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Worker Monitoru/i })).not.toBeNull();
    expect(screen.queryByText(/Lokal Windows Worker/i)).toBeNull();
    expect(screen.queryByText(/Kompüter Monitoru/i)).toBeNull();
  });

  it("3. JobsClient preserves totalCount (86) and serverStatusCounts without 24<->86 flicker and paginates fetchAll", async () => {
    const twoJobs: PipelineJob[] = [
      {
        id: "j-1",
        idempotency_key: "k-1",
        job_type: "LIVENESS_CHECK",
        listing_id: null,
        trigger_source: "WEB_UI",
        params_json: {},
        status: "SUCCEEDED",
        attempts: 1,
        max_attempts: 2,
        locked_by: "rep-1",
        lease_expires_at: null,
        expires_at: null,
        error_message: null,
        created_at: "2026-11-26T10:00:00Z",
        started_at: "2026-11-26T10:00:01Z",
        finished_at: "2026-11-26T10:00:08Z",
        listings: null,
      },
      {
        id: "j-2",
        idempotency_key: "k-2",
        job_type: "SCRAPE_NEW",
        listing_id: null,
        trigger_source: "WEB_UI",
        params_json: {},
        status: "FAILED",
        attempts: 1,
        max_attempts: 2,
        locked_by: "rep-1",
        lease_expires_at: null,
        expires_at: null,
        error_message: "timeout",
        created_at: "2026-11-26T09:00:00Z",
        started_at: "2026-11-26T09:00:01Z",
        finished_at: "2026-11-26T09:00:10Z",
        listings: null,
      },
    ];

    const worker: WorkerStatusRow = {
      worker_id: "rep-1",
      last_seen_at: new Date().toISOString(),
      current_job_id: null,
      current_job_type: null,
      current_job_status: null,
      metadata_json: { state: "IDLE" },
      is_online: true,
      seconds_since_heartbeat: 4,
    };

    render(
      <JobsClient
        initialJobs={twoJobs}
        initialWorkers={[worker]}
        totalCount={86}
        page={1}
        pageSize={24}
        initialStatusCounts={{ ALL: 86, SUCCEEDED: 81, FAILED: 5 }}
      />
    );

    expect(screen.getByRole("button", { name: /İş Tarixçəsi \(86\)/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Hamısı \(86\)/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Uğurlu \(81\)/i })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /Worker Monitoru/i }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Yenilə/i }));
    await waitFor(() => {
      expect(mockRange).toHaveBeenCalledWith(0, 23);
    });
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("4. DashboardClient deduplicates DUPLICATE_REVIEW tasks, links +Yeni Müştəri to /leads?new=1, and LeadsClient auto-opens modal", () => {
    const dupPair: DuplicatePair = {
      candidate: makeListing({
        id: "cand-1",
        bina_id: "7000001",
        duplicate_of_listing_id: "orig-1",
        duplicate_confidence: 0.92,
        duplicate_resolution: "PENDING_REVIEW",
      }),
      original: null,
    };

    const tasks: FollowUpTask[] = [
      {
        id: "task-dup",
        entity_type: "DUPLICATE_REVIEW",
        lead_id: null,
        listing_id: "cand-1",
        title: "Şübhəli təkrar elan təsdiqi (#7000001)",
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
      {
        id: "task-lead",
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
    ];

    render(
      <DashboardClient
        initialTasks={tasks}
        initialPriceAlerts={[]}
        initialDuplicates={[dupPair]}
        initialWorkers={[]}
        kpi={{ activeListings: 40, queuedJobs: 0, openLeads: 1 }}
      />
    );

    expect(screen.getByText("Müştəriyə zəng et")).not.toBeNull();
    expect(screen.queryByText("Şübhəli təkrar elan təsdiqi (#7000001)")).toBeNull();

    const newLeadLink = screen.getByRole("link", { name: /Yeni Müştəri/i });
    expect(newLeadLink.getAttribute("href")).toBe("/leads?new=1");

    render(
      <CopilotProvider>
        <LeadsClient
          initialLeads={[]}
          listingOptions={[]}
          initialOpenNewModal={true}
        />
      </CopilotProvider>
    );

    expect(screen.getByRole("button", { name: /Müştərini Yarat/i })).not.toBeNull();
  });

  it("5. ListingsClient clears stale niche filter when switching top tabs", () => {
    window.history.pushState({}, "", "/listings?niche=LUXURY");
    const listing: ListingWithLatestRender = {
      ...makeListing(),
      latestRender: null,
      publication: null,
    };

    render(
      <ListingsClient
        initialListings={[listing]}
        pagination={{
          items: [listing],
          totalCount: 1,
          page: 1,
          pageSize: 24,
          hasNextPage: false,
        }}
        initialFilters={{
          tab: "ALL",
          niche: "LUXURY",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Yayıma Hazır Qaralamalar/i }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    const pushedUrl = String(mockPush.mock.calls[0][0]);
    expect(pushedUrl).toContain("tab=DRAFTS");
    expect(pushedUrl).not.toContain("niche=LUXURY");
  });

  it("6. ListingsClient uses serverTabCounts & serverNicheCounts (e.g. 28 drafts instead of page-local count)", () => {
    const listing: ListingWithLatestRender = {
      ...makeListing(),
      latestRender: {
        id: "r-1",
        version_num: 1,
        status: "COMPLETED",
        video_cdn_url: "https://cdn.example.com/v1.mp4",
      },
      publication: null,
    };

    render(
      <ListingsClient
        initialListings={[listing]}
        pagination={{
          items: [listing],
          totalCount: 40,
          page: 1,
          pageSize: 24,
          hasNextPage: true,
        }}
        serverTabCounts={{ all: 40, drafts: 28, published: 3 }}
        serverNicheCounts={{ all: 40, luxury: 19, affordable: 8, general: 13, tiktok: 0 }}
      />
    );

    expect(screen.getByRole("button", { name: /Yayıma Hazır Qaralamalar\s*28/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Bütün Elanlar\s*40/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /@bakuestate\.premium\s*19/i })).not.toBeNull();
  });

  it("7. ListingsClient displays custom channelProfiles handles when set and falls back to defaults", () => {
    const listing: ListingWithLatestRender = {
      ...makeListing(),
      latestRender: null,
      publication: null,
    };

    render(
      <ListingsClient
        initialListings={[listing]}
        channelProfiles={{
          LUXURY: { handle: "@menim.luxury", url: "https://instagram.com/menim.luxury" },
          GENERAL: { handle: "@menim.emlak" },
        }}
      />
    );

    expect(screen.getByRole("button", { name: /@menim\.luxury/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /@menim\.emlak/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /@baku\.serfeli\.evler/i })).not.toBeNull();
  });

  it("8. SettingsClient loads and saves custom social channel handles & URLs in niche_rules_json.channels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const initialSettings: AgencySettings = {
      agency_id: "ag-1",
      public_phone: "+994501234567",
      telegram_chat_id: null,
      niche_rules_json: {
        luxury_min_azn: 250000,
        affordable_max_azn: 120000,
        viral_drop_pct: 10,
        channels: {
          LUXURY: { handle: "@my.vip", url: "https://instagram.com/my.vip" },
        },
      },
      social_api_mode: "TELEGRAM_FALLBACK",
      watermark_preset_json: { text: "BakuEstate.az", position: "bottom-right" },
      monthly_ai_budget_usd: 50,
      ai_rate_limit_rpm: 20,
      updated_at: new Date().toISOString(),
    };

    render(
      <SettingsClient
        initialSettings={initialSettings}
        initialMembers={[]}
        currentUserId="u-1"
      />
    );

    const luxHandle = screen.getByLabelText(/Lüks Hesab Adı/i) as HTMLInputElement;
    const luxUrl = screen.getByLabelText(/Lüks Profil Linki/i) as HTMLInputElement;
    expect(luxHandle.value).toBe("@my.vip");
    expect(luxUrl.value).toBe("https://instagram.com/my.vip");

    const affHandle = screen.getByLabelText(/Sərfəli Hesab Adı/i) as HTMLInputElement;
    fireEvent.change(affHandle, { target: { value: "@serfeli.baku" } });
    fireEvent.click(screen.getByRole("button", { name: /Ayarları Yadda Saxla/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/agency/settings",
        expect.objectContaining({ method: "PATCH" })
      );
    });

    const sentBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(sentBody.niche_rules_json.channels.AFFORDABLE.handle).toBe("@serfeli.baku");
    expect(sentBody.niche_rules_json.channels.LUXURY.handle).toBe("@my.vip");
  });
});
