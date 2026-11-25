import type { ChannelNiche } from "@/lib/types";

export interface NicheRulesConfig {
  luxury_min_azn?: number | null;
  affordable_max_azn?: number | null;
  viral_drop_pct?: number | null;
}

export interface NicheRoutableListing {
  price_azn_normalized?: number | string | null;
  price?: number | string | null;
  price_azn?: number | string | null;
  district_normalized?: string | null;
  location?: string | null;
  district?: string | null;
  address?: string | null;
  settlement?: string | null;
  is_urgent?: boolean | string | null;
  price_drop_pct?: number | string | null;
  price_drop_info?: {
    drop_pct?: number | string | null;
    price_drop_pct?: number | string | null;
  } | null;
  canonical_niche?: ChannelNiche | string | null;
  publication?: {
    channel_niche?: ChannelNiche | string | null;
    target_account_handle?: string | null;
  } | null;
}

export interface CanonicalNicheResult {
  niche: ChannelNiche;
  account: string;
  handle: string;
  label: string;
}

export interface NormalizedNicheRules {
  luxury_min_azn: number;
  affordable_max_azn: number;
  viral_drop_pct: number;
}

export const DEFAULT_NICHE_RULES: NormalizedNicheRules = {
  luxury_min_azn: 250_000,
  affordable_max_azn: 120_000,
  viral_drop_pct: 10,
};

export const CHANNEL_ACCOUNT_HANDLES: Record<ChannelNiche, string> = {
  TIKTOK: "@baku_emlak_ai",
  LUXURY: "@bakuestate.premium",
  AFFORDABLE: "@baku.serfeli.evler",
  GENERAL: "@bakuestate.official",
};

export const CHANNEL_NICHE_LABELS: Record<ChannelNiche, string> = {
  LUXURY: "Lüks Portfel",
  AFFORDABLE: "Sərfəli / Büdcə",
  TIKTOK: "Viral / Endirim",
  GENERAL: "Ümumi Portfel",
};

export const ELITE_CENTRAL_DISTRICTS: readonly string[] = [
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

export const SUBURBAN_DISTRICTS: readonly string[] = [
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

function isValidChannelNiche(value: unknown): value is ChannelNiche {
  return (
    value === "LUXURY" ||
    value === "AFFORDABLE" ||
    value === "GENERAL" ||
    value === "TIKTOK"
  );
}

function parseNumeric(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : 0;
  }
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^\d.]/g, "");
    if (!cleaned) return 0;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function extractPriceAzn(listing: NicheRoutableListing): number {
  if (listing.price_azn_normalized !== undefined && listing.price_azn_normalized !== null) {
    return parseNumeric(listing.price_azn_normalized);
  }
  if (listing.price_azn !== undefined && listing.price_azn !== null) {
    return parseNumeric(listing.price_azn);
  }
  if (listing.price !== undefined && listing.price !== null) {
    return parseNumeric(listing.price);
  }
  return 0;
}

function extractPriceDropPct(listing: NicheRoutableListing): number {
  if (listing.price_drop_pct !== undefined && listing.price_drop_pct !== null) {
    return parseNumeric(listing.price_drop_pct);
  }
  const info = listing.price_drop_info;
  if (info && typeof info === "object") {
    if (info.drop_pct !== undefined && info.drop_pct !== null) {
      return parseNumeric(info.drop_pct);
    }
    if (info.price_drop_pct !== undefined && info.price_drop_pct !== null) {
      return parseNumeric(info.price_drop_pct);
    }
  }
  return 0;
}

function isListingUrgent(listing: NicheRoutableListing): boolean {
  const val = listing.is_urgent;
  if (typeof val === "string") {
    return ["true", "1", "yes", "t"].includes(val.trim().toLowerCase());
  }
  return Boolean(val);
}

function extractDistrictText(listing: NicheRoutableListing): string {
  return [
    listing.district_normalized,
    listing.location,
    listing.district,
    listing.settlement,
    listing.address,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase())
    .join(" ");
}

