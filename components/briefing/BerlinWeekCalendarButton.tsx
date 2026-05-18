"use client";

import { CalendarDays } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buttonVariants } from "@/components/ui/button";
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
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      try {
        inputRef.current?.showPicker?.();
      } catch {
        // showPicker may be unsupported or blocked outside a direct gesture
      }
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          openPicker();
        }
      }}
    >
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
      <PopoverContent className="w-auto min-w-[14rem] p-3" align="center" sideOffset={8}>
        <label
          htmlFor={inputId}
          className="block text-center text-xs font-semibold text-slate-800 dark:text-slate-100"
        >
          {language === "de" ? "Kalenderwoche wählen" : "Choose calendar week"}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="week"
          value={value}
          max={max}
          onChange={(event) => {
            const next = event.target.value;
            if (!next) {
              return;
            }
            onChange(next);
            setOpen(false);
          }}
          className="mt-2 block w-full min-h-10 cursor-pointer rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold tabular-nums text-slate-900 dark:text-white"
        />
      </PopoverContent>
    </Popover>
  );
}
