import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient as createBrowserClient, resetBrowserClientForTest } from "@/lib/supabase/client";
import { requireOperator, resolveOperator } from "@/lib/auth/resolve-operator";
import { JOB_STATUS_META } from "@/lib/format";
import { invokeCopilot } from "@/lib/ai-client";

const mockAuthGetUser = vi.fn();
const mockServerAuthGetUser = vi.fn();
const mockAgencyMembersMaybeSingle = vi.fn();

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: vi.fn((url: string, key: string, opts?: unknown) => {
      // Allow real validation behavior while mocking network auth/db queries
      return {
        _url: url,
        _key: key,
        _opts: opts,
        auth: {
          getUser: mockAuthGetUser,
        },
        from: (table: string) => {
          if (table === "agency_members") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: mockAgencyMembersMaybeSingle,
                }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        },
      };
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: mockServerAuthGetUser,
    },
  }),
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: mockServerAuthGetUser,
    },
  }),
  getServerSessionMember: vi.fn().mockResolvedValue(null),
}));

describe("v2 P0 Task 3 & 4: Middleware, Fail-Closed Clients, RBAC & Types", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...origEnv };
    resetBrowserClientForTest?.();
    mockServerAuthGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockAuthGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Invalid JWT" } });
    mockAgencyMembersMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  it("redirects unauthenticated /listings to /login, passes /api/social/webhooks/meta and /api/* without 307", async () => {
    const pageRes = await middleware(new NextRequest("https://app.test/listings"));
    expect(pageRes.status).toBe(307);
    expect(new URL(pageRes.headers.get("location")!).pathname).toBe("/login");

    const hookRes = await middleware(new NextRequest("https://app.test/api/social/webhooks/meta"));
    expect(hookRes.status).toBe(200);

    const oauthRes = await middleware(new NextRequest("https://app.test/api/social/oauth/meta"));
    expect(oauthRes.status).toBe(200);

    const apiRes = await middleware(new NextRequest("https://app.test/api/ai/copilot"));
    expect(apiRes.status).toBe(200);
  });

  it("rejects test-jwt tokens and missing sessions with 401, and inactive agency_members with 403", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://v2-isolated.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret";

    const badTestJwt = await requireOperator(
      new Request("https://app.test/api/x", {
        headers: { Authorization: "Bearer test-jwt-123" },
      })
    );
    expect(badTestJwt.ok).toBe(false);
    if (!badTestJwt.ok) expect(badTestJwt.response.status).toBe(401);

    const badPlaceholderJwt = await requireOperator(
      new Request("https://app.test/api/x", {
        headers: { Authorization: "Bearer <TEST_SUPABASE_JWT>" },
      })
    );
    expect(badPlaceholderJwt.ok).toBe(false);
    if (!badPlaceholderJwt.ok) expect(badPlaceholderJwt.response.status).toBe(401);

    const unauthCookie = await requireOperator(new Request("https://app.test/api/x"));
    expect(unauthCookie.ok).toBe(false);
    if (!unauthCookie.ok) expect(unauthCookie.response.status).toBe(401);

    // Valid JWT but inactive agency_member -> 403
    mockAuthGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-inactive-1", email: "broker@bakuestate.az" } },
      error: null,
    });
    mockAgencyMembersMaybeSingle.mockResolvedValueOnce({
      data: {
        user_id: "user-inactive-1",
        agency_id: "agency-1",
        role: "BROKER",
        display_name: "Deactivated Broker",
        is_active: false,
      },
      error: null,
    });

    const inactiveRes = await requireOperator(
      new Request("https://app.test/api/x", {
        headers: { Authorization: "Bearer header.payload.signature" },
      })
    );
    expect(inactiveRes.ok).toBe(false);
    if (!inactiveRes.ok) expect(inactiveRes.response.status).toBe(403);

    // Active SMM denied on ADMIN/BROKER route -> 403
    mockAuthGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-smm-1", email: "smm@bakuestate.az" } },
      error: null,
    });
    mockAgencyMembersMaybeSingle.mockResolvedValueOnce({
      data: {
        user_id: "user-smm-1",
        agency_id: "agency-1",
        role: "SMM",
        display_name: "SMM Specialist",
        is_active: true,
      },
      error: null,
    });

    const smmForbidden = await requireOperator(
      new Request("https://app.test/api/x", {
        headers: { Authorization: "Bearer header.payload.signature" },
      }),
      ["ADMIN", "BROKER"]
    );
    expect(smmForbidden.ok).toBe(false);
    if (!smmForbidden.ok) expect(smmForbidden.response.status).toBe(403);

    // Active BROKER succeeds and resolves full tenant context
    mockAuthGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-broker-1", email: "broker@bakuestate.az" } },
      error: null,
    });
    mockAgencyMembersMaybeSingle.mockResolvedValueOnce({
      data: {
        user_id: "user-broker-1",
        agency_id: "agency-1",
        role: "BROKER",
        display_name: "Əli Broker",
        is_active: true,
      },
      error: null,
    });

    const resolved = await resolveOperator(
      new Request("https://app.test/api/x", {
        headers: { Authorization: "Bearer header.payload.signature" },
      })
    );
    expect(resolved).toEqual({
      operatorId: "user-broker-1",
      email: "broker@bakuestate.az",
      agencyId: "agency-1",
      role: "BROKER",
      displayName: "Əli Broker",
    });
  });

  it("throws in createAdminClient when SUPABASE_SERVICE_ROLE_KEY or URL is unset (zero fallback)", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-must-never-be-used";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://v2-isolated.supabase.co";
    expect(() => createAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);

    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret";
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => createAdminClient()).toThrow(/SUPABASE_URL/);
  });

  it("returns singleton browser client from web/lib/supabase/client.ts", () => {
    if (typeof globalThis.WebSocket === "undefined") {
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {};
    }
    const c1 = createBrowserClient();
    const c2 = createBrowserClient();
    expect(c1).toBe(c2);
  });

  it("preserves UPSTREAM_UNAVAILABLE in invokeCopilot and maps CANCELLED in JOB_STATUS_META", async () => {
    expect((JOB_STATUS_META as Record<string, { label: string }>).CANCELLED?.label).toBeTruthy();
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        code: "UPSTREAM_UNAVAILABLE",
        error: "Gemini offline",
        fallback_available: false,
      }),
    });
    const res = await invokeCopilot({ action: "agent_chat", agent_id: "mudir", message: "Salam" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(res.fallback_available).toBe(false);
    }
  });
});

