// =============================================================================
// BakuEstate-AI: Automated Morning Cockpit Generator (Supabase Edge Function)
// File: supabase/functions/cockpit-generator/index.ts
//
// Scheduled daily at 08:00 Asia/Baku (04:00 UTC) via pg_cron:
//   - Fail-closed CRON_SECRET guard (timing-safe comparison)
//   - Expires prior unactioned PENDING cockpit_cards where expires_at < NOW()
//     (marks them DISMISSED with acted_at = NOW(), complying with v2 CHECK)
//   - Iterates active agencies in bounded batches (<= 20 per invocation)
//   - Reads overdue follow_up_tasks & stale high-value buyer_leads per agency
//   - Reserves & reconciles AI budget via check_and_reserve_ai_budget +
//     reconcile_ai_budget_run (recording usage in ai_copilot_runs &
//     agency_ai_usage_monthly)
//   - Invokes gemini-3.8-flash and writes clean uppercase priority /
//     status='PENDING' / strategic_rationale cards to public.cockpit_cards
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const MAX_AGENCIES_PER_RUN = 20;
const MAX_CARDS_PER_AGENCY = 5;
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const ESTIMATED_RUN_USD = 0.015;
const CARD_TTL_HOURS = 24;

// Pricing per 1M tokens (aligned with web/app/api/ai/copilot/route.ts)
const GEMINI_INPUT_USD_PER_1M = 0.15;
const GEMINI_OUTPUT_USD_PER_1M = 0.6;

type CockpitPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

interface AgencyBatchItem {
  agency_id: string;
  agency_name: string;
  operator_id: string;
}

interface OverdueTaskRow {
  id: string;
  entity_type: string;
  lead_id: string | null;
  listing_id: string | null;
  assigned_agent_id: string | null;
  title: string;
  due_at: string;
  priority: string;
  status: string;
}

interface StaleLeadRow {
  id: string;
  client_name: string;
  stage: string;
  budget_max_azn: number | null;
  expected_commission_azn: number | null;
  phone_normalized: string | null;
  assigned_agent_id: string | null;
  next_followup_at: string | null;
  updated_at: string;
  notes: string | null;
}

interface GeneratedCardCandidate {
  lead_id?: string | null;
  listing_id?: string | null;
  channel?: string | null;
  priority?: string | null;
  headline?: string | null;
  draft_text?: string | null;
  reason?: string | null;
  sentinel_warning?: string | null;
  strategic_rationale?: string | null;
  target_uri?: string | null;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface BudgetReserveRow {
  allowed: boolean;
  run_id: string | null;
  reason: string;
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

function normalizePriority(raw: unknown): CockpitPriority {
  const upper = String(raw ?? "HIGH").trim().toUpperCase();
  if (upper === "URGENT") return "URGENT";
  if (upper === "HIGH") return "HIGH";
  if (upper === "NORMAL") return "NORMAL";
  if (upper === "LOW") return "LOW";
  return "HIGH";
}

function computeActualCostUsd(
  promptTokens: number,
  outputTokens: number,
): number {
  const usd =
    (Math.max(0, promptTokens) / 1_000_000) * GEMINI_INPUT_USD_PER_1M +
    (Math.max(0, outputTokens) / 1_000_000) * GEMINI_OUTPUT_USD_PER_1M;
  return Number(usd.toFixed(6));
}

function extractJsonArray(rawText: string): GeneratedCardCandidate[] | null {
  const trimmed = rawText.trim();
  const tryParse = (candidate: string): GeneratedCardCandidate[] | null => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed as GeneratedCardCandidate[];
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { cards?: unknown }).cards)
      ) {
        return (parsed as { cards: GeneratedCardCandidate[] }).cards;
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) {
    const fromFence = tryParse(fenced[1]);
    if (fromFence) return fromFence;
  }

  const bracketed = trimmed.match(/\[[\s\S]*\]/);
  if (bracketed && bracketed[0]) {
    return tryParse(bracketed[0]);
  }

  return null;
}

