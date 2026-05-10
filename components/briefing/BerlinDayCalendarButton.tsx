"use client";

import { format, parseISO } from "date-fns";
import { CalendarDays } from "lucide-react";
import { useState } from "react";

import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type BerlinDayCalendarButtonProps = {
  value: string;
  max: string;
  onChange: (dateKey: string) => void;
  language: "en" | "de";
  className?: string;
};

export function BerlinDayCalendarButton({
  value,
  max,
  onChange,
  language,
  className,
}: BerlinDayCalendarButtonProps) {
  const [open, setOpen] = useState(false);
  const selected = parseISO(`${value}T12:00:00.000Z`);
  const end = parseISO(`${max}T12:00:00.000Z`);

  const label = format(selected, language === "de" ? "dd.MM.yyyy" : "MMM d, yyyy");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "h-9 min-h-9 min-w-0 shrink gap-2 rounded-xl border-border/80 bg-background/90 px-3 text-xs font-semibold tabular-nums shadow-sm backdrop-blur-sm transition-colors hover:bg-background dark:border-white/[0.12] dark:bg-slate-950/90 sm:min-w-[9.5rem] sm:justify-start",
          className
        )}
      >
        <CalendarDays className="size-3.5 shrink-0 text-emerald-500/90" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end" sideOffset={8}>
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          disabled={{ after: end }}
          onSelect={(date) => {
            if (!date) {
              return;
            }
            const key = format(date, "yyyy-MM-dd");
            onChange(key);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
