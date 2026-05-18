import {
  addBerlinCalendarDays,
  berlinDateKeyToIsoWeekKey,
  findFirstUnixSecondForBerlinDateKey,
  formatBerlinDateKeyFromUtcDate,
  getBerlinDateKeyFromUnixSeconds,
  isoWeekKeyToBerlinStartKey,
  nextBerlinDateKey,
  prevBerlinDateKey,
} from "@/lib/berlinCalendar";

describe("berlinCalendar", () => {
  it("formats a known instant in Berlin as YYYY-MM-DD", () => {
    const ms = Date.UTC(2024, 5, 15, 10, 0, 0);
    expect(formatBerlinDateKeyFromUtcDate(new Date(ms))).toBe("2024-06-15");
  });

  it("round-trips midnight lookup for a summer date", () => {
    const key = "2024-06-15";
    const s = findFirstUnixSecondForBerlinDateKey(key);
    expect(getBerlinDateKeyFromUnixSeconds(s)).toBe(key);
    expect(getBerlinDateKeyFromUnixSeconds(s - 1)).not.toBe(key);
  });

  it("steps next and previous Berlin calendar days", () => {
    expect(nextBerlinDateKey("2024-06-15")).toBe("2024-06-16");
    expect(prevBerlinDateKey("2024-06-15")).toBe("2024-06-14");
  });

  it("adds Berlin calendar days across a DST boundary month", () => {
    expect(addBerlinCalendarDays("2024-03-28", 5)).toBe("2024-04-02");
  });

  it("round-trips Berlin ISO week keys", () => {
    const weekKey = berlinDateKeyToIsoWeekKey("2026-05-11");
    expect(weekKey).toMatch(/^2026-W\d{2}$/);
    expect(isoWeekKeyToBerlinStartKey(weekKey)).toBe("2026-05-11");
  });
});