describe("v2 P0 Task 5 & 6: Copilot Hardening & API Route Leases", () => {
  const origEnv = { ...process.env };
  const validJwtHeader = {
    "Content-Type": "application/json",
    Authorization: "Bearer header.payload.signature",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...origEnv };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://v2-isolated.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret";
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  it("returns 401 from copilot, queue-render, preflight, and dispatch-video when unauthenticated", async () => {
    mockServerAuthGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const { POST: copilotPOST } = await import("@/app/api/ai/copilot/route");
    const { POST: queueRenderPOST } = await import("@/app/api/pipeline/queue-render/route");
    const { POST: preflightPOST } = await import("@/app/api/listings/[bina_id]/preflight/route");
    const { POST: dispatchPOST } = await import("@/app/api/telegram/dispatch-video/route");

    const cRes = await copilotPOST(
      new Request("https://app.test/api/ai/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "agent_chat", agent_id: "mudir", message: "hi" }),
      })
    );
    expect(cRes.status).toBe(401);

    const qRes = await queueRenderPOST(
      new Request("https://app.test/api/pipeline/queue-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listing_id: "11111111-1111-4111-8111-111111111111" }),
      })
    );
    expect(qRes.status).toBe(401);

    const pRes = await preflightPOST(
      new Request("https://app.test/api/listings/6588858/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ bina_id: "6588858" }) }
    );
    expect(pRes.status).toBe(401);

    const dRes = await dispatchPOST(
      new Request("https://app.test/api/telegram/dispatch-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listing_id: "6588858" }),
      })
    );
    expect(dRes.status).toBe(401);
  });

  it("copilot returns HTTP 503 UPSTREAM_UNAVAILABLE with zero mock fallbacks when Gemini is unavailable", async () => {
    delete process.env.GEMINI_API_KEY;
    const mockRpc = vi.fn().mockImplementation(async (fnName: string) => {
      if (fnName === "check_and_reserve_ai_budget") {
        return { data: [{ allowed: true, run_id: "run-budget-1", reason: "OK" }], error: null };
      }
      if (fnName === "reconcile_ai_budget_run") {
        return { data: true, error: null };
      }
      return { data: null, error: null };
    });

    const supabaseMod = await import("@supabase/supabase-js");
    vi.mocked(supabaseMod.createClient).mockImplementation(() => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1", email: "admin@bakuestate.az" } },
          error: null,
        }),
      },
      rpc: mockRpc,
      from: (table: string) => {
        if (table === "agency_members") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    user_id: "user-1",
                    agency_id: "agency-1",
                    role: "ADMIN",
                    display_name: "Admin",
                    is_active: true,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          insert: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      },
    }) as never);

    const { POST: copilotPOST } = await import("@/app/api/ai/copilot/route");
    const res = await copilotPOST(
      new Request("https://app.test/api/ai/copilot", {
        method: "POST",
        headers: validJwtHeader,
        body: JSON.stringify({
          action: "voice_debrief",
          audio_base64: "AAAA",
          mime_type: "audio/webm",
        }),
      })
    );
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(data.fallback_available).toBe(false);
  });

  it("copilot save_insight omits invalid metadata column and scopes by agency_id", async () => {
    const insertedInsights: Record<string, unknown>[] = [];
    const supabaseMod = await import("@supabase/supabase-js");
    vi.mocked(supabaseMod.createClient).mockImplementation(() => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1", email: "admin@bakuestate.az" } },
          error: null,
        }),
      },
      rpc: vi.fn(),
      from: (table: string) => {
        if (table === "agency_members") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    user_id: "user-1",
                    agency_id: "agency-1",
                    role: "BROKER",
                    display_name: "Broker",
                    is_active: true,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "agent_learned_insights") {
          return {
            insert: (row: Record<string, unknown>) => {
              insertedInsights.push(row);
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: "insight-1", ...row, created_at: "2026-11-25T10:00:00Z" },
                    error: null,
                  }),
                }),
              };
            },
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      },
    }) as never);

    const { POST: copilotPOST } = await import("@/app/api/ai/copilot/route");
    const res = await copilotPOST(
      new Request("https://app.test/api/ai/copilot", {
        method: "POST",
        headers: validJwtHeader,
        body: JSON.stringify({
          action: "save_insight",
          agent_id: "farabi",
          domain: "OBJECTION_COMMISSION",
          insight_text: "Kupça yoxlanışı vurğulanmalıdır.",
          metadata: { shouldBeIgnored: true },
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(insertedInsights).toHaveLength(1);
    expect(insertedInsights[0]).not.toHaveProperty("metadata");
    expect(insertedInsights[0].agency_id).toBe("agency-1");
  });

  it("dispatch-video returns 410 Gone for pruned video assets and 503 when Telegram creds are missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const supabaseMod = await import("@supabase/supabase-js");
    let prunedAtValue: string | null = "2026-11-20T00:00:00Z";

    vi.mocked(supabaseMod.createClient).mockImplementation(() => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1", email: "admin@bakuestate.az" } },
          error: null,
        }),
      },
      from: (table: string) => {
        if (table === "agency_members") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    user_id: "user-1",
                    agency_id: "agency-1",
                    role: "ADMIN",
                    display_name: "Admin",
                    is_active: true,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "listings") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: "11111111-1111-4111-8111-111111111111",
                      bina_id: "5616503",
                      agency_id: "agency-1",
                      has_bill_of_sale: false,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "render_versions") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [
                      {
                        id: "rv-1",
                        listing_id: "11111111-1111-4111-8111-111111111111",
                        video_cdn_url: "https://media.bakuestate.az/v/test.mp4",
                        storage_pruned_at: prunedAtValue,
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "agency_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { telegram_chat_id: null, public_phone: "+994501112233" },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      },
    }) as never);

    const { POST: dispatchPOST } = await import("@/app/api/telegram/dispatch-video/route");
    const prunedRes = await dispatchPOST(
      new Request("https://app.test/api/telegram/dispatch-video", {
        method: "POST",
        headers: validJwtHeader,
        body: JSON.stringify({ listing_id: "5616503" }),
      })
    );
    expect(prunedRes.status).toBe(410);

    prunedAtValue = null;
    const noTokenRes = await dispatchPOST(
      new Request("https://app.test/api/telegram/dispatch-video", {
        method: "POST",
        headers: validJwtHeader,
        body: JSON.stringify({ listing_id: "5616503" }),
      })
    );
    expect(noTokenRes.status).toBe(503);
  });

  it("preflight acquires Telegram lease, releases slot on sendVideo failure with 502, and blocks concurrent click", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "live-bot-token";
    process.env.TELEGRAM_CHAT_ID = "123456";
    const mockRpc = vi.fn().mockImplementation(async (fnName: string) => {
      if (fnName === "claim_telegram_dispatch_slot") {
        return {
          data: [{ acquired: true, lock_token: "lock-uuid-1", locked_until: "2026-11-25T19:00:00Z" }],
          error: null,
        };
      }
      if (fnName === "release_telegram_dispatch_slot") {
        return { data: true, error: null };
      }
      return { data: null, error: null };
    });

    const supabaseMod = await import("@supabase/supabase-js");
    vi.mocked(supabaseMod.createClient).mockImplementation(() => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-1", email: "admin@bakuestate.az" } },
          error: null,
        }),
      },
      rpc: mockRpc,
      from: (table: string) => {
        if (table === "agency_members") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    user_id: "user-1",
                    agency_id: "agency-1",
                    role: "ADMIN",
                    display_name: "Admin",
                    is_active: true,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "listings") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: "11111111-1111-4111-8111-111111111111",
                      bina_id: "5616503",
                      agency_id: "agency-1",
                      source_type: "OFF_MARKET",
                      price_azn_normalized: 185000,
                      has_bill_of_sale: false,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "render_versions") {
          const rvQuery: Record<string, unknown> = {
            eq: () => rvQuery,
            order: () => rvQuery,
            limit: () => rvQuery,
            maybeSingle: async () => ({
              data: {
                id: "rv-1",
                rendered_price: 185000,
                video_cdn_url: "https://media.bakuestate.az/v/test.mp4",
                storage_pruned_at: null,
              },
              error: null,
            }),
          };
          return {
            select: () => rvQuery,
          };
        }
        if (table === "publications") {
          const pubQuery: Record<string, unknown> = {
            eq: () => pubQuery,
            order: () => pubQuery,
            limit: () => pubQuery,
            maybeSingle: async () => ({
              data: { id: "pub-1", listing_id: "11111111-1111-4111-8111-111111111111" },
              error: null,
            }),
          };
          return {
            select: () => pubQuery,
          };
        }
        if (table === "agency_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { telegram_chat_id: "999888", public_phone: "+994501112233" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "preflight_checks") {
          return {
            insert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      },
    }) as never);

    // Mock Telegram sendVideo failure
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, description: "Telegram unavailable" }),
    });

    const { POST: preflightPOST } = await import("@/app/api/listings/[bina_id]/preflight/route");
    const failRes = await preflightPOST(
      new Request("https://app.test/api/listings/5616503/preflight", {
        method: "POST",
        headers: validJwtHeader,
        body: JSON.stringify({ dispatch_to_telegram: true }),
      }),
      { params: Promise.resolve({ bina_id: "5616503" }) }
    );
    expect(failRes.status).toBe(502);
    const failData = await failRes.json();
    expect(failData.telegram_dispatched).toBe(false);
    expect(mockRpc).toHaveBeenCalledWith("claim_telegram_dispatch_slot", expect.any(Object));
    expect(mockRpc).toHaveBeenCalledWith("release_telegram_dispatch_slot", {
      p_publication_id: "pub-1",
      p_lock_token: "lock-uuid-1",
    });

    // Second concurrent click fails to acquire slot -> 409
    mockRpc.mockResolvedValueOnce({
      data: [{ acquired: false, lock_token: null, locked_until: "2026-11-25T19:00:00Z" }],
      error: null,
    });
    const concurrentRes = await preflightPOST(
      new Request("https://app.test/api/listings/5616503/preflight", {
        method: "POST",
        headers: validJwtHeader,
        body: JSON.stringify({ dispatch_to_telegram: true }),
      }),
      { params: Promise.resolve({ bina_id: "5616503" }) }
    );
    expect(concurrentRes.status).toBe(409);
    const concurrentData = await concurrentRes.json();
    expect(concurrentData.telegram_dispatched).toBe(false);
    expect(concurrentData.already_dispatched).toBe(true);
  });
});

