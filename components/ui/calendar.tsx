"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { type DayPickerProps, DayPicker } from "react-day-picker";

import { cn } from "@/lib/utils";

import "react-day-picker/style.css";

export type CalendarProps = DayPickerProps & {
  className?: string;
};

function Calendar({ className, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("aether-rdp p-2", className)}
      classNames={{
        root: "font-sans text-foreground",
        months: "flex flex-col gap-3 sm:flex-row",
        month: "space-y-2",
        month_caption: "relative flex items-center justify-center px-2 py-1",
        caption_label: "text-sm font-semibold",
        nav: "flex items-center justify-between gap-1",
        button_previous:
          "inline-flex size-8 items-center justify-center rounded-md border border-border bg-muted/40 text-foreground hover:bg-muted",
        button_next:
          "inline-flex size-8 items-center justify-center rounded-md border border-border bg-muted/40 text-foreground hover:bg-muted",
        weekdays: "flex",
        weekday: "w-9 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
        weeks: "",
        week: "flex w-full",
        day: "group/day relative size-9 p-0 text-center text-sm",
        day_button:
          "inline-flex size-9 items-center justify-center rounded-md text-sm font-medium hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-selected-single=true]]:!bg-emerald-500 [&[data-selected-single=true]]:!text-white dark:[&[data-selected-single=true]]:!bg-emerald-500",
        selected: "font-semibold",
        today: "font-bold text-emerald-600 dark:text-emerald-300",
        outside: "text-muted-foreground/45",
        disabled: "text-muted-foreground/35 opacity-40",
        hidden: "invisible",
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />,
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";

export { Calendar };
