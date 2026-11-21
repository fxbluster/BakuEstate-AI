/**
 * BakuEstate-AI Client Core Heuristics & Deterministic Guardrails
 *
 * Provides 0ms instantaneous client-side address leak detection (Sentinel),
 * commission margin defense token detection, and deterministic top-5 lead
 * radar prioritization for offline/mobile cockpit hydration.
 *
 * Re-exports phone normalization and WhatsApp URL builders from `@/lib/format`.
 */

import { normalizePhoneInput, buildWhatsAppUrl } from "./format";

export { normalizePhoneInput, buildWhatsAppUrl };

export const ADDRESS_LEAK_PATTERNS: RegExp[] = [
  // Explicit building/block/house numbers: "bina 45", "bina № 12", "bina no: 4", "ev 45", "ev: 10/2"
  /\b(?:bina|bina\s*№|bina\s*no|ev)\s*[:#№]?\s*(\d+[a-zA-ZəöğıçşƏÖĞİIŞÇ]?(?:\/\d+)?)\b/i,
  // Apartment / flat numbers: "mənzil 12", "mənz. 4", "m. 5", "kvartira 12", "kv. 8"
  /\b(?:mənzil|mənz\.|m\.|kvartira|kv\.(?!\s*m\b))\s*[:#№]?\s*(\d+)\b/i,
  // Block / entrance numbers: "blok 3", "blok №2", "blok no 1"
  /\b(?:blok|blok\s*№|blok\s*no)\s*[:#№]?\s*(\d+)\b/i,
  // Microdistrict / quarter: "məhəllə 5", "kvartal 10", "mikrorayon 4", "mkr 9"
  /\b(?:məhəllə|kvartal|mikrorayon|mkr)\s*[:#№]?\s*(\d+)\b/i,
  // Floor / building fraction notation: "5/9", "9/9", "12/16", "12/14" (not part of dates like 20/11/2026)
  /\b\d{1,3}\/\d{1,3}\b(?!\/\d)/i,
  // Street + number combinations: e.g. "Təbriz küçəsi 45", "Nizami küç. 12/14", "Neftçilər prospekti 10"
  /([A-ZƏÖĞIŞÇa-zəöğışç\s]+(?:küçəsi|küç\.|prospekti|pr\.|döngəsi))\s*[:#№]?\s*(\d+[a-zA-ZəöğıçşƏÖĞİIŞÇ]?(?:\/\d+)?)\b/i,
];

export const COMMISSION_SHAVING_PATTERNS: RegExp[] = [
  /(\d+)\s*(?:azn|manat)?\s*(?:endirim|çıx|çıxın|düş|aşağı|azalt)/i,
  /komissiya(?:nı)?\s*(?:vermək\s*istəmirəm|yoxdur|olmasın|verməyəcəm|ödəmirəm|50|100|az|düş)/i,
  /komissiya(?:nı)?\s*(\d+)?\s*(?:azn|manat)?\s*(?:edin|edin\s*də|endirin)/i,
  /faiz\s*(?:yoxdur|düşün|az\s*edin)/i,
  /\b50\s*(?:azn|manat)\b/i,
  /\b100\s*(?:azn|manat)\b/i,
];

export interface AddressLeakScan {
  hasLeak: boolean;
  leakedTokens: string[];
  sanitizedText: string;
  warning: string | null;
}

export interface CommissionShavingScan {
  hasShaving: boolean;
  detectedTokens: string[];
}

/**
 * Scans message or text for sensitive address details (building number, apartment,
 * exact floor fraction, street numbers) that would allow a buyer to bypass the agency.
 */
export function checkAddressLeak(text: string): AddressLeakScan {
  if (!text || typeof text !== "string") {
    return {
      hasLeak: false,
      leakedTokens: [],
      sanitizedText: text || "",
      warning: null,
    };
  }

  const foundTokens: string[] = [];

  for (const pattern of ADDRESS_LEAK_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const regex = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const token = match[0].trim();
      if (token && !foundTokens.includes(token)) {
        foundTokens.push(token);
      }
    }
  }

  const hasLeak = foundTokens.length > 0;
  let sanitizedText = text;
  let warning: string | null = null;

  if (hasLeak) {
    warning = `⚠️ SENTINEL XƏBƏRDARLIĞI: Dəqiq ünvan detalı (${foundTokens.join(", ")}) aşkarlandı! Müştəri vasitəçini kənarda qoyub birbaşa ünvana gedə bilər. Zəhmət olmasa bina/mənzil nömrəsini gizlədin, yalnız rayon/metro oriyentirini saxlayın.`;

    // Replace longer tokens first to avoid nested partial replacement corruption
    const sortedTokens = [...foundTokens].sort((a, b) => b.length - a.length);
    for (const token of sortedTokens) {
      sanitizedText = sanitizedText.split(token).join("[DƏQİQ ÜNVAN GİZLƏDİLDİ - BAXIŞDA VERİLƏCƏK]");
    }
  }

  return {
    hasLeak,
    leakedTokens: foundTokens,
    sanitizedText,
    warning,
  };
}

/**
 * Scans text for buyer or client attempts to shave 50-100 AZN commission margins
 * or refuse broker service fees.
 */
export function checkCommissionShaving(text: string): CommissionShavingScan {
  if (!text || typeof text !== "string") {
    return {
      hasShaving: false,
      detectedTokens: [],
    };
  }

  const detectedTokens: string[] = [];

  for (const pattern of COMMISSION_SHAVING_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const regex = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const token = match[0].trim();
      if (token && !detectedTokens.includes(token)) {
        detectedTokens.push(token);
      }
    }
  }

  return {
    hasShaving: detectedTokens.length > 0,
    detectedTokens,
  };
}

export interface TriagedRadarItem {
  radar_score: number;
  headline: string;
  channel: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Deterministic Triaged Radar Priority Ranking.
 *
 * Scoring formula:
 * - URGENT: 100
 * - HIGH: 75
 * - NORMAL: 50
 * - LOW / OTHER: 25
 * - Bonus: +20 for "endirimi" or "təcili" in text fields
 *
 * Returns descending sorted array capped at Top 5 items.
 */
export function computeTriagedRadar<T extends Record<string, unknown> = Record<string, unknown>>(
  leads: T[]
): (T & TriagedRadarItem)[] {
  if (!leads || !Array.isArray(leads) || leads.length === 0) {
    return [];
  }

  const scored = leads.map((lead) => {
    let score = 0;
    const rec = lead as Record<string, unknown>;
    const priority = String(
      rec.priority || rec.priority_level || (rec.is_urgent ? "URGENT" : "NORMAL")
    ).toUpperCase();

    if (priority === "URGENT") {
      score += 100;
    } else if (priority === "HIGH") {
      score += 75;
    } else if (priority === "NORMAL") {
      score += 50;
    } else {
      score += 25;
    }

    const text = `${String(rec.headline || "")} ${String(rec.notes || "")} ${String(rec.title || "")} ${String(rec.summary || "")} ${String(rec.client_name || "")} ${String(rec.name || "")} ${String(rec.strategic_rationale || "")}`.toLowerCase();
    if (text.includes("endirimi") || text.includes("təcili")) {
      score += 20;
    }

    const headline = typeof rec.headline === "string" && rec.headline
      ? rec.headline
      : typeof rec.client_name === "string" && rec.client_name
        ? `${rec.client_name} (${typeof rec.stage === "string" ? rec.stage : "Aktiv"})`
        : "Yeni Müraciət";

    const channel = typeof rec.channel === "string" && rec.channel
      ? rec.channel
      : typeof rec.source_channel === "string" && rec.source_channel
        ? rec.source_channel
        : "WHATSAPP";

    const status = typeof rec.status === "string" && rec.status
      ? rec.status
      : "PENDING";

    const enriched: T & TriagedRadarItem = {
      ...lead,
      radar_score: score,
      headline,
      channel,
      status,
    };

    return {
      lead: enriched,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.lead);
}
