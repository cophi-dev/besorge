export function LegendDot({
  color,
  label,
  hint,
}: {
  color: string;
  label: string;
  hint?: string;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[10px] text-slate-600 dark:text-slate-300"
      title={hint}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}
