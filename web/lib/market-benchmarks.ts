export interface DistrictBenchmark {
  min: number;
  max: number;
  label: string;
}

export const DISTRICT_LIQUIDITY_CORRIDORS: Record<string, DistrictBenchmark> = {
  yasamal: { min: 2200, max: 2800, label: "Yasamal r." },
  nasimi: { min: 2500, max: 3400, label: "Nəsimi r." },
  sabail: { min: 3200, max: 4800, label: "Səbail r." },
  khatai: { min: 2100, max: 2900, label: "Xətai r." },
  narimanov: { min: 2400, max: 3200, label: "Nərimanov r." },
  masazir: { min: 1100, max: 1600, label: "Masazır qəs." },
  default: { min: 2000, max: 3000, label: "Bakı Ortalaması" },
};

export function resolveDistrictCorridor(location?: string): DistrictBenchmark {
  if (!location) return DISTRICT_LIQUIDITY_CORRIDORS.default;
  const lower = location.toLowerCase();
  if (lower.includes("yasamal") || lower.includes("inşaatçılar") || lower.includes("elmlər")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.yasamal;
  }
  if (lower.includes("nəsimi") || lower.includes("nasimi") || lower.includes("28 may")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.nasimi;
  }
  if (lower.includes("səbail") || lower.includes("sabail") || lower.includes("badamdar") || lower.includes("sahil")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.sabail;
  }
  if (lower.includes("xətai") || lower.includes("khatai") || lower.includes("əhmədli") || lower.includes("həzi")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.khatai;
  }
  if (lower.includes("nərimanov") || lower.includes("narimanov") || lower.includes("gənclik")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.narimanov;
  }
  if (lower.includes("masazır") || lower.includes("masazir")) {
    return DISTRICT_LIQUIDITY_CORRIDORS.masazir;
  }
  return DISTRICT_LIQUIDITY_CORRIDORS.default;
}
