"use client";

import { format, parseISO } from "date-fns";
import { CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";

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

function toDateKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function formatRangeLabel(start: string, end: string, language: "en" | "de"): string {
  const startDate = parseISO(`${start}T12:00:00.000Z`);
  const endDate = parseISO(`${end}T12:00:00.000Z`);
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
  const maxDate = parseISO(`${max}T12:00:00.000Z`);

  const selected: DateRange = useMemo(
    () => ({
      from: parseISO(`${start}T12:00:00.000Z`),
      to: parseISO(`${end}T12:00:00.000Z`),
    }),
    [start, end]
  );

  const label = formatRangeLabel(start, end, language);

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <div className="border-b border-border/60 px-3 py-2 text-center text-[11px] font-medium text-muted-foreground">
          {language === "de"
            ? "Start- und Enddatum wählen"
            : "Pick a start and end date"}
        </div>
        <Calendar
          mode="range"
          selected={selected}
          defaultMonth={selected.to ?? selected.from}
          disabled={{ after: maxDate }}
          numberOfMonths={2}
          onSelect={(range) => {
            if (!range?.from) {
              return;
            }
            const nextStart = toDateKey(range.from);
            const nextEnd = toDateKey(range.to ?? range.from);
            onChange({ start: nextStart, end: nextEnd });
            if (range.to) {
              setOpen(false);
            }
          }}
          classNames={{
            day_button:
              "inline-flex size-9 items-center justify-center rounded-md text-sm font-medium hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-selected-single=true]]:!bg-emerald-500 [&[data-selected-single=true]]:!text-white [&[data-range-start=true]]:!bg-emerald-500 [&[data-range-start=true]]:!text-white [&[data-range-end=true]]:!bg-emerald-500 [&[data-range-end=true]]:!text-white [&[data-range-middle=true]]:!bg-emerald-500/20 dark:[&[data-selected-single=true]]:!bg-emerald-500",
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
