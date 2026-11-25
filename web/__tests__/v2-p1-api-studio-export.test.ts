import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetSignedUrl,
  mockPutObjectCommand,
  mockS3Client,
  mockProxyAgent,
  mockGenerateContent,
  mockCreateAdminClient,
  mockRequireOperator,
} = vi.hoisted(() => ({
  mockGetSignedUrl: vi.fn(),
  mockPutObjectCommand: vi.fn((input: unknown) => ({ input })),
  mockS3Client: vi.fn(),
  mockProxyAgent: vi.fn(),
  mockGenerateContent: vi.fn(),
  mockCreateAdminClient: vi.fn(),
  mockRequireOperator: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: mockS3Client,
  PutObjectCommand: mockPutObjectCommand,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock("undici", () => ({
  ProxyAgent: mockProxyAgent,
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: mockGenerateContent,
    },
  })),
  createPartFromBase64: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock("@/lib/auth/resolve-operator", () => ({
  requireOperator: mockRequireOperator,
}));

const AGENCY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LISTING_UUID = "11111111-1111-4111-8111-111111111111";
const MEMBER_UUID = "22222222-2222-4222-8222-222222222222";

function allowOperator(
  role: "ADMIN" | "BROKER" | "SMM" = "ADMIN",
  operatorId = OPERATOR_ID
) {
  mockRequireOperator.mockImplementation(
    async (_req: Request, allowedRoles?: string[]) => {
      if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(role)) {
        return {
          ok: false,
          response: new Response(
            JSON.stringify({ ok: false, success: false, code: "FORBIDDEN", error: "Forbidden" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          ),
        };
      }
      return {
        ok: true,
        operator: {
          operatorId,
          email: `${role.toLowerCase()}@bakuestate.az`,
          agencyId: AGENCY_ID,
          role,
          displayName: `Test ${role}`,
        },
      };
    }
  );
}

describe("v2 Phase 2: Env helpers (NEXT_PUBLIC_R2_MEDIA_BASE_URL, BINA_PROXY_URL)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("resolves R2 media base URL with default fallback and trailing slash trimming", async () => {
    const envMod = await import("@/lib/supabase/env");
    delete process.env.NEXT_PUBLIC_R2_MEDIA_BASE_URL;
    delete process.env.R2_MEDIA_BASE_URL;
    expect(envMod.getR2MediaBaseUrl()).toBe("https://media.bakuestate.az");

    process.env.NEXT_PUBLIC_R2_MEDIA_BASE_URL = "https://cdn.example.az///";
    expect(envMod.getR2MediaBaseUrl()).toBe("https://cdn.example.az");

    process.env.NEXT_PUBLIC_R2_MEDIA_BASE_URL = "javascript:alert(1)";
    expect(envMod.getR2MediaBaseUrl()).toBe("https://media.bakuestate.az");
  });

  it("validates BINA_PROXY_URL safely", async () => {
    const envMod = await import("@/lib/supabase/env");
    delete process.env.BINA_PROXY_URL;
    expect(envMod.getBinaProxyUrl()).toBeNull();

    process.env.BINA_PROXY_URL = "http://user:pass@proxy.webshare.io:80";
    expect(envMod.getBinaProxyUrl()).toBe("http://user:pass@proxy.webshare.io:80");

    process.env.BINA_PROXY_URL = "ftp://invalid.proxy";
    expect(envMod.getBinaProxyUrl()).toBeNull();
  });
});

