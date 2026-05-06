import { estimateEveningSoc } from "@/lib/socEstimator";

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
