// =============================================================================
// BakuEstate-AI: Daily Storage Pruner Edge Function (Supabase / Deno)
// File: supabase/functions/storage-pruner/index.ts
//
// Scheduled daily at 03:00 Asia/Baku (23:00 UTC) via pg_cron:
//   - Protects Supabase Free Plan 1 GB Storage quota
//   - Calls SQL RPC public.get_prunable_render_versions(p_prune_days,
//     p_active_keep_limit, p_batch_limit) to select:
//       (a) Unpruned renders older than STORAGE_PRUNE_DAYS (default 14) that
//           are SUPERSEDED or belong to ARCHIVED / OWNER_SOLD /
//           REMOVED_ON_BINA / CONFIRMED_SOLD listings
//       (b) Active COMPLETED renders ranked beyond STORAGE_ACTIVE_KEEP_LIMIT
//           (default 35) newest (LRU cap protecting 1 GB bucket)
//   - Deletes physical MP4 objects from `baku-estate-media` bucket
//   - Marks storage_pruned_at = NOW() while preserving DB history & local PC files
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

interface PruneCandidate {
  id: string;
  listing_id: string;
  version_num: number;
  storage_object_path: string;
  prune_reason: string;
}

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
    return new Response(JSON.stringify({ error: "Server misconfiguration: CRON_SECRET not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const provided = (req.headers.get("x-cron-secret") ?? "").trim();
  if (!provided || !timingSafeEqual(expectedCronSecret, provided)) {
    return new Response(JSON.stringify({ error: "Forbidden: invalid cron secret" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const bucket = (Deno.env.get("SUPABASE_BUCKET") ?? "baku-estate-media").trim();
  const pruneDays = Math.max(1, Number(Deno.env.get("STORAGE_PRUNE_DAYS") ?? "14") || 14);
  const rawActiveKeep = (Deno.env.get("STORAGE_ACTIVE_KEEP_LIMIT") ?? "").trim();
  const parsedActiveKeep = rawActiveKeep !== "" ? Number(rawActiveKeep) : 35;
  const activeKeepLimit =
    Number.isFinite(parsedActiveKeep) && parsedActiveKeep >= 0
      ? Math.floor(parsedActiveKeep)
      : 35;

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
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
      JSON.stringify({ ok: false, error: `Failed to query get_prunable_render_versions: ${queryErr.message}` }),
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
        prune_reasons: pruneReasonCounts,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const nowIso = new Date().toISOString();
  const prunedIds: string[] = [];
  const errors: string[] = [];
  const CHUNK_SIZE = 50;

  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const paths = chunk.map((c) => c.storage_object_path.replace(/^\/+/, ""));

    const { error: removeErr } = await supabase.storage.from(bucket).remove(paths);
    if (removeErr) {
      errors.push(`chunk[${i}]: ${removeErr.message}`);
      continue;
    }

    const ids = chunk.map((c) => c.id);
    const { error: updateErr } = await supabase
      .from("render_versions")
      .update({ storage_pruned_at: nowIso })
      .in("id", ids);

    if (updateErr) {
      errors.push(`db_update[${i}]: ${updateErr.message}`);
    } else {
      prunedIds.push(...ids);
    }
  }

  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      bucket,
      prune_days: pruneDays,
      active_keep_limit: activeKeepLimit,
      eligible_count: candidates.length,
      pruned_count: prunedIds.length,
      prune_reasons: pruneReasonCounts,
      errors,
    }),
    { status: errors.length === 0 ? 200 : 207, headers: { "Content-Type": "application/json" } },
  );
});