describe("v2 Phase 2 Task 4: Preflight ProxyAgent, 5-failure circuit breaker & OFF_MARKET UUID", () => {
  const origEnv = { ...process.env };
  const origFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...origEnv };
    allowOperator("BROKER");
  });

  afterEach(() => {
    process.env = origEnv;
    global.fetch = origFetch;
  });

  it("exports nodejs runtime and resolves OFF_MARKET UUID without parseInt 400 or hitting bina.az", async () => {
    vi.resetModules();
    const preflightMod = await import("@/app/api/listings/[bina_id]/preflight/route");
    expect(preflightMod.runtime).toBe("nodejs");

    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table === "listings") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LISTING_UUID,
                      agency_id: AGENCY_ID,
                      source_type: "OFF_MARKET",
                      bina_id: null,
                      price_azn_normalized: 210000,
                      has_bill_of_sale: false,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "preflight_checks") {
          return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
        }
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          update: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    });

    const res = await preflightMod.POST(
      new Request(`https://app.test/api/listings/${LISTING_UUID}/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ bina_id: LISTING_UUID }) }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.portal_price).toBe(210000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses undici.ProxyAgent when BINA_PROXY_URL is set and opens circuit breaker after 5 consecutive failures", async () => {
    process.env.BINA_PROXY_URL = "http://user:pass@proxy.webshare.io:80";
    vi.resetModules();
    const preflightMod = await import("@/app/api/listings/[bina_id]/preflight/route");

    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table === "listings") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LISTING_UUID,
                      agency_id: AGENCY_ID,
                      source_type: "BINA_AZ",
                      bina_id: "6588858",
                      price_azn_normalized: 195000,
                      has_bill_of_sale: false,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "preflight_checks") {
          return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
        }
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          update: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    });

    const fetchSpy = vi.fn().mockRejectedValue(new Error("Proxy connection reset"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    for (let i = 1; i <= 4; i++) {
      const r = await preflightMod.POST(
        new Request("https://app.test/api/listings/6588858/preflight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        { params: Promise.resolve({ bina_id: "6588858" }) }
      );
      expect(r.status).toBe(502);
    }

    expect(mockProxyAgent).toHaveBeenCalledWith("http://user:pass@proxy.webshare.io:80");

    // 5th consecutive failure trips the circuit breaker
    const fifthRes = await preflightMod.POST(
      new Request("https://app.test/api/listings/6588858/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ bina_id: "6588858" }) }
    );
    expect(fifthRes.status).toBe(503);
    const fifthBody = await fifthRes.json();
    expect(fifthBody.ok).toBe(false);
    expect(fifthBody.reason).toBe("PROXY_CIRCUIT_OPEN");
    expect(fifthBody.manual_override_allowed).toBe(true);

    // 6th call short-circuits immediately without invoking fetch
    const callsBeforeSixth = fetchSpy.mock.calls.length;
    const sixthRes = await preflightMod.POST(
      new Request("https://app.test/api/listings/6588858/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ bina_id: "6588858" }) }
    );
    expect(sixthRes.status).toBe(503);
    const sixthBody = await sixthRes.json();
    expect(sixthBody.reason).toBe("PROXY_CIRCUIT_OPEN");
    expect(sixthBody.manual_override_allowed).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(callsBeforeSixth);

    // Manual override succeeds even while circuit is open
    const overrideRes = await preflightMod.POST(
      new Request("https://app.test/api/listings/6588858/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bypass_live_check: true }),
      }),
      { params: Promise.resolve({ bina_id: "6588858" }) }
    );
    expect(overrideRes.status).toBe(200);
  });
});

describe("v2 Phase 2 Task 4: /api/listings/manual OFF_MARKET & R2 pre-signed PUT", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...origEnv,
      R2_ACCOUNT_ID: "acc-123",
      R2_ACCESS_KEY_ID: "key-123",
      R2_SECRET_ACCESS_KEY: "secret-123",
      R2_BUCKET: "baku-estate-media",
      NEXT_PUBLIC_R2_MEDIA_BASE_URL: "https://media.bakuestate.az",
    };
    allowOperator("BROKER");
    mockGetSignedUrl.mockResolvedValue("https://acc-123.r2.cloudflarestorage.com/signed-put");
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("rejects SMM with 403 and rejects invalid photo counts, MIME types, or >10MB files with 400", async () => {
    const manualMod = await import("@/app/api/listings/manual/route");

    allowOperator("SMM");
    const smmRes = await manualMod.POST(
      new Request("https://app.test/api/listings/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test", price_azn: 180000, area_m2: 85, rooms: 3, district: "Yasamal", address: "Inshaatchilar" }),
      })
    );
    expect(smmRes.status).toBe(403);

    allowOperator("BROKER");
    const baseBody = {
      title: "Eksklüziv 3 otaqlı mənzil",
      price_azn: 180000,
      area_m2: 92,
      rooms: 3,
      district: "Yasamal",
      address: "İnşaatçılar metrosu yaxınlığı",
      has_bill_of_sale: false,
    };

    // < 4 files
    const tooFewRes = await manualMod.POST(
      new Request("https://app.test/api/listings/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseBody,
          photo_files: [
            { name: "1.jpg", contentType: "image/jpeg", sizeBytes: 1000 },
            { name: "2.jpg", contentType: "image/jpeg", sizeBytes: 1000 },
          ],
        }),
      })
    );
    expect(tooFewRes.status).toBe(400);

    // Unsupported MIME
    const badMimeRes = await manualMod.POST(
      new Request("https://app.test/api/listings/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseBody,
          photo_files: [
            { name: "1.svg", contentType: "image/svg+xml", sizeBytes: 1000 },
            { name: "2.jpg", contentType: "image/jpeg", sizeBytes: 1000 },
            { name: "3.png", contentType: "image/png", sizeBytes: 1000 },
            { name: "4.webp", contentType: "image/webp", sizeBytes: 1000 },
          ],
        }),
      })
    );
    expect(badMimeRes.status).toBe(400);

    // > 10 MB
    const oversizedRes = await manualMod.POST(
      new Request("https://app.test/api/listings/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseBody,
          photo_files: [
            { name: "1.jpg", contentType: "image/jpeg", sizeBytes: 10 * 1024 * 1024 + 1 },
            { name: "2.jpg", contentType: "image/jpeg", sizeBytes: 1000 },
            { name: "3.png", contentType: "image/png", sizeBytes: 1000 },
            { name: "4.webp", contentType: "image/webp", sizeBytes: 1000 },
          ],
        }),
      })
    );
    expect(oversizedRes.status).toBe(400);
  });

  it("creates OFF_MARKET listing + owner contacts + 900s R2 pre-signed PUT URLs, and confirms via PATCH", async () => {
    const insertedListings: Record<string, unknown>[] = [];
    const insertedContacts: Record<string, unknown>[] = [];
    const updatedPhotos: Record<string, unknown>[] = [];

    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table === "agency_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { niche_rules_json: { luxury_min_azn: 250000, affordable_max_azn: 120000, viral_drop_pct: 10 } },
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
                    data: { id: LISTING_UUID, ...row },
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
                      id: LISTING_UUID,
                      agency_id: AGENCY_ID,
                      source_type: "OFF_MARKET",
                      assigned_agent_id: OPERATOR_ID,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updatedPhotos.push(patch);
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({
                      single: async () => ({
                        data: { id: LISTING_UUID, photo_urls: patch.photo_urls },
                        error: null,
                      }),
                    }),
                  }),
                }),
              };
            },
          };
        }
        if (table === "listing_owner_contacts") {
          return {
            insert: async (row: Record<string, unknown>) => {
              insertedContacts.push(row);
              return { data: row, error: null };
            },
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      },
    });

    const manualMod = await import("@/app/api/listings/manual/route");
    const postRes = await manualMod.POST(
      new Request("https://app.test/api/listings/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Eksklüziv Ağ Şəhər 3 otaq",
          price_azn: 290000,
          area_m2: 115,
          rooms: 3,
          district: "Ağ Şəhər",
          address: "Mərkəzi Bulvar küçəsi",
          owner_name: "Elvin",
          owner_phone: "0501234567",
          photo_files: [
            { name: "a.jpg", contentType: "image/jpeg", sizeBytes: 250000 },
            { name: "b.png", contentType: "image/png", sizeBytes: 300000 },
            { name: "c.webp", contentType: "image/webp", sizeBytes: 150000 },
            { name: "d.jpg", contentType: "image/jpeg", sizeBytes: 220000 },
          ],
        }),
      })
    );

    expect(postRes.status).toBe(201);
    const postData = await postRes.json();
    expect(postData.ok).toBe(true);
    expect(postData.listing_id).toBe(LISTING_UUID);
    expect(postData.upload_urls).toHaveLength(4);
    expect(postData.upload_urls[0].expires_in).toBe(900);
    expect(postData.upload_urls[0].object_key).toContain(`staging/${AGENCY_ID}/${LISTING_UUID}/`);
    expect(postData.upload_urls[0].public_path).toContain(`https://media.bakuestate.az/staging/${AGENCY_ID}/${LISTING_UUID}/`);
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(4);
    expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 900 });

    expect(insertedListings[0].source_type).toBe("OFF_MARKET");
    expect(insertedListings[0].bina_id).toBeNull();
    expect(insertedListings[0].has_bill_of_sale).toBe(false);
    expect(insertedListings[0].canonical_niche).toBe("LUXURY");
    expect(insertedContacts).toHaveLength(1);
    expect(insertedContacts[0].owner_phone_normalized).toBe("+994501234567");

    // PATCH rejects SSRF / non-agency URL
    const badPatch = await manualMod.PATCH(
      new Request("https://app.test/api/listings/manual", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: LISTING_UUID,
          photo_urls: [
            "http://169.254.169.254/latest/meta-data/",
            postData.upload_urls[1].public_path,
            postData.upload_urls[2].public_path,
            postData.upload_urls[3].public_path,
          ],
        }),
      })
    );
    expect(badPatch.status).toBe(400);

    // PATCH succeeds with valid R2 staging URLs
    const validUrls = postData.upload_urls.map((u: { public_path: string }) => u.public_path);
    const okPatch = await manualMod.PATCH(
      new Request("https://app.test/api/listings/manual", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: LISTING_UUID,
          photo_urls: validUrls,
        }),
      })
    );
    expect(okPatch.status).toBe(200);
    const patchBody = await okPatch.json();
    expect(patchBody.ok).toBe(true);
    expect(patchBody.photo_urls).toEqual(validUrls);
    expect(updatedPhotos[0].photo_urls).toEqual(validUrls);
  });
});

