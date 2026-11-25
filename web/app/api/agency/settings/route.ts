import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import type { ChannelNiche } from "@/lib/types";

const ELITE_CENTRAL_DISTRICTS = [
  "səbail",
  "sebail",
  "nəsimi",
  "nasimi",
  "nərimanov",
  "nerimanov",
  "gənclik",
  "genclik",
  "ağ şəhər",
  "ag seher",
  "ag sheher",
  "white city",
  "badamdar",
  "bilgəh",
  "bilgeh",
  "mərdəkan",
  "merdekan",
];

const SUBURBAN_DISTRICTS = [
  "xırdalan",
  "xirdalan",
  "masazır",
  "masazir",
  "hövsan",
  "hovsan",
  "zabrat",
  "suraxanı",
  "suraxani",
  "binəqədi",
  "bineqedi",
  "sabunçu",
  "sabuncu",
];

interface NicheRulesInput {
  luxury_min_azn: number;
  affordable_max_azn: number;
  viral_drop_pct: number;
}

function resolveCanonicalNicheForListing(
  listing: {
    price_azn_normalized?: number | null;
    district_normalized?: string | null;
    location?: string | null;
    canonical_niche?: string | null;
  },
  rules: NicheRulesInput
): ChannelNiche {
  if (listing.canonical_niche === "TIKTOK") {
    return "TIKTOK";
  }

  const price = Number(listing.price_azn_normalized ?? 0);
  const districtText = [listing.district_normalized, listing.location]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ")
    .toLowerCase();

  const isElite = ELITE_CENTRAL_DISTRICTS.some((d) => districtText.includes(d));
  const isSuburban = SUBURBAN_DISTRICTS.some((d) => districtText.includes(d));

  if (price >= rules.luxury_min_azn || isElite) {
    return "LUXURY";
  }
  if (isSuburban || (price > 0 && price <= rules.affordable_max_azn)) {
    return "AFFORDABLE";
  }
  return "GENERAL";
}

export async function GET(request: Request) {
  const auth = await requireOperator(request, ["ADMIN"]);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  const supabase = createAdminClient();
  const { data: settings, error } = await supabase
    .from("agency_settings")
    .select(
      "agency_id, public_phone, telegram_chat_id, niche_rules_json, social_api_mode, watermark_preset_json, monthly_ai_budget_usd, ai_rate_limit_rpm, updated_at"
    )
    .eq("agency_id", operator.agencyId)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message || "Agentlik ayarları oxuna bilmədi." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    settings: settings ?? null,
  });
}

