import { describe, it, expect } from "vitest";
import {
  checkAddressLeak,
  checkCommissionShaving,
  computeTriagedRadar,
  normalizePhoneInput,
  buildWhatsAppUrl,
  ADDRESS_LEAK_PATTERNS,
  COMMISSION_SHAVING_PATTERNS,
} from "../lib/copilot-core";

describe("Sentinel Persona - checkAddressLeak", () => {
  it("detects 'ev 45' building pattern and sanitizes it", () => {
    const input = "Salam, ev 45 qarşısında görüşək.";
    const result = checkAddressLeak(input);
    expect(result.hasLeak).toBe(true);
    expect(result.leakedTokens).toContain("ev 45");
    expect(result.sanitizedText).toContain("[DƏQİQ ÜNVAN GİZLƏDİLDİ - BAXIŞDA VERİLƏCƏK]");
    expect(result.sanitizedText).not.toContain("ev 45");
    expect(result.warning).toContain("SENTINEL XƏBƏRDARLIĞI");
  });

  it("detects 'kvartira 12' apartment pattern", () => {
    const input = "Müştəri kvartira 12 ünvanını soruşur.";
    const result = checkAddressLeak(input);
    expect(result.hasLeak).toBe(true);
    expect(result.leakedTokens).toContain("kvartira 12");
    expect(result.sanitizedText).not.toContain("kvartira 12");
  });

  it("detects '5/9' floor/building fraction notation", () => {
    const input = "Mənzil 5/9 mərtəbədə yerləşir.";
    const result = checkAddressLeak(input);
    expect(result.hasLeak).toBe(true);
    expect(result.leakedTokens).toContain("5/9");
    expect(result.sanitizedText).toContain("[DƏQİQ ÜNVAN GİZLƏDİLDİ - BAXIŞDA VERİLƏCƏK]");
  });

  it("detects 'Təbriz küçəsi 45' street number pattern", () => {
    const input = "Mənzil Təbriz küçəsi 45 ünvanında yerləşir.";
    const result = checkAddressLeak(input);
    expect(result.hasLeak).toBe(true);
    expect(result.leakedTokens.some((tok) => tok.includes("Təbriz küçəsi 45"))).toBe(true);
    expect(result.sanitizedText).not.toContain("Təbriz küçəsi 45");
  });

  it("detects multiple address leaks in a single text", () => {
    const input = "Bina 12, blok 3, mənzil 45 ünvanına yaxınlaşın.";
    const result = checkAddressLeak(input);
    expect(result.hasLeak).toBe(true);
    expect(result.leakedTokens.length).toBeGreaterThanOrEqual(3);
    expect(result.sanitizedText).not.toContain("bina 12");
    expect(result.sanitizedText).not.toContain("blok 3");
    expect(result.sanitizedText).not.toContain("mənzil 45");
  });

  it("does NOT flag safe district, metro, and landmark orienting points", () => {
    const safeInputs = [
      "Təbriz küçəsi, Təfəkkür Universiteti yaxınlığı",
      "Nəsimi rayonu, 28 May metrosuna 5 dəqiqəlik məsafə",
      "Yasamal r., Elmlər Akademiyası metrosu",
      "3 otaqlı mənzil, 180000 AZN",
      "Ümumi sahəsi 120 kv.m olan mənzil",
      "20/11/2026 tarixində baxış keçiriləcək",
    ];

    for (const text of safeInputs) {
      const result = checkAddressLeak(text);
      expect(result.hasLeak).toBe(false);
      expect(result.leakedTokens).toHaveLength(0);
      expect(result.warning).toBeNull();
      expect(result.sanitizedText).toBe(text);
    }
  });

  it("gracefully handles empty, null, and undefined inputs", () => {
    expect(checkAddressLeak("").hasLeak).toBe(false);
    expect(checkAddressLeak(null as unknown as string).hasLeak).toBe(false);
    expect(checkAddressLeak(undefined as unknown as string).hasLeak).toBe(false);
  });
});