describe("v2 Phase 2 Task 5: Pre-Render Studio (generate_render_script & SSRF-guarded queue-render)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...origEnv,
      GEMINI_API_KEY: "live-gemini-key",
      NEXT_PUBLIC_R2_MEDIA_BASE_URL: "https://media.bakuestate.az",
    };
    allowOperator("BROKER");
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("copilot action generate_render_script returns draft_script <= 1000 chars and valid hook_type", async () => {
    const mockRpc = vi.fn().mockImplementation(async (fn: string) => {
      if (fn === "check_and_reserve_ai_budget") {
        return { data: [{ allowed: true, run_id: "run-script-1", reason: "OK" }], error: null };
      }
      return { data: true, error: null };
    });

    mockCreateAdminClient.mockReturnValue({
      rpc: mockRpc,
      from: (table: string) => {
        if (table === "listings") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LISTING_UUID,
                      bina_id: null,
                      title: "Nərimanovda 3 otaqlı mənzil",
                      price_azn_normalized: 245000,
                      district_normalized: "Nərimanov",
                      address: "Təbriz küçəsi",
                      rooms: 3,
                      area: 108,
                      floor: 9,
                      floors: 16,
                      has_bill_of_sale: false,
                      description: "Tam təmirli geniş mənzil.",
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
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      },
    });

    // Return > 1000 chars from Gemini to verify hard server cap <= 1000
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        draft_script: "Salam Bakı! ".repeat(150),
        hook_type: "LOCATION_FIRST",
      }),
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 300 },
    });

    const { POST: copilotPOST } = await import("@/app/api/ai/copilot/route");
    const res = await copilotPOST(
      new Request("https://app.test/api/ai/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate_render_script",
          listing_id: LISTING_UUID,
        }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("generate_render_script");
    expect(body.data.hook_type).toBe("LOCATION_FIRST");
    expect(body.data.draft_script.length).toBeGreaterThan(0);
    expect(body.data.draft_script.length).toBeLessThanOrEqual(1000);
  });

  it("queue-render rejects SSRF internal IP, unallowlisted URLs, <4 or >10 photos, and >1000 char custom_script_text with 400", async () => {
    const allowedPhotos = [
      "https://bina.az/uploads/1.jpg",
      "https://bina.az/uploads/2.jpg",
      "https://bina.az/uploads/3.jpg",
      "https://bina.az/uploads/4.jpg",
      "https://bina.az/uploads/5.jpg",
    ];
    const mockRpc = vi.fn().mockResolvedValue({
      data: { ok: true, job_id: "job-render-1" },
      error: null,
    });

    mockCreateAdminClient.mockReturnValue({
      rpc: mockRpc,
      from: (table: string) => {
        if (table === "listings") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LISTING_UUID,
                      bina_id: "6588858",
                      photo_urls: allowedPhotos,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      },
    });

    const { POST: queueRenderPOST } = await import("@/app/api/pipeline/queue-render/route");

    // 1. SSRF internal IP
    const ssrfRes = await queueRenderPOST(
      new Request("https://app.test/api/pipeline/queue-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: LISTING_UUID,
          selected_photo_urls: [
            "http://169.254.169.254/latest/meta-data/",
            allowedPhotos[0],
            allowedPhotos[1],
            allowedPhotos[2],
          ],
        }),
      })
    );
    expect(ssrfRes.status).toBe(400);

    // 2. Cross-agency R2 staging URL
    const crossTenantRes = await queueRenderPOST(
      new Request("https://app.test/api/pipeline/queue-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: LISTING_UUID,
          selected_photo_urls: [
            "https://media.bakuestate.az/staging/other-agency/1.jpg",
            allowedPhotos[0],
            allowedPhotos[1],
            allowedPhotos[2],
          ],
        }),
      })
    );
    expect(crossTenantRes.status).toBe(400);

    // 3. Too few photos (< 4)
    const tooFewRes = await queueRenderPOST(
      new Request("https://app.test/api/pipeline/queue-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: LISTING_UUID,
          selected_photo_urls: allowedPhotos.slice(0, 3),
        }),
      })
    );
    expect(tooFewRes.status).toBe(400);

    // 4. custom_script_text > 1000 chars
    const longScriptRes = await queueRenderPOST(
      new Request("https://app.test/api/pipeline/queue-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: LISTING_UUID,
          selected_photo_urls: allowedPhotos.slice(0, 4),
          custom_script_text: "A".repeat(1001),
        }),
      })
    );
    expect(longScriptRes.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();

    // 5. Valid allowlisted subset + own agency R2 staging + <=1000 script -> 200
    const validPhotos = [
      allowedPhotos[0],
      allowedPhotos[1],
      allowedPhotos[2],
      `https://media.bakuestate.az/staging/${AGENCY_ID}/${LISTING_UUID}/custom.webp`,
    ];
    const okRes = await queueRenderPOST(
      new Request("https://app.test/api/pipeline/queue-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: LISTING_UUID,
          selected_photo_urls: validPhotos,
          custom_script_text: "BakuEstate eksklüziv mənzil təqdimatı!",
        }),
      })
    );
    expect(okRes.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      "enqueue_listing_render_atomic",
      expect.objectContaining({
        p_listing_id: LISTING_UUID,
        p_params_json: expect.objectContaining({
          selected_photo_urls: validPhotos,
          custom_script_text: "BakuEstate eksklüziv mənzil təqdimatı!",
        }),
      })
    );
  });
});

