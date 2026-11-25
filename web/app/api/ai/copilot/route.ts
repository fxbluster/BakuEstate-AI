import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import { GoogleGenAI, createPartFromBase64 } from "@google/genai";
import { buildWhatsAppUrl } from "@/lib/format";
import type {
  CopilotActionPayload,
  CopilotApiResponse,
  SentinelAuditResult,
  ScribeTemplateResult,
  VoiceDebriefResult,
  StrategistCockpitResult,
  AgentPersonaId,
  ActionCardPayload,
  AgentChatMessage,
  AgentChatResult,
} from "@/lib/ai-client";
import type { HookType } from "@/lib/types";

interface GenerateRenderScriptResult {
  draft_script: string;
  hook_type: HookType;
}

type ExtendedCopilotActionPayload =
  | CopilotActionPayload
  | {
      action: "generate_render_script";
      listing_id: string;
      hook_type?: HookType;
      target_account?: string;
    };

const VALID_HOOK_TYPES: HookType[] = [
  "PRICE_FIRST",
  "LOCATION_FIRST",
  "LUXURY_LIFESTYLE",
];
const MAX_RENDER_SCRIPT_CHARS = 1000;
import {
  buildAgentSystemInstruction,
  getAgentPersona,
  resolvePersonaId,
} from "@/lib/agent-personas";

const COPILOT_FAST_MODEL = "gemini-3.1-flash-lite";
const COPILOT_STRONG_MODEL = "gemini-3.8-flash";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_AGENT_IDS = new Set([
  "mudir",
  "analitika",
  "musteri_psixologiyasi",
  "farabi",
  "teymur",
  "usta",
]);

const MODEL_PRICING_PER_1M: Record<
  string,
  { input: number; output: number; audioPerSec: number }
> = {
  "gemini-3.8-flash": { input: 0.15, output: 0.6, audioPerSec: 0.000025 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6, audioPerSec: 0.000025 },
  "gemini-3.1-flash-lite": { input: 0.15, output: 0.6, audioPerSec: 0.000025 },
};

function computeActualCostUsd(
  model: string,
  promptTokens: number,
  outputTokens: number,
  audioSeconds: number
): number {
  const rate = MODEL_PRICING_PER_1M[model] ?? MODEL_PRICING_PER_1M[COPILOT_STRONG_MODEL];
  const usd =
    (Math.max(0, promptTokens) / 1_000_000) * rate.input +
    (Math.max(0, outputTokens) / 1_000_000) * rate.output +
    Math.max(0, audioSeconds) * rate.audioPerSec;
  return Number(usd.toFixed(6));
}

function extractJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw);
  } catch {
    const jsonMatch =
      raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
      raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function estimateAudioSeconds(base64Audio: string): number {
  if (!base64Audio) return 0;
  const approxBytes = Math.floor((base64Audio.length * 3) / 4);
  // Approximate compressed speech (~16 kbps = 2000 bytes/s), clamped >= 1s
  return Math.max(1, Math.round(approxBytes / 2000));
}

async function isBudgetDowngradeActive(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  agencyId: string
): Promise<boolean> {
  try {
    const nowBaku = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const monthBaku = `${nowBaku.getUTCFullYear()}-${String(
      nowBaku.getUTCMonth() + 1
    ).padStart(2, "0")}`;

    const [{ data: usage }, { data: settings }] = await Promise.all([
      supabaseAdmin
        .from("agency_ai_usage_monthly")
        .select("spent_usd, reserved_usd")
        .eq("agency_id", agencyId)
        .eq("month_baku", monthBaku)
        .maybeSingle(),
      supabaseAdmin
        .from("agency_settings")
        .select("monthly_ai_budget_usd")
        .eq("agency_id", agencyId)
        .maybeSingle(),
    ]);

    const budgetCap = Number(settings?.monthly_ai_budget_usd ?? 50.0);
    const used = Number(usage?.spent_usd ?? 0) + Number(usage?.reserved_usd ?? 0);
    return budgetCap > 0 && used >= budgetCap * 0.8;
  } catch {
    return false;
  }
}

async function reconcileBudgetRunSafe(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  params: {
    runId: string;
    promptTokens: number;
    outputTokens: number;
    audioSeconds: number;
    actualUsd: number;
    status: "COMPLETED" | "FAILED";
  }
) {
  try {
    await supabaseAdmin.rpc("reconcile_ai_budget_run", {
      p_run_id: params.runId,
      p_prompt_tokens: params.promptTokens,
      p_output_tokens: params.outputTokens,
      p_audio_seconds: params.audioSeconds,
      p_actual_usd: params.actualUsd,
      p_status: params.status,
    });
  } catch (e) {
    console.warn("[COPILOT RECONCILE] Failed to reconcile budget run:", e);
  }
}

function mapMessageRow(row: Record<string, unknown>): AgentChatMessage {
  const actionPayload =
    row.action_payload &&
    typeof row.action_payload === "object" &&
    Object.keys(row.action_payload as Record<string, unknown>).length > 0
      ? (row.action_payload as ActionCardPayload)
      : null;

  return {
    id: String(row.id),
    sender_type: (row.sender_type as AgentChatMessage["sender_type"]) || "AGENT",
    sender_name: String(row.sender_name || "Agent"),
    content: String(row.content || ""),
    action_payload: actionPayload,
    created_at: String(row.created_at || new Date().toISOString()),
  };
}

export async function POST(request: Request) {
  const runId = crypto.randomUUID();

  // 1. Authenticate & check active agency_members row
  const auth = await requireOperator(request);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  // 2. Parse request body
  let payload: ExtendedCopilotActionPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "Sorğu gövdəsi etibarlı JSON deyil.",
        code: "UPSTREAM_ERROR",
        fallback_available: false,
      } as CopilotApiResponse,
      {
        status: 400,
        headers: { "X-BakuEstate-Run-Id": runId },
      }
    );
  }

  const supabaseAdmin = createAdminClient();

  // 3. Fast-path data actions (no LLM tokens reserved or consumed)
  if (payload.action === "get_conversation") {
    try {
      const canonicalAgent = resolvePersonaId(payload.agent_id);
      const agentFilter = VALID_AGENT_IDS.has(String(payload.agent_id))
        ? Array.from(new Set([String(payload.agent_id), canonicalAgent]))
        : [canonicalAgent];

      const { data: conv } = await supabaseAdmin
        .from("agent_conversations")
        .select("id, room_type, title, updated_at")
        .eq("operator_id", operator.operatorId)
        .eq("agency_id", operator.agencyId)
        .in("agent_id", agentFilter)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      let messages: AgentChatMessage[] = [];
      if (conv?.id) {
        const { data: msgRows } = await supabaseAdmin
          .from("agent_messages")
          .select("id, sender_type, sender_name, content, action_payload, seq_num, created_at")
          .eq("conversation_id", conv.id)
          .eq("agency_id", operator.agencyId)
          .order("created_at", { ascending: true })
          .order("seq_num", { ascending: true });

        if (Array.isArray(msgRows)) {
          messages = msgRows.map((r) => mapMessageRow(r as Record<string, unknown>));
        }
      }

      return NextResponse.json(
        {
          ok: true,
          action: "get_conversation",
          model_served: "supabase",
          run_id: runId,
          data: {
            conversation_id: conv?.id || null,
            messages,
          },
        },
        {
          headers: {
            "X-BakuEstate-Model-Served": "supabase",
            "X-BakuEstate-Run-Id": runId,
          },
        }
      );
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: "Söhbət tarixçəsi oxuna bilmədi.",
          code: "UPSTREAM_ERROR",
          fallback_available: false,
        } as CopilotApiResponse,
        { status: 500 }
      );
    }
  }

  if (payload.action === "reset_conversation") {
    try {
      const canonicalAgent = resolvePersonaId(payload.agent_id);
      const agentFilter = VALID_AGENT_IDS.has(String(payload.agent_id))
        ? Array.from(new Set([String(payload.agent_id), canonicalAgent]))
        : [canonicalAgent];

      await supabaseAdmin
        .from("agent_conversations")
        .delete()
        .eq("operator_id", operator.operatorId)
        .eq("agency_id", operator.agencyId)
        .in("agent_id", agentFilter);

      return NextResponse.json(
        {
          ok: true,
          action: "reset_conversation",
          model_served: "supabase",
          run_id: runId,
          data: {
            reset: true,
            agent_id: payload.agent_id,
          },
        },
        {
          headers: {
            "X-BakuEstate-Model-Served": "supabase",
            "X-BakuEstate-Run-Id": runId,
          },
        }
      );
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: "Söhbət sıfırlana bilmədi.",
          code: "UPSTREAM_ERROR",
          fallback_available: false,
        } as CopilotApiResponse,
        { status: 500 }
      );
    }
  }

  if (payload.action === "save_insight") {
    try {
      const canonicalAgent = resolvePersonaId(
        payload.agent_id || "musteri_psixologiyasi"
      );
      let scope = payload.persona_scope;
      if (!scope) {
        if (canonicalAgent === "musteri_psixologiyasi") scope = "crm";
        else if (canonicalAgent === "analitika") scope = "analytics";
        else scope = "general";
      }

      const { data: newInsight, error: insertErr } = await supabaseAdmin
        .from("agent_learned_insights")
        .insert({
          operator_id: operator.operatorId,
          agency_id: operator.agencyId,
          agent_id: canonicalAgent,
          persona_scope: scope,
          domain: payload.domain || "OBJECTION_PRICE_PER_M2",
          insight_text: payload.insight_text,
          confidence_score: payload.confidence_score ?? 0.85,
        })
        .select("id, agent_id, domain, insight_text, persona_scope, created_at")
        .single();

      if (insertErr) {
        throw insertErr;
      }

      return NextResponse.json(
        {
          ok: true,
          action: "save_insight",
          model_served: "supabase-admin",
          run_id: runId,
          data: newInsight,
        },
        {
          headers: {
            "X-BakuEstate-Model-Served": "supabase-admin",
            "X-BakuEstate-Run-Id": runId,
          },
        }
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        {
          ok: false,
          error: msg || "Dərslik qeydi saxlanıla bilmədi.",
          code: "UPSTREAM_ERROR",
          fallback_available: false,
        } as CopilotApiResponse,
        { status: 500 }
      );
    }
  }

  if (payload.action === "generate_render_script") {
    if (!payload.listing_id || typeof payload.listing_id !== "string") {
      return NextResponse.json(
        {
          ok: false,
          error: "generate_render_script üçün listing_id tələb olunur.",
          code: "UPSTREAM_ERROR",
          fallback_available: false,
        } as CopilotApiResponse,
        { status: 400, headers: { "X-BakuEstate-Run-Id": runId } }
      );
    }
  }

  // 4. Fail-closed serialized budget & rate limit reservation RPC
  const { data: budgetRaw, error: budgetErr } = await supabaseAdmin.rpc(
    "check_and_reserve_ai_budget",
    {
      p_operator_id: operator.operatorId,
      p_agency_id: operator.agencyId,
      p_estimated_usd: 0.015,
    }
  );
  const budgetRow = Array.isArray(budgetRaw) ? budgetRaw[0] : budgetRaw;

  if (budgetErr || !budgetRow) {
    return NextResponse.json(
      {
        ok: false,
        error: "AI büdcə və sorğu limiti yoxlanıla bilmədi (fail-closed).",
        code: "UPSTREAM_UNAVAILABLE",
        fallback_available: false,
      } as CopilotApiResponse,
      { status: 503, headers: { "X-BakuEstate-Run-Id": runId } }
    );
  }

  if (budgetRow.allowed !== true) {
    const reason = String(budgetRow.reason || "BUDGET_EXCEEDED");
    const isRateLimit = reason.toUpperCase().includes("RATE");
    return NextResponse.json(
      {
        ok: false,
        error: isRateLimit
          ? "Dəqiqəlik AI sorğu limiti aşıldı."
          : "Agentliyin aylıq AI büdcə limiti aşıldı.",
        code: isRateLimit ? "RATE_LIMITED" : "BUDGET_EXCEEDED",
        fallback_available: false,
      } as CopilotApiResponse,
      { status: 429, headers: { "X-BakuEstate-Run-Id": runId } }
    );
  }

  const budgetRunId = String(budgetRow.run_id || runId);

  // 5. Dynamic Model Routing
  const isBudgetDowngrade = await isBudgetDowngradeActive(
    supabaseAdmin,
    operator.agencyId
  );

  let targetModel = COPILOT_FAST_MODEL;
  if (payload.action === "agent_chat") {
    if (payload.agent_id === "teymur" || isBudgetDowngrade) {
      targetModel = COPILOT_FAST_MODEL;
    } else {
      targetModel = COPILOT_STRONG_MODEL;
    }
  } else {
    const isStrong =
      payload.action === "sentinel_audit" ||
      payload.action === "voice_debrief" ||
      payload.action === "strategist_cockpit";
    targetModel =
      isStrong && !isBudgetDowngrade ? COPILOT_STRONG_MODEL : COPILOT_FAST_MODEL;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const hasLiveApiKey = Boolean(
    apiKey && !apiKey.startsWith("dummy") && apiKey !== "test"
  );

  if (!hasLiveApiKey) {
    await reconcileBudgetRunSafe(supabaseAdmin, {
      runId: budgetRunId,
      promptTokens: 0,
      outputTokens: 0,
      audioSeconds: 0,
      actualUsd: 0,
      status: "FAILED",
    });

    return NextResponse.json(
      {
        ok: false,
        error:
          "AI xidməti hazırda əlçatan deyil (GEMINI_API_KEY konfiqurasiya edilməyib).",
        code: "UPSTREAM_UNAVAILABLE",
        fallback_available: false,
      } as CopilotApiResponse,
      {
        status: 503,
        headers: {
          "X-BakuEstate-Fallback-Triggered": "false",
          "X-BakuEstate-Run-Id": budgetRunId,
        },
      }
    );
  }

  let promptTokens = 0;
  let outputTokens = 0;
  let audioSeconds = 0;
  let resultData:
    | SentinelAuditResult
    | ScribeTemplateResult
    | VoiceDebriefResult
    | StrategistCockpitResult
    | AgentChatResult
    | GenerateRenderScriptResult
    | null = null;

  try {
    const ai = new GoogleGenAI({ apiKey });

    if (payload.action === "generate_render_script") {
      let listingQuery = supabaseAdmin
        .from("listings")
        .select(
          "id, bina_id, title, price, price_azn_normalized, district_normalized, location, address, rooms, area, floor, floors, has_bill_of_sale, description"
        )
        .eq("agency_id", operator.agencyId);

      if (UUID_REGEX.test(payload.listing_id)) {
        listingQuery = listingQuery.eq("id", payload.listing_id);
      } else {
        listingQuery = listingQuery.eq("bina_id", String(payload.listing_id));
      }

      const { data: listing } = await listingQuery.maybeSingle();
      if (!listing) {
        await reconcileBudgetRunSafe(supabaseAdmin, {
          runId: budgetRunId,
          promptTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          actualUsd: 0,
          status: "FAILED",
        });

        return NextResponse.json(
          {
            ok: false,
            error: "Elan tapılmadı və ya bu agentliyə aid deyil.",
            code: "UPSTREAM_ERROR",
            fallback_available: false,
          } as CopilotApiResponse,
          { status: 404, headers: { "X-BakuEstate-Run-Id": budgetRunId } }
        );
      }

      const priceAzn = Number(listing.price_azn_normalized ?? listing.price ?? 0);
      const preferredHook: HookType =
        payload.hook_type && VALID_HOOK_TYPES.includes(payload.hook_type)
          ? payload.hook_type
          : priceAzn >= 250_000
          ? "LUXURY_LIFESTYLE"
          : "PRICE_FIRST";

      const kupcaRule = listing.has_bill_of_sale
        ? "Kupça (Dövlət Çıxarışı) VAR — qeyd edə bilərsən."
        : "Kupça qeyd edilməyib — QƏTİYYƏN 'Kupçalı' və ya 'Çıxarışlı' ifadəsini işlətmə!";

      const promptText = `
Sən BakuEstate-AI agentliyinin peşəkar şaquli video (Reels/TikTok) ssenari müəllifisən.
Məqsəd: Aşağıdakı əmlak üçün 25–40 saniyəlik, yüksək saxlanma (retention) və satış konversiyalı Azərbaycan dilində səsləndirmə ssenarisi yazmaq.

Əmlak məlumatları:
- Başlıq: ${listing.title || "Mənzil"}
- Qiymət: ${priceAzn} AZN
- Rayon / Ünvan: ${listing.district_normalized || listing.location || "Bakı"}, ${listing.address || ""}
- Otaq / Sahə: ${listing.rooms || "—"} otaq, ${listing.area || "—"} m²
- Mərtəbə: ${listing.floor || "—"}/${listing.floors || "—"}
- Sənəd qaydası: ${kupcaRule}
- Təsvir: ${String(listing.description || "").slice(0, 400)}
- Hədəf hesab: ${payload.target_account || "@bakuestate.official"}
- Tövsiyə olunan hook növü: ${preferredHook}

QAYDALAR:
1. Ssenari səlis, enerjili Bakı Azərbaycan dilində yalnız danışıq mətni olsun (səhnə göstərişi, mötərizə və emoji yazma).
2. Dəqiq bina/mənzil nömrəsini açıqlama.
3. Mətn MÜTLƏQ maksimum ${MAX_RENDER_SCRIPT_CHARS} simvol daxilində olmalıdır.
4. Çıxış yalnız təmiz JSON formatında olmalıdır:
{
  "draft_script": "səsləndirmə mətni (<= ${MAX_RENDER_SCRIPT_CHARS} simvol)",
  "hook_type": "PRICE_FIRST" | "LOCATION_FIRST" | "LUXURY_LIFESTYLE"
}
`;

      const response = await ai.models.generateContent({
        model: COPILOT_FAST_MODEL,
        contents: [{ text: promptText }],
        config: {
          responseMimeType: "application/json",
        },
      });

      promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      const parsed = extractJson<{ draft_script?: string; hook_type?: string }>(
        response.text || ""
      );
      const rawScript =
        typeof parsed?.draft_script === "string"
          ? parsed.draft_script.trim()
          : "";
      if (!rawScript) {
        throw new Error("Invalid model response for generate_render_script");
      }

      const resolvedHook: HookType =
        parsed?.hook_type &&
        VALID_HOOK_TYPES.includes(parsed.hook_type as HookType)
          ? (parsed.hook_type as HookType)
          : preferredHook;

      resultData = {
        draft_script: rawScript.slice(0, MAX_RENDER_SCRIPT_CHARS),
        hook_type: resolvedHook,
      };
    } else if (payload.action === "scribe_response") {
      let listingInfo = "";
      let binaId = payload.listing_id || "";
      let ownerPhone = "";

      if (payload.listing_id) {
        let listingQuery = supabaseAdmin
          .from("listings")
          .select(
            "id, bina_id, location, address, price, price_azn_normalized, rooms, area"
          )
          .eq("agency_id", operator.agencyId);

        if (UUID_REGEX.test(payload.listing_id)) {
          listingQuery = listingQuery.eq("id", payload.listing_id);
        } else {
          listingQuery = listingQuery.eq("bina_id", String(payload.listing_id));
        }

        const { data: listing } = await listingQuery.maybeSingle();

        if (listing) {
          binaId = listing.bina_id || binaId;
          listingInfo = `Elan: #${listing.bina_id || listing.id}, Ünvan: ${
            listing.location || listing.address || "Bakı"
          }, Qiymət: ${listing.price_azn_normalized || listing.price} AZN, Otaq: ${
            listing.rooms || "—"
          }`;

          if (operator.role !== "SMM") {
            const { data: ownerContact } = await supabaseAdmin
              .from("listing_owner_contacts")
              .select("owner_phone_raw, owner_phone_normalized")
              .eq("listing_id", listing.id)
              .eq("agency_id", operator.agencyId)
              .maybeSingle();

            ownerPhone =
              ownerContact?.owner_phone_raw ||
              ownerContact?.owner_phone_normalized ||
              "";
          }
        }
      }

      const promptText = `
Sən Bakı Əmlak (BakuEstate) agentliyinin Scribe persona-sısan.
Məqsəd: Müştəri və ya mülkiyyətçi sorğusuna nəzakətli, peşəkar və yüksək konversiyalı Bakı ləhcəsində Azərbaycan dilində WhatsApp cavabı hazırlamaq.
Qaydalar:
1. Nəzakətli, səmimi Bakı dialektində yaz ("Salam", "baxış təyin edək", "ətraflı məlumat").
2. Əsla dəqiq bina və ya mənzil nömrəsini açıqlama (yalnız rayon/metro oriyentirini saxla).
3. Mütləq elan kodunu ("kod:${binaId || "bakuestate"}") daxil et.
4. Çıxış mütləq təmiz JSON formatında olmalıdır.

Əlavə kontekst: ${listingInfo || "Ümumi əmlak sorğusu"}
Gələn sorğu/qeyd: "${payload.prompt}"

Çıxış JSON şablonu:
{
  "headline": "WhatsApp İsmarış Qaralaması",
  "draft_text": "yazılan mesaj",
  "listing_code": "kod:${binaId || "bakuestate"}"
}
`;

      const response = await ai.models.generateContent({
        model: COPILOT_FAST_MODEL,
        contents: [{ text: promptText }],
        config: {
          responseMimeType: "application/json",
        },
      });

      promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      const parsed = extractJson<ScribeTemplateResult>(response.text || "");
      if (!parsed?.draft_text) {
        throw new Error("Model invalid JSON response");
      }

      const waLink = ownerPhone
        ? buildWhatsAppUrl(ownerPhone, parsed.draft_text) || ""
        : "";
      resultData = {
        headline: parsed.headline || "WhatsApp İsmarış Qaralaması",
        draft_text: parsed.draft_text,
        wa_link: waLink,
        listing_code: parsed.listing_code || `kod:${binaId || "bakuestate"}`,
      };
    } else if (payload.action === "sentinel_audit") {
      const promptText = `
Sən Bakı Əmlak (BakuEstate) agentliyinin Sentinel təhlükəsizlik və komissiya qoruyucususən.
Məqsəd:
1. Dəqiq ünvan sızmasını yoxla: bina nömrəsi, mənzil nömrəsi, blok, küçə nömrəsi (məs: "bina 45", "ev 12", "mənzil 7", "Təbriz küçəsi 45"). Əgər varsa, has_leak: true, leaked_tokens siyahısı və sanitized_text daxilində həmin detalları "[DƏQİQ ÜNVAN GİZLƏDİLDİ - BAXIŞDA VERİLƏCƏK]" ilə əvəzlə.
2. Komissiya endirimi təzyiqini yoxla: müştəri 50-100 AZN komissiyanı azaltmaq və ya ödəməmək istəyirsə ("50 azn endirim", "komissiya yoxdur"), standart komissiya müdafiə arqumentini (commission_defense_rebuttal) Bakı ləhcəsində hazırla.

Yoxlanılacaq mətn: "${payload.text}"

Çıxış JSON şablonu:
{
  "has_leak": boolean,
  "leaked_tokens": ["token1"],
  "sanitized_text": "təmizlənmiş mətn",
  "sentinel_warning": "xəbərdarlıq və ya null",
  "commission_defense_rebuttal": "müdafiə mətni və ya null"
}
`;

      const response = await ai.models.generateContent({
        model: COPILOT_STRONG_MODEL,
        contents: [{ text: promptText }],
        config: {
          responseMimeType: "application/json",
          generationConfig: { thinkingLevel: "low" },
          thinkingConfig: { thinkingLevel: "low" },
        } as unknown as Record<string, unknown>,
      });

      promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      const parsed = extractJson<SentinelAuditResult>(response.text || "");
      if (!parsed) {
        throw new Error("Model invalid JSON response");
      }
      resultData = parsed;
    } else if (payload.action === "voice_debrief") {
      audioSeconds = estimateAudioSeconds(payload.audio_base64);
      const audioPart = createPartFromBase64(
        payload.audio_base64,
        payload.mime_type
      );

      const promptText = `
Sən Bakı Əmlak (BakuEstate) agentliyinin Janitor və Səs Debrief analitikisən.
Səs yazısını dinlə (Azərbaycan dilində real əmlak baxışından sonra brokerin səs qeydidir):
1. Səs yazısını verbatim Azərbaycan dilində transkripsiya et (transcript_az).
2. Sövdələşmə mərhələsini müəyyən et (extracted_stage): 'OFFER', 'SHOWING_SCHEDULED', 'QUALIFIED', 'NEGOTIATING', 'DEAL_LOST', 'VIEWED'.
3. Müştərinin təklif etdiyi büdcə/qiyməti AZN ilə çıxar (extracted_offer_azn: ədəd və ya null).
4. İtirazları çıxar (extracted_objections: sətirlər massivi).
5. Broker üçün dərhal icra olunacaq növbəti addımı tərtib et (next_action).

Çıxış JSON şablonu:
{
  "transcript_az": "...",
  "extracted_stage": "OFFER",
  "extracted_offer_azn": 175000,
  "extracted_objections": ["mətbəx mebeli"],
  "next_action": "..."
}
`;

      const response = await ai.models.generateContent({
        model: COPILOT_STRONG_MODEL,
        contents: [audioPart, { text: promptText }],
        config: {
          responseMimeType: "application/json",
          generationConfig: { thinkingLevel: "low" },
          thinkingConfig: { thinkingLevel: "low" },
        } as unknown as Record<string, unknown>,
      });

      promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      const parsed = extractJson<VoiceDebriefResult>(response.text || "");
      if (!parsed?.transcript_az) {
        throw new Error("Voice debrief invalid JSON response");
      }
      resultData = parsed;
    } else if (payload.action === "strategist_cockpit") {
      let leadsQuery = supabaseAdmin
        .from("buyer_leads")
        .select(
          "id, client_name, phone_normalized, stage, budget_max_azn, preferred_districts, notes"
        )
        .eq("agency_id", operator.agencyId)
        .order("created_at", { ascending: false })
        .limit(payload.limit || 10);

      if (operator.role === "BROKER") {
        leadsQuery = leadsQuery.eq("assigned_agent_id", operator.operatorId);
      }

      const { data: leads } = await leadsQuery;

      const promptText = `
Sən Bakı Əmlak (BakuEstate) Strategist personasısan.
Məqsəd: Cari müştəri bazasından ən vacib və təcili Günün Top 5 Fürsət kartını seçmək və prioritetləşdirmək.
Baza müştəriləri: ${JSON.stringify(leads || [])}

Qaydalar:
Hər kart üçün:
- headline: konkret başlıq
- channel: "WHATSAPP" və ya "CALL"
- priority: "URGENT" | "HIGH" | "NORMAL"
- draft_text: Bakı ləhcəsində hazır ismarış
- reason: strateji əsaslandırma
- status: "PENDING"

Çıxış JSON şablonu:
{
  "briefing_title": "🌅 10:00 AM Operator Cockpit: Günün Top 5 Əsas Fürsəti",
  "total_candidates": ${(leads || []).length},
  "top_cards": [],
  "executive_summary": "Qısa xülasə"
}
`;

      const response = await ai.models.generateContent({
        model: COPILOT_STRONG_MODEL,
        contents: [{ text: promptText }],
        config: {
          responseMimeType: "application/json",
          generationConfig: { thinkingLevel: "low" },
          thinkingConfig: { thinkingLevel: "low" },
        } as unknown as Record<string, unknown>,
      });

      promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      const parsed = extractJson<StrategistCockpitResult>(response.text || "");
      if (!parsed?.top_cards) {
        throw new Error("Strategist cockpit invalid JSON");
      }
      resultData = parsed;
    } else if (payload.action === "agent_chat") {
      let conversationId = payload.conversation_id;
      let existingMessages: AgentChatMessage[] = [];
      const canonicalAgent = resolvePersonaId(payload.agent_id);
      const roomType = canonicalAgent === "mudir" ? "OMNI" : "SPECIALIST";

      const title = payload.context?.initial_text
        ? payload.context.initial_text.slice(0, 40)
        : payload.message.slice(0, 40) || "Yeni Söhbət";

      if (conversationId && UUID_REGEX.test(conversationId)) {
        const { data: conv } = await supabaseAdmin
          .from("agent_conversations")
          .select("id")
          .eq("id", conversationId)
          .eq("operator_id", operator.operatorId)
          .eq("agency_id", operator.agencyId)
          .maybeSingle();

        if (!conv) {
          await supabaseAdmin.from("agent_conversations").insert({
            id: conversationId,
            agency_id: operator.agencyId,
            operator_id: operator.operatorId,
            agent_id: canonicalAgent,
            room_type: roomType,
            title,
          });
        }
      } else {
        const { data: newConv } = await supabaseAdmin
          .from("agent_conversations")
          .insert({
            agency_id: operator.agencyId,
            operator_id: operator.operatorId,
            agent_id: canonicalAgent,
            room_type: roomType,
            title,
          })
          .select("id")
          .maybeSingle();

        conversationId = newConv?.id || crypto.randomUUID();
      }

      // Read append-only agent_messages ordered by (created_at ASC, seq_num ASC)
      try {
        const { data: msgRows } = await supabaseAdmin
          .from("agent_messages")
          .select("id, sender_type, sender_name, content, action_payload, seq_num, created_at")
          .eq("conversation_id", conversationId)
          .eq("agency_id", operator.agencyId)
          .order("created_at", { ascending: true })
          .order("seq_num", { ascending: true });

        if (Array.isArray(msgRows)) {
          existingMessages = msgRows.map((r) =>
            mapMessageRow(r as Record<string, unknown>)
          );
        }
      } catch (e) {
        console.warn("[COPILOT AGENT CHAT] Error loading agent_messages:", e);
      }

      const historyWindow = existingMessages.slice(-8);

      // Load domain insights safely without .or(...) string interpolation
      let domainInsights: string[] = [];
      try {
        const scope =
          canonicalAgent === "musteri_psixologiyasi"
            ? "crm"
            : canonicalAgent === "analitika"
            ? "analytics"
            : "general";

        const { data: insights } = await supabaseAdmin
          .from("agent_learned_insights")
          .select("domain, insight_text")
          .eq("agency_id", operator.agencyId)
          .eq("persona_scope", scope)
          .order("created_at", { ascending: false })
          .limit(3);

        if (insights && insights.length > 0) {
          domainInsights = insights.map(
            (i) => `[${i.domain}]: ${i.insight_text}`
          );
        }
      } catch (e) {
        console.warn("[COPILOT AGENT CHAT] Error loading domain insights:", e);
      }

      // Load active portfolio listings scoped by agency_id
      let activePortfolioSummary = "";
      try {
        const { data: activeListings } = await supabaseAdmin
          .from("listings")
          .select(
            "id, bina_id, title, price_azn_normalized, district_normalized, location, area, rooms, has_bill_of_sale, editorial_status, pipeline_status"
          )
          .eq("agency_id", operator.agencyId)
          .eq("source_availability", "ACTIVE")
          .order("first_seen_at", { ascending: false })
          .limit(8);

        if (activeListings && activeListings.length > 0) {
          activePortfolioSummary = activeListings
            .map(
              (l) =>
                `- #${l.bina_id || l.id} (id:${l.id}): ${l.title || "Mənzil"}, ${Number(
                  l.price_azn_normalized || 0
                ).toLocaleString("az-AZ")} AZN (${
                  l.district_normalized || l.location || "Bakı"
                }), Sahə: ${l.area || "-"} m², Otaq: ${
                  l.rooms || "-"
                }, Kupça: ${l.has_bill_of_sale ? "Var" : "Yoxdur"}, Status: ${
                  l.editorial_status || l.pipeline_status
                }`
            )
            .join("\n");
        }
      } catch (e) {
        console.warn("[COPILOT AGENT CHAT] Error loading portfolio listings:", e);
      }

      const systemInstruction = buildAgentSystemInstruction(canonicalAgent, {
        learnedInsights: domainInsights,
        operatorContext: payload.context
          ? `lead_id: ${payload.context.lead_id || "yoxdur"}, listing_id: ${
              payload.context.listing_id || "yoxdur"
            }, initial_text: ${payload.context.initial_text || "yoxdur"}`
          : undefined,
        activePortfolioContext: activePortfolioSummary || undefined,
      });

      const promptText = `
${systemInstruction}

Tarixçə (Son ${historyWindow.length} ismarış):
${historyWindow
  .map(
    (m) =>
      `${m.sender_name} (${m.sender_type}): ${m.content}${
        m.action_payload ? ` [Action: ${m.action_payload.type}]` : ""
      }`
  )
  .join("\n")}

İstifadəçinin yeni müraciəti:
"${payload.message}"

QAYDALAR:
1. Cavabın içərisində əgər elan, video və ya danışıq təqdim edirsənsə, mütləq Sol Kətan interaktiv fəaliyyət düymələrini formatla:
   - Video və ya elan yoxlanışı: [🎬 Videoya Bax](stage:VIDEO_INSPECTION:<bina_id>)
   - Telemetriya analitikası: [📊 Analitikaya Bax](stage:ANALYTICS_TELEMETRY:<publication_id_or_listing_id>)
   - WhatsApp müştəri danışığı və etirazı: [💬 Danışığa Bax](stage:CRM_NEGOTIATION:<lead_id>)
2. Səhər brifinqi və ya ümumi sorğularda ("Bugün hansı videonu paylaşaq?") portfeldən 1 və ya 2 konkret elan seç, səbəbini izah et və [🎬 Videoya Bax](stage:VIDEO_INSPECTION:<bina_id>) düyməsi ver.

Tələb olunan çıxış JSON formatı:
{
  "content": "Agentin Bakı ləhcəsində canlı, peşəkar və konkret cavabı",
  "suggested_followups": ["Tövsiyə olunan 1-ci sual/fəaliyyət", "Tövsiyə olunan 2-ci sual/fəaliyyət"],
  "action_payload": null VƏ YA {
    "type": "OPEN_STAGE_CARD",
    "cardType": "VIDEO_INSPECTION",
    "targetEntityId": "<bina_id>"
  } VƏ YA {
    "type": "UPDATE_LEAD_STAGE",
    "lead_id": "uuid",
    "current_stage": "cari mərhələ",
    "recommended_stage": "tövsiyə olunan mərhələ",
    "rationale": "səbəb"
  } VƏ YA {
    "type": "DISPATCH_WHATSAPP",
    "phone_number": "994xxxxxxxxx",
    "draft_text": "hazır mesaj mətni",
    "listing_code": "kod:123456"
  } VƏ YA {
    "type": "SAVE_INSIGHT",
    "agent_id": "${canonicalAgent}",
    "domain": "sahə",
    "insight_text": "əldə edilən dərslik nəticə",
    "confidence_score": 0.85
  }
}
`;

      interface AgentRawOutput {
        content: string;
        suggested_followups?: string[];
        action_payload?: {
          type:
            | "OPEN_STAGE_CARD"
            | "UPDATE_LEAD_STAGE"
            | "DISPATCH_WHATSAPP"
            | "SAVE_INSIGHT";
          cardType?:
            | "VIDEO_INSPECTION"
            | "ANALYTICS_TELEMETRY"
            | "CRM_NEGOTIATION";
          targetEntityId?: string;
          payload?: Record<string, unknown>;
          lead_id?: string;
          current_stage?: string;
          recommended_stage?: string;
          rationale?: string;
          phone_number?: string;
          draft_text?: string;
          listing_code?: string;
          agent_id?: AgentPersonaId;
          domain?: string;
          insight_text?: string;
          confidence_score?: number;
        } | null;
      }

      const modelConfig =
        targetModel === COPILOT_STRONG_MODEL
          ? {
              responseMimeType: "application/json",
              generationConfig: { thinkingLevel: "low" },
              thinkingConfig: { thinkingLevel: "low" },
            }
          : { responseMimeType: "application/json" };

      const response = await ai.models.generateContent({
        model: targetModel,
        contents: [{ text: promptText }],
        config: modelConfig as unknown as Record<string, unknown>,
      });

      promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      const parsed = extractJson<AgentRawOutput>(response.text || "");
      if (!parsed?.content) {
        throw new Error("Invalid model response for agent_chat");
      }

      let resolvedActionPayload: ActionCardPayload | null = null;
      if (parsed.action_payload && parsed.action_payload.type) {
        if (
          parsed.action_payload.type === "OPEN_STAGE_CARD" &&
          parsed.action_payload.targetEntityId
        ) {
          resolvedActionPayload = {
            type: "OPEN_STAGE_CARD",
            cardType: parsed.action_payload.cardType || "VIDEO_INSPECTION",
            targetEntityId: parsed.action_payload.targetEntityId,
            payload: parsed.action_payload.payload,
          };
        } else if (
          parsed.action_payload.type === "UPDATE_LEAD_STAGE" &&
          (parsed.action_payload.lead_id || payload.context?.lead_id)
        ) {
          resolvedActionPayload = {
            type: "UPDATE_LEAD_STAGE",
            lead_id:
              parsed.action_payload.lead_id || payload.context!.lead_id!,
            current_stage: parsed.action_payload.current_stage || "NEW_INQUIRY",
            recommended_stage:
              parsed.action_payload.recommended_stage || "QUALIFIED",
            rationale:
              parsed.action_payload.rationale ||
              "Müştəri tələblərinə əsasən mərhələ yeniləndi.",
          };
        } else if (
          parsed.action_payload.type === "DISPATCH_WHATSAPP" &&
          parsed.action_payload.phone_number
        ) {
          const phone = parsed.action_payload.phone_number;
          const draft =
            parsed.action_payload.draft_text ||
            "Salam! BakuEstate xidmətinizdədir.";
          const listingCode =
            parsed.action_payload.listing_code ||
            (payload.context?.listing_id
              ? `kod:${payload.context.listing_id}`
              : undefined);
          const waLink =
            buildWhatsAppUrl(phone, draft) || `https://wa.me/${phone}`;
          resolvedActionPayload = {
            type: "DISPATCH_WHATSAPP",
            phone_number: phone,
            draft_text: draft,
            listing_code: listingCode,
            wa_link: waLink,
          };
        } else if (parsed.action_payload.type === "SAVE_INSIGHT") {
          resolvedActionPayload = {
            type: "SAVE_INSIGHT",
            agent_id: canonicalAgent,
            domain: parsed.action_payload.domain || "GENERAL_OPS",
            insight_text: parsed.action_payload.insight_text || parsed.content,
            confidence_score:
              typeof parsed.action_payload.confidence_score === "number"
                ? parsed.action_payload.confidence_score
                : 0.85,
          };
        }
      }

      const personaDef = getAgentPersona(canonicalAgent);
      const userId = crypto.randomUUID();
      const agentMsgId = crypto.randomUUID();
      const nowIso = new Date().toISOString();

      const userSenderName =
        operator.displayName ||
        (operator.email ? operator.email.split("@")[0] : "Operator");

      const agentMsg: AgentChatMessage = {
        id: agentMsgId,
        sender_type: "AGENT",
        sender_name: personaDef.title,
        content: parsed.content,
        action_payload: resolvedActionPayload,
        created_at: nowIso,
      };

      // Append both turns atomically to append-only agent_messages table
      try {
        await supabaseAdmin.from("agent_messages").insert([
          {
            id: userId,
            conversation_id: conversationId,
            agency_id: operator.agencyId,
            operator_id: operator.operatorId,
            sender_type: "USER",
            sender_name: userSenderName,
            content: payload.message,
            action_payload: {},
          },
          {
            id: agentMsgId,
            conversation_id: conversationId,
            agency_id: operator.agencyId,
            operator_id: operator.operatorId,
            sender_type: "AGENT",
            sender_name: personaDef.title,
            content: parsed.content,
            action_payload: resolvedActionPayload ?? {},
          },
        ]);

        await supabaseAdmin
          .from("agent_conversations")
          .update({ updated_at: nowIso })
          .eq("id", conversationId)
          .eq("agency_id", operator.agencyId);
      } catch (e) {
        console.warn("[COPILOT AGENT CHAT] Failed to persist agent_messages:", e);
      }

      resultData = {
        conversation_id: conversationId!,
        agent_id: payload.agent_id,
        message: agentMsg,
        suggested_followups:
          parsed.suggested_followups || personaDef.quickPills.slice(0, 3),
      };
    }
  } catch (apiErr: unknown) {
    console.warn("[COPILOT API ERROR] Upstream Gemini error:", apiErr);
    await reconcileBudgetRunSafe(supabaseAdmin, {
      runId: budgetRunId,
      promptTokens: 0,
      outputTokens: 0,
      audioSeconds: 0,
      actualUsd: 0,
      status: "FAILED",
    });

    return NextResponse.json(
      {
        ok: false,
        error:
          "AI xidməti hazırda əlçatan deyil. Zəhmət olmasa bir az sonra yenidən cəhd edin.",
        code: "UPSTREAM_UNAVAILABLE",
        fallback_available: false,
      } as CopilotApiResponse,
      {
        status: 503,
        headers: {
          "X-BakuEstate-Model-Served": targetModel,
          "X-BakuEstate-Fallback-Triggered": "false",
          "X-BakuEstate-Run-Id": budgetRunId,
        },
      }
    );
  }

  if (!resultData) {
    await reconcileBudgetRunSafe(supabaseAdmin, {
      runId: budgetRunId,
      promptTokens: 0,
      outputTokens: 0,
      audioSeconds: 0,
      actualUsd: 0,
      status: "FAILED",
    });

    return NextResponse.json(
      {
        ok: false,
        error: "AI cavabı yaradıla bilmədi.",
        code: "UPSTREAM_UNAVAILABLE",
        fallback_available: false,
      } as CopilotApiResponse,
      { status: 503, headers: { "X-BakuEstate-Run-Id": budgetRunId } }
    );
  }

  // 6. Reconcile real token & audio cost into agency_ai_usage_monthly
  const actualUsd = computeActualCostUsd(
    targetModel,
    promptTokens,
    outputTokens,
    audioSeconds
  );
  await reconcileBudgetRunSafe(supabaseAdmin, {
    runId: budgetRunId,
    promptTokens,
    outputTokens,
    audioSeconds,
    actualUsd,
    status: "COMPLETED",
  });

  return NextResponse.json(
    {
      ok: true,
      action: payload.action,
      model_served: targetModel,
      run_id: budgetRunId,
      data: resultData,
    } as CopilotApiResponse,
    {
      status: 200,
      headers: {
        "X-BakuEstate-Model-Served": targetModel,
        "X-BakuEstate-Fallback-Triggered": "false",
        "X-BakuEstate-Run-Id": budgetRunId,
      },
    }
  );
}
