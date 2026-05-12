import type { GermanyDispatchSlot } from "@/lib/energyChartsApi";
import { computeBriefingDayShape } from "@/lib/morningBriefingContext";

function mkSlot(hour: number, genMw: number, loadMw: number, renewableMw: number | null): GermanyDispatchSlot {
  return {
    timestampIso: "2026-05-09T12:00:00.000Z",
    hourBerlin: hour,
    residualLoadMw: loadMw - (renewableMw ?? 0),
    loadMw,
    totalGenerationMw: genMw,
    renewableGenerationMw: renewableMw,
    crossBorderElectricityTradingMw: null,
  };
}

describe("computeBriefingDayShape", () => {
  it("sums structural net by Berlin-hour band (day core, evening ramp, overnight/base)", () => {
    const slots = [
      mkSlot(3, 900, 1000, 400), // overnightBase: −25 MWh
      mkSlot(12, 1200, 1000, 800), // dayCore: +50 MWh
      mkSlot(19, 700, 1000, null), // eveningRamp: −75 MWh
    ];
    const shape = computeBriefingDayShape(slots);
    expect(shape.structuralNetGwhByWindow.overnightBaseGwh).toBeCloseTo(-25 / 1000, 6);
    expect(shape.structuralNetGwhByWindow.dayCoreGwh).toBeCloseTo(50 / 1000, 6);
    expect(shape.structuralNetGwhByWindow.eveningRampGwh).toBeCloseTo(-75 / 1000, 6);
    const total =
      shape.structuralNetGwhByWindow.overnightBaseGwh +
      shape.structuralNetGwhByWindow.dayCoreGwh +
      shape.structuralNetGwhByWindow.eveningRampGwh;
    expect(total).toBeCloseTo(-50 / 1000, 6);
  });

  it("computes renewable-only structural balance when renewable MW is present", () => {
    const slots = [
      mkSlot(12, 1200, 1000, 700), // renewable − load = −300 per slot * 0.25 = −75 MWh
      mkSlot(12, 1200, 1000, 700),
    ];
    const shape = computeBriefingDayShape(slots);
    expect(shape.renewableNetStructuralBalanceGwh).toBeCloseTo(-150 / 1000, 6);
    expect(shape.renewableSlotFractionOfSampled).toBe(1);
  });

  it("returns null renewable net when no slot has renewable data", () => {
    const slots = [mkSlot(10, 1000, 1000, null)];
    const shape = computeBriefingDayShape(slots);
    expect(shape.renewableNetStructuralBalanceGwh).toBeNull();
    expect(shape.renewableSlotFractionOfSampled).toBe(0);
  });

  it("picks peak surplus and deficit hours from hourly structural sums", () => {
    const slots = [
      mkSlot(11, 2000, 1000, 500), // +250 MWh
      mkSlot(18, 500, 1000, 200), // −125 MWh
    ];
    const shape = computeBriefingDayShape(slots);
    expect(shape.peakSurplusHourBerlin).toBe(11);
    expect(shape.peakDeficitHourBerlin).toBe(18);
  });

  it("returns null peaks when no hour is in surplus or deficit", () => {
    const slots = [mkSlot(10, 1000, 1000, 500)]; // net 0
    const shape = computeBriefingDayShape(slots);
    expect(shape.peakSurplusHourBerlin).toBeNull();
    expect(shape.peakDeficitHourBerlin).toBeNull();
  });

  it("handles empty slots", () => {
    expect(computeBriefingDayShape([]).structuralNetGwhByWindow.dayCoreGwh).toBe(0);
    expect(computeBriefingDayShape([]).renewableNetStructuralBalanceGwh).toBeNull();
    expect(computeBriefingDayShape([]).renewableSlotFractionOfSampled).toBe(0);
  });
});