describe("Sentinel Persona - checkCommissionShaving", () => {
  it("detects '50 azn endirim' attempt", () => {
    const input = "Mənə 50 azn endirim edin də zəhmət olmasa.";
    const result = checkCommissionShaving(input);
    expect(result.hasShaving).toBe(true);
    expect(result.detectedTokens.some((t) => t.includes("50 azn") || t.includes("endirim"))).toBe(true);
  });

  it("detects 'komissiya yoxdur' refusal", () => {
    const input = "Bizdə vasitəçiyə komissiya yoxdur, razısınızsa baxaq.";
    const result = checkCommissionShaving(input);
    expect(result.hasShaving).toBe(true);
    expect(result.detectedTokens).toContain("komissiya yoxdur");
  });

  it("detects '100 manat çıxın' attempt", () => {
    const input = "Zəhmət olmasa xidmət haqqından 100 manat çıxın.";
    const result = checkCommissionShaving(input);
    expect(result.hasShaving).toBe(true);
    expect(result.detectedTokens.some((t) => t.includes("100 manat"))).toBe(true);
  });

  it("detects 'faiz düşün' attempt", () => {
    const input = "Xidmət haqqı üçün faiz düşün.";
    const result = checkCommissionShaving(input);
    expect(result.hasShaving).toBe(true);
    expect(result.detectedTokens).toContain("faiz düşün");
  });

  it("detects 'komissiyanı 50 manat edin' from CUJ 2", () => {
    const input = "Salam, o Təbriz küçəsindəki 180 minlik evin bina və mənzil nömrəsini deyin baxaq, bir də komissiyanı 50 manat edin.";
    const result = checkCommissionShaving(input);
    expect(result.hasShaving).toBe(true);
  });

  it("does NOT flag standard legitimate inquiries without commission shaving", () => {
    const cleanInputs = [
      "Salam, bu mənzil hələ satışdadır?",
      "Baxış üçün bu gün saat 18:00 uyğundur?",
      "Mənzilin Kupçası var və ipotekaya yararlıdır?",
      "Mənzil sahibi ilə qiymət müzakirəsi aparmaq mümkündür?",
    ];

    for (const text of cleanInputs) {
      const result = checkCommissionShaving(text);
      expect(result.hasShaving).toBe(false);
      expect(result.detectedTokens).toHaveLength(0);
    }
  });

  it("gracefully handles empty, null, and undefined inputs", () => {
    expect(checkCommissionShaving("").hasShaving).toBe(false);
    expect(checkCommissionShaving(null as unknown as string).hasShaving).toBe(false);
    expect(checkCommissionShaving(undefined as unknown as string).hasShaving).toBe(false);
  });
});

describe("Strategist Persona - computeTriagedRadar", () => {
  it("scores priorities correctly: URGENT(100) > HIGH(75) > NORMAL(50) > LOW(25)", () => {
    const leads = [
      { id: "1", priority: "NORMAL", headline: "Normal müştəri" },
      { id: "2", priority: "URGENT", headline: "Təcili zəng" },
      { id: "3", priority: "LOW", headline: "Soyuq müştəri" },
      { id: "4", priority: "HIGH", headline: "Vacib müştəri" },
    ];

    const ranked = computeTriagedRadar(leads);
    expect(ranked[0].id).toBe("2"); // URGENT + "Təcili" = 120
    expect(ranked[1].id).toBe("4"); // HIGH = 75
    expect(ranked[2].id).toBe("1"); // NORMAL = 50
    expect(ranked[3].id).toBe("3"); // LOW = 25
  });

  it("applies +20 bonus for 'endirimi' or 'təcili' keyword in text", () => {
    const leads = [
      { id: "1", priority: "NORMAL", headline: "Qiymət endirimi oldu" }, // 50 + 20 = 70
      { id: "2", priority: "HIGH", headline: "Sadə sorğu" },            // 75
      { id: "3", priority: "NORMAL", headline: "Standart maraq" },         // 50
    ];

    const ranked = computeTriagedRadar(leads);
    expect(ranked[0].id).toBe("2"); // 75
    expect(ranked[1].id).toBe("1"); // 70
    expect(ranked[2].id).toBe("3"); // 50
  });

  it("limits output strictly to Top 5 items", () => {
    const leads = [
      { id: "1", priority: "LOW" },
      { id: "2", priority: "NORMAL" },
      { id: "3", priority: "HIGH" },
      { id: "4", priority: "URGENT" },
      { id: "5", priority: "HIGH" },
      { id: "6", priority: "NORMAL" },
      { id: "7", priority: "LOW" },
    ];

    const ranked = computeTriagedRadar(leads);
    expect(ranked).toHaveLength(5);
    expect(ranked[0].priority).toBe("URGENT");
  });

  it("returns empty array for empty or invalid inputs", () => {
    expect(computeTriagedRadar([])).toEqual([]);
    expect(computeTriagedRadar(null as unknown as Record<string, unknown>[])).toEqual([]);
    expect(computeTriagedRadar(undefined as unknown as Record<string, unknown>[])).toEqual([]);
  });

  it("populates default card fields if lead lacks them", () => {
    const rawLeads = [
      { id: "101", client_name: "Rəşad Əliyev", stage: "QUALIFIED" },
    ];

    const ranked = computeTriagedRadar(rawLeads);
    expect(ranked[0].headline).toBe("Rəşad Əliyev (QUALIFIED)");
    expect(ranked[0].channel).toBe("WHATSAPP");
    expect(ranked[0].status).toBe("PENDING");
    expect(ranked[0].radar_score).toBe(50);
  });
});

describe("Format Utilities Re-export Verification", () => {
  it("re-exports normalizePhoneInput from format.ts", () => {
    expect(normalizePhoneInput("0501234567")).toBe("+994501234567");
    expect(normalizePhoneInput("501234567")).toBe("+994501234567");
    expect(normalizePhoneInput("+994501234567")).toBe("+994501234567");
  });

  it("re-exports buildWhatsAppUrl from format.ts", () => {
    const url = buildWhatsAppUrl("0501234567", "Salam");
    expect(url).toBe("https://wa.me/994501234567?text=Salam");
  });
});
