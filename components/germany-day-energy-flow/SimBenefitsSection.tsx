import { ObservedStressMetric } from "./ObservedStressMetric";
import type { ObservedStressMetricItem } from "./types";

type SimBenefitsSectionProps = {
  selectorLabel: string;
  capacitySuffix?: string | null;
  heroLabel: string;
  heroValue: string;
  heroDetail: string;
  swingCompareLine: string;
  netBalanceNote: string;
  showLead: boolean;
  leadEyebrow: string;
  leadText: string;
  impactEyebrow: string;
  metrics: [ObservedStressMetricItem, ObservedStressMetricItem, ObservedStressMetricItem, ObservedStressMetricItem];
  auxLine?: string | null;
  auxFootnote?: string | null;
  economicsLine?: string | null;
  disclaimer: string;
};

export function SimBenefitsSection({
  selectorLabel,
  capacitySuffix,
  heroLabel,
  heroValue,
  heroDetail,
  swingCompareLine,
  netBalanceNote,
  showLead,
  leadEyebrow,
  leadText,
  impactEyebrow,
  metrics,
  auxLine,
  auxFootnote,
  economicsLine,
  disclaimer,
}: SimBenefitsSectionProps) {
  return (
    <section
      aria-labelledby="sim-benefits-heading"
      className="rounded-xl border border-emerald-300/55 bg-gradient-to-b from-emerald-50/90 to-white px-3 py-3 shadow-sm dark:border-emerald-500/30 dark:from-emerald-950/30 dark:to-slate-950/85 md:px-4 md:py-4"
    >
      <div className="border-b border-border/45 pb-4 text-center dark:border-slate-600/35">
        <p className="text-[11px] tabular-nums text-slate-600 dark:text-slate-300">
          {selectorLabel}
          {capacitySuffix ? ` · ${capacitySuffix}` : ""}
        </p>
        <p
          id="sim-benefits-heading"
          className="mt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-600 dark:text-slate-400"
        >
          {heroLabel}
        </p>
        <p
          className="mt-1 text-3xl font-black tabular-nums leading-none tracking-tight text-emerald-600 sm:text-4xl md:text-5xl dark:text-emerald-300"
          aria-label={`${heroLabel}: ${heroValue}`}
        >
          {heroValue}
        </p>
        <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">{heroDetail}</p>
        <p className="mt-2 text-[10px] tabular-nums text-slate-500 dark:text-slate-400">{swingCompareLine}</p>
        <p className="mx-auto mt-2 max-w-2xl text-[10px] leading-snug text-slate-500 dark:text-slate-400">
          {netBalanceNote}
        </p>
      </div>

      {showLead ? (
        <div className="mt-3 space-y-1 text-center">
          <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-emerald-800 dark:text-emerald-200">
            {leadEyebrow}
          </p>
          <p className="mx-auto max-w-2xl text-[11px] font-medium leading-snug text-emerald-950 dark:text-emerald-100">
            {leadText}
          </p>
        </div>
      ) : null}

      <div className="mt-3">
        <p className="mb-2 text-center text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400">
          {impactEyebrow}
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

      {auxLine ? (
        <p className="mt-2.5 text-center text-[10px] tabular-nums text-slate-600 dark:text-slate-400">{auxLine}</p>
      ) : null}
      {auxFootnote ? (
        <p className="mt-2 text-center text-[9px] leading-snug text-slate-400 dark:text-slate-500">{auxFootnote}</p>
      ) : null}
      {economicsLine ? (
        <p className="mt-2 text-center text-[10px] text-slate-600 dark:text-slate-400">{economicsLine}</p>
      ) : null}

      <p className="mt-1 text-center text-[9px] text-slate-400 dark:text-slate-500">{disclaimer}</p>
    </section>
  );
}
