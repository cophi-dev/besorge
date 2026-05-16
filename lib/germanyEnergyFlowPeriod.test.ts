import {
  BERLIN_CUSTOM_RANGE_MAX_DAYS,
  expectedQuarterHoursInFlowRange,
  lastDayOfPreviousMonthBerlin,
  normalizeBerlinCustomDateRange,
  resolveGermanyEnergyFlowBerlinRange,
  resolveGermanyEnergyFlowBerlinRangeForCustomRange,
} from "@/lib/germanyEnergyFlowPeriod";

describe("germanyEnergyFlowPeriod", () => {
  const noon = new Date("2024-06-15T12:00:00.000Z");

  it("resolves yesterday as previous calendar day in Berlin", () => {
    const r = resolveGermanyEnergyFlowBerlinRange("yesterday", noon);
    expect(r.startKey).toBe("2024-06-14");
    expect(r.endKey).toBe("2024-06-14");
    expect(r.capSlotsAtNow).toBe(false);
  });

  it("resolves last month to full May when today is Berlin June", () => {
    const r = resolveGermanyEnergyFlowBerlinRange("last_month", noon);
    expect(r.startKey).toBe("2024-05-01");
    expect(r.endKey).toBe("2024-05-31");
    expect(expectedQuarterHoursInFlowRange(r, noon)).toBe(31 * 96);
  });

  it("lastDayOfPreviousMonthBerlin matches June anchor", () => {
    expect(lastDayOfPreviousMonthBerlin("2024-06-15")).toBe("2024-05-31");
  });

  it("normalizes reversed custom range keys", () => {
    expect(normalizeBerlinCustomDateRange("2024-06-10", "2024-06-01")).toEqual({
      startKey: "2024-06-01",
      endKey: "2024-06-10",
    });
  });

  it("resolves custom range and caps end at Berlin today", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    const r = resolveGermanyEnergyFlowBerlinRangeForCustomRange("2024-06-01", "2024-06-20", now);
    expect(r.startKey).toBe("2024-06-01");
    expect(r.endKey).toBe("2024-06-15");
    expect(r.capSlotsAtNow).toBe(true);
  });

  it("rejects custom ranges longer than the configured maximum", () => {
    const now = new Date("2024-06-15T12:00:00.000Z");
    const end = "2024-06-15";
    const start = "2024-01-01";
    expect(() => resolveGermanyEnergyFlowBerlinRangeForCustomRange(start, end, now)).toThrow(
      String(BERLIN_CUSTOM_RANGE_MAX_DAYS)
    );
  });
});
