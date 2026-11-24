import { describe, it, expect } from "vitest";
import { resolveDistrictCorridor, DISTRICT_LIQUIDITY_CORRIDORS } from "@/lib/market-benchmarks";

describe("market-benchmarks", () => {
  it("resolves Yasamal corridor", () => {
    const res = resolveDistrictCorridor("Bakı, Yasamal r., İnşaatçılar m.");
    expect(res.label).toBe("Yasamal r.");
    expect(res.min).toBe(2200);
    expect(res.max).toBe(2800);
  });

  it("resolves Sabail luxury corridor", () => {
    const res = resolveDistrictCorridor("Bakı şəhəri, Səbail rayonu, Badamdar");
    expect(res.label).toBe("Səbail r.");
    expect(res.min).toBe(3200);
    expect(res.max).toBe(4800);
  });

  it("falls back to default Baku average when district is unknown", () => {
    const res = resolveDistrictCorridor("Qaradağ r., Lökbatan");
    expect(res.label).toBe("Bakı Ortalaması");
    expect(res.min).toBe(2000);
    expect(res.max).toBe(3000);
  });
});
