import type { ObservedStressMetricTone } from "./types";

export function ObservedStressMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: ObservedStressMetricTone;
}) {
  const valueToneClass =
    tone === "surplus"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "deficit"
        ? "text-rose-700 dark:text-rose-300"
        : tone === "warning"
          ? "text-amber-800 dark:text-amber-200"
          : "text-slate-950 dark:text-white";

  return (
    <div className="min-w-0 px-1 py-2 text-center sm:px-1.5 sm:py-0">
      <p className="text-[9px] font-semibold uppercase leading-tight tracking-[0.06em] text-slate-700/85 sm:text-[8px] sm:tracking-[0.07em] dark:text-slate-300/85">
        {label}
      </p>
      <p className={`mt-0.5 text-sm font-black tabular-nums leading-none sm:text-base md:text-lg ${valueToneClass}`}>
        {value}
      </p>
      {detail ? (
        <p className="mt-0.5 text-[9px] leading-snug text-slate-600 dark:text-slate-400">{detail}</p>
      ) : null}
    </div>
  );
}
