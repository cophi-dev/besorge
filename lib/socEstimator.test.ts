import { computeSlotSurplusFraction, estimateEveningSoc, estimateFleetSocAtMoment } from "@/lib/socEstimator";

describe("estimateEveningSoc", () => {
  it("returns the high band when renewable share clears 70% and last 3 days had >= 2 solar-rich sessions", () => {
    const band = estimateEveningSoc({ renewableShareOfLoadPct: 78, solarRichDays: 2 });
    expect(band.label).toBe("high");
    expect(band.lowPct).toBe(75);
    expect(band.highPct).toBe(85);
    expect(band.midpointPct).toBe(80);
  });

  it("falls back to moderate when renewable share is high but solar streak is insufficient", () => {
    const band = estimateEveningSoc({ renewableShareOfLoadPct: 78, solarRichDays: 1 });
    expect(band.label).toBe("moderate");
  });

  it("returns the moderate band for renewable shares between 50 and 70", () => {
    const band = estimateEveningSoc({ renewableShareOfLoadPct: 62, solarRichDays: 1 });
    expect(band.label).toBe("moderate");
    expect(band.lowPct).toBe(55);
    expect(band.highPct).toBe(70);
    expect(band.midpointPct).toBe(62);
  });

  it("returns the low band when renewable share is below 50", () => {
    const band = estimateEveningSoc({ renewableShareOfLoadPct: 32, solarRichDays: 0 });
    expect(band.label).toBe("low");
    expect(band.lowPct).toBe(40);
    expect(band.highPct).toBe(55);
    expect(band.midpointPct).toBe(47);
  });

  it("returns the unknown band when the renewable share is missing", () => {
    const band = estimateEveningSoc({ renewableShareOfLoadPct: null, solarRichDays: 2 });
    expect(band.label).toBe("unknown");
    expect(band.midpointPct).toBeGreaterThan(0);
    expect(band.midpointPct).toBeLessThan(100);
  });

  it("treats undefined solar streak as zero solar-rich days", () => {
    const band = estimateEveningSoc({ renewableShareOfLoadPct: 75, solarRichDays: undefined });
    expect(band.label).toBe("moderate");
  });
});

describe("estimateFleetSocAtMoment", () => {
  it("scales the evening midpoint down in early Berlin morning", () => {
    const moment = estimateFleetSocAtMoment({
      renewableShareOfLoadPct: 60,
      solarRichDays: 1,
      at: new Date("2026-06-15T05:30:00+02:00"),
    });
    expect(moment.midpointPct).toBeLessThan(62);
    expect(moment.lowPct).toBeLessThan(moment.midpointPct);
    expect(moment.highPct).toBeGreaterThan(moment.midpointPct);
  });

  it("aligns with the evening midpoint around 19:00 Berlin on a neutral surplus day", () => {
    const moment = estimateFleetSocAtMoment({
      renewableShareOfLoadPct: 60,
      solarRichDays: 1,
      at: new Date("2026-06-15T19:00:00+02:00"),
      slotSurplusFraction: 0.45,
    });
    expect(moment.midpointPct).toBeCloseTo(62, 0);
  });

  it("nudges upward when the battery series shows strong charging", () => {
    const baseline = estimateFleetSocAtMoment({
      renewableShareOfLoadPct: 60,
      solarRichDays: 1,
      at: new Date("2026-06-15T19:00:00+02:00"),
      slotSurplusFraction: 0.45,
      batteryStorageMw: 0,
      installedFleetPowerMw: 10_000,
    });
    const charging = estimateFleetSocAtMoment({
      renewableShareOfLoadPct: 60,
      solarRichDays: 1,
      at: new Date("2026-06-15T19:00:00+02:00"),
      slotSurplusFraction: 0.45,
      batteryStorageMw: -8000,
      installedFleetPowerMw: 10_000,
    });
    expect(charging.midpointPct).toBeGreaterThan(baseline.midpointPct);
  });

  it("lifts the estimate when most quarter-hours were in structural surplus", () => {
    const lifted = estimateFleetSocAtMoment({
      renewableShareOfLoadPct: 60,
      solarRichDays: 1,
      at: new Date("2026-06-15T18:30:00+02:00"),
      slotSurplusFraction: 0.72,
    });
    const baseline = estimateFleetSocAtMoment({
      renewableShareOfLoadPct: 60,
      solarRichDays: 1,
      at: new Date("2026-06-15T18:30:00+02:00"),
      slotSurplusFraction: 0.28,
    });
    expect(lifted.midpointPct).toBeGreaterThan(baseline.midpointPct);
  });

  it("damps surplus lift when the live net position is strongly in deficit", () => {
    const strong = estimateFleetSocAtMoment({
      renewableShareOfLoadPct: 60,
      solarRichDays: 1,
      at: new Date("2026-06-15T18:30:00+02:00"),
      slotSurplusFraction: 0.72,
      currentNetPositionMw: -2_000,
    });
    const neutral = estimateFleetSocAtMoment({
      renewableShareOfLoadPct: 60,
      solarRichDays: 1,
      at: new Date("2026-06-15T18:30:00+02:00"),
      slotSurplusFraction: 0.72,
      currentNetPositionMw: 200,
    });
    expect(strong.midpointPct).toBeLessThan(neutral.midpointPct);
  });

  it("counts structural surplus slots for the day profile", () => {
    const frac = computeSlotSurplusFraction([
      { totalGenerationMw: 100, loadMw: 90 },
      { totalGenerationMw: 80, loadMw: 90 },
      { totalGenerationMw: 100, loadMw: 95 },
    ]);
    expect(frac).toBeCloseTo(2 / 3, 5);
  });
});