export async function PATCH(request: Request) {
  const auth = await requireOperator(request, ["ADMIN"]);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Sorğu gövdəsi etibarlı JSON deyil." },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = {};
  let validatedNicheRules: NicheRulesInput | null = null;

  if (body.public_phone !== undefined) {
    if (typeof body.public_phone !== "string" || !body.public_phone.trim()) {
      return NextResponse.json(
        { ok: false, error: "public_phone boş olmayan mətn olmalıdır." },
        { status: 400 }
      );
    }
    patch.public_phone = body.public_phone.trim();
  }

  if (body.telegram_chat_id !== undefined) {
    if (
      body.telegram_chat_id !== null &&
      typeof body.telegram_chat_id !== "string"
    ) {
      return NextResponse.json(
        { ok: false, error: "telegram_chat_id mətn və ya null olmalıdır." },
        { status: 400 }
      );
    }
    patch.telegram_chat_id =
      typeof body.telegram_chat_id === "string"
        ? body.telegram_chat_id.trim() || null
        : null;
  }

  if (body.niche_rules_json !== undefined) {
    if (
      !body.niche_rules_json ||
      typeof body.niche_rules_json !== "object" ||
      Array.isArray(body.niche_rules_json)
    ) {
      return NextResponse.json(
        { ok: false, error: "niche_rules_json obyekt olmalıdır." },
        { status: 400 }
      );
    }
    const rawRules = body.niche_rules_json as Record<string, unknown>;
    const luxuryMin = Number(rawRules.luxury_min_azn);
    const affordableMax = Number(rawRules.affordable_max_azn);
    const viralDropPct = Number(rawRules.viral_drop_pct ?? 10);

    if (
      !Number.isFinite(luxuryMin) ||
      !Number.isFinite(affordableMax) ||
      !Number.isFinite(viralDropPct) ||
      affordableMax < 0 ||
      luxuryMin <= affordableMax ||
      viralDropPct < 0 ||
      viralDropPct > 100
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "niche_rules_json etibarsızdır: luxury_min_azn > affordable_max_azn >= 0 və viral_drop_pct 0..100 arasında olmalıdır.",
        },
        { status: 400 }
      );
    }

    validatedNicheRules = {
      luxury_min_azn: luxuryMin,
      affordable_max_azn: affordableMax,
      viral_drop_pct: viralDropPct,
    };
    patch.niche_rules_json = validatedNicheRules;
  }

  if (body.watermark_preset_json !== undefined) {
    if (
      !body.watermark_preset_json ||
      typeof body.watermark_preset_json !== "object" ||
      Array.isArray(body.watermark_preset_json)
    ) {
      return NextResponse.json(
        { ok: false, error: "watermark_preset_json obyekt olmalıdır." },
        { status: 400 }
      );
    }
    patch.watermark_preset_json = body.watermark_preset_json;
  }

  if (body.monthly_ai_budget_usd !== undefined) {
    const budget = Number(body.monthly_ai_budget_usd);
    if (!Number.isFinite(budget) || budget < 0) {
      return NextResponse.json(
        { ok: false, error: "monthly_ai_budget_usd mənfi olmayan ədəd olmalıdır." },
        { status: 400 }
      );
    }
    patch.monthly_ai_budget_usd = Number(budget.toFixed(2));
  }

  if (body.ai_rate_limit_rpm !== undefined) {
    const rpm = Number(body.ai_rate_limit_rpm);
    if (!Number.isInteger(rpm) || rpm < 1 || rpm > 1000) {
      return NextResponse.json(
        { ok: false, error: "ai_rate_limit_rpm 1 ilə 1000 arasında tam ədəd olmalıdır." },
        { status: 400 }
      );
    }
    patch.ai_rate_limit_rpm = rpm;
  }

  if (body.social_api_mode !== undefined) {
    if (
      body.social_api_mode !== "OFFICIAL" &&
      body.social_api_mode !== "TELEGRAM_FALLBACK"
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "social_api_mode yalnız OFFICIAL və ya TELEGRAM_FALLBACK ola bilər.",
        },
        { status: 400 }
      );
    }
    patch.social_api_mode = body.social_api_mode;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { ok: false, error: "Yenilənməli heç bir sahə göndərilməyib." },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const { data: updatedSettings, error: updateErr } = await supabase
    .from("agency_settings")
    .update(patch)
    .eq("agency_id", operator.agencyId)
    .select(
      "agency_id, public_phone, telegram_chat_id, niche_rules_json, social_api_mode, watermark_preset_json, monthly_ai_budget_usd, ai_rate_limit_rpm, updated_at"
    )
    .single();

  if (updateErr || !updatedSettings) {
    return NextResponse.json(
      { ok: false, error: updateErr?.message || "Agentlik ayarları yenilənə bilmədi." },
      { status: 500 }
    );
  }

  let recalculatedListingsCount = 0;

  if (validatedNicheRules) {
    const { data: listings, error: listingsErr } = await supabase
      .from("listings")
      .select("id, price_azn_normalized, district_normalized, location, canonical_niche")
      .eq("agency_id", operator.agencyId);

    if (!listingsErr && Array.isArray(listings)) {
      const groupedByNiche: Record<ChannelNiche, string[]> = {
        LUXURY: [],
        AFFORDABLE: [],
        GENERAL: [],
        TIKTOK: [],
      };

      for (const row of listings) {
        const nextNiche = resolveCanonicalNicheForListing(row, validatedNicheRules);
        if (nextNiche !== row.canonical_niche) {
          groupedByNiche[nextNiche].push(String(row.id));
        }
      }

      const niches: ChannelNiche[] = ["LUXURY", "AFFORDABLE", "GENERAL", "TIKTOK"];
      for (const niche of niches) {
        const ids = groupedByNiche[niche];
        if (ids.length === 0) continue;

        const CHUNK_SIZE = 500;
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
          const chunk = ids.slice(i, i + CHUNK_SIZE);
          const { error: batchErr } = await supabase
            .from("listings")
            .update({ canonical_niche: niche })
            .eq("agency_id", operator.agencyId)
            .in("id", chunk);

          if (!batchErr) {
            recalculatedListingsCount += chunk.length;
          }
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    settings: updatedSettings,
    recalculated_listings_count: recalculatedListingsCount,
  });
}
