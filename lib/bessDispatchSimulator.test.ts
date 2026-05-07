import { simulateBessDispatch, type BessDispatchDayInput } from "@/lib/bessDispatchSimulator";

const buildDuckCurveDay = (): BessDispatchDayInput => {
  const dateBerlin = "2026-05-07";
  const timestampsIso: string[] = [];
  const hourBerlin: number[] = [];
  const loadMw: number[] = [];
  const totalGenerationMw: number[] = [];
  const residualLoadMw: number[] = [];
  const renewableShareOfLoadPct: number[] = [];

  for (let q = 0; q < 96; q += 1) {
    const hour = Math.floor(q / 4);
    const minute = (q % 4) * 15;
    timestampsIso.push(`${dateBerlin}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+02:00`);
    hourBerlin.push(hour);

    const load = 55_000;
    let residual: number;
    let ren: number;
    if (hour >= 10 && hour <= 14) {
      residual = -8_000 + (hour - 10) * 1_500;
      ren = 82;
    } else if (hour >= 17 && hour < 21) {
      residual = 48_000 + (hour - 17) * 3_000;
      ren = 35;
    } else {
      residual = 28_000;
      ren = 52;
    }
    const renewableGen = load - residual;
    const conventional = 12_000;
    const gen = renewableGen + conventional;

    loadMw.push(load);
    totalGenerationMw.push(gen);
    residualLoadMw.push(residual);
    renewableShareOfLoadPct.push(ren);
  }

  return {
    dateBerlin,
    timestampsIso,
    hourBerlin,
    loadMw,
    totalGenerationMw,
    residualLoadMw,
    renewableShareOfLoadPct,
    eveningFlexibilityGapMw: 30_000,
    renewableShareCurrentPct: 48,
  };
};

describe("simulateBessDispatch", () => {
  const day = buildDuckCurveDay();

  it("returns aligned series and respects SoC band", () => {
    const out = simulateBessDispatch({
      powerMW: 500,
      energyMWh: 2_000,
      efficiency: 0.92,
      strategy: "arbitrage_gap",
      day,
    });
    expect(out.powerDispatchMw).toHaveLength(out.socMwh.length);
    expect(out.quarters).toHaveLength(out.socMwh.length);
    for (const s of out.socMwh) {
      expect(s).toBeGreaterThanOrEqual(out.params.energyMWh * 0.1 - 1e-3);
      expect(s).toBeLessThanOrEqual(out.params.energyMWh * 0.9 + 1e-3);
    }
  });

  it("produces positive net revenue on a spread day", () => {
    const out = simulateBessDispatch({
      powerMW: 500,
      energyMWh: 2_000,
      efficiency: 0.92,
      strategy: "arbitrage_gap",
      day,
    });
    expect(out.economics.grossRevenueEur).toBeGreaterThan(0);
    expect(out.economics.averageSpreadEurPerMwh).toBeGreaterThan(0);
  });

  it("prefers evening discharge slots (coverage fraction)", () => {
    const out = simulateBessDispatch({
      powerMW: 500,
      energyMWh: 2_000,
      efficiency: 0.92,
      strategy: "arbitrage_gap",
      day,
    });
    const eveningDischargeSlots = out.quarters.filter(
      (q) => q.hourBerlin >= 17 && q.hourBerlin < 21 && q.powerMw > 0
    );
    expect(eveningDischargeSlots.length).toBeGreaterThan(0);
  });

  it("reports evening gap KPIs", () => {
    const out = simulateBessDispatch({
      powerMW: 500,
      energyMWh: 2_000,
      efficiency: 0.92,
      strategy: "arbitrage_gap",
      day,
    });
    expect(out.evening.flexibilityGapMw).toBe(30_000);
    expect(out.evening.gapCoveredMw).toBeGreaterThanOrEqual(0);
    expect(out.evening.gapCoveredMw).toBeLessThanOrEqual(out.evening.flexibilityGapMw + 1e-6);
  });

  it("rejects invalid efficiency", () => {
    expect(() =>
      simulateBessDispatch({
        powerMW: 500,
        energyMWh: 2_000,
        efficiency: 1.1,
        strategy: "arbitrage_gap",
        day,
      })
    ).toThrow(/efficiency/);
  });
});
