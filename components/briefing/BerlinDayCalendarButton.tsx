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
          "min-h-9 min-w-[10.5rem] justify-start gap-2 border-border/90 bg-background/80 text-left text-xs font-semibold",
          className
        )}
      >
        <CalendarDays className="size-3.5 text-emerald-500/90" aria-hidden />
        {label}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
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
