import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as queueRenderPOST } from "../../app/api/pipeline/queue-render/route";

const mockRpc = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "083d8ea3-4a73-4b85-8479-0c532ce939f0", email: "operator@bakuestate.az" } },
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
                  user_id: "083d8ea3-4a73-4b85-8479-0c532ce939f0",
                  agency_id: "agency-1",
                  role: "ADMIN",
                  display_name: "Operator",
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
                    bina_id: "6588858",
                  },
                  error: null,
                }),
              }),
            }),
          }),
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
  createClient: async () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "083d8ea3-4a73-4b85-8479-0c532ce939f0", email: "operator@bakuestate.az" } },
        error: null,
      }),
    },
  }),
}));

describe("POST /api/pipeline/queue-render deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues a new RENDER_INITIAL job via enqueue_listing_render_atomic when no active job exists", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { ok: true, already_queued: false, job_id: "job-new-1" },
      error: null,
    });

    const req = new Request("http://localhost:3000/api/pipeline/queue-render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listing_id: "11111111-1111-4111-8111-111111111111",
        bina_id: "6588858",
        voice_preset: "Arif",
      }),
    });

    const res = await queueRenderPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.job_id).toBe("job-new-1");
    expect(data.already_queued).toBeUndefined();
    expect(mockRpc).toHaveBeenCalledWith("enqueue_listing_render_atomic", expect.objectContaining({
      p_listing_id: "11111111-1111-4111-8111-111111111111",
      p_job_type: "RENDER_INITIAL",
    }));
  });

  it("returns existing active job without inserting duplicate when QUEUED or RUNNING job exists", async () => {
    mockRpc.mockResolvedValueOnce({
      data: { ok: true, already_queued: true, job_id: "job-active-777" },
      error: null,
    });

    const req = new Request("http://localhost:3000/api/pipeline/queue-render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listing_id: "11111111-1111-4111-8111-111111111111",
        bina_id: "6588858",
        voice_preset: "Arif",
      }),
    });

    const res = await queueRenderPOST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.job_id).toBe("job-active-777");
    expect(data.already_queued).toBe(true);
    expect(data.message).toContain("artıq montaj növbəsindədir");
  });
});
