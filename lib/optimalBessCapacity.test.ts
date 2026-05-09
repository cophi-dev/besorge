import {
  computeCoverageAtCapacityMwh,
  computeOptimalSurplusDeficitCapacityMwh,
  computePracticalDailyCycleCapacityMwh,
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

