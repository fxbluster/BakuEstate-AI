import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockPush = vi.fn();
const mockRefresh = vi.fn();
let mockPathname = "/listings";
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/env", () => ({
  isSupabaseConfigured: () => true,
}));

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockGetSession = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    rpc: mockRpc,
    from: mockFrom,
  }),
}));

const mockServerFrom = vi.fn();
const mockServerRpc = vi.fn();
const mockGetServerSessionMember = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockServerFrom,
    rpc: mockServerRpc,
  }),
  getServerSessionMember: (...args: unknown[]) =>
    mockGetServerSessionMember(...args),
}));

import { CopilotProvider } from "@/lib/copilot-context";
import {
  ListingsClient,
  escapePostgrestSearch,
  type ListingWithLatestRender,
} from "@/components/ListingsClient";
import { ListingDetailClient } from "@/components/ListingDetailClient";
import { LeadsClient } from "@/components/LeadsClient";
import { AnalyticsClient } from "@/components/AnalyticsClient";
import { SettingsClient } from "@/components/SettingsClient";
import ListingDetailPage from "@/app/listings/[bina_id]/page";
import SettingsPage from "@/app/settings/page";
import type { AgencyMember, AgencySettings, Listing } from "@/lib/types";

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    bina_id: "6588858",
    url: "https://bina.az/items/6588858",
    duplicate_of_listing_id: null,
    duplicate_confidence: null,
    duplicate_resolution: "NONE",
    photo_urls_hash: null,
    content_revision: 1,
    last_rendered_revision: null,
    title: "Nəsimi 3 otaqlı mənzil",
    price: 260000,
    currency: "AZN",
    price_azn_normalized: 260000,
    location: "Nəsimi",
    district_normalized: "Nəsimi",
    address: "Nizami küç. 45",
    rooms: 3,
    area: 110,
    floor: 6,
    floors: 16,
    has_bill_of_sale: true,
    is_owner: true,
    contact_name: "Murad",
    owner_phone_raw: "0501234567",
    owner_phone_normalized: "994501234567",
    photo_urls: [
      "https://bina.az/p1.jpg",
      "https://bina.az/p2.jpg",
      "https://bina.az/p3.jpg",
      "https://bina.az/p4.jpg",
      "https://bina.az/p5.jpg",
    ],
    description: "Təmirli mənzil",
    archetype: "luxury",
    source_availability: "ACTIVE",
    first_seen_at: "2026-11-20T10:00:00Z",
    last_seen_at: "2026-11-25T10:00:00Z",
    last_checked_at: null,
    pipeline_status: "DRAFT_READY",
    editorial_status: "PENDING_REVIEW",
    owner_outreach_status: "NOT_CONTACTED",
    commission_type: "PERCENT",
    commission_value: 2,
    owner_min_price_azn: 250000,
    owner_last_contacted_at: null,
    owner_next_checkin_at: null,
    owner_notes: null,
    last_auto_rendered_at: null,
    created_at: "2026-11-20T10:00:00Z",
    updated_at: "2026-11-25T10:00:00Z",
    ...overrides,
  };
}

