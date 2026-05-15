import {
  borderCoupledBatteryChargeMw,
  computeDailyBessSizingProfiles,
  computeLogicalBessRecommendation,
  computeCoverageAtCapacityMwh,
  computeOptimalSurplusDeficitCapacityMwh,
  computePracticalDailyCycleCapacityMwh,
  computeStitchedPracticalInitialSocMwh,
  simulateAdjustedNetMwAtCapacity,
  simulatePracticalDispatchAtCapacity,
  simulateSocPctAtCapacityMwh,
} from "@/lib/optimalBessCapacity";

describe("computeOptimalSurplusDeficitCapacityMwh", () => {
  it("tracks max SoC when charging on surplus and discharging on deficit", () => {
    const slots = [
      { totalGenerationMw: 1200, loadMw: 1000 }, // +200 MW => +50 MWh
      { totalGenerationMw: 1500, loadMw: 1000 }, // +500 MW => +125 MWh (SoC 175)
      { totalGenerationMw: 800, loadMw: 1000 }, // -200 MW => -50 MWh (SoC 125)
      { totalGenerationMw: 600, loadMw: 1000 }, // -400 MW => -100 MWh (SoC 25)
      { totalGenerationMw: 500, loadMw: 1000 }, // -500 MW => -125 MWh (SoC floored to 0)
      { totalGenerationMw: 1400, loadMw: 1000 }, // +400 MW => +100 MWh
    ];
    const result = computeOptimalSurplusDeficitCapacityMwh(slots);
    expect(result.maxSocMwh).toBeCloseTo(175, 6);
    expect(result.optimalCapacityMwh).toBeCloseTo(175, 6);
    expect(result.endSocMwh).toBeCloseTo(100, 6);
    expect(result.servedDeficitEnergyMwh).toBeCloseTo(175, 6);
  });

  it("treats curtailment as extra charge opportunity without changing structural deficits", () => {
    const slots = [
      { totalGenerationMw: 1000, loadMw: 1000, curtailmentMw: 400 }, // +100 MWh curtailed only
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh deficit
    ];
    const result = computeOptimalSurplusDeficitCapacityMwh(slots);
    expect(result.optimalCapacityMwh).toBeCloseTo(100, 6);
    expect(result.servedDeficitEnergyMwh).toBeCloseTo(100, 6);
    expect(result.endSocMwh).toBeCloseTo(0, 6);
  });
});

describe("computePracticalDailyCycleCapacityMwh", () => {
  it("resets SoC per Berlin day and returns P95 practical capacity", () => {
    const slots = [
      // Day 1: required 100 MWh
      { timestampIso: "2026-04-01T00:00:00.000Z", totalGenerationMw: 1400, loadMw: 1000 }, // +100
      { timestampIso: "2026-04-01T00:15:00.000Z", totalGenerationMw: 600, loadMw: 1000 }, // -100
      // Day 2: required 25 MWh
      { timestampIso: "2026-04-02T00:00:00.000Z", totalGenerationMw: 1100, loadMw: 1000 }, // +25
      { timestampIso: "2026-04-02T00:15:00.000Z", totalGenerationMw: 900, loadMw: 1000 }, // -25
    ];
    const result = computePracticalDailyCycleCapacityMwh(slots);
    expect(result.observedDays).toBe(2);
    expect(result.maxDailyRequiredMwh).toBeCloseTo(100, 6);
    expect(result.p95DailyRequiredMwh).toBeCloseTo(96.25, 6);
    expect(result.practicalCapacityMwh).toBeCloseTo(96.25, 6);
  });
});

describe("computeDailyBessSizingProfiles", () => {
  it("returns daily required energy and power profiles", () => {
    const slots = [
      { timestampIso: "2026-04-01T00:00:00.000Z", totalGenerationMw: 1400, loadMw: 1000 }, // +100 MWh, +400 MW
      { timestampIso: "2026-04-01T00:15:00.000Z", totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh, 400 MW discharge
      { timestampIso: "2026-04-02T00:00:00.000Z", totalGenerationMw: 1200, loadMw: 1000 }, // +50 MWh, +200 MW
      { timestampIso: "2026-04-02T00:15:00.000Z", totalGenerationMw: 900, loadMw: 1000 }, // -25 MWh, 100 MW discharge
    ];
    const profiles = computeDailyBessSizingProfiles(slots);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.requiredEnergyMwh).toBeCloseTo(100, 6);
    expect(profiles[0]?.requiredPowerMw).toBeCloseTo(400, 6);
    expect(profiles[1]?.requiredEnergyMwh).toBeCloseTo(50, 6);
    expect(profiles[1]?.requiredPowerMw).toBeCloseTo(200, 6);
  });
});

