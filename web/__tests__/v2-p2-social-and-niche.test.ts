// @vitest-environment node
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveCanonicalListingNiche } from "@/lib/niche-router";
import {
  resolveDistrictCorridor,
  fetchDistrictPriceMedians,
  resolveLiveDistrictCorridor,
  type DistrictPriceMedianRow,
} from "@/lib/market-benchmarks";
import {
  AGENT_PERSONAS,
  CORE_AGENCY_INVARIANTS,
  buildAgentSystemInstruction,
} from "@/lib/agent-personas";

const mockRequireOperator = vi.fn();
const mockCreateAdminClient = vi.fn();
const mockGetSignedUrl = vi.fn();

vi.mock("@/lib/auth/resolve-operator", () => ({
  requireOperator: (...args: unknown[]) => mockRequireOperator(...args),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => mockCreateAdminClient(...args),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor() {}
  },
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

const AGENCY_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const PUB_ID = "44444444-4444-4444-8444-444444444444";

describe("v2 Phase 3 Task 5: Canonical Niche Router (<= 120,000 AZN rule)", () => {
  it("routes 115k, 120k, 135k, 260k, and 12% price drop deterministically", () => {
    // 115,000 AZN in neutral Xətai -> AFFORDABLE
    const r115 = resolveCanonicalListingNiche({
      price_azn_normalized: 115_000,
      location: "Bakı, Xətai r.",
    });
    expect(r115.niche).toBe("AFFORDABLE");
    expect(r115.account).toBe("@baku.serfeli.evler");
    expect(r115.handle).toBe("@baku.serfeli.evler");

    // Boundary 120,000 AZN -> AFFORDABLE
    const r120 = resolveCanonicalListingNiche({
      price_azn_normalized: 120_000,
      location: "Bakı, Xətai r.",
    });
    expect(r120.niche).toBe("AFFORDABLE");
    expect(r120.account).toBe("@baku.serfeli.evler");

    // 135,000 AZN -> GENERAL under default <= 120k rule
    const r135 = resolveCanonicalListingNiche({
      price_azn_normalized: 135_000,
      location: "Bakı, Xətai r.",
    });
    expect(r135.niche).toBe("GENERAL");
    expect(r135.account).toBe("@bakuestate.official");

    // 260,000 AZN -> LUXURY
    const r260 = resolveCanonicalListingNiche({
      price_azn_normalized: 260_000,
      location: "Bakı, Xətai r.",
    });
    expect(r260.niche).toBe("LUXURY");
    expect(r260.account).toBe("@bakuestate.premium");

    // 12% price drop -> TIKTOK overrides price/district
    const rDrop = resolveCanonicalListingNiche({
      price_azn_normalized: 260_000,
      location: "Bakı, Səbail r.",
      price_drop_pct: 12,
    });
    expect(rDrop.niche).toBe("TIKTOK");
    expect(rDrop.account).toBe("@baku_emlak_ai");

    // Urgent flag -> TIKTOK
    const rUrgent = resolveCanonicalListingNiche({
      price_azn_normalized: 180_000,
      location: "Bakı, Xətai r.",
      is_urgent: true,
    });
    expect(rUrgent.niche).toBe("TIKTOK");
    expect(rUrgent.account).toBe("@baku_emlak_ai");
  });

  it("applies elite/suburban district rules and dynamic agency_settings.niche_rules_json overrides", () => {
    // Elite central district -> LUXURY even at lower price
    const elite = resolveCanonicalListingNiche({
      price_azn_normalized: 110_000,
      district_normalized: "Nəsimi",
    });
    expect(elite.niche).toBe("LUXURY");
    expect(elite.account).toBe("@bakuestate.premium");

    // Suburban district -> AFFORDABLE
    const suburban = resolveCanonicalListingNiche({
      price_azn_normalized: 135_000,
      district_normalized: "Masazır",
    });
    expect(suburban.niche).toBe("AFFORDABLE");
    expect(suburban.account).toBe("@baku.serfeli.evler");

    // Dynamic agency rule threshold override: 135k becomes AFFORDABLE when threshold is 140k
    const overridden = resolveCanonicalListingNiche(
      {
        price_azn_normalized: 135_000,
        location: "Bakı, Xətai r.",
        canonical_niche: "GENERAL",
      },
      {
        luxury_min_azn: 280_000,
        affordable_max_azn: 140_000,
        viral_drop_pct: 10,
      }
    );
    expect(overridden.niche).toBe("AFFORDABLE");
    expect(overridden.account).toBe("@baku.serfeli.evler");
  });
});

describe("v2 Phase 3 Task 6: Live district_price_medians & Dynamic Agent Personas", () => {
  it("prefers live district_price_medians over static fallback corridors and falls back safely", async () => {
    const liveRows: DistrictPriceMedianRow[] = [
      {
        agency_id: AGENCY_ID,
        district_normalized: "yasamal",
        sample_count: 24,
        median_azn_per_m2: 2650,
        p25_azn_per_m2: 2410,
        p75_azn_per_m2: 2980,
      },
    ];

    const liveRes = resolveDistrictCorridor("Bakı, Yasamal r., İnşaatçılar", liveRows);
    expect(liveRes.min).toBe(2410);
    expect(liveRes.max).toBe(2980);
    expect(liveRes.median).toBe(2650);
    expect(liveRes.sampleCount).toBe(24);
    expect(liveRes.source).toBe("live_db");

    // Fallback when district not in live rows
    const fallbackRes = resolveDistrictCorridor("Bakı, Səbail r., Badamdar", liveRows);
    expect(fallbackRes.min).toBe(3200);
    expect(fallbackRes.max).toBe(4800);
    expect(fallbackRes.source).toBe("fallback");

    // Async DB fetcher queries district_price_medians and handles empty/error safely
    const mockSupabase = {
      from: (table: string) => {
        expect(table).toBe("district_price_medians");
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: liveRows, error: null }),
            }),
          }),
        };
      },
    };
    const fetched = await fetchDistrictPriceMedians(mockSupabase, AGENCY_ID);
    expect(fetched).toHaveLength(1);

    const resolvedAsync = await resolveLiveDistrictCorridor(
      mockSupabase,
      "Yasamal",
      AGENCY_ID
    );
    expect(resolvedAsync.source).toBe("live_db");
    expect(resolvedAsync.min).toBe(2410);

    const brokenSupabase = {
      from: () => ({
        select: () => ({
          order: async () => ({ data: null, error: { message: "db error" } }),
        }),
      }),
    };
    const safeFallback = await resolveLiveDistrictCorridor(brokenSupabase, "Yasamal");
    expect(safeFallback.source).toBe("fallback");
    expect(safeFallback.min).toBe(2200);
  });

  it("removes static Baku district AZN price numbers from personas and injects live medians", () => {
    expect(CORE_AGENCY_INVARIANTS.BAKU_MEDIAN_VALUATION).not.toMatch(/2200|2800|1900|2400/);
    expect(AGENT_PERSONAS.analitika.systemPrompt).not.toMatch(
      /2200-2800|2300-3000|1900-2400|3000-4500/
    );

    const prompt = buildAgentSystemInstruction("analitika", {
      districtMedians: [
        {
          district_normalized: "yasamal",
          sample_count: 15,
          median_azn_per_m2: 2590,
          p25_azn_per_m2: 2350,
          p75_azn_per_m2: 2890,
        },
      ],
    });
    expect(prompt).toContain("district_price_medians");
    expect(prompt).toContain("yasamal: median 2590 AZN/m²");
    expect(prompt).toContain("p25–p75: 2350–2890 AZN/m²");
  });
});