describe("Phase 2: Server Pagination, Pre-Render Studio, OFF_MARKET, Settings & CSV Export UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = "/listings";
    mockSearchParams = new URLSearchParams();
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "jwt-token-123" } },
    });
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        publication: {
          id: "pub-atomic-1",
          listing_id: "11111111-1111-4111-8111-111111111111",
          render_version_id: null,
          channel: "INSTAGRAM_REELS",
          post_url: "https://www.instagram.com/reel/abc/",
          caption_used: null,
          status: "PUBLISHED",
          published_at: "2026-11-25T12:00:00Z",
          notes: null,
          views_count: 0,
          likes_count: 0,
          comments_count: 0,
          shares_count: 0,
          external_post_id: null,
          telemetry_status: "ACTIVE",
          last_scraped_at: null,
          next_poll_at: null,
          created_at: "2026-11-25T12:00:00Z",
        },
      },
      error: null,
    });
    mockFrom.mockImplementation(() => ({
      update: () => ({ eq: async () => ({ error: null }) }),
      insert: () => ({
        select: () => ({ single: async () => ({ data: { id: "ev-1" }, error: null }) }),
      }),
      upsert: async () => ({ error: null }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("escapes PostgREST wildcard and structural filter characters safely", () => {
    expect(escapePostgrestSearch("Nəsimi,100%_test(a)")).toBe(
      "Nəsimi100\\%\\_testa"
    );
  });

  it("ListingDetailPage resolves OFF_MARKET UUID without parseInt error and queries by id", async () => {
    const offMarketId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const eqCalls: Array<[string, string]> = [];

    mockGetServerSessionMember.mockResolvedValue({
      user_id: "u-broker",
      agency_id: "ag-1",
      role: "BROKER",
      display_name: "Broker Test",
      is_active: true,
    });

    mockServerFrom.mockImplementation((table: string) => {
      if (table === "listings") {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              eqCalls.push([col, val]);
              return {
                eq: (col2: string, val2: string) => {
                  eqCalls.push([col2, val2]);
                  return {
                    maybeSingle: async () => ({
                      data: {
                        ...makeListing({
                          id: offMarketId,
                          bina_id: null as unknown as string,
                          url: null as unknown as string,
                          title: "Eksklüziv Badamdar Villa",
                        }),
                        source_type: "OFF_MARKET",
                      },
                      error: null,
                    }),
                  };
                },
                maybeSingle: async () => ({
                  data: {
                    ...makeListing({
                      id: offMarketId,
                      bina_id: null as unknown as string,
                      url: null as unknown as string,
                      title: "Eksklüziv Badamdar Villa",
                    }),
                    source_type: "OFF_MARKET",
                  },
                  error: null,
                }),
              };
            },
          }),
        };
      }
      if (table === "listing_owner_contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      };
    });

    const element = await ListingDetailPage({
      params: Promise.resolve({ bina_id: offMarketId }),
    });

    expect(element).toBeTruthy();
    expect(eqCalls.some(([col, val]) => col === "id" && val === offMarketId)).toBe(
      true
    );
    expect(eqCalls.some(([col]) => col === "bina_id")).toBe(false);
  });

  it("ListingDetailClient Pre-Render Studio blocks <4 photos, enforces <=1000 script chars, generates AI script, reorders photos, and calls queue-render + confirm_publication_atomic", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/ai/copilot")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                draft_script: "Nəsimi rayonunda eksklüziv 3 otaqlı mənzil!",
                hook_type: "LOCATION_FIRST",
              },
            }),
            { status: 200 }
          )
        );
      }
      if (String(url).includes("/api/pipeline/queue-render")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              job_id: "job-studio-1",
              already_queued: false,
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    // 1. < 4 photos guard
    const fewPhotosListing = makeListing({
      photo_urls: ["https://bina.az/p1.jpg", "https://bina.az/p2.jpg"],
    });
    const { unmount } = render(
      <ListingDetailClient
        initialListing={fewPhotosListing}
        initialEvents={[]}
        initialRenders={[]}
        initialPublications={[]}
      />
    );

    expect(
      screen.getByText(/ən azı 4 foto tələb olunur/i)
    ).not.toBeNull();
    const disabledSubmit = screen.getByRole("button", {
      name: /Renderə Göndər/i,
    }) as HTMLButtonElement;
    expect(disabledSubmit.disabled).toBe(true);
    unmount();

    // 2. Full studio flow with 5 photos
    render(
      <ListingDetailClient
        initialListing={makeListing()}
        initialEvents={[]}
        initialRenders={[]}
        initialPublications={[]}
      />
    );

    // Generate AI script
    fireEvent.click(screen.getByRole("button", { name: /AI Ssenari Yarat/i }));
    await waitFor(() => {
      const textarea = screen.getByLabelText(
        /Video Ssenarisi/i
      ) as HTMLTextAreaElement;
      expect(textarea.value).toContain("Nəsimi rayonunda eksklüziv");
    });

    // Reject > 1000 chars in UI
    const scriptBox = screen.getByLabelText(
      /Video Ssenarisi/i
    ) as HTMLTextAreaElement;
    fireEvent.change(scriptBox, { target: { value: "A".repeat(1005) } });
    expect(
      (screen.getByRole("button", { name: /Renderə Göndər/i }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    // Valid script <= 1000 chars
    fireEvent.change(scriptBox, {
      target: { value: "Təcili satılır! Nəsimidə kupçalı mənzil." },
    });

    // Submit Pre-Render Studio
    fireEvent.click(screen.getByRole("button", { name: /Renderə Göndər/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pipeline/queue-render",
        expect.objectContaining({
          method: "POST",
        })
      );
    });

    const queueCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/pipeline/queue-render")
    );
    const body = JSON.parse(String(queueCall?.[1]?.body || "{}"));
    expect(body.selected_photo_urls).toHaveLength(5);
    expect(body.custom_script_text).toBe(
      "Təcili satılır! Nəsimidə kupçalı mənzil."
    );

    // Atomic handleAddPublication
    const pubUrlInput = screen.getByPlaceholderText(/instagram\.com\/reel/i);
    fireEvent.change(pubUrlInput, {
      target: { value: "https://www.instagram.com/reel/test123/" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Paylaşımı Qeyd Et/i }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "confirm_publication_atomic",
        expect.objectContaining({
          p_listing_id: "11111111-1111-4111-8111-111111111111",
          p_post_url: "https://www.instagram.com/reel/test123/",
        })
      );
    });
  });

  it("ListingsClient renders server pagination controls, resets page=1 on filter change, uses confirm_publication_atomic, and opens OFF_MARKET modal", async () => {
    mockSearchParams = new URLSearchParams("page=2&niche=ALL");
    const item: ListingWithLatestRender = {
      ...makeListing(),
      latestRender: {
        id: "rv-1",
        version_num: 1,
        status: "COMPLETED",
        video_cdn_url: "https://media.bakuestate.az/v/1.mp4",
      },
      publication: null,
    };

    render(
      <ListingsClient
        initialListings={[item]}
        pagination={{
          items: [item],
          totalCount: 60,
          page: 2,
          pageSize: 24,
          hasNextPage: true,
        }}
        memberRole="BROKER"
      />
    );

    expect(screen.getByText(/Səhifə 2 \/ 3/i)).not.toBeNull();
    expect(screen.getAllByText(/60 elan/i).length).toBeGreaterThan(0);

    // Clicking next page goes to page=3
    fireEvent.click(screen.getByRole("button", { name: /Növbəti/i }));
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining("page=3")
    );

    // Changing niche filter resets page=1
    fireEvent.click(screen.getByRole("button", { name: /Ətraflı filtrlər/i }));
    fireEvent.change(screen.getByLabelText(/Niş \/ Kanal/i), {
      target: { value: "LUXURY" },
    });
    expect(mockPush).toHaveBeenLastCalledWith(
      expect.stringMatching(/niche=LUXURY.*page=1|page=1.*niche=LUXURY/)
    );

    // Open OFF_MARKET modal
    fireEvent.click(
      screen.getByRole("button", { name: /\+ Eksklüziv Elan Əlavə Et/i })
    );
    expect(
      screen.getByText(/Yeni Eksklüziv \(OFF-MARKET\) Elan/i)
    ).not.toBeNull();

    // Publish modal uses confirm_publication_atomic RPC
    fireEvent.click(screen.getByRole("button", { name: /🚀 Paylaşıldı/i }));
    const linkInput = screen.getByPlaceholderText(/instagram\.com\/reel/i);
    fireEvent.change(linkInput, {
      target: { value: "https://www.instagram.com/reel/xyz999/" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Təsdiqlə & Telemetriya Başlat/i })
    );

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "confirm_publication_atomic",
        expect.objectContaining({
          p_listing_id: item.id,
          p_post_url: "https://www.instagram.com/reel/xyz999/",
        })
      );
    });
  });

  it("LeadsClient renders get_agency_crm_kpis split cards, CSV Export button (hidden for SMM), broker assignment, and server pagination", () => {
    mockPathname = "/leads";
    mockSearchParams = new URLSearchParams("page=2");

    const members: AgencyMember[] = [
      {
        user_id: "broker-1",
        agency_id: "ag-1",
        role: "BROKER",
        display_name: "Rəşad Broker",
        whatsapp_phone: null,
        telegram_chat_id: null,
        commission_split_pct: 55,
        is_active: true,
        created_at: "2026-11-20T00:00:00Z",
      },
    ];

    const { rerender } = render(
      <CopilotProvider>
        <LeadsClient
          initialLeads={[]}
          listingOptions={[]}
          memberRole="ADMIN"
          agencyMembers={members}
          kpis={{
            ok: true,
            total_leads: 140,
            active_leads: 85,
            won_leads: 12,
            expected_commission_total_azn: 36000,
            expected_broker_commission_azn: 18000,
            expected_agency_commission_azn: 18000,
            actual_commission_total_azn: 18500,
            actual_broker_commission_azn: 9250,
            actual_agency_commission_azn: 9250,
          }}
          pagination={{
            items: [],
            totalCount: 140,
            page: 2,
            pageSize: 24,
            hasNextPage: true,
          }}
        />
      </CopilotProvider>
    );

    expect(screen.getAllByText("140").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /CSV İxrac/i })).not.toBeNull();
    expect(screen.getByText(/Səhifə 2 \/ 6/i)).not.toBeNull();

    // SMM must NOT see CSV Export button
    rerender(
      <CopilotProvider>
        <LeadsClient
          initialLeads={[]}
          listingOptions={[]}
          memberRole="SMM"
          agencyMembers={members}
        />
      </CopilotProvider>
    );
    expect(screen.queryByRole("button", { name: /CSV İxrac/i })).toBeNull();
  });

  it("AnalyticsClient renders SQL get_analytics_summary aggregates and leaderboard pagination", () => {
    mockPathname = "/analytics";
    render(
      <AnalyticsClient
        publications={[]}
        comments={[]}
        snapshots={[]}
        summary={{
          ok: true,
          window_days: 30,
          totals: {
            publications_count: 42,
            views_count: 125400,
            likes_count: 4200,
            comments_count: 310,
            shares_count: 190,
            interactions_count: 4700,
            engagement_rate_pct: 3.75,
            scraped_comments_count: 310,
            intent_comments_count: 45,
            snapshots_count: 120,
            leads_count: 19,
            showings_count: 8,
            won_count: 4,
            actual_commission_azn: 14500,
          },
          funnel: {
            views: 125400,
            interactions: 4700,
            intent_comments: 45,
            leads_count: 19,
            showings_count: 8,
            won_count: 4,
            actual_commission_azn: 14500,
            view_to_engagement_pct: 3.7,
            engagement_to_lead_pct: 0.4,
            lead_to_showing_pct: 42.1,
            showing_to_won_pct: 50.0,
          },
        }}
        pagination={{
          items: [],
          totalCount: 42,
          page: 1,
          pageSize: 24,
          hasNextPage: true,
        }}
        initialDays={30}
      />
    );

    expect(screen.getAllByText(/125\.4K|125,4K|125 400/i).length).toBeGreaterThan(
      0
    );
    expect(screen.getByText(/Səhifə 1 \/ 2/i)).not.toBeNull();
  });

  it("SettingsPage enforces ADMIN-only RBAC and SettingsClient patches /api/agency/settings & /api/agency/members", async () => {
    // 1. BROKER blocked by SSR page
    mockGetServerSessionMember.mockResolvedValueOnce({
      user_id: "u-broker",
      agency_id: "ag-1",
      role: "BROKER",
      display_name: "Broker User",
      is_active: true,
    });
    const deniedEl = await SettingsPage();
    const { unmount } = render(deniedEl as React.ReactElement);
    expect(screen.getByText(/Yalnız ADMIN/i)).not.toBeNull();
    unmount();

    // 2. SettingsClient saves agency settings & member split
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const settings: AgencySettings = {
      agency_id: "ag-1",
      public_phone: "+994 50 555 44 33",
      telegram_chat_id: "-100123456",
      niche_rules_json: {
        luxury_min_azn: 250000,
        affordable_max_azn: 120000,
        viral_drop_pct: 10,
      },
      social_api_mode: "TELEGRAM_FALLBACK",
      watermark_preset_json: { text: "BakuEstate" },
      monthly_ai_budget_usd: 50,
      ai_rate_limit_rpm: 20,
      updated_at: "2026-11-25T00:00:00Z",
    };

    const members: AgencyMember[] = [
      {
        user_id: "broker-1",
        agency_id: "ag-1",
        role: "BROKER",
        display_name: "Leyla Broker",
        whatsapp_phone: "+994501112233",
        telegram_chat_id: null,
        commission_split_pct: 50,
        is_active: true,
        created_at: "2026-11-20T00:00:00Z",
      },
    ];

    render(
      <SettingsClient
        initialSettings={settings}
        initialMembers={members}
        currentUserId="admin-1"
      />
    );

    fireEvent.change(screen.getByLabelText(/İctimai Telefon/i), {
      target: { value: "+994 55 999 88 77" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ayarları Yadda Saxla/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/agency/settings",
        expect.objectContaining({ method: "PATCH" })
      );
    });

    const splitInput = screen.getByLabelText(
      /Komissiya Payı — Leyla Broker/i
    ) as HTMLInputElement;
    fireEvent.change(splitInput, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: /Üzvü Saxla/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/agency/members",
        expect.objectContaining({ method: "PATCH" })
      );
    });
  });
});
