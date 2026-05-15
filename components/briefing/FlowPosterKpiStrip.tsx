/**
 * Compact KPI row for Germany flow poster (chart + KPIs share one PNG export).
 */

export type FlowPosterKpiAccent = "emerald" | "amber" | "sky" | "teal" | "fuchsia" | "slate";

export type FlowPosterKpiItem = {
  eyebrow: string;
  value: string;
  hint?: string;
  /** Short footer matching the fuller KPI tiles (compact line height). */
  subtitle?: string;
  accent?: FlowPosterKpiAccent;
};

type FlowPosterKpiStripProps = {
  items: [FlowPosterKpiItem, FlowPosterKpiItem, FlowPosterKpiItem, FlowPosterKpiItem];
};

const ACCENT_SHELL: Record<FlowPosterKpiAccent, { bar: string; panel: string; eyebrowTone: string; valueTone: string }> = {
  emerald: {
    bar: "bg-emerald-500/90 dark:bg-emerald-400/70",
    panel:
      "border-emerald-200/85 bg-emerald-50/50 shadow-sm dark:border-emerald-500/32 dark:bg-emerald-950/28",
    eyebrowTone: "text-emerald-900 dark:text-emerald-100",
    valueTone: "text-emerald-950 dark:text-emerald-50",
  },
  amber: {
    bar: "bg-gradient-to-r from-amber-400 via-amber-500 to-orange-400 dark:from-amber-400/95 dark:to-orange-500/90",
    panel:
      "border-amber-200/85 bg-card shadow-sm dark:border-amber-500/38 dark:bg-amber-950/22",
    eyebrowTone: "text-amber-950 dark:text-amber-100",
    valueTone: "text-amber-950 dark:text-amber-50",
  },
  sky: {
    bar: "bg-sky-500/78 dark:bg-sky-400/65",
    panel: "border-sky-200/90 bg-card shadow-sm dark:border-sky-700/50 dark:bg-slate-950/65",
    eyebrowTone: "text-sky-950 dark:text-sky-100",
    valueTone: "text-sky-950 dark:text-sky-50",
  },
  teal: {
    bar: "bg-teal-500/82 dark:bg-teal-400/65",
    panel: "border-teal-200/85 bg-card shadow-sm dark:border-teal-700/50 dark:bg-slate-950/60",
    eyebrowTone: "text-teal-950 dark:text-teal-100",
    valueTone: "text-teal-950 dark:text-teal-50",
  },
  fuchsia: {
    bar: "bg-fuchsia-500/72 dark:bg-fuchsia-400/60",
    panel: "border-border/85 bg-card shadow-sm dark:border-slate-600/50 dark:bg-slate-950/65",
    eyebrowTone: "text-slate-700 dark:text-slate-300",
    valueTone: "text-slate-950 dark:text-white",
  },
  slate: {
    bar: "bg-slate-400/85 dark:bg-slate-500/55",
    panel: "border-border/85 bg-card shadow-sm dark:border-slate-600/50 dark:bg-slate-950/65",
    eyebrowTone: "text-muted-foreground",
    valueTone: "text-slate-950 dark:text-white",
  },
};

export function FlowPosterKpiStrip({ items }: FlowPosterKpiStripProps) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3.5" role="group" aria-label="Key indicators">
      {items.map((item, i) => {
        const accent = item.accent ?? "slate";
        const tone = ACCENT_SHELL[accent];
        return (
          <div
            key={`${item.eyebrow}-${i}`}
            className={`relative flex min-h-0 flex-col rounded-xl border px-3.5 py-3 ${tone.panel}`}
          >
            <div className={`pointer-events-none mb-1.5 h-0.5 w-11 shrink-0 rounded-full ${tone.bar}`} aria-hidden />
            <p className={`text-[9px] font-semibold uppercase leading-snug tracking-[0.13em] ${tone.eyebrowTone}`}>
              {item.eyebrow}
            </p>
            <p
              className={`mt-1.5 text-[1.35rem] font-extrabold leading-tight tabular-nums sm:text-[1.6rem] [font-family:var(--font-sans)] ${tone.valueTone}`}
            >
              {item.value}
            </p>
            {item.hint ? (
              <p className="mt-1 text-[9.5px] font-medium leading-snug text-slate-600 dark:text-slate-400">
                {item.hint}
              </p>
            ) : null}
            {item.subtitle ? (
              <p className="mt-0.5 line-clamp-2 text-[8.75px] leading-snug text-slate-600/92 dark:text-slate-400/95">
                {item.subtitle}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
