import {
  addBerlinCalendarDays,
  berlinDateKeyToIsoWeekKey,
  countBerlinCalendarDaysInclusive,
  formatBerlinDateKeyFromUtcDate,
  isoWeekKeyToBerlinStartKey,
} from "@/lib/berlinCalendar";
import { berlinDateKeySchema } from "@/lib/germanyEnergyFlowPeriod";

import { monthLabelFormatter, monthLabelFormatterEn } from "./constants";
import type { SelectorMode } from "./types";

export function formatTimeRangeCenterLabel(options: {
  language: "en" | "de";
  selectorMode: SelectorMode;
  selectedDate: string;
  selectedWeek: string;
  selectedMonth: string;
  customRangeStart: string;
  customRangeEnd: string;
}): string {
  const {
    language,
    selectorMode,
    selectedDate,
    selectedWeek,
    selectedMonth,
    customRangeStart,
    customRangeEnd,
  } = options;
  const locale = language === "de" ? "de-DE" : "en-US";
  if (selectorMode === "custom") {
    const startLabel = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      month: "short",
      day: "numeric",
      year: customRangeStart.slice(0, 4) === customRangeEnd.slice(0, 4) ? undefined : "numeric",
    }).format(new Date(`${customRangeStart}T12:00:00.000Z`));
    const endLabel = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${customRangeEnd}T12:00:00.000Z`));
    if (language === "de") {
      return customRangeStart === customRangeEnd ? endLabel : `${startLabel} – ${endLabel}`;
    }
    return customRangeStart === customRangeEnd ? endLabel : `${startLabel} – ${endLabel}`;
  }
  if (selectorMode === "day") {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${selectedDate}T12:00:00.000Z`));
  }
  if (selectorMode === "week") {
    const start = isoWeekKeyToBerlinStartKey(selectedWeek);
    const end = addBerlinCalendarDays(start, 6);
    const match = selectedWeek.match(/^\d{4}-W(\d{2})$/);
    const weekNum = match ? Number(match[1]) : null;
    const startLabel = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      month: "short",
      day: "numeric",
    }).format(new Date(`${start}T12:00:00.000Z`));
    const endLabel = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${end}T12:00:00.000Z`));
    if (language === "de") {
      return weekNum
        ? `Kalenderwoche ${weekNum} · ${startLabel} – ${endLabel}`
        : `${startLabel} – ${endLabel}`;
    }
    return weekNum ? `Week ${weekNum} · ${startLabel} – ${endLabel}` : `${startLabel} – ${endLabel}`;
  }
  const date = new Date(`${selectedMonth}-01T00:00:00.000Z`);
  return (language === "de" ? monthLabelFormatter : monthLabelFormatterEn).format(date);
}

export function berlinTodayKey(): string {
  return formatBerlinDateKeyFromUtcDate(new Date());
}

export function resolveSeedDateKey(seed: string | null | undefined): string {
  if (seed && berlinDateKeySchema.safeParse(seed).success) {
    return seed;
  }
  return berlinTodayKey();
}

export function previousIsoWeekKey(weekKey: string): string {
  return berlinDateKeyToIsoWeekKey(addBerlinCalendarDays(isoWeekKeyToBerlinStartKey(weekKey), -7));
}

export function priorWindowMatchingSpan(start: string, end: string): { warmupStart: string; warmupEnd: string } {
  const spanDays = Math.max(1, countBerlinCalendarDaysInclusive(start, end));
  const warmupEnd = addBerlinCalendarDays(start, -1);
  const warmupStart = addBerlinCalendarDays(warmupEnd, -(spanDays - 1));
  return { warmupStart, warmupEnd };
}

export function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, 1));
  base.setUTCMonth(base.getUTCMonth() + delta);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
}
