"use client";

import { format, isSameDay, isWithinInterval, parseISO } from "date-fns";
import { CalendarDays } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type BerlinDateRangeCalendarButtonProps = {
  start: string;
  end: string;
  max: string;
  onChange: (range: { start: string; end: string }) => void;
  language: "en" | "de";
  className?: string;
  prominent?: boolean;
};

type PickStep = "start" | "end";

function toDateKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function parseBerlinDateKey(key: string): Date {
  return parseISO(`${key}T12:00:00.000Z`);
}

function formatRangeLabel(start: string, end: string, language: "en" | "de"): string {
  const startDate = parseBerlinDateKey(start);
  const endDate = parseBerlinDateKey(end);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const locale = language === "de" ? "de-DE" : "en-US";

  if (start === end) {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(startDate);
  }

  const startFmt = new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Berlin",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(startDate);

  const endFmt = new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Berlin",
    month: sameMonth ? "short" : "long",
    day: "numeric",
    year: "numeric",
  }).format(endDate);

  return `${startFmt} – ${endFmt}`;
}

function formatDayLabel(date: Date, language: "en" | "de"): string {
  const locale = language === "de" ? "de-DE" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Berlin",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function BerlinDateRangeCalendarButton({
  start,
  end,
  max,
  onChange,
  language,
  className,
  prominent = false,
}: BerlinDateRangeCalendarButtonProps) {
  const [open, setOpen] = useState(false);
  const [pickStep, setPickStep] = useState<PickStep>("start");
  const [pendingStart, setPendingStart] = useState<Date | null>(null);
  const maxDate = parseBerlinDateKey(max);
  const priorFrom = parseBerlinDateKey(start);
  const priorTo = parseBerlinDateKey(end);

  const resetPicker = () => {
    setPickStep("start");
    setPendingStart(null);
  };

  useEffect(() => {
    if (open) {
      resetPicker();
    }
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      resetPicker();
    }
  };

  const handleDaySelect = (day: Date | undefined) => {
    if (!day) {
      return;
    }
    if (pickStep === "start") {
      setPendingStart(day);
      setPickStep("end");
      return;
    }
    if (!pendingStart) {
      setPendingStart(day);
      setPickStep("end");
      return;
    }
    let from = pendingStart;
    let to = day;
    if (to < from) {
      [from, to] = [to, from];
    }
    onChange({ start: toDateKey(from), end: toDateKey(to) });
    setOpen(false);
    resetPicker();
  };

  const calendarSelected = pendingStart ?? undefined;

  const showPriorRange = pickStep === "start" && pendingStart === null;

  const stepHint = useMemo(() => {
    if (pickStep === "start") {
      return language === "de" ? "Schritt 1: Startdatum antippen" : "Step 1: Tap your start date";
    }
    return language === "de" ? "Schritt 2: Enddatum antippen" : "Step 2: Tap your end date";
  }, [language, pickStep]);

  const label = formatRangeLabel(start, end, language);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        type="button"
        className={cn(
          buttonVariants({ variant: "outline", size: prominent ? "lg" : "sm" }),
          prominent
            ? "h-12 min-h-12 w-full min-w-0 shrink justify-center gap-2.5 rounded-xl border-2 border-sky-300/75 bg-white px-4 text-center text-base font-bold tabular-nums text-slate-900 shadow-inner transition-colors hover:border-sky-400 hover:bg-sky-50/80 focus-visible:ring-4 focus-visible:ring-sky-400/30 dark:border-sky-500/40 dark:bg-slate-950/90 dark:text-white dark:hover:border-sky-400/55 dark:hover:bg-sky-950/50"
            : "h-9 min-h-9 min-w-0 shrink gap-2 rounded-xl border-border/80 bg-background/90 px-3 text-xs font-semibold tabular-nums shadow-sm backdrop-blur-sm transition-colors hover:bg-background dark:border-white/[0.12] dark:bg-slate-950/90 sm:min-w-[9.5rem] sm:justify-start",
          className
        )}
      >
        <CalendarDays
          className={cn(
            "shrink-0",
            prominent
              ? "size-5 text-sky-600 dark:text-sky-300"
              : "size-3.5 text-emerald-500/90"
          )}
          aria-hidden
        />
        <span className="min-w-0 truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end" sideOffset={8}>
        <div className="space-y-0 border-b border-border/60 px-3 py-2.5 text-center">
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{stepHint}</p>
          {pickStep === "end" && pendingStart ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {language === "de" ? "Start:" : "Start:"}{" "}
              <span className="font-medium text-sky-800 dark:text-sky-200">
                {formatDayLabel(pendingStart, language)}
              </span>
            </p>
          ) : showPriorRange ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {language === "de" ? "Aktuell:" : "Current:"}{" "}
              <span className="font-medium">{formatRangeLabel(start, end, language)}</span>
            </p>
          ) : null}
        </div>
        <Calendar
          mode="single"
          selected={calendarSelected}
          defaultMonth={pendingStart ?? priorTo}
          disabled={{ after: maxDate }}
          numberOfMonths={2}
          onSelect={handleDaySelect}
          modifiers={{
            prior_range: (date) =>
              showPriorRange && isWithinInterval(date, { start: priorFrom, end: priorTo }),
            range_start: (date) => pendingStart !== null && isSameDay(date, pendingStart),
          }}
          modifiersClassNames={{
            prior_range: "bg-sky-100/70 text-slate-700 dark:bg-sky-950/50 dark:text-slate-200",
            range_start:
              "rounded-md bg-emerald-500/15 font-semibold text-emerald-900 dark:text-emerald-100",
          }}
          classNames={{
            day_button:
              "inline-flex size-9 items-center justify-center rounded-md text-sm font-medium hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-selected-single=true]]:!bg-emerald-500 [&[data-selected-single=true]]:!text-white dark:[&[data-selected-single=true]]:!bg-emerald-500",
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