function buildStrategistPrompt(
  agencyName: string,
  overdueTasks: OverdueTaskRow[],
  staleLeads: StaleLeadRow[],
): string {
  return [
    `Sən BakuEstate-AI əmlak agentliyi ("${agencyName}") üçün baş satış strategistsən.`,
    `Aşağıdakı gecikmiş tapşırıqları və hərəkətsiz qalmış yüksək dəyərli alıcı leadlərini təhlil et və ən vacib 1-${MAX_CARDS_PER_AGENCY} ədəd gündəlik Cockpit Fəaliyyət Kartı yarat.`,
    ``,
    `QAYDALAR:`,
    `1. Yalnız aşağıdakı siyahıda verilən real lead_id və listing_id dəyərlərindən istifadə et (uyğun deyilsə null yaz).`,
    `2. priority yalnız "URGENT", "HIGH", "NORMAL", "LOW" ola bilər.`,
    `3. channel yalnız "WHATSAPP", "CRM", "TELEGRAM", "CALL" ola bilər.`,
    `4. Hər kartda Azərbaycan dilində qısa və konkret headline, strategic_rationale, reason və lazım olduqda Bakı üslubunda nəzakətli draft_text yaz.`,
    `5. YALNIZ xalis JSON massiv (array) qaytar — əlavə izahat yazma.`,
    ``,
    `GECİKMİŞ TAPŞIRIQLAR:`,
    JSON.stringify(overdueTasks),
    ``,
    `HƏRƏKƏTSİZ YÜKSƏK DƏYƏRLİ LEADLƏR:`,
    JSON.stringify(staleLeads),
    ``,
    `CAVAB FORMATI (JSON array):`,
    `[{"lead_id": null, "listing_id": null, "channel": "WHATSAPP", "priority": "URGENT", "headline": "...", "draft_text": "...", "reason": "...", "sentinel_warning": null, "strategic_rationale": "...", "target_uri": null}]`,
  ].join("\n");
}