describe("v2 Phase 3 Task 2: Official Meta/TikTok OAuth & HMAC-Verified Meta Webhook", () => {
  const origEnv = { ...process.env };
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key-000";
    process.env.SOCIAL_OAUTH_STATE_SECRET = "test-oauth-state-secret-123";
    process.env.META_APP_ID = "meta-app-123";
    process.env.META_APP_SECRET = "meta-app-secret-xyz";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "meta-verify-token-999";
    process.env.TIKTOK_CLIENT_KEY = "tt-key-123";
    process.env.TIKTOK_CLIENT_SECRET = "tt-secret-abc";
  });

  afterEach(() => {
    process.env = { ...origEnv };
    globalThis.fetch = origFetch;
  });

  it("enforces ADMIN|SMM RBAC on OAuth start, issues signed CSRF state cookie, and rejects state mismatch", async () => {
    // 1. Unauthenticated -> 401
    mockRequireOperator.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED" }), {
        status: 401,
      }),
    });

    const oauthMod = await import("@/app/api/social/oauth/[platform]/route");
    const unauthRes = await oauthMod.GET(
      new Request("https://app.bakuestate.az/api/social/oauth/instagram"),
      { params: Promise.resolve({ platform: "instagram" }) }
    );
    expect(unauthRes.status).toBe(401);

    // 2. ADMIN/SMM start -> 302 redirect with required IG scopes + HTTP-only cookie
    mockRequireOperator.mockResolvedValueOnce({
      ok: true,
      operator: {
        operatorId: OPERATOR_ID,
        agencyId: AGENCY_ID,
        role: "SMM",
        displayName: "SMM User",
      },
    });
    const startRes = await oauthMod.GET(
      new Request("https://app.bakuestate.az/api/social/oauth/instagram"),
      { params: Promise.resolve({ platform: "instagram" }) }
    );
    expect(startRes.status).toBe(302);
    const location = startRes.headers.get("location") || "";
    expect(location).toContain("https://www.facebook.com/v21.0/dialog/oauth");
    expect(location).toContain("instagram_content_publish");
    expect(location).toContain("instagram_manage_comments");

    const setCookieHeader = startRes.headers.get("set-cookie") || "";
    expect(setCookieHeader).toContain("bakuestate_social_oauth_state=");
    expect(setCookieHeader.toLowerCase()).toContain("httponly");

    const cookiePair = setCookieHeader.split(";")[0];

    // 3. Callback with mismatched state query param -> 403 CSRF_STATE_MISMATCH
    const mismatchRes = await oauthMod.GET(
      new Request(
        "https://app.bakuestate.az/api/social/oauth/instagram?code=auth_code_1&state=tampered-state",
        { headers: { cookie: cookiePair } }
      ),
      { params: Promise.resolve({ platform: "instagram" }) }
    );
    expect(mismatchRes.status).toBe(403);
    const mismatchJson = await mismatchRes.json();
    expect(mismatchJson.code).toBe("CSRF_STATE_MISMATCH");
    expect(mockCreateAdminClient).not.toHaveBeenCalled();

    // 4. Callback without cookie -> 403
    const validNonce = new URL(location).searchParams.get("state");
    const noCookieRes = await oauthMod.GET(
      new Request(
        `https://app.bakuestate.az/api/social/oauth/instagram?code=auth_code_1&state=${validNonce}`
      ),
      { params: Promise.resolve({ platform: "instagram" }) }
    );
    expect(noCookieRes.status).toBe(403);

    // 5. Valid TikTok start + callback stores access & refresh secrets in Vault & upserts social_accounts
    mockRequireOperator.mockResolvedValueOnce({
      ok: true,
      operator: {
        operatorId: OPERATOR_ID,
        agencyId: AGENCY_ID,
        role: "ADMIN",
        displayName: "Admin",
      },
    });
    const ttStartRes = await oauthMod.GET(
      new Request("https://app.bakuestate.az/api/social/oauth/tiktok"),
      { params: Promise.resolve({ platform: "tiktok" }) }
    );
    expect(ttStartRes.status).toBe(302);
    const ttLoc = new URL(ttStartRes.headers.get("location") || "");
    expect(ttLoc.origin + ttLoc.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(ttLoc.searchParams.get("scope")).toContain("video.publish");
    const ttState = ttLoc.searchParams.get("state");
    const ttCookie = (ttStartRes.headers.get("set-cookie") || "").split(";")[0];

    const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
    const upsertedRows: Array<Record<string, unknown>> = [];

    mockCreateAdminClient.mockReturnValue({
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        return {
          data:
            params.p_name?.toString().endsWith("_refresh")
              ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
              : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          error: null,
        };
      },
      from: (table: string) => {
        expect(table).toBe("social_accounts");
        return {
          upsert: (row: Record<string, unknown>) => {
            upsertedRows.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ...row },
                  error: null,
                }),
              }),
            };
          },
        };
      },
    });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("open.tiktokapis.com/v2/oauth/token/")) {
        return new Response(
          JSON.stringify({
            access_token: "tt-access-tok",
            refresh_token: "tt-refresh-tok",
            expires_in: 86400,
            open_id: "tt-open-id-77",
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: { user: { username: "baku_emlak_ai" } },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const ttCallbackRes = await oauthMod.GET(
      new Request(
        `https://app.bakuestate.az/api/social/oauth/tiktok?code=tt-code-ok&state=${ttState}`,
        { headers: { cookie: ttCookie } }
      ),
      { params: Promise.resolve({ platform: "tiktok" }) }
    );
    expect(ttCallbackRes.status).toBe(200);
    const ttJson = await ttCallbackRes.json();
    expect(ttJson.ok).toBe(true);
    expect(ttJson.platform).toBe("TIKTOK");
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].fn).toBe("store_social_secret");
    expect(rpcCalls[0].params.p_secret).toBe("tt-access-tok");
    expect(rpcCalls[1].params.p_secret).toBe("tt-refresh-tok");
    expect(upsertedRows).toHaveLength(1);
    expect(upsertedRows[0].account_handle).toBe("@baku_emlak_ai");
    expect(upsertedRows[0].vault_secret_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(upsertedRows[0].refresh_vault_secret_id).toBe(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    );
  });

  it("handles Meta Webhook GET hub.challenge and rejects POST with missing/invalid X-Hub-Signature-256 (401)", async () => {
    const metaMod = await import("@/app/api/social/webhooks/meta/route");

    // 1. Valid GET challenge
    const getOk = await metaMod.GET(
      new Request(
        "https://app.bakuestate.az/api/social/webhooks/meta?hub.mode=subscribe&hub.verify_token=meta-verify-token-999&hub.challenge=challenge_xyz_123"
      )
    );
    expect(getOk.status).toBe(200);
    expect(await getOk.text()).toBe("challenge_xyz_123");

    // 2. Invalid GET token -> 403
    const getBad = await metaMod.GET(
      new Request(
        "https://app.bakuestate.az/api/social/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge_xyz_123"
      )
    );
    expect(getBad.status).toBe(403);

    const payloadText = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "ig-biz-1",
          changes: [
            {
              field: "comments",
              value: {
                id: "ig_comment_987",
                text: "Salam, kupçası var?",
                like_count: 2,
                from: { id: "u1", username: "buyer_elchin" },
                media: { id: "ig_media_555" },
              },
            },
          ],
        },
      ],
    });

    // 3. Missing signature -> 401 before DB access
    const postMissingSig = await metaMod.POST(
      new Request("https://app.bakuestate.az/api/social/webhooks/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payloadText,
      })
    );
    expect(postMissingSig.status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();

    // 4. Invalid signature -> 401 before DB access
    const postBadSig = await metaMod.POST(
      new Request("https://app.bakuestate.az/api/social/webhooks/meta", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256":
            "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        },
        body: payloadText,
      })
    );
    expect(postBadSig.status).toBe(401);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();

    // 5. Valid HMAC-SHA256 signature -> resolves publication & calls upsert_social_comment_returning_is_new
    const validSig =
      "sha256=" +
      crypto
        .createHmac("sha256", "meta-app-secret-xyz")
        .update(payloadText, "utf8")
        .digest("hex");

    const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        expect(table).toBe("publications");
        return {
          select: () => ({
            eq: (col1: string, val1: string) => {
              expect(col1).toBe("channel");
              expect(val1).toBe("INSTAGRAM_REELS");
              return {
                eq: (col2: string, val2: string) => {
                  expect(col2).toBe("external_post_id");
                  expect(val2).toBe("ig_media_555");
                  return {
                    maybeSingle: async () => ({
                      data: { id: PUB_ID, agency_id: AGENCY_ID, listing_id: LISTING_ID },
                      error: null,
                    }),
                  };
                },
              };
            },
          }),
        };
      },
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        return { data: [{ comment_id: "55555555-5555-4555-8555-555555555555", is_new: true }], error: null };
      },
    });

    const postOk = await metaMod.POST(
      new Request("https://app.bakuestate.az/api/social/webhooks/meta", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": validSig,
        },
        body: payloadText,
      })
    );
    expect(postOk.status).toBe(200);
    const postJson = await postOk.json();
    expect(postJson.ok).toBe(true);
    expect(postJson.processed).toBe(1);
    expect(postJson.inserted).toBe(1);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("upsert_social_comment_returning_is_new");
    expect(rpcCalls[0].params).toMatchObject({
      p_agency_id: AGENCY_ID,
      p_publication_id: PUB_ID,
      p_platform_comment_id: "ig_comment_987",
      p_author_handle: "buyer_elchin",
      p_comment_text: "Salam, kupçası var?",
      p_like_count: 2,
    });
  });
});

