import {
  assessCapacityCredibility,
  CAPACITY_CREDIBILITY_RATIO_THRESHOLD,
  computeIndicativeEurPerMwhStored,
  formatPaybackYears,
  presentIndicativeEurTotal,
} from "@/lib/indicativeEconomicsDisplay";

describe("assessCapacityCredibility", () => {
  it("flags capacity far above the reference tier", () => {
    const result = assessCapacityCredibility(200_000, 40_000);
    expect(result.isExtrapolated).toBe(true);
    expect(result.ratioToReference).toBe(5);
  });

  it("stays credible near the balanced recommendation", () => {
    const result = assessCapacityCredibility(45_000, 40_000);
    expect(result.isExtrapolated).toBe(false);
    expect(result.ratioToReference).toBeCloseTo(1.125);
  });

  it("flags very large absolute capacity even without reference", () => {
    const result = assessCapacityCredibility(60_000, null);
    expect(result.isExtrapolated).toBe(true);
  });
});

describe("presentIndicativeEurTotal", () => {
  it("surfaces EUR/MWh first when capacity is extrapolated", () => {
    const presentation = presentIndicativeEurTotal({
      language: "en",
      valueEur: 2_000_000,
      windowDays: 1,
      absorbedMwh: 20_000,
      capacityMwh: 265_000,
      referenceCapacityMwh: 40_000,
    });

    expect(presentation.primaryValue).toContain("EUR/MWh");
    expect(presentation.warning).toMatch(/linear/i);
    expect(presentation.secondaryValue).toMatch(/Linear model/i);
  });

  it("shows per-day normalization for multi-day windows", () => {
    const presentation = presentIndicativeEurTotal({
      language: "de",
      valueEur: 300_000,
      windowDays: 7,
      absorbedMwh: 5_000,
      capacityMwh: 30_000,
      referenceCapacityMwh: 28_000,
    });

    expect(presentation.secondaryValue).toMatch(/Tag/);
    expect(presentation.warning).toBeNull();
  });
});

describe("formatPaybackYears", () => {
  it("formats fractional years without percent styling", () => {
    expect(formatPaybackYears(8.4, "de")).toBe("8,4 Jahre");
    expect(formatPaybackYears(8.4, "en")).toBe("8.4 years");
  });
});

describe("computeIndicativeEurPerMwhStored", () => {
  it("returns null when absorbed energy is zero", () => {
    expect(computeIndicativeEurPerMwhStored(10_000, 0)).toBeNull();
  });

  it("divides indicative euros by stored MWh", () => {
    expect(computeIndicativeEurPerMwhStored(100_000, 2_000)).toBe(50);
  });
});

describe("CAPACITY_CREDIBILITY_RATIO_THRESHOLD", () => {
  it("documents the ratio gate used in the UI", () => {
    expect(CAPACITY_CREDIBILITY_RATIO_THRESHOLD).toBeGreaterThan(1);
  });
});
