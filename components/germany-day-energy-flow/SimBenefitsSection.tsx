import { ObservedStressMetric } from "./ObservedStressMetric";
import type { ObservedStressMetricItem } from "./types";

type SimBenefitsSectionProps = {
  selectorLabel: string;
  capacitySuffix?: string | null;
  heroLabel: string;
  heroValue: string;
  heroDetail: string;
  impactEyebrow: string;
  metrics: ObservedStressMetricItem[];
};

export function SimBenefitsSection({
  selectorLabel,
  capacitySuffix,
  heroLabel,
  heroValue,
  heroDetail,
  impactEyebrow,
  metrics,
}: SimBenefitsSectionProps) {
  const gridCols =
    metrics.length === 2
      ? "grid-cols-2 sm:grid-cols-2"
      : metrics.length === 3
        ? "grid-cols-3 sm:grid-cols-3"
        : "grid-cols-2 sm:grid-cols-4";
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
      </div>

      <div className="mt-3">
        <p className="mb-2 text-center text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400">
          {impactEyebrow}
        </p>
        <div
          className={`grid ${gridCols} gap-3 sm:gap-0 sm:divide-x sm:divide-border/60 dark:sm:divide-slate-600/40`}
        >
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
    </section>
  );
}