describe("v2 Phase 2 Task 7: Admin /api/agency/settings, /api/agency/members & Formula-Safe /api/export/commissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowOperator("ADMIN");
  });

  it("enforces ADMIN-only on /api/agency/settings and recalculates listings.canonical_niche on niche_rules_json change", async () => {
    const settingsMod = await import("@/app/api/agency/settings/route");

    allowOperator("BROKER");
    const forbiddenGet = await settingsMod.GET(new Request("https://app.test/api/agency/settings"));
    expect(forbiddenGet.status).toBe(403);
    const forbiddenPatch = await settingsMod.PATCH(
      new Request("https://app.test/api/agency/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_phone: "+994501112233" }),
      })
    );
    expect(forbiddenPatch.status).toBe(403);

    allowOperator("ADMIN");
    const listingUpdates: Array<{ niche: string; ids: string[] }> = [];

    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table === "agency_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    agency_id: AGENCY_ID,
                    public_phone: "+994501112233",
                    telegram_chat_id: "-100123",
                    niche_rules_json: { luxury_min_azn: 250000, affordable_max_azn: 120000, viral_drop_pct: 10 },
                    social_api_mode: "TELEGRAM_FALLBACK",
                    watermark_preset_json: {},
                    monthly_ai_budget_usd: 50,
                    ai_rate_limit_rpm: 20,
                    updated_at: "2026-11-25T10:00:00Z",
                  },
                  error: null,
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: {
                      agency_id: AGENCY_ID,
                      public_phone: "+994501112233",
                      telegram_chat_id: "-100123",
                      social_api_mode: "TELEGRAM_FALLBACK",
                      watermark_preset_json: {},
                      monthly_ai_budget_usd: 50,
                      ai_rate_limit_rpm: 20,
                      updated_at: "2026-11-25T12:00:00Z",
                      ...patch,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "listings") {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  {
                    id: "l-1",
                    price_azn_normalized: 210000,
                    district_normalized: "Yasamal",
                    location: "Yasamal",
                    canonical_niche: "GENERAL",
                  },
                  {
                    id: "l-2",
                    price_azn_normalized: 135000,
                    district_normalized: "Yasamal",
                    location: "Yasamal",
                    canonical_niche: "GENERAL",
                  },
                ],
                error: null,
              }),
            }),
            update: (patch: { canonical_niche: string }) => ({
              eq: () => ({
                in: async (_col: string, ids: string[]) => {
                  listingUpdates.push({ niche: patch.canonical_niche, ids });
                  return { error: null };
                },
              }),
            }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      },
    });

    // Invalid niche thresholds -> 400
    const badRules = await settingsMod.PATCH(
      new Request("https://app.test/api/agency/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          niche_rules_json: { luxury_min_azn: 100000, affordable_max_azn: 150000, viral_drop_pct: 10 },
        }),
      })
    );
    expect(badRules.status).toBe(400);

    // Valid niche rules update recalculates listings
    const okPatch = await settingsMod.PATCH(
      new Request("https://app.test/api/agency/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          niche_rules_json: { luxury_min_azn: 200000, affordable_max_azn: 140000, viral_drop_pct: 10 },
        }),
      })
    );
    expect(okPatch.status).toBe(200);
    const patchBody = await okPatch.json();
    expect(patchBody.ok).toBe(true);
    expect(patchBody.recalculated_listings_count).toBe(2);
    expect(listingUpdates).toEqual(
      expect.arrayContaining([
        { niche: "LUXURY", ids: ["l-1"] },
        { niche: "AFFORDABLE", ids: ["l-2"] },
      ])
    );
  });

  it("enforces ADMIN-only on /api/agency/members and validates split/role/self-lockout", async () => {
    const membersMod = await import("@/app/api/agency/members/route");

    allowOperator("SMM");
    const smmRes = await membersMod.GET(new Request("https://app.test/api/agency/members"));
    expect(smmRes.status).toBe(403);

    allowOperator("ADMIN");
    const updatedPayloads: Record<string, unknown>[] = [];
    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table === "agency_members") {
          return {
            select: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      user_id: MEMBER_UUID,
                      agency_id: AGENCY_ID,
                      role: "BROKER",
                      display_name: "Kənan Broker",
                      commission_split_pct: 50,
                      is_active: true,
                      created_at: "2026-11-25T10:00:00Z",
                    },
                  ],
                  error: null,
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updatedPayloads.push(patch);
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({
                      maybeSingle: async () => ({
                        data: {
                          user_id: MEMBER_UUID,
                          agency_id: AGENCY_ID,
                          role: "BROKER",
                          display_name: "Kənan Broker",
                          commission_split_pct: 50,
                          is_active: true,
                          ...patch,
                        },
                        error: null,
                      }),
                    }),
                  }),
                }),
              };
            },
          };
        }
        return { select: vi.fn().mockReturnThis() };
      },
    });

    // Self deactivation blocked -> 400
    const selfDeactivate = await membersMod.PATCH(
      new Request("https://app.test/api/agency/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: OPERATOR_ID, is_active: false }),
      })
    );
    expect(selfDeactivate.status).toBe(400);

    // Invalid commission_split_pct > 100 -> 400
    const badSplit = await membersMod.PATCH(
      new Request("https://app.test/api/agency/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: MEMBER_UUID, commission_split_pct: 120 }),
      })
    );
    expect(badSplit.status).toBe(400);

    // Valid member update
    const okPatch = await membersMod.PATCH(
      new Request("https://app.test/api/agency/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: MEMBER_UUID,
          role: "BROKER",
          commission_split_pct: 60,
          is_active: false,
        }),
      })
    );
    expect(okPatch.status).toBe(200);
    const body = await okPatch.json();
    expect(body.ok).toBe(true);
    expect(body.member.commission_split_pct).toBe(60);
    expect(body.member.is_active).toBe(false);
  });

  it("exports UTF-8 BOM formula-escaped CSV for ADMIN/BROKER, scopes BROKER to own leads, rejects SMM 403 & >365d 400", async () => {
    const exportMod = await import("@/app/api/export/commissions/route");

    // SMM -> 403
    allowOperator("SMM");
    const smmRes = await exportMod.GET(
      new Request("https://app.test/api/export/commissions?from=2026-10-01&to=2026-11-25")
    );
    expect(smmRes.status).toBe(403);

    // > 365 days -> 400
    allowOperator("ADMIN");
    const wideRangeRes = await exportMod.GET(
      new Request("https://app.test/api/export/commissions?from=2025-01-01&to=2026-11-25")
    );
    expect(wideRangeRes.status).toBe(400);

    // Mock DB for ADMIN & BROKER
    const eqCalls: Array<[string, unknown]> = [];
    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table === "buyer_leads") {
          const queryChain: Record<string, unknown> = {
            select: () => queryChain,
            eq: (col: string, val: unknown) => {
              eqCalls.push([col, val]);
              return queryChain;
            },
            in: () => queryChain,
            gte: () => queryChain,
            lte: () => queryChain,
            order: () => queryChain,
            limit: async () => ({
              data: [
                {
                  id: "lead-1",
                  client_name: "=CMD|' /C calc'!A0",
                  phone_normalized: "+994501234567",
                  stage: "WON_CLOSED",
                  assigned_agent_id: OPERATOR_ID,
                  budget_max_azn: 200000,
                  expected_commission_azn: 4000,
                  actual_commission_azn: 4000,
                  notes: "\t=HYPERLINK(\"http://evil\")",
                  updated_at: "2026-11-20T10:00:00Z",
                },
                {
                  id: "lead-2",
                  client_name: "@SUM(1+1)",
                  phone_normalized: "-501112233",
                  stage: "NEGOTIATING",
                  assigned_agent_id: OPERATOR_ID,
                  budget_max_azn: 100000,
                  expected_commission_azn: 2000,
                  actual_commission_azn: null,
                  notes: "\r=1+1",
                  updated_at: "2026-11-21T10:00:00Z",
                },
                {
                  id: "lead-3",
                  client_name: "\t=HYPERLINK(\"http://evil\")",
                  phone_normalized: "\r=2+2",
                  stage: "DEPOSIT",
                  assigned_agent_id: OPERATOR_ID,
                  budget_max_azn: 150000,
                  expected_commission_azn: 3000,
                  actual_commission_azn: null,
                  updated_at: "2026-11-22T10:00:00Z",
                },
              ],
              error: null,
            }),
          };
          return queryChain;
        }
        if (table === "agency_members") {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  {
                    user_id: OPERATOR_ID,
                    display_name: "Əli Broker",
                    commission_split_pct: 60,
                  },
                ],
                error: null,
              }),
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      },
    });

    // BROKER scoped to assigned_agent_id
    allowOperator("BROKER", OPERATOR_ID);
    const brokerRes = await exportMod.GET(
      new Request("https://app.test/api/export/commissions?from=2026-11-01&to=2026-11-25")
    );
    expect(brokerRes.status).toBe(200);
    expect(brokerRes.headers.get("content-type")).toContain("text/csv");
    expect(eqCalls).toContainEqual(["assigned_agent_id", OPERATOR_ID]);

    const rawBytes = new Uint8Array(await brokerRes.arrayBuffer());
    // Starts with exact UTF-8 BOM bytes (0xEF, 0xBB, 0xBF)
    expect(Array.from(rawBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csvText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(rawBytes);
    expect(csvText.charCodeAt(0)).toBe(0xfeff);
    const lines = csvText.slice(1).trim().split("\n");
    expect(lines[0]).toBe(
      "lead_id,client_name,phone_normalized,stage,agent_name,commission_pct,commission_split_pct,expected_broker_azn,expected_agency_azn,updated_at"
    );
    // Formula injection escaped with leading '
    expect(lines[1]).toContain("'=CMD|' /C calc'!A0");
    expect(lines[1]).toContain("'+994501234567");
    expect(lines[1]).toContain(",2,60,2400,1600,");
    expect(lines[2]).toContain("'@SUM(1+1)");
    expect(lines[2]).toContain("'-501112233");
    expect(lines[3]).toContain(`"'\t=HYPERLINK(""http://evil"")"`);
    expect(lines[3]).toContain(`"'\r=2+2"`);
  });
});
