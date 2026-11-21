import { describe, it, expect } from "vitest";
import {
  type AgentPersonaId,
  type LegacyPersonaId,
  AGENT_PERSONAS,
  getAgentPersona,
  isValidAgentPersonaId,
  resolvePersonaId,
  PERSONA_ALIASES,
  OBJECTION_DOMAINS,
  OBJECTION_DOMAIN_LABELS,
  BAKU_REAL_ESTATE_LEXICON,
  CORE_AGENCY_INVARIANTS,
  FORBIDDEN_PHRASES,
  ANTI_ROBOTIC_FORBIDDEN_PHRASES,
  checkForbiddenPhrases,
  hasForbiddenPhrase,
  buildAgentSystemInstruction,
} from "../lib/agent-personas";

describe("Agent Personas & Core Invariants (Tri-Persona Council)", () => {
  const triPersonaIds: AgentPersonaId[] = ["mudir", "analitika", "musteri_psixologiyasi"];
  const legacyAliases: LegacyPersonaId[] = ["farabi", "teymur", "usta"];

  it("asserts all 3 Tri-Persona council members exist and have non-empty system prompts", () => {
    for (const personaId of triPersonaIds) {
      const persona = AGENT_PERSONAS[personaId];
      expect(persona, `Persona ${personaId} must be defined`).toBeDefined();
      expect(persona.id).toBe(personaId);
      expect(persona.title).toBeTruthy();
      expect(persona.roleSubtitle).toBeTruthy();
      expect(persona.avatarIcon).toBeTruthy();
      expect(typeof persona.systemPrompt).toBe("string");
      expect(persona.systemPrompt.trim().length).toBeGreaterThan(50);
      expect(persona.quickPills).toBeInstanceOf(Array);
      expect(persona.quickPills.length).toBeGreaterThan(0);
      expect(persona.memoryDomains).toBeInstanceOf(Array);
      expect(persona.memoryDomains.length).toBeGreaterThan(0);
      expect(persona.supportedActions).toBeInstanceOf(Array);
      expect(persona.supportedActions).toContain("OPEN_STAGE_CARD");
    }
  });

  it("verifies backward-compatibility aliases correctly map to modern tri-personas", () => {
    expect(PERSONA_ALIASES.farabi).toBe("musteri_psixologiyasi");
    expect(PERSONA_ALIASES.teymur).toBe("analitika");
    expect(PERSONA_ALIASES.usta).toBe("mudir");

    expect(resolvePersonaId("farabi")).toBe("musteri_psixologiyasi");
    expect(resolvePersonaId("teymur")).toBe("analitika");
    expect(resolvePersonaId("usta")).toBe("mudir");

    expect(getAgentPersona("farabi").id).toBe("musteri_psixologiyasi");
    expect(getAgentPersona("teymur").id).toBe("analitika");
    expect(getAgentPersona("usta").id).toBe("mudir");
  });

  it("verifies all 5 standardized objection domains are configured", () => {
    expect(OBJECTION_DOMAINS.PRICE_PER_M2).toBe("OBJECTION_PRICE_PER_M2");
    expect(OBJECTION_DOMAINS.KUPCA_TRUST).toBe("OBJECTION_KUPCA_TRUST");
    expect(OBJECTION_DOMAINS.LOCATION).toBe("OBJECTION_LOCATION");
    expect(OBJECTION_DOMAINS.COMMISSION).toBe("OBJECTION_COMMISSION");
    expect(OBJECTION_DOMAINS.TIMING_GHOST).toBe("OBJECTION_TIMING_GHOST");

    expect(Object.keys(OBJECTION_DOMAINS)).toHaveLength(5);
    expect(Object.keys(OBJECTION_DOMAIN_LABELS)).toHaveLength(5);
  });

  it("verifies Baku Real Estate Lexicon constants", () => {
    expect(BAKU_REAL_ESTATE_LEXICON.KUPCA_CONFIRMATION).toContain("Kupçası əldədir");
    expect(BAKU_REAL_ESTATE_LEXICON.MORTGAGE_ELIGIBLE).toContain("İpotekaya");
    expect(BAKU_REAL_ESTATE_LEXICON.STARTING_PRICE).toContain("Start qiymətdir");
    expect(BAKU_REAL_ESTATE_LEXICON.NOTARY_DEPOSIT_CHECK).toContain("Beh verməzdən əvvəl");
  });

  it("asserts forbidden phrases list contains critical anti-robotic phrases", () => {
    expect(FORBIDDEN_PHRASES).toContain("Hörmətli istifadəçi");
    expect(FORBIDDEN_PHRASES).toContain("Hörmətli müştəri");
    expect(FORBIDDEN_PHRASES).toContain("Sizə necə kömək edə bilərəm");
    expect(FORBIDDEN_PHRASES).toContain("Bağışlayın");
    expect(FORBIDDEN_PHRASES).toContain("I apologize");
    expect(ANTI_ROBOTIC_FORBIDDEN_PHRASES).toEqual(FORBIDDEN_PHRASES);
  });

  it("asserts CORE_AGENCY_INVARIANTS contains required legal and business mandates", () => {
    expect(CORE_AGENCY_INVARIANTS).toHaveProperty("KUPCA_MANDATE");
    expect(CORE_AGENCY_INVARIANTS).toHaveProperty("COMMISSION_FLOOR_DEFENSE");
    expect(CORE_AGENCY_INVARIANTS).toHaveProperty("BAKU_MEDIAN_VALUATION");

    expect(CORE_AGENCY_INVARIANTS.KUPCA_MANDATE).toContain("Kupçasız");
    expect(CORE_AGENCY_INVARIANTS.KUPCA_MANDATE).toContain("Dövlət Reyestrindən Çıxarışı");

    expect(CORE_AGENCY_INVARIANTS.COMMISSION_FLOOR_DEFENSE).toContain("50-100 AZN");
    expect(CORE_AGENCY_INVARIANTS.COMMISSION_FLOOR_DEFENSE).toContain("2000-5000 AZN");

    expect(CORE_AGENCY_INVARIANTS.BAKU_MEDIAN_VALUATION).toContain("Nəsimi");
    expect(CORE_AGENCY_INVARIANTS.BAKU_MEDIAN_VALUATION).toContain("Yasamal");
    expect(CORE_AGENCY_INVARIANTS.BAKU_MEDIAN_VALUATION).toContain("Xətai");
  });

  it("verifies individual personas have correct tier models and thinking configurations", () => {
    expect(AGENT_PERSONAS.mudir.defaultModel).toBe("gemini-3.8-flash");
    expect(AGENT_PERSONAS.mudir.thinkingLevel).toBe("low");

    expect(AGENT_PERSONAS.analitika.defaultModel).toBe("gemini-3.8-flash");
    expect(AGENT_PERSONAS.analitika.thinkingLevel).toBe("low");

    expect(AGENT_PERSONAS.musteri_psixologiyasi.defaultModel).toBe("gemini-3.8-flash");
    expect(AGENT_PERSONAS.musteri_psixologiyasi.thinkingLevel).toBe("low");
  });

  it("guarantees no persona systemPrompt contains any forbidden robotic phrase", () => {
    for (const personaId of triPersonaIds) {
      const persona = AGENT_PERSONAS[personaId];
      const violations = checkForbiddenPhrases(persona.systemPrompt);
      expect(
        violations,
        `Persona ${personaId} systemPrompt violated anti-robotic rules with: ${violations.join(", ")}`
      ).toHaveLength(0);
    }
  });

  it("tests helper functions getAgentPersona and isValidAgentPersonaId", () => {
    expect(isValidAgentPersonaId("mudir")).toBe(true);
    expect(isValidAgentPersonaId("analitika")).toBe(true);
    expect(isValidAgentPersonaId("musteri_psixologiyasi")).toBe(true);
    // Legacy IDs still pass validation
    expect(isValidAgentPersonaId("farabi")).toBe(true);
    expect(isValidAgentPersonaId("usta")).toBe(true);
    expect(isValidAgentPersonaId("teymur")).toBe(true);
    expect(isValidAgentPersonaId("unknown_agent")).toBe(false);
    expect(isValidAgentPersonaId(null)).toBe(false);

    const mudir = getAgentPersona("mudir");
    expect(mudir.id).toBe("mudir");

    // Fallback to mudir if unknown persona requested
    const fallback = getAgentPersona("nonexistent");
    expect(fallback.id).toBe("mudir");
  });

  it("tests checkForbiddenPhrases and hasForbiddenPhrase detection", () => {
    expect(hasForbiddenPhrase("Hörmətli istifadəçi, necə kömək edim?")).toBe(true);
    expect(hasForbiddenPhrase("Hörmətli müştəri, sizin üçün təklif.")).toBe(true);
    expect(hasForbiddenPhrase("Sizə necə kömək edə bilərəm")).toBe(true);
    expect(hasForbiddenPhrase("Bağışlayın, mən başa düşmədim.")).toBe(true);
    expect(hasForbiddenPhrase("I apologize for the confusion.")).toBe(true);
    expect(hasForbiddenPhrase("Mənzilin Kupçası var, çıxarış tam qaydasındadır.")).toBe(false);

    const matches = checkForbiddenPhrases("Hörmətli istifadəçi, Bağışlayın!");
    expect(matches).toContain("Hörmətli istifadəçi");
    expect(matches).toContain("Bağışlayın");
  });

  it("builds assembled agent system prompt with invariants and episodic insights", () => {
    const fullPrompt = buildAgentSystemInstruction("musteri_psixologiyasi", {
      learnedInsights: [
        "Xətai rayonunda alıcılar 2000 AZN-dən artıq beh verməyə tərəddüd edirlər.",
        "Kupçasız evlərdə Beh müqaviləsi notarial qaydada deyil, daxili şərtlə bağlanır.",
      ],
      operatorContext: "Lead ID: lead-442 | Listing: 5616503",
    });

    expect(fullPrompt).toContain("Sən BakuEstate-AI agentliyinin Bakı Realizmi üzrə CRM");
    expect(fullPrompt).toContain("DƏYİŞMƏZ AGENTLİK QANUNLARI (CORE INVARIANTS)");
    expect(fullPrompt).toContain(CORE_AGENCY_INVARIANTS.KUPCA_MANDATE);
    expect(fullPrompt).toContain(CORE_AGENCY_INVARIANTS.COMMISSION_FLOOR_DEFENSE);
    expect(fullPrompt).toContain(CORE_AGENCY_INVARIANTS.BAKU_MEDIAN_VALUATION);
    expect(fullPrompt).toContain("YADDAŞDAN ÇIXARIŞLAR (EPISODIC INSIGHTS)");
    expect(fullPrompt).toContain("Xətai rayonunda alıcılar 2000 AZN-dən artıq beh verməyə tərəddüd edirlər");
    expect(fullPrompt).toContain("CARİ ƏMƏLİYYAT KONTEKSTİ");
    expect(fullPrompt).toContain("Lead ID: lead-442");
    expect(fullPrompt).toContain("stage:VIDEO_INSPECTION");
  });
});
