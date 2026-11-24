import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as queueRenderPOST } from "../../app/api/pipeline/queue-render/route";

const mockInsert = vi.fn();
let mockActiveJobs: Array<{ id: string; status: string }> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "083d8ea3-4a73-4b85-8479-0c532ce939f0" } },
        error: null,
      }),
    },
    from: (table: string) => {
      if (table === "listings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "listing-uuid-123",
                  bina_id: "6588858",
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "pipeline_jobs") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                or: () => ({
                  order: () => ({
                    limit: async () => ({
                      data: mockActiveJobs,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            mockInsert(row);
            return {
              select: () => ({
                single: async () => ({
                  data: { id: "job-new-1", ...row },
                  error: null,
                }),
              }),
            };
          },
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
  createClient: async () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "083d8ea3-4a73-4b85-8479-0c532ce939f0" } },
        error: null,
      }),
    },
  }),
}));

describe("POST /api/pipeline/queue-render deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveJobs = [];
  });

  it("inserts a new RENDER_INITIAL job when no active job exists", async () => {
    mockActiveJobs = [];
    const req = new Request("http://localhost:3000/api/pipeline/queue-render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listing_id: "listing-uuid-123",
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
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("returns existing active job without inserting duplicate when QUEUED or RUNNING job exists", async () => {
    mockActiveJobs = [{ id: "job-active-777", status: "QUEUED" }];
    const req = new Request("http://localhost:3000/api/pipeline/queue-render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listing_id: "listing-uuid-123",
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
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
