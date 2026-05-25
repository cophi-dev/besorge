export const EVENING_HOUR_START = 17;
export const EVENING_HOUR_END = 21;
export const QUARTER_HOUR_H = 0.25;

/** LLM live snapshot (STORY DES TAGES) — off while structural KPIs + charts carry the page. */
export const WORKSPACE_LIVE_SNAPSHOT_ENABLED = false;

export const SIM_CHART_NET_STROKE = "#2DD4BF";
export const SIM_CHART_SOC_STROKE = "#22C173";
export const SIM_CHART_CHARGE_FILL = "#6366F1";
export const SIM_CHART_DISCHARGE_FILL = "#F97316";
export const OBSERVED_CURTAILMENT_FILL = "#EC4899";
export const CROSS_BORDER_IMPORT_FILL = "#EF4444";
export const CROSS_BORDER_EXPORT_FILL = "#0EA5E9";

export const TIME_RANGE_NAV_BUTTON_CLASS =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-xl border-2 border-slate-200/90 bg-white text-slate-700 shadow-sm transition hover:border-sky-300 hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-600/55 dark:bg-slate-900/90 dark:text-slate-100 dark:hover:border-sky-500/45 dark:hover:bg-sky-950/45";

export const timeFormatterSingleDay = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const timeFormatterMultiDay = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const integerFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
export const pctFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
export const energyFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
export const powerFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
export const euroCurrencyFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
export const priceFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export const monthLabelFormatter = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  month: "long",
  year: "numeric",
});

export const monthLabelFormatterEn = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  month: "long",
  year: "numeric",
});
