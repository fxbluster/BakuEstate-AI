// @vitest-environment happy-dom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  usePathname: () => "/leads",
  useSearchParams: () => new URLSearchParams(),
}));

const mockGetSession = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
    },
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

import { CopilotProvider, type StageCardInstance } from "@/lib/copilot-context";
import { VideoPipelineCard } from "@/components/hub/stage/VideoPipelineCard";
import { AnalyticsTelemetryCard } from "@/components/hub/stage/AnalyticsTelemetryCard";
import { CrmNegotiationCard } from "@/components/hub/stage/CrmNegotiationCard";
import {
  resolveListingNiche,
  type ListingWithLatestRender,
} from "@/components/ListingsClient";
import { resolveTargetAccount } from "@/components/PreflightModal";
import {
  LeadsClient,
  type LeadListingMatchItem,
} from "@/components/LeadsClient";
import type { BuyerLeadWithListings, Listing } from "@/lib/types";

function makeListing(overrides: Partial<Listing> = {}): ListingWithLatestRender {
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
    title: "Yasamal 3 otaqlı mənzil",
    price: 135000,
    currency: "AZN",
    price_azn_normalized: 135000,
    location: "Yasamal",
    district_normalized: "Yasamal",
    address: "Şərifzadə küç.",
    rooms: 3,
    area: 85,
    floor: 5,
    floors: 16,
    has_bill_of_sale: true,
    is_owner: true,
    contact_name: null,
    owner_phone_raw: null,
    owner_phone_normalized: null,
    photo_urls: [],
    description: null,
    archetype: "budget",
    source_availability: "ACTIVE",
    first_seen_at: "2026-11-20T10:00:00Z",
    last_seen_at: "2026-11-25T10:00:00Z",
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
    created_at: "2026-11-20T10:00:00Z",
    updated_at: "2026-11-25T10:00:00Z",
    ...overrides,
  };
}

