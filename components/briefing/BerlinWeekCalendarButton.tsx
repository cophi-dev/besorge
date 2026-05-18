"use client";

import { format, isWithinInterval, parseISO } from "date-fns";
import { CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";

import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buttonVariants } from "@/components/ui/button";
import {
  addBerlinCalendarDays,
  berlinDateKeyToIsoWeekKey,
  isoWeekKeyToBerlinStartKey,
} from "@/lib/berlinCalendar";
import { cn } from "@/lib/utils";

type BerlinWeekCalendarButtonProps = {
  value: string;
  max: string;
  onChange: (weekKey: string) => void;
  label: string;
  language: "en" | "de";
  className?: string;
  prominent?: boolean;
};

function parseBerlinDateKey(key: string): Date {
  return parseISO(`${key}T12:00:00.000Z`);
}

function pickerDayToBerlinDateKey(day: Date): string {
  return format(day, "yyyy-MM-dd");
}

export function BerlinWeekCalendarButton({
  value,
  max,
  onChange,
  label,
  language,
  className,
  prominent = false,
}: BerlinWeekCalendarButtonProps) {
  const [open, setOpen] = useState(false);

  const weekStartKey = isoWeekKeyToBerlinStartKey(value);
  const weekEndKey = addBerlinCalendarDays(weekStartKey, 6);
  const weekStart = parseBerlinDateKey(weekStartKey);
  const weekEnd = parseBerlinDateKey(weekEndKey);

  const maxWeekStartKey = isoWeekKeyToBerlinStartKey(max);
  const maxWeekEndKey = addBerlinCalendarDays(maxWeekStartKey, 6);
  const maxDate = parseBerlinDateKey(maxWeekEndKey);

  const stepHint =
    language === "de"
      ? "Beliebigen Tag in der Kalenderwoche antippen"
      : "Tap any day in the calendar week";

  const handleDaySelect = (day: Date | undefined) => {
    if (!day) {
      return;
    }
    const weekKey = berlinDateKeyToIsoWeekKey(pickerDayToBerlinDateKey(day));
    if (weekKey > max) {
      return;
    }
    onChange(weekKey);
    setOpen(false);
  };

  const isInSelectedWeek = useMemo(
    () => (date: Date) => isWithinInterval(date, { start: weekStart, end: weekEnd }),
    [weekStart, weekEnd]
  );

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
      <PopoverContent className="w-auto p-0" align="center" sideOffset={8}>
        <div className="border-b border-border/60 px-3 py-2.5 text-center">
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{stepHint}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {language === "de" ? "Aktuell:" : "Current:"}{" "}
            <span className="font-medium">{label}</span>
          </p>
        </div>
        <Calendar
          mode="single"
          selected={weekStart}
          defaultMonth={weekStart}
          disabled={{ after: maxDate }}
          numberOfMonths={2}
          onSelect={handleDaySelect}
          modifiers={{
            selected_week: isInSelectedWeek,
          }}
          modifiersClassNames={{
            selected_week:
              "bg-sky-100/80 text-sky-950 font-medium dark:bg-sky-950/55 dark:text-sky-100 [&_.rdp-day_button]:bg-sky-200/60 dark:[&_.rdp-day_button]:bg-sky-900/50",
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
