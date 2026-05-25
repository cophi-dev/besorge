import { ObservedStressMetric } from "./ObservedStressMetric";
import type { ObservedStressMetricItem } from "./types";

type ObservedStressSectionProps = {
  selectorLabel: string;
  netBalanceLabel: string;
  netBalanceValue: string;
  netValueClass: string;
  netBadgeClass: string;
  netBadgeLabel: string;
  netHint: string;
  sectionBorderClass: string;
  sectionBgClass: string;
  showParadoxLead: boolean;
  paradoxEyebrow: string;
  paradoxLead: string;
  metricsEyebrow: string;
  metrics: [ObservedStressMetricItem, ObservedStressMetricItem, ObservedStressMetricItem, ObservedStressMetricItem];
  disclaimer: string;
};

export function ObservedStressSection({
  selectorLabel,
  netBalanceLabel,
  netBalanceValue,
  netValueClass,
  netBadgeClass,
  netBadgeLabel,
  netHint,
  sectionBorderClass,
  sectionBgClass,
  showParadoxLead,
  paradoxEyebrow,
  paradoxLead,
  metricsEyebrow,
  metrics,
  disclaimer,
}: ObservedStressSectionProps) {
  return (
    <section
      aria-labelledby="observed-stress-heading"
      className={`rounded-xl border bg-gradient-to-b to-white px-3 py-3 shadow-sm dark:to-slate-950/85 md:px-4 md:py-4 ${sectionBorderClass} ${sectionBgClass}`}
    >
      <div className="border-b border-border/45 pb-4 text-center dark:border-slate-600/35">
        <p className="text-[11px] tabular-nums text-slate-600 dark:text-slate-300">{selectorLabel}</p>
        <p
          id="observed-stress-heading"
          className="mt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-600 dark:text-slate-400"
        >
          {netBalanceLabel}
        </p>
        <p
          className={`mt-1 text-3xl font-black tabular-nums leading-none tracking-tight sm:text-4xl md:text-5xl ${netValueClass}`}
          aria-label={`${netBalanceLabel}: ${netBalanceValue}`}
        >
          {netBalanceValue}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${netBadgeClass}`}
          >
            {netBadgeLabel}
          </span>
          <span className="text-[11px] text-slate-600 dark:text-slate-400">{netHint}</span>
        </div>
      </div>

      {showParadoxLead ? (
        <div className="mt-3 space-y-1 text-center">
          <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-amber-800 dark:text-amber-200">
            {paradoxEyebrow}
          </p>
          <p className="mx-auto max-w-2xl text-[11px] font-medium leading-snug text-amber-950 dark:text-amber-100">
            {paradoxLead}
          </p>
        </div>
      ) : null}

      <div className="mt-3">
        <p className="mb-2 text-center text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400">
          {metricsEyebrow}
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-0 sm:divide-x sm:divide-border/60 dark:sm:divide-slate-600/40">
          {metrics.map((metric) => (
            <ObservedStressMetric
              key={metric.label}
              label={metric.label}
              value={metric.value}
              detail={metric.detail}
              tone={metric.tone}
            />
          ))}
        </div>
      </div>

      <p className="mt-2 text-center text-[9px] text-slate-400 dark:text-slate-500">{disclaimer}</p>
    </section>
  );
}