describe("v2 Phase 3 Task 4: /api/listings/manual triggers match_listing_to_leads RPC", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.R2_ACCOUNT_ID = "acc-1";
    process.env.R2_ACCESS_KEY_ID = "key-1";
    process.env.R2_SECRET_ACCESS_KEY = "sec-1";
    process.env.R2_BUCKET = "baku-estate-media";
    process.env.NEXT_PUBLIC_R2_MEDIA_BASE_URL = "https://media.bakuestate.az";
    mockGetSignedUrl.mockResolvedValue("https://acc-1.r2.cloudflarestorage.com/put");
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("invokes match_listing_to_leads on OFF_MARKET listing creation (<=120k AFFORDABLE) and PATCH confirmation", async () => {
    mockRequireOperator.mockResolvedValue({
      ok: true,
      operator: {
        operatorId: OPERATOR_ID,
        agencyId: AGENCY_ID,
        role: "BROKER",
        displayName: "Broker",
      },
    });

    const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
    const insertedListings: Array<Record<string, unknown>> = [];

    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table === "agency_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    niche_rules_json: {
                      luxury_min_azn: 250000,
                      affordable_max_azn: 120000,
                      viral_drop_pct: 10,
                    },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "listings") {
          return {
            insert: (row: Record<string, unknown>) => {
              insertedListings.push(row);
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: LISTING_ID, ...row },
                    error: null,
                  }),
                }),
              };
            },
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LISTING_ID,
                      agency_id: AGENCY_ID,
                      source_type: "OFF_MARKET",
                      assigned_agent_id: OPERATOR_ID,
                      source_availability: "ACTIVE",
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    single: async () => ({
                      data: { id: LISTING_ID, photo_urls: patch.photo_urls },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return { insert: async () => ({ error: null }) };
      },
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        return { data: 3, error: null };
      },
    });

    const manualMod = await import("@/app/api/listings/manual/route");
    const postRes = await manualMod.POST(
      new Request("https://app.bakuestate.az/api/listings/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Xətai sərfəli 2 otaq",
          price_azn: 115000,
          area_m2: 58,
          rooms: 2,
          district: "Xətai",
          address: "Məhəmməd Hadi küçəsi",
          photo_files: [
            { name: "1.jpg", contentType: "image/jpeg", sizeBytes: 100000 },
            { name: "2.jpg", contentType: "image/jpeg", sizeBytes: 100000 },
            { name: "3.jpg", contentType: "image/jpeg", sizeBytes: 100000 },
            { name: "4.jpg", contentType: "image/jpeg", sizeBytes: 100000 },
          ],
        }),
      })
    );

    expect(postRes.status).toBe(201);
    const postBody = await postRes.json();
    expect(postBody.matched_leads_count).toBe(3);
    expect(insertedListings[0].canonical_niche).toBe("AFFORDABLE");
    expect(rpcCalls[0]).toEqual({
      fn: "match_listing_to_leads",
      params: { p_listing_id: LISTING_ID },
    });

    const validUrls = postBody.upload_urls.map((u: { public_path: string }) => u.public_path);
    const patchRes = await manualMod.PATCH(
      new Request("https://app.bakuestate.az/api/listings/manual", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: LISTING_ID,
          photo_urls: validUrls,
        }),
      })
    );
    expect(patchRes.status).toBe(200);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[1]).toEqual({
      fn: "match_listing_to_leads",
      params: { p_listing_id: LISTING_ID },
    });
  });
});