describe("computeLogicalBessRecommendation", () => {
  it("derives aggressive, balanced and conservative recommendation tiers", () => {
    const slots = [
      // day 1
      { timestampIso: "2026-04-01T00:00:00.000Z", totalGenerationMw: 1400, loadMw: 1000 },
      { timestampIso: "2026-04-01T00:15:00.000Z", totalGenerationMw: 600, loadMw: 1000 },
      // day 2
      { timestampIso: "2026-04-02T00:00:00.000Z", totalGenerationMw: 1200, loadMw: 1000 },
      { timestampIso: "2026-04-02T00:15:00.000Z", totalGenerationMw: 900, loadMw: 1000 },
      // day 3
      { timestampIso: "2026-04-03T00:00:00.000Z", totalGenerationMw: 1600, loadMw: 1000 },
      { timestampIso: "2026-04-03T00:15:00.000Z", totalGenerationMw: 600, loadMw: 1000 },
    ];
    const recommendation = computeLogicalBessRecommendation(slots);
    expect(recommendation.observedDays).toBe(3);
    expect(recommendation.tiers.map((entry) => entry.label)).toEqual([
      "aggressive",
      "balanced",
      "conservative",
    ]);
    expect(recommendation.tiers[0]?.recommendedEnergyMwh).toBeGreaterThan(0);
    expect(recommendation.tiers[1]?.recommendedPowerMw).toBeGreaterThan(0);
    expect(recommendation.continuousWindowRequiredEnergyMwh).toBeGreaterThan(0);
  });
});

