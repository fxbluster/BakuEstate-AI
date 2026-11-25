export interface DistrictBenchmark {
  min: number;
  max: number;
  label: string;
  median?: number;
  sampleCount?: number;
  source?: "live_db" | "fallback";
}

export interface DistrictPriceMedianRow {
  agency_id?: string;
  district_normalized: string;
  sample_count: number;
  median_azn_per_m2: number;
  p25_azn_per_m2: number;
  p75_azn_per_m2: number;
  avg_price_azn?: number | null;
  latest_seen_at?: string | null;
}

export interface SupabaseMediansQueryClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
}

/**
 * Fallback-only liquidity corridors when live `public.district_price_medians`
 * has no rows or insufficient samples for a district.
 */
export const DISTRICT_LIQUIDITY_CORRIDORS: Record<string, DistrictBenchmark> = {
  yasamal: { min: 2200, max: 2800, label: "Yasamal r." },
  nasimi: { min: 2500, max: 3400, label: "Nəsimi r." },
  sabail: { min: 3200, max: 4800, label: "Səbail r." },
  khatai: { min: 2100, max: 2900, label: "Xətai r." },
  narimanov: { min: 2400, max: 3200, label: "Nərimanov r." },
  masazir: { min: 1100, max: 1600, label: "Masazır qəs." },
  default: { min: 2000, max: 3000, label: "Bakı Ortalaması" },
};

const DISTRICT_ALIASES: Array<{ key: string; patterns: string[] }> = [
  { key: "yasamal", patterns: ["yasamal", "inşaatçılar", "insaatcilar", "elmlər", "elmler"] },
  { key: "nasimi", patterns: ["nəsimi", "nasimi", "28 may"] },
  { key: "sabail", patterns: ["səbail", "sebail", "badamdar", "sahil"] },
  { key: "khatai", patterns: ["xətai", "khatai", "əhmədli", "ehmedli", "həzi", "hezi", "ağ şəhər", "ag seher"] },
  { key: "narimanov", patterns: ["nərimanov", "narimanov", "gənclik", "genclik"] },
  { key: "masazir", patterns: ["masazır", "masazir"] },
];

function findLiveDistrictMatch(
  location: string,
  liveMedians: DistrictPriceMedianRow[]
): DistrictPriceMedianRow | null {
  const lower = location.trim().toLowerCase();
  if (!lower) return null;

  // 1. Direct substring match against normalized district names from DB view
  const direct = liveMedians.find((row) => {
    const d = (row.district_normalized || "").trim().toLowerCase();
    return d.length > 0 && (lower.includes(d) || d.includes(lower));
  });
  if (direct) return direct;

  // 2. Alias match (e.g. "İnşaatçılar" -> "yasamal")
  const aliasEntry = DISTRICT_ALIASES.find((entry) =>
    entry.patterns.some((p) => lower.includes(p))
  );
  if (aliasEntry) {
    const aliasMatched = liveMedians.find((row) => {
      const d = (row.district_normalized || "").trim().toLowerCase();
      return aliasEntry.patterns.some((p) => d.includes(p)) || d.includes(aliasEntry.key);
    });
    if (aliasMatched) return aliasMatched;
  }

  return null;
}

function buildLiveBenchmark(
  row: DistrictPriceMedianRow,
  fallbackLabel?: string
): DistrictBenchmark | null {
  const median = Number(row.median_azn_per_m2 ?? 0);
  const p25 = Number(row.p25_azn_per_m2 ?? 0);
  const p75 = Number(row.p75_azn_per_m2 ?? 0);
  if (!Number.isFinite(median) || median <= 0) {
    return null;
  }

  const min =
    Number.isFinite(p25) && p25 > 0 ? Math.round(p25) : Math.round(median * 0.88);
  const max =
    Number.isFinite(p75) && p75 >= min ? Math.round(p75) : Math.round(median * 1.12);

  return {
    min,
    max,
    label: fallbackLabel || row.district_normalized || "Bakı Ortalaması",
    median: Math.round(median),
    sampleCount: Number(row.sample_count ?? 0),
    source: "live_db",
  };
}

