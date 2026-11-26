import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetSignedUrl,
  mockGetObjectCommand,
  mockS3Client,
  mockCreateAdminClient,
  mockRequireOperator,
} = vi.hoisted(() => ({
  mockGetSignedUrl: vi.fn(),
  mockGetObjectCommand: vi.fn((input: unknown) => ({ input })),
  mockS3Client: vi.fn(),
  mockCreateAdminClient: vi.fn(),
  mockRequireOperator: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: mockS3Client,
  GetObjectCommand: mockGetObjectCommand,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock("@/lib/auth/resolve-operator", () => ({
  requireOperator: mockRequireOperator,
}));

const AGENCY_ID = "dd6ea89f-919d-51e5-bdd9-2af772a0a5b3";
const OTHER_AGENCY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LISTING_UUID = "aa113ba9-8b2c-4403-80b0-1f5758086af6";
const RENDER_UUID = "b57870b6-8c84-49eb-a41c-db2da59d36e5";

const ORIGINAL_ENV = { ...process.env };

function setupR2Env() {
  process.env.R2_ACCOUNT_ID = "acc123";
  process.env.R2_ACCESS_KEY_ID = "key123";
  process.env.R2_SECRET_ACCESS_KEY = "sec123";
  process.env.R2_BUCKET = "baku-estate-media";
  process.env.R2_MEDIA_BASE_URL = "https://pub-7ec08c01aaf8419abcd973a652288081.r2.dev";
}

describe("R2 Media Playback & Presigning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    setupR2Env();
    mockGetSignedUrl.mockResolvedValue(
      "https://acc123.r2.cloudflarestorage.com/baku-estate-media/videos/test.mp4?X-Amz-Signature=sig123"
    );
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("presigns GetObjectCommand for private .r2.dev/v/ render URLs", async () => {
    const { resolvePlayableRenderUrl } = await import("@/lib/r2-media");

    const url = await resolvePlayableRenderUrl({
      id: RENDER_UUID,
      storage_provider: "r2",
      storage_object_path:
        "videos/dd6ea89f-919d-51e5-bdd9-2af772a0a5b3/aa113ba9-8b2c-4403-80b0-1f5758086af6/v1__at_bakuestate.premium.mp4",
      video_cdn_url:
        "https://pub-7ec08c01aaf8419abcd973a652288081.r2.dev/v/videos/dd6ea89f-919d-51e5-bdd9-2af772a0a5b3/aa113ba9-8b2c-4403-80b0-1f5758086af6/v1__at_bakuestate.premium.mp4",
      storage_pruned_at: null,
    });

    expect(mockGetObjectCommand).toHaveBeenCalledWith({
      Bucket: "baku-estate-media",
      Key: "videos/dd6ea89f-919d-51e5-bdd9-2af772a0a5b3/aa113ba9-8b2c-4403-80b0-1f5758086af6/v1__at_bakuestate.premium.mp4",
    });
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    expect(url).toContain("X-Amz-Signature=sig123");
  });

  it("falls back to stripping /v/ from .r2.dev URL when storage_object_path is missing", async () => {
    const { resolvePlayableRenderUrl } = await import("@/lib/r2-media");

    await resolvePlayableRenderUrl({
      id: RENDER_UUID,
      video_cdn_url:
        "https://pub-7ec08c01aaf8419abcd973a652288081.r2.dev/v/videos/folder/clip.mp4",
      storage_pruned_at: null,
    });

    expect(mockGetObjectCommand).toHaveBeenCalledWith({
      Bucket: "baku-estate-media",
      Key: "videos/folder/clip.mp4",
    });
  });

  it("preserves working legacy Supabase Storage URLs without signing via R2", async () => {
    const { resolvePlayableRenderUrl } = await import("@/lib/r2-media");

    const legacyUrl =
      "https://ejsaccbeatmwqodwwzwu.supabase.co/storage/v1/object/public/baku-estate-media/videos/5867067/v3__at_bakuestate.premium.mp4";
    const resolved = await resolvePlayableRenderUrl({
      id: RENDER_UUID,
      storage_provider: "r2",
      storage_object_path: "videos/5867067/v3__at_bakuestate.premium.mp4",
      video_cdn_url: legacyUrl,
      storage_pruned_at: null,
    });

    expect(resolved).toBe(legacyUrl);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("returns null when render is pruned", async () => {
    const { resolvePlayableRenderUrl } = await import("@/lib/r2-media");

    const resolved = await resolvePlayableRenderUrl({
      id: RENDER_UUID,
      storage_provider: "r2",
      storage_object_path: "videos/a/b.mp4",
      video_cdn_url: "https://pub-7ec08c01aaf8419abcd973a652288081.r2.dev/v/videos/a/b.mp4",
      storage_pruned_at: "2026-11-26T00:00:00Z",
    });

    expect(resolved).toBeNull();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("resolveClientVideoSrc routes raw .r2.dev URLs through /api/media/render/[id] while leaving signed/Supabase URLs unchanged", async () => {
    const { resolveClientVideoSrc } = await import("@/lib/r2-media-client");

    expect(
      resolveClientVideoSrc({
        id: RENDER_UUID,
        video_cdn_url:
          "https://pub-7ec08c01aaf8419abcd973a652288081.r2.dev/v/videos/a/b.mp4",
        storage_pruned_at: null,
      })
    ).toBe(`/api/media/render/${RENDER_UUID}`);

    const signed =
      "https://acc123.r2.cloudflarestorage.com/baku-estate-media/videos/a/b.mp4?X-Amz-Signature=sig123";
    expect(
      resolveClientVideoSrc({
        id: RENDER_UUID,
        video_cdn_url: signed,
        storage_pruned_at: null,
      })
    ).toBe(signed);

    const legacySupa =
      "https://ejsaccbeatmwqodwwzwu.supabase.co/storage/v1/object/public/baku-estate-media/videos/5867067/v3.mp4";
    expect(
      resolveClientVideoSrc({
        id: RENDER_UUID,
        video_cdn_url: legacySupa,
        storage_pruned_at: null,
      })
    ).toBe(legacySupa);
  });

  it("GET /api/media/render/[id] redirects authenticated same-agency operator to signed R2 URL", async () => {
    mockRequireOperator.mockResolvedValueOnce({
      ok: true,
      operator: {
        operatorId: OPERATOR_ID,
        agencyId: AGENCY_ID,
        role: "ADMIN",
        displayName: "Admin",
      },
    });

    mockCreateAdminClient.mockReturnValueOnce({
      from: (table: string) => {
        if (table === "render_versions") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: RENDER_UUID,
                    listing_id: LISTING_UUID,
                    storage_provider: "r2",
                    storage_object_path:
                      "videos/dd6ea89f-919d-51e5-bdd9-2af772a0a5b3/aa113ba9-8b2c-4403-80b0-1f5758086af6/v1__at_bakuestate.premium.mp4",
                    video_cdn_url:
                      "https://pub-7ec08c01aaf8419abcd973a652288081.r2.dev/v/videos/dd6ea89f-919d-51e5-bdd9-2af772a0a5b3/aa113ba9-8b2c-4403-80b0-1f5758086af6/v1__at_bakuestate.premium.mp4",
                    storage_pruned_at: null,
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
                maybeSingle: async () => ({
                  data: { id: LISTING_UUID, agency_id: AGENCY_ID },
                  error: null,
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    });

    const { GET } = await import("@/app/api/media/render/[id]/route");
    const req = new Request(`https://bakuestate-ai.vercel.app/api/media/render/${RENDER_UUID}`);
    const res = await GET(req, { params: Promise.resolve({ id: RENDER_UUID }) });

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("X-Amz-Signature=sig123");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("GET /api/media/render/[id] returns 404 when render belongs to a different agency", async () => {
    mockRequireOperator.mockResolvedValueOnce({
      ok: true,
      operator: {
        operatorId: OPERATOR_ID,
        agencyId: AGENCY_ID,
        role: "ADMIN",
        displayName: "Admin",
      },
    });

    mockCreateAdminClient.mockReturnValueOnce({
      from: (table: string) => {
        if (table === "render_versions") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: RENDER_UUID,
                    listing_id: LISTING_UUID,
                    storage_provider: "r2",
                    storage_object_path: "videos/other/clip.mp4",
                    video_cdn_url:
                      "https://pub-7ec08c01aaf8419abcd973a652288081.r2.dev/v/videos/other/clip.mp4",
                    storage_pruned_at: null,
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
                maybeSingle: async () => ({
                  data: { id: LISTING_UUID, agency_id: OTHER_AGENCY_ID },
                  error: null,
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    });

    const { GET } = await import("@/app/api/media/render/[id]/route");
    const req = new Request(`https://bakuestate-ai.vercel.app/api/media/render/${RENDER_UUID}`);
    const res = await GET(req, { params: Promise.resolve({ id: RENDER_UUID }) });

    expect(res.status).toBe(404);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
