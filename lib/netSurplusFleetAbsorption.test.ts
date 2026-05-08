import { computeNetSurplusFleetAbsorption } from "@/lib/netSurplusFleetAbsorption";

describe("computeNetSurplusFleetAbsorption", () => {
  it("sums gross surplus when gen exceeds load each quarter-hour", () => {
    const slots = Array.from({ length: 4 }, () => ({
      totalGenerationMw: 40_000,
      loadMw: 30_000,
    }));
    const r = computeNetSurplusFleetAbsorption(slots, 500_000, 500_000);
    /** 10_000 MW × ¼ h × 4 = 10_000 MWh */
    expect(r.grossSurplusEnergyMwh).toBeCloseTo(10_000, 5);
    expect(r.absorbedEnergyMwh).toBeCloseTo(10_000, 5);
    expect(r.missedSurplusEnergyMwh).toBeCloseTo(0, 5);
    expect(r.inferredFleetSocPctSeries.every((p) => p <= 100 + 1e-6)).toBe(true);
  });

  it("caps absorption by fleet energy capacity (full recharge then spill)", () => {
    const slots = Array.from({ length: 4 }, () => ({
      totalGenerationMw: 40_000,
      loadMw: 30_000,
    }));
    const r = computeNetSurplusFleetAbsorption(slots, 1_000, 50_000);
    expect(r.grossSurplusEnergyMwh).toBeCloseTo(10_000, 5);
    expect(r.absorbedEnergyMwh).toBeCloseTo(1_000, 5);
    expect(r.missedSurplusEnergyMwh).toBeCloseTo(9_000, 5);
    expect(r.endSocMwh).toBeCloseTo(1_000, 5);
  });

  it("caps per-slot energy by fleet power (MW × ¼ h)", () => {
    const slots = Array.from({ length: 4 }, () => ({
      totalGenerationMw: 40_000,
      loadMw: 30_000,
    }));
    const r = computeNetSurplusFleetAbsorption(slots, 500_000, 2_000);
    /** Per slot surplus 2_500 MWh but power cap 2_000 × 0.25 = 500 MWh */
    expect(r.absorbedEnergyMwh).toBeCloseTo(2_000, 5);
    expect(r.missedSurplusEnergyMwh).toBeCloseTo(8_000, 5);
  });

  it("returns zero absorption when no energy capacity is provided", () => {
    const slots = [{ totalGenerationMw: 50_000, loadMw: 40_000 }];
    const r = computeNetSurplusFleetAbsorption(slots, null, 10_000);
    expect(r.grossSurplusEnergyMwh).toBeCloseTo(2_500, 5);
    expect(r.absorbedEnergyMwh).toBe(0);
    expect(r.missedSurplusEnergyMwh).toBeCloseTo(2_500, 5);
    expect(r.inferredFleetSocPctSeries).toEqual([0]);
  });
});
