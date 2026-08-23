export function CompactDetailStat({
  label,
  value,
  subtitle,
  detail,
}: {
  label: string;
  value: string;
  subtitle?: string;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white/80 px-3.5 py-3 shadow-sm dark:border-slate-600/45 dark:bg-slate-950/55">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-base font-extrabold leading-tight text-slate-900 tabular-nums dark:text-white md:text-[1.1rem]">
        {value}
      </p>
      {subtitle ? (
        <p className="mt-1 text-[10px] leading-snug text-slate-500 dark:text-slate-400">{subtitle}</p>
      ) : null}
      {detail ? (
        <p className="mt-2 text-[11px] leading-snug text-slate-600 dark:text-slate-400">{detail}</p>
      ) : null}
    </div>
  );
}

function splitPerspectiveNarrative(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) {
    return paragraphs;
  }
  const single = paragraphs[0] ?? text.trim();
  if (single.length < 240) {
    return [single];
  }
  const sentences =
    single.match(/[^.!?]+[.!?]+(?:\s|$)/g)?.map((entry) => entry.trim()).filter(Boolean) ?? [single];
  if (sentences.length <= 2) {
    return [single];
  }
  const mid = Math.ceil(sentences.length / 2);
  return [sentences.slice(0, mid).join(" "), sentences.slice(mid).join(" ")];
}

export function PerspectiveNarrativeBody({ text }: { text: string }) {
  const paragraphs = splitPerspectiveNarrative(text);
  return (
    <div className="mt-4 space-y-3.5 border-t border-border/50 pt-4 dark:border-slate-600/35">
      {paragraphs.map((paragraph, index) => (
        <p
          key={`${index}-${paragraph.slice(0, 24)}`}
          className={
            index === 0
              ? "text-[15px] font-medium leading-[1.65] text-slate-800 dark:text-slate-100"
              : "text-sm leading-[1.7] text-slate-600 dark:text-slate-300"
          }
        >
          {paragraph}
        </p>
      ))}
    </div>
  );
}

export function PerspectiveSummaryWithDetails({
  summaryText,
  detailsText,
  detailsLabel,
}: {
  summaryText: string;
  detailsText: string;
  detailsLabel: string;
}) {
  return (
    <div className="mt-4 space-y-3 border-t border-border/50 pt-4 dark:border-slate-600/35">
      <p className="text-[15px] font-medium leading-[1.65] text-slate-800 dark:text-slate-100">
        {summaryText}
      </p>
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
          {detailsLabel}
        </summary>
        <p className="mt-2 text-sm leading-[1.7] text-slate-600 dark:text-slate-300">
          {detailsText}
        </p>
      </details>
    </div>
  );
}
