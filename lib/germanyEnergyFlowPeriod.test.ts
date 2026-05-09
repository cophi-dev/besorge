import {
  expectedQuarterHoursInFlowRange,
  lastDayOfPreviousMonthBerlin,
  resolveGermanyEnergyFlowBerlinRange,
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
});