async function invokeGeminiCockpit(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{
  ok: boolean;
  cards: GeneratedCardCandidate[];
  promptTokens: number;
  outputTokens: number;
  error?: string;
}> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1600,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return {
      ok: false,
      cards: [],
      promptTokens: 0,
      outputTokens: 0,
      error: `Gemini HTTP ${resp.status}: ${errText.slice(0, 240)}`,
    };
  }

  const payload = (await resp.json()) as GeminiGenerateResponse;
  const promptTokens = Number(payload.usageMetadata?.promptTokenCount ?? 0);
  const outputTokens = Number(payload.usageMetadata?.candidatesTokenCount ?? 0);
  const rawText =
    payload.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("\n")
      .trim() ?? "";

  const parsed = extractJsonArray(rawText);
  if (!parsed) {
    return {
      ok: false,
      cards: [],
      promptTokens,
      outputTokens,
      error: "Gemini returned non-JSON cockpit payload",
    };
  }

  return {
    ok: true,
    cards: parsed.slice(0, MAX_CARDS_PER_AGENCY),
    promptTokens,
    outputTokens,
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
  const geminiApiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const geminiModel =
    (Deno.env.get("GEMINI_COCKPIT_MODEL") ?? DEFAULT_GEMINI_MODEL).trim() ||
    DEFAULT_GEMINI_MODEL;

  if (!supabaseUrl || !serviceRoleKey || !geminiApiKey) {
    return new Response(
      JSON.stringify({
        error: "Missing required secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY)",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Parse optional bounded pagination params (strictly capped <= MAX_AGENCIES_PER_RUN)
  const reqUrl = new URL(req.url);
  let requestedLimit = Number(reqUrl.searchParams.get("limit") ?? MAX_AGENCIES_PER_RUN);
  let requestedOffset = Number(reqUrl.searchParams.get("offset") ?? 0);
  if (req.method === "POST") {
    try {
      const body = (await req.json()) as { limit?: number; offset?: number };
      if (typeof body?.limit === "number") requestedLimit = body.limit;
      if (typeof body?.offset === "number") requestedOffset = body.offset;
    } catch {
      // Empty or non-JSON body is fine for cron trigger
    }
  }
  const batchLimit = Math.min(
    MAX_AGENCIES_PER_RUN,
    Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : MAX_AGENCIES_PER_RUN),
  );
  const batchOffset = Math.max(
    0,
    Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0,
  );

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAtIso = new Date(
    now.getTime() + CARD_TTL_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const staleCutoffIso = new Date(
    now.getTime() - 48 * 60 * 60 * 1000,
  ).toISOString();

  // ---------------------------------------------------------------------------
  // 1. Expire prior unactioned PENDING cards where expires_at < NOW()
  //    (cockpit_cards status CHECK allows PENDING | EXECUTED | DISMISSED | SNOOZED)
  // ---------------------------------------------------------------------------
  let expiredCardsCount = 0;
  const { data: expiredRows, error: expireErr } = await supabase
    .from("cockpit_cards")
    .update({ status: "DISMISSED", acted_at: nowIso })
    .eq("status", "PENDING")
    .lt("expires_at", nowIso)
    .select("id");

  if (expireErr) {
    console.error("Failed to expire stale cockpit cards:", expireErr.message);
  } else {
    expiredCardsCount = (expiredRows ?? []).length;
  }

  // ---------------------------------------------------------------------------
  // 2. Load active agencies in bounded batch (<= 20 per invocation)
  //    Resolve an active ADMIN (or first active member) as budget operator_id
  // ---------------------------------------------------------------------------
  const { data: activeMembers, error: membersErr } = await supabase
    .from("agency_members")
    .select("agency_id, user_id, role, agencies(name)")
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (membersErr) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Failed to query active agencies: ${membersErr.message}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const agencyMap = new Map<string, AgencyBatchItem & { isAdmin: boolean }>();
  for (const row of (activeMembers ?? []) as unknown as Array<{
    agency_id: string;
    user_id: string;
    role: string;
    agencies?: { name?: string } | Array<{ name?: string }> | null;
  }>) {
    const aId = String(row.agency_id ?? "").trim();
    const uId = String(row.user_id ?? "").trim();
    if (!aId || !uId) continue;
    const isAdmin = String(row.role ?? "").toUpperCase() === "ADMIN";
    const agencyName = Array.isArray(row.agencies)
      ? String(row.agencies[0]?.name ?? "BakuEstate")
      : String(row.agencies?.name ?? "BakuEstate");

    const existing = agencyMap.get(aId);
    if (!existing || (!existing.isAdmin && isAdmin)) {
      agencyMap.set(aId, {
        agency_id: aId,
        agency_name: agencyName,
        operator_id: uId,
        isAdmin,
      });
    }
  }

  const allActiveAgencies = Array.from(agencyMap.values()).sort((a, b) =>
    a.agency_id.localeCompare(b.agency_id),
  );
  const batchAgencies = allActiveAgencies.slice(
    batchOffset,
    batchOffset + batchLimit,
  );

  let agenciesProcessed = 0;
  let agenciesSkippedEmpty = 0;
  let agenciesSkippedBudget = 0;
  let cardsCreated = 0;
  const errors: string[] = [];

  for (const agency of batchAgencies) {
    const [tasksRes, leadsRes] = await Promise.all([
      supabase
        .from("follow_up_tasks")
        .select(
          "id, entity_type, lead_id, listing_id, assigned_agent_id, title, due_at, priority, status",
        )
        .eq("agency_id", agency.agency_id)
        .in("status", ["OPEN", "SNOOZED"])
        .lt("due_at", nowIso)
        .order("due_at", { ascending: true })
        .limit(15),
      supabase
        .from("buyer_leads")
        .select(
          "id, client_name, stage, budget_max_azn, expected_commission_azn, phone_normalized, assigned_agent_id, next_followup_at, updated_at, notes",
        )
        .eq("agency_id", agency.agency_id)
        .not("stage", "in", '("WON_CLOSED","LOST","COLD")')
        .lt("updated_at", staleCutoffIso)
        .order("expected_commission_azn", { ascending: false, nullsFirst: false })
        .order("budget_max_azn", { ascending: false, nullsFirst: false })
        .limit(15),
    ]);

    if (tasksRes.error) {
      errors.push(`agency[${agency.agency_id}] tasks: ${tasksRes.error.message}`);
      continue;
    }
    if (leadsRes.error) {
      errors.push(`agency[${agency.agency_id}] leads: ${leadsRes.error.message}`);
      continue;
    }

    const overdueTasks = (tasksRes.data ?? []) as OverdueTaskRow[];
    const staleLeads = (leadsRes.data ?? []) as StaleLeadRow[];

    if (overdueTasks.length === 0 && staleLeads.length === 0) {
      agenciesSkippedEmpty++;
      continue;
    }

    // Reserve AI budget via agency_ai_usage_monthly + ai_copilot_runs RPC
    const { data: reserveData, error: reserveErr } = await supabase.rpc(
      "check_and_reserve_ai_budget",
      {
        p_operator_id: agency.operator_id,
        p_agency_id: agency.agency_id,
        p_estimated_usd: ESTIMATED_RUN_USD,
      },
    );

    if (reserveErr) {
      errors.push(
        `agency[${agency.agency_id}] budget_reserve: ${reserveErr.message}`,
      );
      continue;
    }

    const reserveRow = (
      Array.isArray(reserveData) ? reserveData[0] : reserveData
    ) as BudgetReserveRow | null;

    if (!reserveRow?.allowed || !reserveRow.run_id) {
      agenciesSkippedBudget++;
      continue;
    }

    const runId = reserveRow.run_id;
    const startedMs = Date.now();
    const prompt = buildStrategistPrompt(
      agency.agency_name,
      overdueTasks,
      staleLeads,
    );

    const geminiRes = await invokeGeminiCockpit(
      geminiApiKey,
      geminiModel,
      prompt,
    );
    const latencyMs = Math.max(0, Date.now() - startedMs);
    const actualUsd = computeActualCostUsd(
      geminiRes.promptTokens,
      geminiRes.outputTokens,
    );

    // Tag ai_copilot_runs metadata & reconcile usage in agency_ai_usage_monthly
    await supabase
      .from("ai_copilot_runs")
      .update({
        action: "cockpit_generator",
        model: geminiModel,
        latency_ms: latencyMs,
        metadata: {
          source: "pg_cron",
          overdue_tasks_count: overdueTasks.length,
          stale_leads_count: staleLeads.length,
        },
      })
      .eq("id", runId);

    await supabase.rpc("reconcile_ai_budget_run", {
      p_run_id: runId,
      p_prompt_tokens: geminiRes.promptTokens,
      p_output_tokens: geminiRes.outputTokens,
      p_audio_seconds: 0,
      p_actual_usd: geminiRes.ok ? actualUsd : 0,
      p_status: geminiRes.ok ? "COMPLETED" : "FAILED",
    });

    if (!geminiRes.ok) {
      errors.push(
        `agency[${agency.agency_id}] gemini: ${geminiRes.error ?? "unknown error"}`,
      );
      continue;
    }

    // Build allowlists of real lead_id / listing_id / agent assignments
    const validLeadAgents = new Map<string, string | null>();
    for (const l of staleLeads) {
      validLeadAgents.set(l.id, l.assigned_agent_id);
    }
    const validListingIds = new Set<string>();
    const taskLeadAgents = new Map<string, string | null>();
    for (const t of overdueTasks) {
      if (t.lead_id) {
        validLeadAgents.set(
          t.lead_id,
          validLeadAgents.get(t.lead_id) ?? t.assigned_agent_id,
        );
        taskLeadAgents.set(t.lead_id, t.assigned_agent_id);
      }
      if (t.listing_id) {
        validListingIds.add(t.listing_id);
      }
    }

    const rowsToInsert = geminiRes.cards
      .filter((c) => Boolean(c.headline && String(c.headline).trim()))
      .map((c) => {
        const safeLeadId =
          c.lead_id && validLeadAgents.has(String(c.lead_id))
            ? String(c.lead_id)
            : null;
        const safeListingId =
          c.listing_id && validListingIds.has(String(c.listing_id))
            ? String(c.listing_id)
            : null;
        const assignedAgentId = safeLeadId
          ? validLeadAgents.get(safeLeadId) ?? taskLeadAgents.get(safeLeadId) ?? null
          : null;
        const rationale =
          String(c.strategic_rationale ?? c.reason ?? "").trim() ||
          "Gündəlik AI Cockpit prioritetləndirməsi";

        return {
          agency_id: agency.agency_id,
          lead_id: safeLeadId,
          listing_id: safeListingId,
          channel: String(c.channel ?? "CRM").trim().toUpperCase() || "CRM",
          priority: normalizePriority(c.priority),
          status: "PENDING",
          headline: String(c.headline).trim().slice(0, 240),
          draft_text: c.draft_text ? String(c.draft_text).trim().slice(0, 1500) : null,
          reason: c.reason ? String(c.reason).trim().slice(0, 500) : rationale,
          sentinel_warning: c.sentinel_warning
            ? String(c.sentinel_warning).trim().slice(0, 500)
            : null,
          strategic_rationale: rationale.slice(0, 1000),
          target_uri: c.target_uri ? String(c.target_uri).trim().slice(0, 500) : null,
          assigned_agent_id: assignedAgentId,
          created_by: agency.operator_id,
          expires_at: expiresAtIso,
        };
      });

    if (rowsToInsert.length > 0) {
      const { data: inserted, error: insertErr } = await supabase
        .from("cockpit_cards")
        .insert(rowsToInsert)
        .select("id");

      if (insertErr) {
        errors.push(`agency[${agency.agency_id}] insert: ${insertErr.message}`);
        continue;
      }
      cardsCreated += (inserted ?? []).length;
    }

    agenciesProcessed++;
  }

  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      model: geminiModel,
      expired_cards_count: expiredCardsCount,
      batch_limit: batchLimit,
      batch_offset: batchOffset,
      total_active_agencies: allActiveAgencies.length,
      agencies_in_batch: batchAgencies.length,
      agencies_processed: agenciesProcessed,
      agencies_skipped_empty: agenciesSkippedEmpty,
      agencies_skipped_budget: agenciesSkippedBudget,
      cards_created: cardsCreated,
      has_more_agencies: batchOffset + batchLimit < allActiveAgencies.length,
      errors,
    }),
    {
      status: errors.length === 0 ? 200 : 207,
      headers: { "Content-Type": "application/json" },
    },
  );
});
