"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";

import { BerlinDayCalendarButton } from "@/components/briefing/BerlinDayCalendarButton";
import { BerlinDateRangeCalendarButton } from "@/components/briefing/BerlinDateRangeCalendarButton";
import { BerlinMonthCalendarButton } from "@/components/briefing/BerlinMonthCalendarButton";
import { BerlinWeekCalendarButton } from "@/components/briefing/BerlinWeekCalendarButton";
import { Button } from "@/components/ui/button";
import { addBerlinCalendarDays, countBerlinCalendarDaysInclusive } from "@/lib/berlinCalendar";
import { BERLIN_CUSTOM_RANGE_MAX_DAYS } from "@/lib/germanyEnergyFlowPeriod";

import { TIME_RANGE_NAV_BUTTON_CLASS, timeFormatterSingleDay } from "./constants";
import type { SelectorMode } from "./types";

type GermanyFlowPeriodSelectorProps = {
  language: "en" | "de";
  profileTitle: string;
  coverageSummaryLine: string;
  lastUpdatedIso?: string | null;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectorMode: SelectorMode;
  onSelectorModeChange: (mode: SelectorMode) => void;
  selectedDate: string;
  onSelectedDateChange: (date: string) => void;
  selectedWeek: string;
  onSelectedWeekChange: (week: string) => void;
  selectedMonth: string;
  onSelectedMonthChange: (month: string) => void;
  customRangeStart: string;
  customRangeEnd: string;
  onCustomRangeChange: (start: string, end: string) => void;
  todayKey: string;
  currentWeekKey: string;
  currentMonthKey: string;
  timeRangeCenterLabel: string;
  onPreviousWindow: () => void;
  onNextWindow: () => void;
  nextDisabled: boolean;
  labels: {
    timeframeLabelShort: string;
    dayMode: string;
    weekMode: string;
    monthMode: string;
    customMode: string;
    previousRange: string;
    nextRange: string;
  };
};

export function GermanyFlowPeriodSelector({
  language,
  profileTitle,
  coverageSummaryLine,
  lastUpdatedIso = null,
  isRefreshing = false,
  onRefresh,
  selectorMode,
  onSelectorModeChange,
  selectedDate,
  onSelectedDateChange,
  selectedWeek,
  onSelectedWeekChange,
  selectedMonth,
  onSelectedMonthChange,
  customRangeStart,
  customRangeEnd,
  onCustomRangeChange,
  todayKey,
  currentWeekKey,
  currentMonthKey,
  timeRangeCenterLabel,
  onPreviousWindow,
  onNextWindow,
  nextDisabled,
  labels,
}: GermanyFlowPeriodSelectorProps) {
  return (
    <div className="flex flex-col gap-3 border-b border-border/55 pb-4 dark:border-slate-600/35">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold leading-tight tracking-tight text-slate-950 md:text-2xl dark:text-white [font-family:var(--font-heading)]">
            {profileTitle}
          </h2>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{coverageSummaryLine}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
          {lastUpdatedIso ? (
            <span className="inline-flex items-center rounded-full border border-border/70 bg-background/55 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-300">
              {language === "de" ? "Live" : "Live"} ·{" "}
              {timeFormatterSingleDay.format(new Date(lastUpdatedIso))}
            </span>
          ) : null}
          {onRefresh ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-full px-3 text-[11px]"
              disabled={isRefreshing}
              onClick={onRefresh}
            >
              {language === "de" ? "Aktualisieren" : "Refresh"}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <motion.div
          className="flex min-h-9 w-full overflow-x-auto rounded-full border border-border/70 bg-muted/40 p-1 [-ms-overflow-style:none] [scrollbar-width:none] dark:border-slate-600/45 dark:bg-slate-950/50 [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label={labels.timeframeLabelShort}
        >
          {(
            [
              { mode: "day", label: labels.dayMode },
              { mode: "week", label: labels.weekMode },
              { mode: "month", label: labels.monthMode },
              { mode: "custom", label: labels.customMode },
            ] as const
          ).map((option) => (
            <button
              key={option.mode}
              type="button"
              role="tab"
              aria-selected={selectorMode === option.mode}
              onClick={() => onSelectorModeChange(option.mode)}
              className={`min-h-9 min-w-[4.5rem] flex-1 rounded-full px-3 py-1.5 text-xs font-bold tracking-tight transition sm:text-sm ${
                selectorMode === option.mode
                  ? "bg-background text-slate-950 shadow-sm ring-1 ring-border/70 dark:bg-slate-900 dark:text-white dark:ring-slate-600/50"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              {option.label}
            </button>
          ))}
        </motion.div>

        <div className="flex w-full items-stretch gap-2 sm:gap-3">
          <button
            type="button"
            onClick={onPreviousWindow}
            className={TIME_RANGE_NAV_BUTTON_CLASS}
            aria-label={labels.previousRange}
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>

          <div className="min-w-0 flex-1">
            {selectorMode === "day" ? (
              <BerlinDayCalendarButton
                value={selectedDate}
                max={todayKey}
                onChange={onSelectedDateChange}
                language={language}
                prominent
              />
            ) : selectorMode === "custom" ? (
              <BerlinDateRangeCalendarButton
                start={customRangeStart}
                end={customRangeEnd}
                max={todayKey}
                onChange={({ start, end }) => {
                  const spanDays = countBerlinCalendarDaysInclusive(start, end);
                  if (spanDays > BERLIN_CUSTOM_RANGE_MAX_DAYS) {
                    onCustomRangeChange(
                      addBerlinCalendarDays(end, -(BERLIN_CUSTOM_RANGE_MAX_DAYS - 1)),
                      end
                    );
                    return;
                  }
                  onCustomRangeChange(start, end);
                }}
                language={language}
                prominent
              />
            ) : selectorMode === "week" ? (
              <BerlinWeekCalendarButton
                value={selectedWeek}
                max={currentWeekKey}
                onChange={onSelectedWeekChange}
                label={timeRangeCenterLabel}
                language={language}
                prominent
              />
            ) : (
              <BerlinMonthCalendarButton
                value={selectedMonth}
                max={currentMonthKey}
                onChange={onSelectedMonthChange}
                label={timeRangeCenterLabel}
                language={language}
                prominent
              />
            )}
          </div>

          <button
            type="button"
            disabled={nextDisabled}
            onClick={onNextWindow}
            className={TIME_RANGE_NAV_BUTTON_CLASS}
            aria-label={labels.nextRange}
          >
            <ChevronRight className="size-5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
