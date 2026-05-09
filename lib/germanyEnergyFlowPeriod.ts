import { z } from "zod";

import {
  addBerlinCalendarDays,
  berlinElapsedQuarterHoursInDayFromNow,
  countBerlinCalendarDaysInclusive,
  formatBerlinDateKeyFromUtcDate,
  mondayBerlinIsoWeekContaining,
  prevBerlinDateKey,
} from "@/lib/berlinCalendar";

export const GERMANY_ENERGY_FLOW_PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "this_month",
  "last_month",
] as const;

export type GermanyEnergyFlowPeriod = (typeof GERMANY_ENERGY_FLOW_PERIODS)[number];

export const germanyEnergyFlowPeriodSchema = z.enum(GERMANY_ENERGY_FLOW_PERIODS);

export type GermanyEnergyFlowBerlinRange = {
  period: GermanyEnergyFlowPeriod;
  /** Inclusive Berlin calendar start. */
  startKey: string;
  /** Inclusive Berlin calendar end (may be partial when capSlotsAtNow is true). */
  endKey: string;
  /** When true, drop quarter-hours after `now` on `endKey`. */
  capSlotsAtNow: boolean;
};

export const berlinDateKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });

export const berlinMonthKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine((value) => {
    const [year, month] = value.split("-").map(Number);
    return Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12;
  });

export const berlinIsoWeekKeySchema = z
  .string()
  .regex(/^\d{4}-W\d{2}$/)
  .refine((value) => {
    const week = Number(value.slice(-2));
    return Number.isFinite(week) && week >= 1 && week <= 53;
  });

function firstDayOfMonthBerlin(dateKey: string): string {
  const [y, m] = dateKey.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function firstDayOfPreviousMonthBerlin(todayKey: string): string {
  const [y, m] = todayKey.split("-").map(Number);
  if (m === 1) {
    return `${y - 1}-12-01`;
  }
  return `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/** Last calendar day of the month before `todayKey` (entire previous month). */
export function lastDayOfPreviousMonthBerlin(todayKey: string): string {
  return prevBerlinDateKey(firstDayOfMonthBerlin(todayKey));
}

export function resolveGermanyEnergyFlowBerlinRange(
  period: GermanyEnergyFlowPeriod,
  now: Date
): GermanyEnergyFlowBerlinRange {
  const todayKey = formatBerlinDateKeyFromUtcDate(now);
  switch (period) {
    case "today":
      return { period, startKey: todayKey, endKey: todayKey, capSlotsAtNow: true };
    case "yesterday": {
      const y = prevBerlinDateKey(todayKey);
      return { period, startKey: y, endKey: y, capSlotsAtNow: false };
    }
    case "this_week": {
      const mon = mondayBerlinIsoWeekContaining(todayKey);
      return { period, startKey: mon, endKey: todayKey, capSlotsAtNow: true };
    }
    case "this_month": {
      const first = firstDayOfMonthBerlin(todayKey);
      return { period, startKey: first, endKey: todayKey, capSlotsAtNow: true };
    }
    case "last_month": {
      const start = firstDayOfPreviousMonthBerlin(todayKey);
      const end = lastDayOfPreviousMonthBerlin(todayKey);
      return { period, startKey: start, endKey: end, capSlotsAtNow: false };
    }
    default: {
      const exhaustive: never = period;
      throw new Error(`Unhandled period ${String(exhaustive)}`);
    }
  }
}

/**
 * Expected quarter-hour slots in the selected window (for coverage KPI).
 * Open-ended ranges cap the last Berlin day at `now`.
 */
export function expectedQuarterHoursInFlowRange(range: GermanyEnergyFlowBerlinRange, now: Date): number {
  const { startKey, endKey, capSlotsAtNow } = range;
  const todayKey = formatBerlinDateKeyFromUtcDate(now);
  const days = countBerlinCalendarDaysInclusive(startKey, endKey);
  if (!capSlotsAtNow || endKey !== todayKey) {
    return days * 96;
  }
  const fullDaysBeforeEnd = days - 1;
  return fullDaysBeforeEnd * 96 + berlinElapsedQuarterHoursInDayFromNow(now);
}

/** Earliest `total_power` calendar `start=` needed to cover `range` (buffer for upstream gaps). */
export function totalPowerFetchStartDateForRange(range: GermanyEnergyFlowBerlinRange): string {
  return addBerlinCalendarDays(range.startKey, -2);
}

function toDateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoWeekStartDateKey(isoWeekKey: string): string {
  const [yearRaw, weekRaw] = isoWeekKey.split("-W");
  const year = Number(yearRaw);
  const week = Number(weekRaw);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4IsoWeekday = ((jan4.getUTCDay() + 6) % 7) + 1;
  const mondayWeek1 = new Date(Date.UTC(year, 0, 4 - (jan4IsoWeekday - 1)));
  mondayWeek1.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);
  return toDateKeyUtc(mondayWeek1);
}

function nextMonthFirstDateKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (month === 12) {
    return `${year + 1}-01-01`;
  }
  return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

export function resolveGermanyEnergyFlowBerlinRangeForDate(
  dateKey: string,
  now: Date
): GermanyEnergyFlowBerlinRange {
  const todayKey = formatBerlinDateKeyFromUtcDate(now);
  return {
    period: "today",
    startKey: dateKey,
    endKey: dateKey,
    capSlotsAtNow: dateKey === todayKey,
  };
}

export function resolveGermanyEnergyFlowBerlinRangeForWeek(
  isoWeekKey: string,
  now: Date
): GermanyEnergyFlowBerlinRange {
  const startKey = isoWeekStartDateKey(isoWeekKey);
  const endKey = addBerlinCalendarDays(startKey, 6);
  const todayKey = formatBerlinDateKeyFromUtcDate(now);
  return {
    period: "this_week",
    startKey,
    endKey: endKey > todayKey ? todayKey : endKey,
    capSlotsAtNow: endKey >= todayKey,
  };
}

export function resolveGermanyEnergyFlowBerlinRangeForMonth(
  monthKey: string,
  now: Date
): GermanyEnergyFlowBerlinRange {
  const startKey = `${monthKey}-01`;
  const endKey = prevBerlinDateKey(nextMonthFirstDateKey(monthKey));
  const todayKey = formatBerlinDateKeyFromUtcDate(now);
  return {
    period: "this_month",
    startKey,
    endKey: endKey > todayKey ? todayKey : endKey,
    capSlotsAtNow: endKey >= todayKey,
  };
}
