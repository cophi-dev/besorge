import {
  computeCyclingFleetSurplusAbsorption,
  computeNetSurplusFleetAbsorption,
} from "@/lib/netSurplusFleetAbsorption";

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

  it("adds curtailed energy to charge opportunity and missed energy", () => {
    const slots = [{ totalGenerationMw: 0, loadMw: 0, curtailmentMw: 100 }];
    const r = computeNetSurplusFleetAbsorption(slots, 10, 1_000);
    expect(r.grossSurplusEnergyMwh).toBeCloseTo(0, 5);
    expect(r.curtailedEnergyMwh).toBeCloseTo(25, 5);
    expect(r.grossChargeOpportunityEnergyMwh).toBeCloseTo(25, 5);
    expect(r.absorbedEnergyMwh).toBeCloseTo(10, 5);
    expect(r.missedSurplusEnergyMwh).toBeCloseTo(15, 5);
  });
});

describe("computeCyclingFleetSurplusAbsorption", () => {
  it("discharges on deficit so a later surplus slot can charge again (charge-only misses that tail)", () => {
    /** 100 MW net for ¼ h = 25 MWh per slot cap; full–empty–full pattern. */
    const slots = [
      { totalGenerationMw: 100, loadMw: 0 },
      { totalGenerationMw: 0, loadMw: 100 },
      { totalGenerationMw: 100, loadMw: 0 },
    ];
    const capMwh = 25;
    const powerMw = 500_000;

    const chargeOnly = computeNetSurplusFleetAbsorption(slots, capMwh, powerMw);
    const cycling = computeCyclingFleetSurplusAbsorption(slots, capMwh, powerMw, {
      resetDailyByBerlin: false,
    });

    expect(chargeOnly.grossSurplusEnergyMwh).toBeCloseTo(50, 5);
    expect(chargeOnly.absorbedEnergyMwh).toBeCloseTo(25, 5);

    expect(cycling.grossSurplusEnergyMwh).toBeCloseTo(50, 5);
    expect(cycling.absorbedEnergyMwh).toBeCloseTo(50, 5);
    expect(cycling.missedSurplusEnergyMwh).toBeCloseTo(0, 5);
  });

  it("matches charge-only behaviour when surplus never follows a fuller battery", () => {
    const slots = Array.from({ length: 4 }, () => ({
      totalGenerationMw: 40_000,
      loadMw: 30_000,
    }));
    const r = computeCyclingFleetSurplusAbsorption(slots, 500_000, 500_000, {
      resetDailyByBerlin: false,
    });
    expect(r.grossSurplusEnergyMwh).toBeCloseTo(10_000, 5);
    expect(r.absorbedEnergyMwh).toBeCloseTo(10_000, 5);
    expect(r.missedSurplusEnergyMwh).toBeCloseTo(0, 5);
  });
});