describe("Phase 3 Stage Cleanup, Canonical Niche UI & Lead Matches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "jwt-stage-test" } },
    });
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
        in: () => ({
          neq: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
        not: () => ({
          overlaps: () => ({
            limit: async () => ({ count: 0, error: null }),
          }),
          limit: async () => ({ count: 0, error: null }),
        }),
      }),
      upsert: async () => ({ error: null }),
      update: () => ({
        eq: async () => ({ error: null }),
      }),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("scrubs all legacy demo fixtures, URLs, and heuristics from hub stage card sources", () => {
    const stageDir = path.resolve(process.cwd(), "components", "hub", "stage");
    const videoSrc = fs.readFileSync(
      path.join(stageDir, "VideoPipelineCard.tsx"),
      "utf8"
    );
    const analyticsSrc = fs.readFileSync(
      path.join(stageDir, "AnalyticsTelemetryCard.tsx"),
      "utf8"
    );
    const crmSrc = fs.readFileSync(
      path.join(stageDir, "CrmNegotiationCard.tsx"),
      "utf8"
    );

    // VideoPipelineCard zero demo assertions
    expect(videoSrc).not.toContain("ForBiggerBlazes.mp4");
    expect(videoSrc).not.toContain("385000");
    expect(videoSrc).not.toContain("385,000");
    expect(videoSrc).not.toContain("Badamdar");
    expect(videoSrc).not.toContain("unsplash.com");
    expect(videoSrc).not.toContain("ElevenLabs Arif");
    expect(videoSrc).not.toContain('href="/worker"');
    expect(videoSrc).toContain('href="/jobs?tab=worker"');
    expect(videoSrc).toContain("resolveCanonicalListingNiche");

    // AnalyticsTelemetryCard zero demo & bounded query assertions
    expect(analyticsSrc).not.toContain("pricePerM2 > 3000");
    expect(analyticsSrc).not.toContain("226000");
    expect(analyticsSrc).not.toMatch(/\?\?\s*95\b|\|\|\s*95\b/);
    expect(analyticsSrc).toContain("resolveCanonicalListingNiche");
    expect(analyticsSrc).toContain('head: true');

    // CrmNegotiationCard zero demo & auth assertions
    expect(crmSrc).not.toContain("Rəşad Əliyev");
    expect(crmSrc).not.toContain("994502123456");
    expect(crmSrc).not.toContain("Badamdar");
    expect(crmSrc).toContain("Authorization");
    expect(crmSrc).toContain("data?.ok");
  });

  it("VideoPipelineCard renders clean empty states and links queue-render success directly to /jobs?tab=worker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          job_id: "job-v-1",
          status: "QUEUED",
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const card: StageCardInstance = {
      id: "VIDEO_INSPECTION_empty",
      cardType: "VIDEO_INSPECTION",
      targetEntityId: "9001234",
      payload: {
        cardType: "VIDEO_INSPECTION",
        listingId: "9001234",
        isRendered: false,
      },
    };

    render(
      <CopilotProvider>
        <VideoPipelineCard card={card} />
      </CopilotProvider>
    );

    expect(screen.getByText("Qiymət gözlənilir")).not.toBeNull();
    expect(screen.getByText("Foto mövcud deyil")).not.toBeNull();
    expect(screen.queryByText(/Badamdar/i)).toBeNull();
    expect(screen.queryByText(/385/)).toBeNull();
    expect(screen.queryByText(/ElevenLabs Arif/i)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Montaj Boru Xəttinə Göndər/i })
    );

    await waitFor(() => {
      const watchLink = screen.getByRole("link", { name: /İzlə/i });
      expect(watchLink.getAttribute("href")).toBe("/jobs?tab=worker");
    });
  });

  it("AnalyticsTelemetryCard uses resolveCanonicalListingNiche (<=120k rule) and bounded buyer_leads count query", async () => {
    const headCounts: Array<{ count?: string; head?: boolean }> = [];
    let limitCalled = false;

    mockFrom.mockImplementation((table: string) => {
      if (table === "listings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "lst-115k",
                  bina_id: "7011500",
                  title: "Yasamal 2 otaqlı mənzil",
                  price_azn_normalized: 115000,
                  rooms: 2,
                  area: 55,
                  location: "Yasamal",
                  district_normalized: "Yasamal",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "publications") {
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
      if (table === "buyer_leads") {
        return {
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            if (opts) headCounts.push(opts);
            return {
              not: () => ({
                overlaps: () => ({
                  limit: async () => {
                    limitCalled = true;
                    return { count: 7, error: null };
                  },
                }),
                limit: async () => {
                  limitCalled = true;
                  return { count: 7, error: null };
                },
              }),
            };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    });

    const card: StageCardInstance = {
      id: "ANALYTICS_7011500",
      cardType: "ANALYTICS_TELEMETRY",
      targetEntityId: "7011500",
      payload: {
        cardType: "ANALYTICS_TELEMETRY",
        listingId: "7011500",
      },
    };

    render(<AnalyticsTelemetryCard card={card} />);

    await waitFor(() => {
      expect(screen.getByText("@baku.serfeli.evler")).not.toBeNull();
      expect(screen.getByText(/7 Alıcı Maraqlanır/)).not.toBeNull();
    });

    expect(headCounts).toEqual([{ count: "exact", head: true }]);
    expect(limitCalled).toBe(true);
    expect(screen.queryByText(/226/)).toBeNull();
  });

  it("CrmNegotiationCard sends Supabase Bearer JWT on /api/ai/copilot and rejects !res.ok || !data.ok", async () => {
    const fetchMock = vi
      .fn()
      // 1. HTTP 200 with ok: false -> must surface error & NOT show saved state
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, error: "BUDGET_EXCEEDED" }),
          { status: 200 }
        )
      )
      // 2. HTTP 500 -> must surface error
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, error: "Server error" }),
          { status: 500 }
        )
      )
      // 3. HTTP 200 with ok: true -> marks saved
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, data: { id: "ins-ok-1" } }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    // First verify empty state renders zero hardcoded demo fixtures
    const emptyCard: StageCardInstance = {
      id: "CRM_empty",
      cardType: "CRM_NEGOTIATION",
      targetEntityId: "lead-empty",
      payload: {
        cardType: "CRM_NEGOTIATION",
        leadId: "lead-empty",
      },
    };
    const { unmount } = render(<CrmNegotiationCard card={emptyCard} />);
    expect(screen.queryByText(/Rəşad Əliyev/i)).toBeNull();
    expect(screen.queryByText(/994502123456/)).toBeNull();
    expect(screen.queryByText(/Badamdar/i)).toBeNull();
    expect(screen.getByText("Yazışma tarixçəsi hələ mövcud deyil.")).not.toBeNull();
    expect(screen.getByText("WhatsApp nömrəsi mövcud deyil")).not.toBeNull();
    unmount();

    const card: StageCardInstance = {
      id: "CRM_1",
      cardType: "CRM_NEGOTIATION",
      targetEntityId: "lead-901",
      payload: {
        cardType: "CRM_NEGOTIATION",
        leadId: "lead-901",
        leadName: "Nigar Vəliyeva",
        phone: "994557776655",
        draftText: "Salam, baxış üçün uyğun vaxtınızı bildirin.",
        extractedObjection: {
          tag: "Qiymət Müzakirəsi",
          domain: "OBJECTION_PRICE_PER_M2",
          insightText: "Müştəri endirim imkanını soruşdu.",
          confidence: 0.91,
        },
      },
    };

    render(<CrmNegotiationCard card={card} />);

    const saveBtn = screen.getByRole("button", {
      name: /Təsdiqlə və Yaddaşa Yaz/i,
    });

    // 1) !data.ok
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(screen.getByText("BUDGET_EXCEEDED")).not.toBeNull();
    });
    expect(screen.queryByText(/Yaddaşa Yazıldı/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/copilot",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-stage-test",
        }),
      })
    );

    // 2) !res.ok
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(screen.getByText("Server error")).not.toBeNull();
    });
    expect(screen.queryByText(/Yaddaşa Yazıldı/)).toBeNull();

    // 3) ok: true
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(screen.getByText(/Yaddaşa Yazıldı/)).not.toBeNull();
    });
  });

  it("ListingsClient and PreflightModal route listings identically via resolveCanonicalListingNiche", () => {
    const affordable = makeListing({
      price: 115000,
      price_azn_normalized: 115000,
      location: "Yasamal",
      district_normalized: "Yasamal",
    });
    const general = makeListing({
      price: 135000,
      price_azn_normalized: 135000,
      location: "Yasamal",
      district_normalized: "Yasamal",
    });
    const luxury = makeListing({
      price: 260000,
      price_azn_normalized: 260000,
      location: "Yasamal",
      district_normalized: "Yasamal",
    });
    const viral = makeListing({
      price: 140000,
      price_azn_normalized: 140000,
      location: "Yasamal",
      district_normalized: "Yasamal",
    }) as ListingWithLatestRender & { price_drop_pct?: number };
    viral.price_drop_pct = 12;

    expect(resolveListingNiche(affordable)).toEqual({
      niche: "AFFORDABLE",
      handle: "@baku.serfeli.evler",
    });
    expect(resolveTargetAccount(affordable).niche).toBe("AFFORDABLE");
    expect(resolveTargetAccount(affordable).handle).toBe("@baku.serfeli.evler");

    expect(resolveListingNiche(general)).toEqual({
      niche: "GENERAL",
      handle: "@bakuestate.official",
    });
    expect(resolveTargetAccount(general).niche).toBe("GENERAL");

    expect(resolveListingNiche(luxury)).toEqual({
      niche: "LUXURY",
      handle: "@bakuestate.premium",
    });
    expect(resolveTargetAccount(luxury).niche).toBe("LUXURY");

    expect(resolveListingNiche(viral)).toEqual({
      niche: "TIKTOK",
      handle: "@baku_emlak_ai",
    });
    expect(resolveTargetAccount(viral).niche).toBe("TIKTOK");
  });

  it("LeadsClient renders lead_listing_matches recommendations, supports pitching and dismissing", async () => {
    const leadWithMatches: BuyerLeadWithListings & {
      lead_listing_matches: LeadListingMatchItem[];
    } = {
      id: "lead-match-1",
      client_name: "Aysel Hüseynova",
      phone_normalized: "994503214567",
      social_handle: null,
      source_channel: "WHATSAPP",
      stage: "QUALIFIED",
      budget_max_azn: 125000,
      preferred_districts: ["Yasamal"],
      expected_commission_azn: 2400,
      actual_commission_azn: null,
      lost_reason: null,
      notes: null,
      next_followup_at: null,
      attributed_publication_id: null,
      attributed_channel_niche: null,
      created_at: "2026-11-25T10:00:00Z",
      updated_at: "2026-11-25T10:00:00Z",
      lead_listings: [],
      lead_listing_matches: [
        {
          id: "match-1",
          lead_id: "lead-match-1",
          listing_id: "lst-m1",
          match_score: 88,
          status: "NEW",
          listings: {
            id: "lst-m1",
            bina_id: "7771112",
            title: "Yasamal 3 otaq",
            location: "Yasamal",
            price_azn_normalized: 118000,
            rooms: 3,
            area: 82,
            has_bill_of_sale: true,
            source_availability: "ACTIVE",
          },
        },
        {
          id: "match-dismissed",
          lead_id: "lead-match-1",
          listing_id: "lst-m2",
          match_score: 70,
          status: "DISMISSED",
          listings: {
            id: "lst-m2",
            bina_id: "7779999",
            title: "Gizlədilmiş Elan",
            location: "Xətai",
            price_azn_normalized: 110000,
            rooms: 2,
            area: 60,
            has_bill_of_sale: false,
            source_availability: "ACTIVE",
          },
        },
      ],
    };

    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: updateEqMock });

    mockFrom.mockImplementation((table: string) => {
      if (table === "lead_listings") {
        return { upsert: upsertMock };
      }
      if (table === "lead_listing_matches") {
        return { update: updateMock };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    });

    render(
      <CopilotProvider>
        <LeadsClient initialLeads={[leadWithMatches]} listingOptions={[]} />
      </CopilotProvider>
    );

    expect(screen.getByText(/Ağıllı Uyğunluq Tövsiyələri/i)).not.toBeNull();
    expect(screen.getByText("88% uyğun")).not.toBeNull();
    expect(screen.getByText(/#7771112 • Yasamal 3 otaq/)).not.toBeNull();
    expect(screen.queryByText(/Gizlədilmiş Elan/)).toBeNull();

    // Pitch match -> upserts lead_listings
    fireEvent.click(screen.getByRole("button", { name: /\+ Təklif Et/i }));
    await waitFor(() => {
      expect(upsertMock).toHaveBeenCalledWith({
        lead_id: "lead-match-1",
        listing_id: "lst-m1",
        relation: "PITCHED",
      });
    });

    // Dismiss match -> updates lead_listing_matches status = DISMISSED
    fireEvent.click(screen.getByRole("button", { name: /Gizlət/i }));
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({ status: "DISMISSED" });
      expect(updateEqMock).toHaveBeenCalledWith("id", "match-1");
    });
    expect(screen.queryByText("88% uyğun")).toBeNull();
  });
});