describe("computeCoverageAtCapacityMwh", () => {
  it("reports surplus and deficit coverage shares at a fixed capacity", () => {
    const slots = [
      { totalGenerationMw: 1400, loadMw: 1000 }, // +100 MWh
      { totalGenerationMw: 1400, loadMw: 1000 }, // +100 MWh
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh
    ];
    const result = computeCoverageAtCapacityMwh(slots, 100);
    expect(result.totalSurplusEnergyMwh).toBeCloseTo(200, 6);
    expect(result.totalDeficitEnergyMwh).toBeCloseTo(200, 6);
    expect(result.absorbedSurplusEnergyMwh).toBeCloseTo(100, 6);
    expect(result.servedDeficitEnergyMwh).toBeCloseTo(100, 6);
    expect(result.absorbedSurplusShare).toBeCloseTo(0.5, 6);
    expect(result.servedDeficitShare).toBeCloseTo(0.5, 6);
    expect(result.totalCurtailmentEnergyMwh).toBeCloseTo(0, 6);
    expect(result.totalChargeOpportunityEnergyMwh).toBeCloseTo(200, 6);
  });

  it("can reset SoC at Berlin day boundaries", () => {
    const slots = [
      { timestampIso: "2026-04-01T08:00:00.000Z", totalGenerationMw: 1400, loadMw: 1000 }, // +100 MWh
      { timestampIso: "2026-04-02T08:00:00.000Z", totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh
    ];
    const continuous = computeCoverageAtCapacityMwh(slots, 100);
    const dailyReset = computeCoverageAtCapacityMwh(slots, 100, { resetDailyByBerlin: true });
    expect(continuous.servedDeficitEnergyMwh).toBeCloseTo(100, 6);
    expect(dailyReset.servedDeficitEnergyMwh).toBeCloseTo(0, 6);
  });

  it("respects power cap when covering deficits and surpluses", () => {
    const slots = [
      { totalGenerationMw: 1400, loadMw: 1000 }, // +100 MWh
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh
    ];
    const powerLimited = computeCoverageAtCapacityMwh(slots, 500, { maxPowerMw: 100 }); // 25 MWh/slot
    expect(powerLimited.absorbedSurplusEnergyMwh).toBeCloseTo(25, 6);
    expect(powerLimited.servedDeficitEnergyMwh).toBeCloseTo(25, 6);
  });

  it("reduces absorbed surplus share when starting partly full", () => {
    const slots = [{ totalGenerationMw: 1400, loadMw: 1000 }]; // +100 MWh single slot
    const emptyStart = computeCoverageAtCapacityMwh(slots, 100, {});
    const halfStart = computeCoverageAtCapacityMwh(slots, 100, { initialSocMwh: 50 });
    expect(emptyStart.absorbedSurplusShare).toBeCloseTo(1, 6);
    expect(halfStart.absorbedSurplusEnergyMwh).toBeCloseTo(50, 6);
    expect(halfStart.absorbedSurplusShare).toBeCloseTo(0.5, 6);
  });

  it("includes curtailment in absorbed charge-opportunity share", () => {
    const slots = [
      { totalGenerationMw: 1000, loadMw: 1000, curtailmentMw: 400 }, // +100 MWh extra charge opportunity
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh
    ];
    const result = computeCoverageAtCapacityMwh(slots, 50, { maxPowerMw: 400 });
    expect(result.totalSurplusEnergyMwh).toBeCloseTo(0, 6);
    expect(result.totalCurtailmentEnergyMwh).toBeCloseTo(100, 6);
    expect(result.totalChargeOpportunityEnergyMwh).toBeCloseTo(100, 6);
    expect(result.absorbedSurplusEnergyMwh).toBeCloseTo(50, 6);
    expect(result.absorbedSurplusShare).toBeCloseTo(0.5, 6);
    expect(result.servedDeficitEnergyMwh).toBeCloseTo(50, 6);
  });
});

describe("computeStitchedPracticalInitialSocMwh", () => {
  it("matches two-day chain into previous-day end energy", () => {
    const dayBefore = [
      { timestampIso: "2026-04-01T00:00:00.000Z", totalGenerationMw: 1100, loadMw: 1000 },
    ];
    const previous = [
      { timestampIso: "2026-04-02T00:00:00.000Z", totalGenerationMw: 1100, loadMw: 1000 },
    ];
    const fromLib = computeStitchedPracticalInitialSocMwh({
      dayBeforePreviousSlots: dayBefore,
      previousDaySlots: previous,
      capacityMwh: 100,
      maxPowerMw: null,
    });
    const stitch0 = simulatePracticalDispatchAtCapacity(dayBefore, 100, {
      resetDailyByBerlin: true,
      maxPowerMw: null,
    });
    const end0 = (stitch0[stitch0.length - 1]!.socPct / 100) * 100;
    const prevWalk = simulatePracticalDispatchAtCapacity(previous, 100, {
      resetDailyByBerlin: true,
      initialSocMwh: end0,
      maxPowerMw: null,
    });
    const manual = (prevWalk[prevWalk.length - 1]!.socPct / 100) * 100;
    expect(fromLib).toBeCloseTo(manual, 6);
  });
});

describe("simulateSocPctAtCapacityMwh", () => {
  it("simulates charge and discharge SoC bounded by capacity", () => {
    const slots = [
      { totalGenerationMw: 1400, loadMw: 1000 }, // +100 MWh
      { totalGenerationMw: 1400, loadMw: 1000 }, // +100 MWh
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh
    ];
    const series = simulateSocPctAtCapacityMwh(slots, 100);
    expect(series).toEqual([100, 100, 0, 0]);
  });

  it("supports an initial soc carry-over estimate", () => {
    const slots = [
      { totalGenerationMw: 1000, loadMw: 1000 }, // flat
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh
    ];
    const series = simulateSocPctAtCapacityMwh(slots, 100, { initialSocMwh: 50 });
    expect(series).toEqual([50, 0]);
  });

  it("applies per-slot power cap to SoC evolution", () => {
    const slots = [
      { totalGenerationMw: 1400, loadMw: 1000 }, // +100 MWh gross
      { totalGenerationMw: 600, loadMw: 1000 }, // -100 MWh gross
    ];
    const series = simulateSocPctAtCapacityMwh(slots, 200, { maxPowerMw: 100 }); // 25 MWh/slot
    expect(series).toEqual([12.5, 0]);
  });
});

describe("simulateAdjustedNetMwAtCapacity", () => {
  it("flattens net balance toward zero with storage dispatch", () => {
    const slots = [
      { totalGenerationMw: 1400, loadMw: 1000 }, // +400 MW
      { totalGenerationMw: 800, loadMw: 1000 }, // -200 MW
      { totalGenerationMw: 600, loadMw: 1000 }, // -400 MW
    ];
    const adjusted = simulateAdjustedNetMwAtCapacity(slots, 100);
    expect(adjusted).toEqual([0, 0, -200]);
  });

  it("limits net adjustment by configured power cap", () => {
    const slots = [{ totalGenerationMw: 1400, loadMw: 1000 }]; // +400 MW
    const adjusted = simulateAdjustedNetMwAtCapacity(slots, 500, { maxPowerMw: 100 });
    expect(adjusted).toEqual([300]);
  });

  it("does not distort the structural net trace when charging from curtailed energy", () => {
    const slots = [{ totalGenerationMw: 1000, loadMw: 1000, curtailmentMw: 400 }];
    const adjusted = simulateAdjustedNetMwAtCapacity(slots, 500, { maxPowerMw: 400 });
    expect(adjusted).toEqual([0]);
  });
});

describe("borderCoupledBatteryChargeMw", () => {
  it("treats surplus- and curtailment-covered charging as domestic (no border coupling)", () => {
    const slot = { totalGenerationMw: 1200, loadMw: 1000, curtailmentMw: 50 };
    expect(borderCoupledBatteryChargeMw(slot, 200)).toBe(0);
    expect(borderCoupledBatteryChargeMw(slot, 250)).toBe(0);
  });

  it("returns excess charge above domestic slack only", () => {
    const slot = { totalGenerationMw: 1050, loadMw: 1000, curtailmentMw: 0 };
    expect(borderCoupledBatteryChargeMw(slot, 50)).toBe(0);
    expect(borderCoupledBatteryChargeMw(slot, 100)).toBeCloseTo(50, 6);
    expect(borderCoupledBatteryChargeMw(slot, 120)).toBeCloseTo(70, 6);
  });

  it("returns 0 for non-positive charge", () => {
    const slot = { totalGenerationMw: 2000, loadMw: 1000 };
    expect(borderCoupledBatteryChargeMw(slot, 0)).toBe(0);
    expect(borderCoupledBatteryChargeMw(slot, -5)).toBe(0);
  });
});

describe("simulatePracticalDispatchAtCapacity", () => {
  it("returns per-slot practical charge/discharge dispatch and soc", () => {
    const slots = [
      { totalGenerationMw: 1400, loadMw: 1000 }, // +400 MW
      { totalGenerationMw: 1400, loadMw: 1000 }, // +400 MW (already full after first slot at 100 MWh cap)
      { totalGenerationMw: 800, loadMw: 1000 }, // -200 MW
      { totalGenerationMw: 600, loadMw: 1000 }, // -400 MW
    ];

    const series = simulatePracticalDispatchAtCapacity(slots, 100);

    expect(series).toEqual([
      { chargeMw: 400, dischargeMw: 0, socPct: 100 },
      { chargeMw: 0, dischargeMw: 0, socPct: 100 },
      { chargeMw: 0, dischargeMw: 200, socPct: 50 },
      { chargeMw: 0, dischargeMw: 200, socPct: 0 },
    ]);
  });

  it("resets soc and dispatch at Berlin day boundaries", () => {
    const slots = [
      { timestampIso: "2026-04-01T08:00:00.000Z", totalGenerationMw: 1400, loadMw: 1000 }, // +400 MW
      { timestampIso: "2026-04-02T08:00:00.000Z", totalGenerationMw: 600, loadMw: 1000 }, // -400 MW
    ];

    const seriesNoReset = simulatePracticalDispatchAtCapacity(slots, 100);
    const seriesReset = simulatePracticalDispatchAtCapacity(slots, 100, {
      resetDailyByBerlin: true,
    });

    expect(seriesNoReset[1]).toEqual({ chargeMw: 0, dischargeMw: 400, socPct: 0 });
    expect(seriesReset[1]).toEqual({ chargeMw: 0, dischargeMw: 0, socPct: 0 });
  });
});

