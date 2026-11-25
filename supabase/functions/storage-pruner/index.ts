// =============================================================================
// BakuEstate-AI: Daily Dual-Path Storage Pruner Edge Function (Supabase / Deno)
// File: supabase/functions/storage-pruner/index.ts
//
// Scheduled daily at 03:00 Asia/Baku (23:00 UTC) via pg_cron:
//   - Fail-closed CRON_SECRET guard (timing-safe comparison)
//   - Calls SQL RPC public.get_prunable_render_versions(p_prune_days,
//     p_active_keep_limit, p_batch_limit)
//   - Dual-path deletion switched on render_versions.storage_provider:
//       * "r2"       -> Deno WebCrypto AWS SigV4 DELETE against Cloudflare R2
//       * "supabase" -> Legacy Supabase Storage bucket remove()
//   - Updates pruned render_versions with storage_pruned_at = NOW() AND
//     video_cdn_url = NULL while preserving DB history
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

interface PruneCandidate {
  id: string;
  agency_id?: string;
  listing_id: string;
  version_num: number;
  storage_object_path: string;
  storage_provider?: string | null;
  prune_reason: string;
}

interface R2Config {
  endpointUrl: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

function toUtf8Bytes(input: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(input);
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toUtf8Bytes(input));
  return toHex(digest);
}

async function hmacSha256(
  keyBytes: Uint8Array<ArrayBuffer>,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, toUtf8Bytes(message));
  return new Uint8Array(sig);
}

function encodeRfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formatAmzTimestamps(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

async function deleteR2ObjectSigV4(
  config: R2Config,
  rawObjectPath: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const cleanPath = rawObjectPath.replace(/^\/+/, "");
  const encodedKey = cleanPath
    .split("/")
    .map((part) => encodeRfc3986(part))
    .join("/");
  const encodedBucket = encodeRfc3986(config.bucket);
  const canonicalUri = `/${encodedBucket}/${encodedKey}`;

  const endpoint = new URL(config.endpointUrl);
  const targetUrl = `${endpoint.origin}${canonicalUri}`;
  const host = endpoint.host;

  const { amzDate, dateStamp } = formatAmzTimestamps(new Date());
  const service = "s3";
  const region = config.region || "auto";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    "DELETE",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    EMPTY_PAYLOAD_SHA256,
  ].join("\n");

  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  const kDate = await hmacSha256(
    toUtf8Bytes(`AWS4${config.secretAccessKey}`),
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signatureBytes = await hmacSha256(kSigning, stringToSign);
  const signature = toHex(signatureBytes.buffer);

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(targetUrl, {
    method: "DELETE",
    headers: {
      Host: host,
      "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
      "x-amz-date": amzDate,
      Authorization: authorization,
    },
  });

  // S3 / R2 DELETE returns 204 No Content (or 200 OK); 404 means already absent
  if (resp.status === 204 || resp.status === 200 || resp.status === 404) {
    return { ok: true, status: resp.status };
  }

  const bodyText = await resp.text().catch(() => "");
  return {
    ok: false,
    status: resp.status,
    error: `HTTP ${resp.status}: ${bodyText.slice(0, 240)}`,
  };
}

function resolveR2Config(): R2Config | null {
  const explicitEndpoint = (Deno.env.get("R2_ENDPOINT_URL") ?? "").trim();
  const accountId = (Deno.env.get("R2_ACCOUNT_ID") ?? "").trim();
  const endpointUrl =
    explicitEndpoint ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  const bucket = (
    Deno.env.get("R2_BUCKET_NAME") ??
    Deno.env.get("R2_BUCKET") ??
    "baku-estate-media"
  ).trim();
  const accessKeyId = (Deno.env.get("R2_ACCESS_KEY_ID") ?? "").trim();
  const secretAccessKey = (Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "").trim();
  const region = (Deno.env.get("R2_REGION") ?? "auto").trim() || "auto";

  if (!endpointUrl || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    endpointUrl,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Mandatory fail-closed cron secret guard
  const expectedCronSecret = (Deno.env.get("CRON_SECRET") ?? "").trim();
  if (!expectedCronSecret) {
    return new Response(
      JSON.stringify({ error: "Server misconfiguration: CRON_SECRET not set" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  const provided = (req.headers.get("x-cron-secret") ?? "").trim();
  if (!provided || !timingSafeEqual(expectedCronSecret, provided)) {
    return new Response(
      JSON.stringify({ error: "Forbidden: invalid cron secret" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const bucket = (Deno.env.get("SUPABASE_BUCKET") ?? "baku-estate-media").trim();
  const pruneDays = Math.max(
    1,
    Number(Deno.env.get("STORAGE_PRUNE_DAYS") ?? "14") || 14,
  );
  const rawActiveKeep = (Deno.env.get("STORAGE_ACTIVE_KEEP_LIMIT") ?? "").trim();
  const parsedActiveKeep = rawActiveKeep !== "" ? Number(rawActiveKeep) : 35;
  const activeKeepLimit =
    Number.isFinite(parsedActiveKeep) && parsedActiveKeep >= 0
      ? Math.floor(parsedActiveKeep)
      : 35;

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: "Missing Supabase credentials" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows, error: queryErr } = await supabase.rpc(
    "get_prunable_render_versions",
    {
      p_prune_days: pruneDays,
      p_active_keep_limit: activeKeepLimit,
      p_batch_limit: 100,
    },
  );

  if (queryErr) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Failed to query get_prunable_render_versions: ${queryErr.message}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const candidates = ((rows ?? []) as unknown as PruneCandidate[]).filter(
    (r) => Boolean(r.storage_object_path?.trim()),
  );

  const pruneReasonCounts: Record<string, number> = {};
  for (const c of candidates) {
    const key = c.prune_reason || "UNKNOWN";
    pruneReasonCounts[key] = (pruneReasonCounts[key] ?? 0) + 1;
  }

  if (candidates.length === 0) {
    return new Response(
      JSON.stringify({
        ok: true,
        bucket,
        prune_days: pruneDays,
        active_keep_limit: activeKeepLimit,
        eligible_count: 0,
        pruned_count: 0,
        pruned_by_provider: { supabase: 0, r2: 0 },
        prune_reasons: pruneReasonCounts,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const nowIso = new Date().toISOString();
  const supabasePrunedIds: string[] = [];
  const r2PrunedIds: string[] = [];
  const errors: string[] = [];

  const supabaseCandidates: PruneCandidate[] = [];
  const r2Candidates: PruneCandidate[] = [];

  for (const candidate of candidates) {
    const provider = (candidate.storage_provider ?? "supabase")
      .trim()
      .toLowerCase();
    if (provider === "r2") {
      r2Candidates.push(candidate);
    } else if (provider === "supabase") {
      supabaseCandidates.push(candidate);
    } else {
      errors.push(
        `unknown_provider[${candidate.id}]: unsupported storage_provider='${provider}'`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Path A: Legacy Supabase Storage deletion ("supabase")
  // ---------------------------------------------------------------------------
  const SUPABASE_CHUNK_SIZE = 50;
  for (let i = 0; i < supabaseCandidates.length; i += SUPABASE_CHUNK_SIZE) {
    const chunk = supabaseCandidates.slice(i, i + SUPABASE_CHUNK_SIZE);
    const paths = chunk.map((c) => c.storage_object_path.replace(/^\/+/, ""));

    const { error: removeErr } = await supabase.storage
      .from(bucket)
      .remove(paths);
    if (removeErr) {
      errors.push(`supabase_remove[${i}]: ${removeErr.message}`);
      continue;
    }

    const ids = chunk.map((c) => c.id);
    const { error: updateErr } = await supabase
      .from("render_versions")
      .update({ storage_pruned_at: nowIso, video_cdn_url: null })
      .in("id", ids);

    if (updateErr) {
      errors.push(`supabase_db_update[${i}]: ${updateErr.message}`);
    } else {
      supabasePrunedIds.push(...ids);
    }
  }

  // ---------------------------------------------------------------------------
  // Path B: Private Cloudflare R2 SigV4 DELETE ("r2")
  // ---------------------------------------------------------------------------
  if (r2Candidates.length > 0) {
    const r2Config = resolveR2Config();
    if (!r2Config) {
      errors.push(
        `r2_config_missing: cannot prune ${r2Candidates.length} r2 candidate(s) without R2_ACCOUNT_ID/R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY`,
      );
    } else {
      const R2_CONCURRENCY = 10;
      const deletedIds: string[] = [];

      for (let i = 0; i < r2Candidates.length; i += R2_CONCURRENCY) {
        const batch = r2Candidates.slice(i, i + R2_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (c) => {
            try {
              const res = await deleteR2ObjectSigV4(
                r2Config,
                c.storage_object_path,
              );
              return { candidate: c, res };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return {
                candidate: c,
                res: { ok: false, status: 0, error: msg },
              };
            }
          }),
        );

        for (const { candidate, res } of results) {
          if (res.ok) {
            deletedIds.push(candidate.id);
          } else {
            errors.push(
              `r2_delete[${candidate.id}]: ${res.error ?? `HTTP ${res.status}`}`,
            );
          }
        }
      }

      const DB_CHUNK_SIZE = 50;
      for (let i = 0; i < deletedIds.length; i += DB_CHUNK_SIZE) {
        const ids = deletedIds.slice(i, i + DB_CHUNK_SIZE);
        const { error: updateErr } = await supabase
          .from("render_versions")
          .update({ storage_pruned_at: nowIso, video_cdn_url: null })
          .in("id", ids);

        if (updateErr) {
          errors.push(`r2_db_update[${i}]: ${updateErr.message}`);
        } else {
          r2PrunedIds.push(...ids);
        }
      }
    }
  }

  const totalPruned = supabasePrunedIds.length + r2PrunedIds.length;

  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      bucket,
      prune_days: pruneDays,
      active_keep_limit: activeKeepLimit,
      eligible_count: candidates.length,
      pruned_count: totalPruned,
      pruned_by_provider: {
        supabase: supabasePrunedIds.length,
        r2: r2PrunedIds.length,
      },
      prune_reasons: pruneReasonCounts,
      errors,
    }),
    {
      status: errors.length === 0 ? 200 : 207,
      headers: { "Content-Type": "application/json" },
    },
  );
});
