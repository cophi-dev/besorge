import {
  addBerlinCalendarDays,
  berlinDateKeyToIsoWeekKey,
  isoWeekKeyToBerlinStartKey,
} from "@/lib/berlinCalendar";
import {
  berlinDateKeySchema,
  berlinIsoWeekKeySchema,
  berlinMonthKeySchema,
  normalizeBerlinCustomDateRange,
} from "@/lib/germanyEnergyFlowPeriod";
import { z } from "zod";

/**
 * Which Germany-flow window the hero story should narrate — must stay aligned
 * with {@link GermanyDayEnergyFlow} selector (day / week / month / custom).
 */
export type BriefingStoryWindow =
  | { type: "day"; date: string }
  | { type: "week"; weekKey: string }
  | { type: "month"; monthKey: string }
  | { type: "custom"; start: string; end: string };

export const briefingStoryWindowSchema = z.union([
  z.object({ type: z.literal("day"), date: berlinDateKeySchema }),
  z.object({ type: z.literal("week"), weekKey: berlinIsoWeekKeySchema }),
  z.object({ type: z.literal("month"), monthKey: berlinMonthKeySchema }),
  z.object({
    type: z.literal("custom"),
    start: berlinDateKeySchema,
    end: berlinDateKeySchema,
  }),
]);

export function serializeBriefingStoryWindow(w: BriefingStoryWindow): string {
  if (w.type === "day") {
    return `d:${w.date}`;
  }
  if (w.type === "week") {
    return `w:${w.weekKey}`;
  }
  if (w.type === "month") {
    return `m:${w.monthKey}`;
  }
  const { startKey, endKey } = normalizeBerlinCustomDateRange(w.start, w.end);
  return `r:${startKey}:${endKey}`;
}

export type EnergyFlowSelectorState = {
  mode: "day" | "week" | "month" | "custom";
  selectedDate: string;
  selectedWeek: string;
  selectedMonth: string;
  customRangeStart: string;
  customRangeEnd: string;
};

/** Maps a story window to GermanyDayEnergyFlow selector state. */
export function energyFlowSelectorStateFromStoryWindow(
  window: BriefingStoryWindow,
  fallbackDateKey: string
): EnergyFlowSelectorState {
  const fallbackWeek = berlinDateKeyToIsoWeekKey(fallbackDateKey);
  const fallbackMonth = fallbackDateKey.slice(0, 7);
  const fallbackCustomStart = addBerlinCalendarDays(fallbackDateKey, -6);

  if (window.type === "week") {
    const weekStart = isoWeekKeyToBerlinStartKey(window.weekKey);
    return {
      mode: "week",
      selectedDate: weekStart,
      selectedWeek: window.weekKey,
      selectedMonth: weekStart.slice(0, 7),
      customRangeStart: fallbackCustomStart,
      customRangeEnd: fallbackDateKey,
    };
  }
  if (window.type === "month") {
    const monthStart = `${window.monthKey}-01`;
    return {
      mode: "month",
      selectedDate: monthStart,
      selectedWeek: berlinDateKeyToIsoWeekKey(monthStart),
      selectedMonth: window.monthKey,
      customRangeStart: fallbackCustomStart,
      customRangeEnd: fallbackDateKey,
    };
  }
  if (window.type === "custom") {
    const { startKey, endKey } = normalizeBerlinCustomDateRange(window.start, window.end);
    return {
      mode: "custom",
      selectedDate: endKey,
      selectedWeek: berlinDateKeyToIsoWeekKey(endKey),
      selectedMonth: endKey.slice(0, 7),
      customRangeStart: startKey,
      customRangeEnd: endKey,
    };
  }
  return {
    mode: "day",
    selectedDate: window.date,
    selectedWeek: berlinDateKeyToIsoWeekKey(window.date),
    selectedMonth: window.date.slice(0, 7),
    customRangeStart: fallbackCustomStart,
    customRangeEnd: window.date,
  };
}

type SearchParamsReader = {
  get(name: string): string | null;
};

/** Reads `?week=`, `?month=`, `?start=&end=`, or `?date=` (first match wins). */
export function parseBriefingStoryWindowFromSearchParams(
  params: SearchParamsReader
): BriefingStoryWindow | null {
  const week = params.get("week");
  if (week && berlinIsoWeekKeySchema.safeParse(week).success) {
    return { type: "week", weekKey: week };
  }
  const month = params.get("month");
  if (month && berlinMonthKeySchema.safeParse(month).success) {
    return { type: "month", monthKey: month };
  }
  const start = params.get("start");
  const end = params.get("end");
  if (
    start &&
    end &&
    berlinDateKeySchema.safeParse(start).success &&
    berlinDateKeySchema.safeParse(end).success
  ) {
    const { startKey, endKey } = normalizeBerlinCustomDateRange(start, end);
    return { type: "custom", start: startKey, end: endKey };
  }
  const date = params.get("date");
  if (date && berlinDateKeySchema.safeParse(date).success) {
    return { type: "day", date };
  }
  return null;
}

/** Writes the active window to query params and clears the other range keys. */
export function applyBriefingStoryWindowToSearchParams(
  window: BriefingStoryWindow,
  params: URLSearchParams
): void {
  params.delete("date");
  params.delete("week");
  params.delete("month");
  params.delete("start");
  params.delete("end");
  if (window.type === "day") {
    params.set("date", window.date);
    return;
  }
  if (window.type === "week") {
    params.set("week", window.weekKey);
    return;
  }
  if (window.type === "month") {
    params.set("month", window.monthKey);
    return;
  }
  const { startKey, endKey } = normalizeBerlinCustomDateRange(window.start, window.end);
  params.set("start", startKey);
  params.set("end", endKey);
}
