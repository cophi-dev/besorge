import {
  simulateDispatch,
  type DispatchSlotInput,
  type DispatchSimulationInput,
} from "@/lib/dispatchSimulation";

const buildSyntheticDay = (): DispatchSlotInput[] => {
  // 96 slots covering a synthetic Berlin day, with a duck-curve-shaped residual load:
  //   - low/negative residual around midday (cheap charging)
  //   - high residual 17-21h (expensive evening peak)
  const slots: DispatchSlotInput[] = [];
  const baseDate = "2026-05-07";
  for (let q = 0; q < 96; q += 1) {
    const hour = Math.floor(q / 4);
    const minute = (q % 4) * 15;
    const timestampIso = `${baseDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+02:00`;
    let residualLoadMw: number;
    if (hour >= 10 && hour <= 14) {
      residualLoadMw = 5_000 + (12 - hour) * 1_000;
    } else if (hour >= 17 && hour <= 20) {
      residualLoadMw = 60_000 + (hour - 17) * 2_000;
    } else if (hour >= 0 && hour <= 5) {
      residualLoadMw = 25_000;
    } else {
      residualLoadMw = 40_000;
    }
    slots.push({
      timestampIso,
      hourBerlin: hour,
      residualLoadMw,
    });
  }
  return slots;
};

const baseInputs: DispatchSimulationInput = {
  powerMw: 500,
  capacityMwh: 2_000,
  rteEfficiencyPct: 92,
  strategy: "arbitrage_evening_priority",
};

describe("simulateDispatch", () => {
  const day = buildSyntheticDay();

  it("produces a schedule with one entry per input slot", () => {
    const output = simulateDispatch(day, baseInputs);
    expect(output.schedule).toHaveLength(day.length);
  });

  it("places charge slots earlier than discharge slots so SoC stays physical", () => {
    const output = simulateDispatch(day, baseInputs);
    const chargeIndices = output.schedule
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => entry.action === "charge")
      .map(({ i }) => i);
    const dischargeIndices = output.schedule
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => entry.action === "discharge")
      .map(({ i }) => i);
    expect(chargeIndices.length).toBeGreaterThan(0);
    expect(dischargeIndices.length).toBeGreaterThan(0);
    expect(Math.max(...chargeIndices)).toBeLessThan(Math.min(...dischargeIndices));
  });

  it("never breaks SoC bounds", () => {
    const output = simulateDispatch(day, baseInputs);
    for (const entry of output.schedule) {
      expect(entry.socMwh).toBeGreaterThanOrEqual(-1e-6);
      expect(entry.socMwh).toBeLessThanOrEqual(baseInputs.capacityMwh + 1e-6);
    }
  });

  it("delivers the full capacity each cycle (within RTE losses)", () => {
    const output = simulateDispatch(day, baseInputs);
    const sqrtEta = Math.sqrt(baseInputs.rteEfficiencyPct / 100);
    const expectedDelivery = baseInputs.capacityMwh * sqrtEta;
    expect(output.results.energyDischargedToGridMwh).toBeGreaterThan(expectedDelivery * 0.95);
    expect(output.results.energyDischargedToGridMwh).toBeLessThanOrEqual(expectedDelivery + 1e-6);
  });

  it("realises a positive arbitrage spread on a duck-curve day", () => {
    const output = simulateDispatch(day, baseInputs);
    expect(output.results.averageSpreadEurPerMwh).toBeGreaterThan(0);
    expect(output.results.grossRevenueEur).toBeGreaterThan(0);
  });

  it("prioritises the 17–20h evening window", () => {
    const output = simulateDispatch(day, baseInputs);
    expect(output.results.eveningCoveragePct).toBeGreaterThan(70);
  });

  it("reports a round-trip loss roughly matching the configured RTE", () => {
    const output = simulateDispatch(day, baseInputs);
    expect(output.results.roundTripLossPct).toBeGreaterThan(7);
    expect(output.results.roundTripLossPct).toBeLessThan(9);
  });

  it("rejects non-positive power or capacity", () => {
    expect(() =>
      simulateDispatch(day, { ...baseInputs, powerMw: 0 })
    ).toThrow(/powerMw/);
    expect(() =>
      simulateDispatch(day, { ...baseInputs, capacityMwh: -10 })
    ).toThrow(/capacityMwh/);
  });

  it("rejects an out-of-range round-trip efficiency", () => {
    expect(() =>
      simulateDispatch(day, { ...baseInputs, rteEfficiencyPct: 0 })
    ).toThrow(/rteEfficiencyPct/);
    expect(() =>
      simulateDispatch(day, { ...baseInputs, rteEfficiencyPct: 120 })
    ).toThrow(/rteEfficiencyPct/);
  });

  it("returns a flat schedule when no spread is available", () => {
    const flatSlots: DispatchSlotInput[] = day.map((slot) => ({
      ...slot,
      residualLoadMw: 30_000,
    }));
    const output = simulateDispatch(flatSlots, baseInputs);
    expect(output.results.averageSpreadEurPerMwh).toBeCloseTo(0, 5);
    expect(output.results.grossRevenueEur).toBeCloseTo(0, 5);
  });

  it("handles a partial day (e.g. fetched mid-afternoon) without throwing", () => {
    const partial = day.slice(0, 60); // ~15:00 Berlin
    const output = simulateDispatch(partial, baseInputs);
    expect(output.schedule).toHaveLength(60);
    expect(output.diagnostics.samplePoints).toBe(60);
  });
});