function normalizeRules(rules?: NicheRulesConfig | null): NormalizedNicheRules {
  const luxuryMin =
    typeof rules?.luxury_min_azn === "number" &&
    Number.isFinite(rules.luxury_min_azn) &&
    rules.luxury_min_azn > 0
      ? rules.luxury_min_azn
      : DEFAULT_NICHE_RULES.luxury_min_azn;

  const affordableMax =
    typeof rules?.affordable_max_azn === "number" &&
    Number.isFinite(rules.affordable_max_azn) &&
    rules.affordable_max_azn >= 0
      ? rules.affordable_max_azn
      : DEFAULT_NICHE_RULES.affordable_max_azn;

  const viralDropPct =
    typeof rules?.viral_drop_pct === "number" &&
    Number.isFinite(rules.viral_drop_pct) &&
    rules.viral_drop_pct >= 0
      ? rules.viral_drop_pct
      : DEFAULT_NICHE_RULES.viral_drop_pct;

  return {
    luxury_min_azn: luxuryMin,
    affordable_max_azn: affordableMax,
    viral_drop_pct: viralDropPct,
  };
}

export function getAccountHandleForNiche(niche: ChannelNiche): string {
  return CHANNEL_ACCOUNT_HANDLES[niche] || CHANNEL_ACCOUNT_HANDLES.GENERAL;
}

function buildResult(niche: ChannelNiche): CanonicalNicheResult {
  const account = getAccountHandleForNiche(niche);
  return {
    niche,
    account,
    handle: account,
    label: CHANNEL_NICHE_LABELS[niche] || CHANNEL_NICHE_LABELS.GENERAL,
  };
}

/**
 * Canonical niche & social account router matching Python `src/worker/account_router.py`.
 *
 * Precedence:
 * 1. Viral trigger: `is_urgent` or `price_drop_pct >= viral_drop_pct` (default 10%) -> TIKTOK (`@baku_emlak_ai`)
 * 2. When `rules` is omitted and DB `canonical_niche` or `publication.channel_niche` is present, honors it.
 * 3. `price >= luxury_min_azn` (default 250,000) or elite central district -> LUXURY (`@bakuestate.premium`)
 * 4. Suburban district or `0 < price <= affordable_max_azn` (default 120,000) -> AFFORDABLE (`@baku.serfeli.evler`)
 * 5. Otherwise -> GENERAL (`@bakuestate.official`)
 */
export function resolveCanonicalListingNiche(
  listing: NicheRoutableListing | null | undefined,
  rules?: NicheRulesConfig | null
): CanonicalNicheResult {
  const safeListing: NicheRoutableListing = listing && typeof listing === "object" ? listing : {};
  const effectiveRules = normalizeRules(rules);

  const isUrgent = isListingUrgent(safeListing);
  const dropPct = extractPriceDropPct(safeListing);

  if (isUrgent || dropPct >= effectiveRules.viral_drop_pct) {
    return buildResult("TIKTOK");
  }

  const hasExplicitRules = Boolean(rules && typeof rules === "object");

  if (!hasExplicitRules) {
    if (isValidChannelNiche(safeListing.canonical_niche)) {
      return buildResult(safeListing.canonical_niche);
    }
    if (isValidChannelNiche(safeListing.publication?.channel_niche)) {
      return buildResult(safeListing.publication.channel_niche);
    }
  } else if (
    safeListing.canonical_niche === "TIKTOK" &&
    safeListing.price_drop_pct === undefined &&
    safeListing.price_drop_info === undefined &&
    safeListing.is_urgent === undefined
  ) {
    return buildResult("TIKTOK");
  }

  const price = extractPriceAzn(safeListing);
  const districtText = extractDistrictText(safeListing);

  const isElite = ELITE_CENTRAL_DISTRICTS.some((d) => districtText.includes(d));
  const isSuburban = SUBURBAN_DISTRICTS.some((d) => districtText.includes(d));

  if (price >= effectiveRules.luxury_min_azn || isElite) {
    return buildResult("LUXURY");
  }
  if (isSuburban || (price > 0 && price <= effectiveRules.affordable_max_azn)) {
    return buildResult("AFFORDABLE");
  }
  return buildResult("GENERAL");
}