function resolveFallbackCorridor(location?: string): DistrictBenchmark {
  if (!location) {
    return { ...DISTRICT_LIQUIDITY_CORRIDORS.default, source: "fallback" };
  }
  const lower = location.toLowerCase();
  if (lower.includes("yasamal") || lower.includes("inşaatçılar") || lower.includes("elmlər")) {
    return { ...DISTRICT_LIQUIDITY_CORRIDORS.yasamal, source: "fallback" };
  }
  if (lower.includes("nəsimi") || lower.includes("nasimi") || lower.includes("28 may")) {
    return { ...DISTRICT_LIQUIDITY_CORRIDORS.nasimi, source: "fallback" };
  }
  if (lower.includes("səbail") || lower.includes("sabail") || lower.includes("badamdar") || lower.includes("sahil")) {
    return { ...DISTRICT_LIQUIDITY_CORRIDORS.sabail, source: "fallback" };
  }
  if (lower.includes("xətai") || lower.includes("khatai") || lower.includes("əhmədli") || lower.includes("həzi")) {
    return { ...DISTRICT_LIQUIDITY_CORRIDORS.khatai, source: "fallback" };
  }
  if (lower.includes("nərimanov") || lower.includes("narimanov") || lower.includes("gənclik")) {
    return { ...DISTRICT_LIQUIDITY_CORRIDORS.narimanov, source: "fallback" };
  }
  if (lower.includes("masazır") || lower.includes("masazir")) {
    return { ...DISTRICT_LIQUIDITY_CORRIDORS.masazir, source: "fallback" };
  }
  return { ...DISTRICT_LIQUIDITY_CORRIDORS.default, source: "fallback" };
}

/**
 * Resolves a district liquidity corridor (AZN/m²).
 * Prefers live `district_price_medians` rows when supplied and falls back safely
 * to `DISTRICT_LIQUIDITY_CORRIDORS` when live data is unavailable.
 */
export function resolveDistrictCorridor(
  location?: string,
  liveMedians?: DistrictPriceMedianRow[] | null
): DistrictBenchmark {
  const fallback = resolveFallbackCorridor(location);
  if (location && Array.isArray(liveMedians) && liveMedians.length > 0) {
    const matched = findLiveDistrictMatch(location, liveMedians);
    if (matched) {
      const liveBenchmark = buildLiveBenchmark(
        matched,
        fallback.label !== DISTRICT_LIQUIDITY_CORRIDORS.default.label
          ? fallback.label
          : matched.district_normalized
      );
      if (liveBenchmark) {
        return liveBenchmark;
      }
    }
  }
  return fallback;
}

/**
 * Queries live 60-day rolling district medians from `public.district_price_medians`.
 * Never throws; returns `[]` when the view is empty or unreachable.
 */
export async function fetchDistrictPriceMedians(
  supabase: SupabaseMediansQueryClient | null | undefined,
  agencyId?: string
): Promise<DistrictPriceMedianRow[]> {
  if (!supabase || typeof supabase.from !== "function") {
    return [];
  }
  try {
    let query = supabase
      .from("district_price_medians")
      .select(
        "agency_id, district_normalized, sample_count, median_azn_per_m2, p25_azn_per_m2, p75_azn_per_m2, avg_price_azn, latest_seen_at"
      );

    if (agencyId) {
      query = query.eq("agency_id", agencyId);
    }
    if (typeof query.order === "function") {
      query = query.order("sample_count", { ascending: false });
    }

    const { data, error } = await query;
    if (error || !Array.isArray(data)) {
      return [];
    }
    return data as DistrictPriceMedianRow[];
  } catch {
    return [];
  }
}

/**
 * Async convenience helper that fetches `public.district_price_medians` and resolves
 * the corridor for `location`, falling back safely to `DISTRICT_LIQUIDITY_CORRIDORS`.
 */
export async function resolveLiveDistrictCorridor(
  supabase: SupabaseMediansQueryClient | null | undefined,
  location?: string,
  agencyId?: string
): Promise<DistrictBenchmark> {
  const rows = await fetchDistrictPriceMedians(supabase, agencyId);
  return resolveDistrictCorridor(location, rows);
}

/**
 * Formats live `district_price_medians` rows for LLM system prompt injection.
 */
export function formatDistrictMediansPromptContext(
  rows: DistrictPriceMedianRow[] | null | undefined
): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "Canlı rayon medianları hələ kifayət qədər nümunə toplamayıb; yalnız baza portfelindəki faktiki qiymətlərə istinad et.";
  }

  return rows
    .slice(0, 12)
    .map((row) => {
      const median = Math.round(Number(row.median_azn_per_m2 || 0));
      const p25 = Math.round(Number(row.p25_azn_per_m2 || 0));
      const p75 = Math.round(Number(row.p75_azn_per_m2 || 0));
      const count = Number(row.sample_count || 0);
      return `- ${row.district_normalized}: median ${median} AZN/m² (p25–p75: ${p25}–${p75} AZN/m², ${count} aktiv elan)`;
    })
    .join("\n");
}
