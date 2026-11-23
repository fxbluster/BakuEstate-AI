import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as dispatchVideoPOST } from "../app/api/telegram/dispatch-video/route";
import { POST as queueRenderPOST } from "../app/api/pipeline/queue-render/route";

// Mock Supabase admin client
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockSingle = vi.fn();
const mockMaybeSingle = vi.fn();
const mockOr = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "083d8ea3-4a73-4b85-8479-0c532ce939f0", email: "operator@bakuestate.az" } },
        error: null,
      }),
    },
    from: (table: string) => {
      if (table === "render_versions") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  data: [
                    {
                      id: "rv-test-1",
                      listing_id: "listing-test-1",
                      bina_id: "5616503",
                      video_cdn_url: "https://cdn.bakuestate.az/renders/5616503_v1.mp4",
                    },
                  ],
                  error: null,
                }),
              }),
              maybeSingle: () => ({
                data: {
                  id: "rv-test-1",
                  listing_id: "listing-test-1",
                  bina_id: "5616503",
                  video_cdn_url: "https://cdn.bakuestate.az/renders/5616503_v1.mp4",
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "listings") {
        const mockListingData = {
          data: {
            id: "listing-test-1",
            bina_id: "5616503",
            title: "Nəsimi 3 otaqlı",
            price_azn_normalized: 185000,
            location: "Nəsimi rayonu",
            owner_phone_raw: "+994501234567",
            contact_name: "Əli Məmmədov",
            has_bill_of_sale: true,
          },
          error: null,
        };
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => mockListingData,
            }),
            or: () => ({
              maybeSingle: () => mockListingData,
            }),
          }),
        };
      }

      if (table === "pipeline_jobs") {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: () => ({
                data: { id: "job-queued-999", ...row },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "listing_events") {
        return {
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }

      return {
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
      };
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "083d8ea3-4a73-4b85-8479-0c532ce939f0" } },
        error: null,
      }),
    },
  }),
}));

describe("POST /api/telegram/dispatch-video", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when listing_id is missing", async () => {
    const req = new Request("http://localhost:3000/api/telegram/dispatch-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await dispatchVideoPOST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("listing_id parametri tələb olunur");
  });

  it("dispatches video directly via URL when file size <= 20MB", async () => {
    // Mock HEAD request returning 12MB (12,582,912 bytes)
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({
            "content-length": "12582912",
          }),
        });
      }
      // Mock Telegram Bot API calls
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: 8492 },
        }),
      });
    });

    const req = new Request("http://localhost:3000/api/telegram/dispatch-video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer <TEST_SUPABASE_JWT>",
      },
      body: JSON.stringify({
        listing_id: "listing-test-1",
        target_account: "@bakuestate.premium",
      }),
    });

    const res = await dispatchVideoPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.dispatch_mode).toBe("DIRECT_URL");
    expect(data.target_chat_id).toBeTruthy();
  });

  it("enqueues TELEGRAM_DISPATCH into pipeline_jobs when file size exceeds 20MB", async () => {
    // Mock HEAD request returning 35MB (36,700,160 bytes)
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({
            "content-length": "36700160",
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const req = new Request("http://localhost:3000/api/telegram/dispatch-video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer <TEST_SUPABASE_JWT>",
      },
      body: JSON.stringify({
        listing_id: "listing-test-1",
        target_account: "@bakuestate.premium",
      }),
    });

    const res = await dispatchVideoPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.dispatch_mode).toBe("QUEUED_WORKER");
    expect(data.job_id).toBe("job-queued-999");
  });

  it("enqueues into pipeline_jobs when HEAD request times out", async () => {
    // Mock HEAD request failing / timing out
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return Promise.reject(new Error("AbortError: operation timed out"));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const req = new Request("http://localhost:3000/api/telegram/dispatch-video", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer <TEST_SUPABASE_JWT>",
      },
      body: JSON.stringify({
        listing_id: "listing-test-1",
      }),
    });

    const res = await dispatchVideoPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.dispatch_mode).toBe("QUEUED_WORKER");
    expect(data.job_id).toBe("job-queued-999");
  });
});

describe("POST /api/pipeline/queue-render", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when listing_id is missing", async () => {
    const req = new Request("http://localhost:3000/api/pipeline/queue-render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await queueRenderPOST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("listing_id parametri tələb olunur");
  });

  it("successfully enqueues RENDER_INITIAL job into pipeline_jobs", async () => {
    const req = new Request("http://localhost:3000/api/pipeline/queue-render", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer <TEST_SUPABASE_JWT>",
      },
      body: JSON.stringify({
        listing_id: "listing-test-1",
        bina_id: "5616503",
        target_account: "@bakuestate.premium",
        voice_preset: "Arif",
      }),
    });

    const res = await queueRenderPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.job_id).toBe("job-queued-999");
  });
});
