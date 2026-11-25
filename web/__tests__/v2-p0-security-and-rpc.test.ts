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
