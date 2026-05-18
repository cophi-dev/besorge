"use client";

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { z } from "zod";

import { Skeleton } from "@/components/ui/skeleton";
import {
  addBerlinCalendarDays,
  countBerlinCalendarDaysInclusive,
  formatBerlinDateKeyFromUtcDate,
  mondayBerlinIsoWeekContaining,
} from "@/lib/berlinCalendar";
import {
  computeEconomics,
  defaultEconomicsAssumptions,
} from "@/lib/bessEconomics";
import {
  assessCapacityCredibility,
  formatPaybackYears,
  buildValueBreakdownLines,
  extractValueBreakdown,
  presentIndicativeEurTotal,
} from "@/lib/indicativeEconomicsDisplay";
import type { BriefingStoryWindow } from "@/lib/briefingStoryWindow";
import {
  BERLIN_CUSTOM_RANGE_MAX_DAYS,
  berlinDateKeySchema,
} from "@/lib/germanyEnergyFlowPeriod";
import { createLogger } from "@/lib/debug";
import type { GermanyDispatchSlotsResponse } from "@/lib/energyChartsApi";
import { germanyEnergyFlowPeriodSchema } from "@/lib/germanyEnergyFlowPeriod";
import {
  computeCyclingFleetSurplusAbsorption,
  computeNetSurplusFleetAbsorption,
} from "@/lib/netSurplusFleetAbsorption";
import {
  computeLogicalBessRecommendation,
  computeCoverageAtCapacityMwh,
  computePracticalDailyCycleCapacityMwh,
  computeEndPracticalSocMwh,
  computeStitchedPracticalInitialSocMwh,
  borderCoupledBatteryChargeMw,
  simulateAdjustedNetMwAtCapacity,
  simulatePracticalDispatchAtCapacity,
} from "@/lib/optimalBessCapacity";
import {
  inferFleetModeFromChartTail,
  type ChartFleetSocSnapshot,
  type ChartRowTailForFleetMode,
} from "@/lib/chartFleetSocSnapshot";
import { BerlinDayCalendarButton } from "@/components/briefing/BerlinDayCalendarButton";
import { BerlinDateRangeCalendarButton } from "@/components/briefing/BerlinDateRangeCalendarButton";
import { Button } from "@/components/ui/button";

const log = createLogger("germany-day-energy-flow");

const EVENING_HOUR_START = 17;
const EVENING_HOUR_END = 21;
const QUARTER_HOUR_H = 0.25;

/** LLM live snapshot (STORY DES TAGES) — off while structural KPIs + charts carry the page. */
const WORKSPACE_LIVE_SNAPSHOT_ENABLED = false;

/**
 * Simulated chart palette: net (structural MW) vs BESS charge bars must not share the same hue.
 * Net = bright teal line (thin); charge = indigo bars; discharge = orange; curtailment = pink; SoC = green.
 */
const SIM_CHART_NET_STROKE = "#2DD4BF"; // teal-400 — reads as “net / balance” line
const SIM_CHART_SOC_STROKE = "#22C173";
const SIM_CHART_CHARGE_FILL = "#6366F1"; // indigo-500 — clearly separate from net + SoC
const SIM_CHART_DISCHARGE_FILL = "#F97316"; // orange-500
const OBSERVED_CURTAILMENT_FILL = "#EC4899"; // pink-500 — auxiliary charge opportunity, not net
const CROSS_BORDER_IMPORT_FILL = "#EF4444"; // red-500
const CROSS_BORDER_EXPORT_FILL = "#0EA5E9"; // sky-500

const timeFormatterSingleDay = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const timeFormatterMultiDay = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const integerFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const pctFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const energyFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const powerFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const euroCurrencyFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const priceFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const germanyDispatchSlotSchema = z.object({
  timestampIso: z.string(),
  hourBerlin: z.number(),
  residualLoadMw: z.number(),
  loadMw: z.number(),
  totalGenerationMw: z.number(),
  renewableGenerationMw: z.number().nullable(),
  crossBorderElectricityTradingMw: z.number().nullable().optional().default(null),
  curtailmentMw: z.number().nullable().optional().default(null),
});

const germanyEnergyFlowApiSchema = z.object({
  dateBerlin: z.string(),
  samplePoints: z.number(),
  pointFractionOfDay: z.number(),
  source: z.literal("energy-charts.total_power"),
  slots: z.array(germanyDispatchSlotSchema),
  curtailmentStatus: z
    .enum(["loaded", "unavailable_not_configured", "unavailable_upstream"])
    .optional()
    .default("unavailable_upstream"),
  period: germanyEnergyFlowPeriodSchema.optional(),
  rangeStartBerlin: z.string().optional(),
  rangeEndBerlin: z.string().optional(),
});

const bessRecommendationTierSchema = z.object({
  label: z.enum(["aggressive", "balanced", "conservative"]),
  percentile: z.number(),
  recommendedEnergyMwh: z.number(),
  recommendedPowerMw: z.number(),
});

const bessRecommendationApiSchema = z.object({
  lookbackDays: z.number(),
  rangeStartBerlin: z.string(),
  rangeEndBerlin: z.string(),
  observedDays: z.number(),
  dailyEnergyP95Mwh: z.number(),
  dailyPowerP95Mw: z.number(),
  continuousWindowRequiredEnergyMwh: z.number(),
  tiers: z.array(bessRecommendationTierSchema),
  impactAtBalancedTier: z
    .object({
      absorbedSurplusShare: z.number(),
      servedDeficitShare: z.number(),
      totalSurplusEnergyMwh: z.number(),
      totalDeficitEnergyMwh: z.number(),
    })
    .nullable(),
  indicativeEconomicsAtBalancedTier: z
    .object({
      capexEur: z.number(),
      annualRevenueEur: z.number(),
      annualOperatingCostsEur: z.number(),
      annualNetCashflowEur: z.number(),
      paybackYears: z.number(),
    })
    .nullable(),
});

const revenueMarketContextSchema = z.object({
  sampledSlots: z.number().int().nonnegative(),
  sampleStartIso: z.string(),
  sampleEndIso: z.string(),
  averageLowPriceEurPerMwh: z.number(),
  averageHighPriceEurPerMwh: z.number(),
  averageMiddayPriceEurPerMwh: z.number(),
  averageEveningPriceEurPerMwh: z.number(),
  eveningPeakPremiumEurPerMwh: z.number(),
  negativePriceSharePct: z.number().min(0).max(100),
});

const revenueMarketReferenceSchema = z.object({
  derivedSpotSpreadEurPerMwh: z.number().nonnegative(),
  averageDailyCurtailmentOpportunityMwh: z.number().nonnegative(),
  positiveRedispatchCostEurPerMwh: z.number().nonnegative(),
  negativeRedispatchCostEurPerMwh: z.number(),
  sampledDays: z.number().int().nonnegative(),
  spotPriceStatus: z.enum(["live", "fallback_unavailable"]),
  curtailmentStatus: z.enum(["loaded", "unavailable_not_configured", "unavailable_upstream"]),
  priceSourceLabel: z.string().min(1),
  redispatchSourceLabel: z.string().min(1),
});

const revenueModelApiSchema = z.object({
  marketReference: revenueMarketReferenceSchema,
  marketContext: revenueMarketContextSchema.nullable(),
});

type SelectorMode = "day" | "week" | "month" | "custom";
type BessRecommendation = z.infer<typeof bessRecommendationApiSchema>;
type RevenueModelPayload = z.infer<typeof revenueModelApiSchema>;

const monthLabelFormatter = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  month: "long",
  year: "numeric",
});

const monthLabelFormatterEn = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  month: "long",
  year: "numeric",
});

function formatTimeRangeCenterLabel(options: {
  language: "en" | "de";
  selectorMode: SelectorMode;
  selectedDate: string;
  selectedWeek: string;
  selectedMonth: string;
  customRangeStart: string;
  customRangeEnd: string;
}): string {
  const {
    language,
    selectorMode,
    selectedDate,
    selectedWeek,
    selectedMonth,
    customRangeStart,
    customRangeEnd,
  } = options;
  const locale = language === "de" ? "de-DE" : "en-US";
  if (selectorMode === "custom") {
    const startLabel = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      month: "short",
      day: "numeric",
      year: customRangeStart.slice(0, 4) === customRangeEnd.slice(0, 4) ? undefined : "numeric",
    }).format(new Date(`${customRangeStart}T12:00:00.000Z`));
    const endLabel = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${customRangeEnd}T12:00:00.000Z`));
    if (language === "de") {
      return customRangeStart === customRangeEnd
        ? endLabel
        : `${startLabel} – ${endLabel}`;
    }
    return customRangeStart === customRangeEnd ? endLabel : `${startLabel} – ${endLabel}`;
  }
  if (selectorMode === "day") {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${selectedDate}T12:00:00.000Z`));
  }
  if (selectorMode === "week") {
    const start = isoWeekKeyToStartKey(selectedWeek);
    const end = addBerlinCalendarDays(start, 6);
    const match = selectedWeek.match(/^\d{4}-W(\d{2})$/);
    const weekNum = match ? Number(match[1]) : null;
    const startLabel = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      month: "short",
      day: "numeric",
    }).format(new Date(`${start}T12:00:00.000Z`));
    const endLabel = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Berlin",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${end}T12:00:00.000Z`));
    if (language === "de") {
      return weekNum
        ? `Kalenderwoche ${weekNum} · ${startLabel} – ${endLabel}`
        : `${startLabel} – ${endLabel}`;
    }
    return weekNum ? `Week ${weekNum} · ${startLabel} – ${endLabel}` : `${startLabel} – ${endLabel}`;
  }
  const date = new Date(`${selectedMonth}-01T00:00:00.000Z`);
  return (language === "de" ? monthLabelFormatter : monthLabelFormatterEn).format(date);
}

function berlinTodayKey(): string {
  return formatBerlinDateKeyFromUtcDate(new Date());
}

function resolveSeedDateKey(seed: string | null | undefined): string {
  if (seed && berlinDateKeySchema.safeParse(seed).success) {
    return seed;
  }
  return berlinTodayKey();
}

function dateKeyToIsoWeekKey(dateKey: string): string {
  const mondayKey = mondayBerlinIsoWeekContaining(dateKey);
  const mondayDate = new Date(`${mondayKey}T00:00:00.000Z`);
  const thursdayDate = new Date(mondayDate);
  thursdayDate.setUTCDate(mondayDate.getUTCDate() + 3);
  const year = thursdayDate.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Iso = ((jan4.getUTCDay() + 6) % 7) + 1;
  const mondayWeek1 = new Date(Date.UTC(year, 0, 4 - (jan4Iso - 1)));
  const diffDays = Math.round((mondayDate.getTime() - mondayWeek1.getTime()) / 86_400_000);
  const week = Math.floor(diffDays / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function isoWeekKeyToStartKey(weekKey: string): string {
  const [yearRaw, weekRaw] = weekKey.split("-W");
  const year = Number(yearRaw);
  const week = Number(weekRaw);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Iso = ((jan4.getUTCDay() + 6) % 7) + 1;
  const mondayWeek1 = new Date(Date.UTC(year, 0, 4 - (jan4Iso - 1)));
  mondayWeek1.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);
  return mondayWeek1.toISOString().slice(0, 10);
}

function previousIsoWeekKey(weekKey: string): string {
  return dateKeyToIsoWeekKey(addBerlinCalendarDays(isoWeekKeyToStartKey(weekKey), -7));
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, 1));
  base.setUTCMonth(base.getUTCMonth() + delta);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
}

type ChartRow = GermanyDispatchSlotsResponse["slots"][number] & {
  timeLabel: string;
  /** Domestic generation − load (positive = surplus MW, negative = deficit). */
  netBalanceMw: number;
  netAfterPracticalBessMw: number;
  observedCrossBorderMw: number | null;
  simulatedCrossBorderMw: number | null;
  observedImportMw: number;
  observedExportSignedMw: number;
  simulatedImportMw: number;
  simulatedExportSignedMw: number;
  curtailmentDisplayMw: number;
  inferredFleetSocPct: number;
  estimatedFleetSocPct: number;
  simulatedPracticalSocPct: number;
  practicalChargeSignedMw: number;
  practicalChargeMw: number;
  practicalDischargeMw: number;
  /** Fleet-capacity heuristic (same series as estimated SoC line). */
  fleetChargeSignedMw: number;
  fleetChargeMw: number;
  fleetDischargeMw: number;
};

export type GermanyDayEnergyFlowProps = {
  fleetCapacityGwh?: number | null;
  fleetPowerGw?: number | null;
  language: "en" | "de";
  isRefreshing?: boolean;
  lastUpdatedIso?: string | null;
  onRefresh?: () => void;
  onShare?: () => void;
  shareBusy?: boolean;
  /** Fires when the plotted SoC series updates so the live header can match the dashed chart line. */
  onChartFleetSocSnapshot?: (snapshot: ChartFleetSocSnapshot | null) => void;
  /** Optional LLM-generated impact blurb for simulated mode; placeholder until wired. */
  simulationAiInsight?: string | null;
  /** Server-rendered series for the seeded Berlin day (skips first-load spinner when keys match). */
  initialEnergyFlow?: GermanyDispatchSlotsResponse | null;
  /** Berlin `YYYY-MM-DD` for `initialEnergyFlow`. */
  initialBerlinDateKey?: string | null;
  /** Optional deep-link / share param (`?date=`) to pre-select a Berlin day. */
  seedDateKey?: string | null;
  /** Sync selected Berlin day back to the URL or parent state. */
  onBerlinDateChange?: (dateKey: string) => void;
  /**
   * Which window the homepage hero story should narrate — aligned with the chart
   * selector (day / ISO week / calendar month). Does not replace `onBerlinDateChange`.
   */
  onBriefingStoryWindowChange?: (window: BriefingStoryWindow) => void;
  /** Story window rendered inline with the chart area. */
  briefingStoryWindow?: BriefingStoryWindow | null;
  /** Bumped when the user refreshes the live briefing. */
  briefingStoryRefreshNonce?: number;
  /** Start in simulated-BESS view (e.g. `?sim=1` for morning export screenshots). */
  initialSimulatedNet?: boolean;
  /** Sync simulated mode to the URL or parent so it survives remounts when the date changes. */
  onSimulatedModeChange?: (simulated: boolean) => void;
};

function LegendDot({
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

type SectionKpiTone = "emerald" | "sky" | "violet" | "amber" | "slate";

function SectionKpiTile({
  eyebrow,
  value,
  subtitle,
  tone = "slate",
  density = "default",
  className,
}: {
  eyebrow: string;
  value: string;
  subtitle?: string;
  tone?: SectionKpiTone;
  /** Compact tiles for secondary metrics (e.g. fleet SoC snapshot). */
  density?: "default" | "compact";
  className?: string;
}) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-200/85 bg-emerald-50/60 text-emerald-950 dark:border-emerald-500/28 dark:bg-emerald-950/25 dark:text-emerald-50"
      : tone === "sky"
        ? "border-sky-200/85 bg-sky-50/65 text-sky-950 dark:border-sky-500/25 dark:bg-sky-950/20 dark:text-sky-50"
        : tone === "violet"
          ? "border-violet-200/85 bg-violet-50/65 text-violet-950 dark:border-violet-500/25 dark:bg-violet-950/22 dark:text-violet-50"
          : tone === "amber"
            ? "border-amber-200/85 bg-amber-50/65 text-amber-950 dark:border-amber-500/25 dark:bg-amber-950/22 dark:text-amber-50"
            : "border-border/70 bg-background/50 text-slate-950 dark:border-slate-600/45 dark:bg-slate-950/35 dark:text-white";

  const padClass = density === "compact" ? "px-2.5 py-2" : "px-3 py-2.5";
  const valueClass =
    density === "compact"
      ? "mt-0.5 text-[0.95rem] font-bold leading-tight tabular-nums md:text-[1.02rem]"
      : "mt-1 text-[1.05rem] font-extrabold leading-tight tabular-nums md:text-[1.15rem]";

  return (
    <div className={`rounded-xl border shadow-sm ${toneClass} ${padClass} ${className ?? ""}`.trim()}>
      <p
        className={`text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300 ${
          density === "compact" ? "leading-tight" : ""
        }`}
      >
        {eyebrow}
      </p>
      <p className={`${valueClass}`}>{value}</p>
      {subtitle ? (
        <p className="mt-1 text-[10px] leading-snug text-slate-600/92 dark:text-slate-400/95">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

function WindowMetricCell({
  label,
  value,
  hint,
  detail,
  tone = "slate",
}: {
  label: string;
  value: string;
  hint?: string;
  detail?: string;
  tone?: SectionKpiTone;
}) {
  const accentBar =
    tone === "emerald"
      ? "bg-emerald-500/85 dark:bg-emerald-400/70"
      : tone === "sky"
        ? "bg-sky-500/85 dark:bg-sky-400/70"
        : tone === "amber"
          ? "bg-amber-500/85 dark:bg-amber-400/70"
          : tone === "violet"
            ? "bg-violet-500/85 dark:bg-violet-400/70"
            : "bg-slate-400/70 dark:bg-slate-500/55";

  return (
    <div className="min-w-0 flex-1 px-3 py-2.5 first:pl-0 last:pr-0 sm:px-4">
      <div className={`mb-1.5 h-0.5 w-8 rounded-full ${accentBar}`} aria-hidden />
      <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-600 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-0.5 text-xl font-extrabold leading-tight tabular-nums text-slate-950 dark:text-white sm:text-[1.35rem]">
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-[10px] leading-snug text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
      {detail ? (
        <p className="mt-1 text-[10px] leading-relaxed text-slate-600 dark:text-slate-400">{detail}</p>
      ) : null}
    </div>
  );
}

function WorkspaceSection({
  eyebrow,
  title,
  lead,
  children,
  className = "",
  headingId,
}: {
  eyebrow: string;
  title?: string;
  lead?: string;
  children: ReactNode;
  className?: string;
  headingId: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-border/70 bg-background/45 p-3 shadow-sm dark:border-slate-600/40 dark:bg-slate-950/30 md:p-5 ${className}`}
      aria-labelledby={headingId}
    >
      <p
        id={headingId}
        className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400"
      >
        {eyebrow}
      </p>
      {title ? (
        <h3 className="mt-1.5 text-base font-semibold text-slate-900 dark:text-white md:text-lg [font-family:var(--font-heading)]">
          {title}
        </h3>
      ) : null}
      {lead ? (
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-600 dark:text-slate-400">{lead}</p>
      ) : null}
      <motion.div layout className={title || lead ? "mt-4" : "mt-3"}>
        {children}
      </motion.div>
    </section>
  );
}

function IndicativeDisclaimerBanner({ title, body }: { title: string; body: string }) {
  return (
    <div
      role="note"
      className="rounded-xl border-2 border-amber-400/80 bg-amber-50 px-3.5 py-3 dark:border-amber-500/45 dark:bg-amber-950/50"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-950 dark:text-amber-100">
        {title}
      </p>
      <p className="mt-1.5 text-sm font-medium leading-snug text-amber-950/95 dark:text-amber-50/95">
        {body}
      </p>
    </div>
  );
}

function CompactDetailStat({
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

function formatSignedMw(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${integerFormatter.format(n)} MW`;
}

function formatEnergyFromMwh(mwh: number): string {
  const gwh = mwh / 1_000;
  if (Math.abs(gwh) >= 1) {
    return `${energyFormatter.format(gwh)} GWh`;
  }
  return `${integerFormatter.format(mwh)} MWh`;
}

function formatPowerFromMw(mw: number): string {
  if (!Number.isFinite(mw) || mw <= 0) {
    return "0 MW";
  }
  if (mw >= 1000) {
    return `${energyFormatter.format(mw / 1000)} GW`;
  }
  return `${powerFormatter.format(mw)} MW`;
}

function formatSignedEnergyFromMwh(mwh: number): string {
  const sign = mwh > 0 ? "+" : mwh < 0 ? "−" : "";
  return `${sign}${formatEnergyFromMwh(Math.abs(mwh))}`;
}

function parseCapacityGwhInput(value: string): number | null {
  const normalized = value.trim().replace(/,/g, ".");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed * 1_000;
}

type AbsorptionTotals = {
  grossSurplusEnergyMwh: number;
  curtailedEnergyMwh: number;
  grossChargeOpportunityEnergyMwh: number;
  missedSurplusEnergyMwh: number;
};

type CoverageTotals = Pick<
  ReturnType<typeof computeCoverageAtCapacityMwh>,
  | "absorbedSurplusShare"
  | "servedDeficitShare"
  | "totalSurplusEnergyMwh"
  | "totalCurtailmentEnergyMwh"
  | "totalChargeOpportunityEnergyMwh"
  | "totalDeficitEnergyMwh"
>;

type BorderTradeTotals = {
  observedImportEnergyMwh: number;
  observedExportEnergyMwh: number;
  simulatedImportEnergyMwh: number;
  simulatedExportEnergyMwh: number;
  importDeltaEnergyMwh: number;
  exportDeltaEnergyMwh: number;
};

type ScenarioImpactSnapshot = {
  coverage: ReturnType<typeof computeCoverageAtCapacityMwh>;
  absorbedCurtailmentEnergyMwh: number;
  remainingCurtailmentEnergyMwh: number;
  peakReductionMw: number;
  gridImpactReductionPct: number | null;
  observedImportEnergyMwh: number | null;
  simulatedImportEnergyMwh: number | null;
  importReductionEnergyMwh: number | null;
  bessRevenueTodayEur: number | null;
  avoidedRedispatchCostsEur: number | null;
  avoidedCurtailmentValueEur: number | null;
  /**
   * Charge-side economic proxy: same €/MWh weighting as `missedOpportunityEur`, applied to absorbed
   * surplus energy. Scales with fleet size when extra capacity banks more surplus (unlike discharge-only
   * spread on `bessRevenueTodayEur`, which plateaus once structural deficits are fully served).
   */
  chargeOpportunityValueEur: number | null;
  totalValueCreatedEur: number | null;
  missedOpportunityEur: number | null;
  curtailedRecoveredToLoadEnergyMwh: number;
  gridReliefScore: number | null;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function formatCurrencyCompact(value: number | null): string {
  return value !== null && Number.isFinite(value) ? euroCurrencyFormatter.format(Math.round(value)) : "—";
}

function computeOpportunityValuePerMwh(
  marketReference: RevenueModelPayload["marketReference"] | null,
  totalChargeOpportunityEnergyMwh: number,
  totalCurtailmentEnergyMwh: number
): number | null {
  const spreadEurPerMwh =
    marketReference !== null && marketReference.derivedSpotSpreadEurPerMwh > 0
      ? marketReference.derivedSpotSpreadEurPerMwh
      : null;
  const redispatchEurPerMwh =
    marketReference !== null && marketReference.positiveRedispatchCostEurPerMwh > 0
      ? marketReference.positiveRedispatchCostEurPerMwh
      : null;
  const curtailedShareOfOpportunity =
    totalChargeOpportunityEnergyMwh > 1e-9
      ? totalCurtailmentEnergyMwh / totalChargeOpportunityEnergyMwh
      : 0;
  const opportunityValuePerMwh =
    (spreadEurPerMwh ?? 0) + (redispatchEurPerMwh ?? 0) * curtailedShareOfOpportunity;
  return opportunityValuePerMwh > 0 ? opportunityValuePerMwh : null;
}

function buildMissedOpportunityFootnote(
  language: "en" | "de",
  marketReference: RevenueModelPayload["marketReference"] | null,
  opportunityValuePerMwh: number | null
): string {
  if (language === "de") {
    if (marketReference === null || opportunityValuePerMwh === null) {
      return "Modellierte Kapazität (Slider). Ladechance = struktureller Überschuss + Abregelung. Ohne SMARD-Spread kein EUR-Wert. Grenzhandel und Slot-Preise fließen nicht ein.";
    }
    return `Modellierte Kapazität. Verpasste MWh × ${priceFormatter.format(opportunityValuePerMwh)} EUR/MWh (SMARD Hoch−Tief ${priceFormatter.format(marketReference.derivedSpotSpreadEurPerMwh)} + Redispatch ${priceFormatter.format(marketReference.positiveRedispatchCostEurPerMwh)} × Abregelungsanteil). Kein Grenzhandel — indikativ, keine Slot-Preise.`;
  }
  if (marketReference === null || opportunityValuePerMwh === null) {
    return "Modeled capacity (slider). Charge opportunity = structural surplus + curtailment. No SMARD spread → no EUR value. Border trade and slot prices are excluded.";
  }
  return `Modeled capacity. Missed MWh × ${priceFormatter.format(opportunityValuePerMwh)} EUR/MWh (SMARD high−low ${priceFormatter.format(marketReference.derivedSpotSpreadEurPerMwh)} + redispatch ${priceFormatter.format(marketReference.positiveRedispatchCostEurPerMwh)} × curtailment share). No border-trade valuation — indicative, not slot-level prices.`;
}

function computeGridReliefScore(input: {
  curtailedAvoidedShare: number | null;
  dampingPct: number | null;
  peakReductionShare: number | null;
  importReductionShare: number | null;
}): number | null {
  const parts = [
    input.curtailedAvoidedShare !== null ? { value: clamp01(input.curtailedAvoidedShare), weight: 0.32 } : null,
    input.dampingPct !== null ? { value: clamp01(input.dampingPct / 100), weight: 0.33 } : null,
    input.peakReductionShare !== null ? { value: clamp01(input.peakReductionShare), weight: 0.2 } : null,
    input.importReductionShare !== null ? { value: clamp01(input.importReductionShare), weight: 0.15 } : null,
  ].filter((part): part is { value: number; weight: number } => part !== null);

  if (parts.length === 0) {
    return null;
  }

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const weighted = parts.reduce((sum, part) => sum + part.value * part.weight, 0);
  return Math.round((weighted / totalWeight) * 100);
}

function evaluateBessScenario(params: {
  slots: GermanyDispatchSlotsResponse["slots"];
  capacityMwh: number;
  maxPowerMw: number | null;
  initialSocMwh: number;
  resetDailyByBerlin: boolean;
  marketReference: RevenueModelPayload["marketReference"] | null;
}): ScenarioImpactSnapshot {
  const { slots, capacityMwh, maxPowerMw, initialSocMwh, resetDailyByBerlin, marketReference } = params;

  const coverage = computeCoverageAtCapacityMwh(slots, capacityMwh, {
    maxPowerMw,
    initialSocMwh,
    resetDailyByBerlin,
  });

  const dispatchSeries =
    capacityMwh > 0
      ? simulatePracticalDispatchAtCapacity(slots, capacityMwh, {
          maxPowerMw,
          initialSocMwh,
          resetDailyByBerlin,
        })
      : [];
  const adjustedNetSeries =
    capacityMwh > 0
      ? simulateAdjustedNetMwAtCapacity(slots, capacityMwh, {
          maxPowerMw,
          initialSocMwh,
          resetDailyByBerlin,
        })
      : [];

  let absorbedCurtailmentEnergyMwh = 0;
  let peakAbsNetMw = 0;
  let peakAbsAdjustedNetMw = 0;
  let baselineAbsMwh = 0;
  let adjustedAbsMwh = 0;
  let hasObservedCrossBorder = false;
  let observedImportEnergyMwh = 0;
  let simulatedImportEnergyMwh = 0;

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]!;
    const structuralSurplusMwh = Math.max(0, slot.totalGenerationMw - slot.loadMw) * QUARTER_HOUR_H;
    const curtailedMwh = Math.max(0, slot.curtailmentMw ?? 0) * QUARTER_HOUR_H;
    const chargeMwh = (dispatchSeries[i]?.chargeMw ?? 0) * QUARTER_HOUR_H;
    const totalChargeOpportunityMwh = structuralSurplusMwh + curtailedMwh;
    if (chargeMwh > 0 && totalChargeOpportunityMwh > 0 && curtailedMwh > 0) {
      absorbedCurtailmentEnergyMwh += Math.min(
        curtailedMwh,
        chargeMwh * (curtailedMwh / totalChargeOpportunityMwh)
      );
    }

    const netMw = slot.totalGenerationMw - slot.loadMw;
    baselineAbsMwh += Math.abs(netMw) * QUARTER_HOUR_H;
    adjustedAbsMwh += Math.abs(adjustedNetSeries[i] ?? netMw) * QUARTER_HOUR_H;
    peakAbsNetMw = Math.max(peakAbsNetMw, Math.abs(netMw));
    peakAbsAdjustedNetMw = Math.max(
      peakAbsAdjustedNetMw,
      Math.abs(adjustedNetSeries[i] ?? netMw)
    );

    if (slot.crossBorderElectricityTradingMw !== null && slot.crossBorderElectricityTradingMw !== undefined) {
      hasObservedCrossBorder = true;
      const observedCrossBorderMw = slot.crossBorderElectricityTradingMw;
      const practicalChargeMw = dispatchSeries[i]?.chargeMw ?? 0;
      const practicalDischargeMw = dispatchSeries[i]?.dischargeMw ?? 0;
      const borderCoupledChargeMw = borderCoupledBatteryChargeMw(slot, practicalChargeMw);
      observedImportEnergyMwh += Math.max(0, observedCrossBorderMw) * QUARTER_HOUR_H;
      simulatedImportEnergyMwh +=
        Math.max(0, observedCrossBorderMw + borderCoupledChargeMw - practicalDischargeMw) *
        QUARTER_HOUR_H;
    }
  }

  const remainingCurtailmentEnergyMwh = Math.max(0, coverage.totalCurtailmentEnergyMwh - absorbedCurtailmentEnergyMwh);
  const peakReductionMw = Math.max(0, peakAbsNetMw - peakAbsAdjustedNetMw);
  const gridImpactReductionPct =
    baselineAbsMwh > 0
      ? Math.min(100, Math.max(0, (1 - adjustedAbsMwh / baselineAbsMwh) * 100))
      : null;
  const importReductionEnergyMwh = hasObservedCrossBorder
    ? Math.max(0, observedImportEnergyMwh - simulatedImportEnergyMwh)
    : null;

  const spreadEurPerMwh =
    marketReference !== null && marketReference.derivedSpotSpreadEurPerMwh > 0
      ? marketReference.derivedSpotSpreadEurPerMwh
      : null;
  const redispatchEurPerMwh =
    marketReference !== null && marketReference.positiveRedispatchCostEurPerMwh > 0
      ? marketReference.positiveRedispatchCostEurPerMwh
      : null;

  const curtailedRecoveredToLoadEnergyMwh = Math.min(
    absorbedCurtailmentEnergyMwh,
    coverage.servedDeficitEnergyMwh
  );
  const bessRevenueTodayEur =
    spreadEurPerMwh !== null
      ? Math.max(0, coverage.servedDeficitEnergyMwh - curtailedRecoveredToLoadEnergyMwh) * spreadEurPerMwh
      : null;
  const avoidedCurtailmentValueEur =
    spreadEurPerMwh !== null ? curtailedRecoveredToLoadEnergyMwh * spreadEurPerMwh : null;
  const avoidedRedispatchCostsEur =
    redispatchEurPerMwh !== null ? absorbedCurtailmentEnergyMwh * redispatchEurPerMwh : null;

  const opportunityValuePerMwh = computeOpportunityValuePerMwh(
    marketReference,
    coverage.totalChargeOpportunityEnergyMwh,
    coverage.totalCurtailmentEnergyMwh
  );
  const chargeOpportunityValueEur =
    opportunityValuePerMwh !== null
      ? coverage.absorbedSurplusEnergyMwh * opportunityValuePerMwh
      : null;
  const missedOpportunityEur =
    opportunityValuePerMwh !== null
      ? Math.max(0, coverage.totalChargeOpportunityEnergyMwh - coverage.absorbedSurplusEnergyMwh) *
        opportunityValuePerMwh
      : null;
  const totalValueCreatedEur =
    bessRevenueTodayEur !== null &&
    avoidedCurtailmentValueEur !== null &&
    avoidedRedispatchCostsEur !== null
      ? bessRevenueTodayEur + avoidedCurtailmentValueEur + avoidedRedispatchCostsEur
      : null;

  const gridReliefScore = computeGridReliefScore({
    curtailedAvoidedShare:
      coverage.totalCurtailmentEnergyMwh > 1e-9
        ? absorbedCurtailmentEnergyMwh / coverage.totalCurtailmentEnergyMwh
        : null,
    dampingPct: coverage.totalChargeOpportunityEnergyMwh > 0 ? gridImpactReductionPct : null,
    peakReductionShare: peakAbsNetMw > 0 ? peakReductionMw / peakAbsNetMw : null,
    importReductionShare:
      hasObservedCrossBorder && observedImportEnergyMwh > 1e-9 && importReductionEnergyMwh !== null
        ? importReductionEnergyMwh / observedImportEnergyMwh
        : null,
  });

  return {
    coverage,
    absorbedCurtailmentEnergyMwh,
    remainingCurtailmentEnergyMwh,
    peakReductionMw,
    gridImpactReductionPct,
    observedImportEnergyMwh: hasObservedCrossBorder ? observedImportEnergyMwh : null,
    simulatedImportEnergyMwh: hasObservedCrossBorder ? simulatedImportEnergyMwh : null,
    importReductionEnergyMwh,
    bessRevenueTodayEur,
    avoidedRedispatchCostsEur,
    avoidedCurtailmentValueEur,
    chargeOpportunityValueEur,
    totalValueCreatedEur,
    missedOpportunityEur,
    curtailedRecoveredToLoadEnergyMwh,
    gridReliefScore,
  };
}

export default function GermanyDayEnergyFlow(props: GermanyDayEnergyFlowProps) {
  const {
    fleetCapacityGwh,
    fleetPowerGw,
    language,
    isRefreshing = false,
    lastUpdatedIso = null,
    onRefresh,
    onChartFleetSocSnapshot,
    simulationAiInsight = null,
    initialEnergyFlow = null,
    initialBerlinDateKey = null,
    seedDateKey = null,
    onBerlinDateChange,
    onBriefingStoryWindowChange,
    briefingStoryWindow: _briefingStoryWindow = null,
    briefingStoryRefreshNonce: _briefingStoryRefreshNonce = 0,
    initialSimulatedNet = false,
    onSimulatedModeChange,
  } = props;
  const resolvedSeedKey = resolveSeedDateKey(seedDateKey ?? undefined);
  const [selectorMode, setSelectorMode] = useState<SelectorMode>("day");
  const [selectedDate, setSelectedDate] = useState(resolvedSeedKey);
  const [selectedWeek, setSelectedWeek] = useState(dateKeyToIsoWeekKey(resolvedSeedKey));
  const [selectedMonth, setSelectedMonth] = useState(resolvedSeedKey.slice(0, 7));
  const [customRangeStart, setCustomRangeStart] = useState(() =>
    addBerlinCalendarDays(resolvedSeedKey, -6)
  );
  const [customRangeEnd, setCustomRangeEnd] = useState(resolvedSeedKey);
  const [dayModeResetAtStart] = useState(false);
  const [customSimulatedCapacityGwhApplied, setCustomSimulatedCapacityGwhApplied] = useState("");
  const [customSimulatedCapacityGwhDraft, setCustomSimulatedCapacityGwhDraft] = useState("");
  const serverHydratedFirstLoad =
    initialEnergyFlow !== null &&
    initialBerlinDateKey !== null &&
    initialBerlinDateKey === resolvedSeedKey;
  const softFirstLoadRef = useRef(serverHydratedFirstLoad);

  const [flow, setFlow] = useState<GermanyDispatchSlotsResponse | null>(() =>
    serverHydratedFirstLoad ? initialEnergyFlow : null
  );
  const [recommendation, setRecommendation] = useState<BessRecommendation | null>(null);
  const [revenueModel, setRevenueModel] = useState<RevenueModelPayload | null>(null);
  const [previousDaySlots, setPreviousDaySlots] = useState<GermanyDispatchSlotsResponse["slots"]>([]);
  /** Berlin day D−2 slots; used only in day mode with carry-in to seed D−1’s starting SoC instead of forcing 0%. */
  const [dayBeforePreviousSlots, setDayBeforePreviousSlots] = useState<GermanyDispatchSlotsResponse["slots"]>([]);
  /** Prior ISO week slots; week mode warm-starts SoC via a 12M-balanced simulation on this window. */
  const [previousWeekSlots, setPreviousWeekSlots] = useState<GermanyDispatchSlotsResponse["slots"]>([]);
  /**
   * Modeled end-of-day SOC (MWh) for the last Berlin day the user actually viewed, used when stepping
   * the date forward by one day — matches the chart the user saw instead of re-deriving from API-only chains.
   */
  const endFleetSocMwhByDateRef = useRef<Map<string, number>>(new Map());
  const endPracticalSocMwhByDateRef = useRef<Map<string, number>>(new Map());
  /** Prior `selectedDate` for detecting +1 transitions (updated only when navigation actually changes date). */
  const priorBerlinDayForNavigationRef = useRef<string>(selectedDate);
  /** Carry from the SOC map when stepping calendar +1 — React state so memos stay pure (no ref reads during render). */
  const [fleetNavigateInitialMwh, setFleetNavigateInitialMwh] = useState<number | null>(null);
  const [practicalNavigateInitialMwh, setPracticalNavigateInitialMwh] = useState<number | null>(null);
  const prevDayModeResetAtStartRef = useRef(dayModeResetAtStart);
  const [isFlowLoading, setIsFlowLoading] = useState(!serverHydratedFirstLoad);
  const [isRecommendationLoading, setIsRecommendationLoading] = useState(true);
  const [isRevenueModelLoading, setIsRevenueModelLoading] = useState(true);
  const [flowLoadError, setFlowLoadError] = useState(false);
  const [recommendationLoadError, setRecommendationLoadError] = useState(false);
  const [revenueModelLoadError, setRevenueModelLoadError] = useState(false);
  const simulatedCapacityInputId = useId();
  const simulatedCapacityHintId = useId();
  const simulatedCapacityInputRef = useRef<HTMLInputElement | null>(null);
  const [chartLayoutCompact, setChartLayoutCompact] = useState(false);
  const [flowChartFullscreenOpen, setFlowChartFullscreenOpen] = useState(false);
  const [flowChartFullscreenMode, setFlowChartFullscreenMode] = useState<"observed" | "simulated">(() =>
    initialSimulatedNet ? "simulated" : "observed"
  );

  useEffect(() => {
    if (!flowChartFullscreenOpen) {
      return undefined;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [flowChartFullscreenOpen]);

  useEffect(() => {
    if (!flowChartFullscreenOpen) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFlowChartFullscreenOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flowChartFullscreenOpen]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return undefined;
    }
    const mq = window.matchMedia("(max-width: 639px)");
    const apply = () => setChartLayoutCompact(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const softOpen = softFirstLoadRef.current;
      if (softOpen) {
        softFirstLoadRef.current = false;
      } else {
        setIsFlowLoading(true);
      }
      setFlowLoadError(false);
      try {
        const query =
          selectorMode === "day"
            ? `date=${selectedDate}`
            : selectorMode === "week"
              ? `week=${selectedWeek}`
              : selectorMode === "month"
                ? `month=${selectedMonth}`
                : `start=${customRangeStart}&end=${customRangeEnd}`;
        const response = await fetch(`/api/market/de/energy-flow?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`energy flow ${response.status}`);
        }
        const raw: unknown = await response.json();
        const parsed = germanyEnergyFlowApiSchema.safeParse(raw);
        if (!parsed.success) {
          log("energy flow schema failed %o", {
            errors: parsed.error.flatten(),
            selectorMode,
            selectedDate,
            selectedWeek,
            selectedMonth,
            customRangeStart,
            customRangeEnd,
          });
          throw new Error("schema");
        }
        if (!controller.signal.aborted) {
          setFlow(parsed.data);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        log("energy flow fetch failed %o", {
          selectorMode,
          selectedDate,
          selectedWeek,
          selectedMonth,
          customRangeStart,
          customRangeEnd,
          error,
        });
        setFlow(null);
        setFlowLoadError(true);
      } finally {
        if (!controller.signal.aborted) {
          setIsFlowLoading(false);
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [selectorMode, selectedDate, selectedWeek, selectedMonth, customRangeStart, customRangeEnd]);

  const skipBerlinUrlNotifyRef = useRef(true);
  useEffect(() => {
    if (selectorMode !== "day" || !onBerlinDateChange) {
      return;
    }
    if (skipBerlinUrlNotifyRef.current) {
      skipBerlinUrlNotifyRef.current = false;
      return;
    }
    onBerlinDateChange(selectedDate);
  }, [selectedDate, selectorMode, onBerlinDateChange]);

  const currentBriefingStoryWindow = useMemo((): BriefingStoryWindow => {
    if (selectorMode === "day") {
      return { type: "day", date: selectedDate };
    }
    if (selectorMode === "week") {
      return { type: "week", weekKey: selectedWeek };
    }
    if (selectorMode === "month") {
      return { type: "month", monthKey: selectedMonth };
    }
    return { type: "custom", start: customRangeStart, end: customRangeEnd };
  }, [selectorMode, selectedDate, selectedWeek, selectedMonth, customRangeStart, customRangeEnd]);

  useEffect(() => {
    if (!onBriefingStoryWindowChange) {
      return;
    }
    onBriefingStoryWindowChange(currentBriefingStoryWindow);
  }, [currentBriefingStoryWindow, onBriefingStoryWindowChange]);

  /** Loads trail windows for SoC carry-in (D−1/D−2 in day mode, prior week in week mode). */
  useEffect(() => {
    const controller = new AbortController();
    const loadTrail = async () => {
      if (selectorMode === "week") {
        try {
          const prevWeek = previousIsoWeekKey(selectedWeek);
          const resp = await fetch(`/api/market/de/energy-flow?week=${prevWeek}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!resp.ok) {
            throw new Error(`energy flow prior week ${resp.status}`);
          }
          const parsed = germanyEnergyFlowApiSchema.safeParse(await resp.json());
          if (!parsed.success) {
            throw new Error("prior week schema");
          }
          if (!controller.signal.aborted) {
            setPreviousWeekSlots(parsed.data.slots);
            setPreviousDaySlots([]);
            setDayBeforePreviousSlots([]);
          }
        } catch {
          if (!controller.signal.aborted) {
            setPreviousWeekSlots([]);
            setPreviousDaySlots([]);
            setDayBeforePreviousSlots([]);
          }
        }
        return;
      }
      if (selectorMode !== "day") {
        if (!controller.signal.aborted) {
          setPreviousWeekSlots([]);
          setPreviousDaySlots([]);
          setDayBeforePreviousSlots([]);
        }
        return;
      }
      try {
        if (!controller.signal.aborted) {
          setPreviousWeekSlots([]);
        }
        const previousDate = addBerlinCalendarDays(selectedDate, -1);
        const prevResp = await fetch(`/api/market/de/energy-flow?date=${previousDate}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!prevResp.ok) {
          throw new Error(`energy flow yesterday ${prevResp.status}`);
        }
        const prevParsed = germanyEnergyFlowApiSchema.safeParse(await prevResp.json());
        if (!prevParsed.success) {
          throw new Error("yesterday schema");
        }
        if (!controller.signal.aborted) {
          setPreviousDaySlots(prevParsed.data.slots);
        }

        try {
          const beforePreviousDate = addBerlinCalendarDays(selectedDate, -2);
          const beforeResp = await fetch(`/api/market/de/energy-flow?date=${beforePreviousDate}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!beforeResp.ok) {
            throw new Error(`energy flow before-previous ${beforeResp.status}`);
          }
          const beforeParsed = germanyEnergyFlowApiSchema.safeParse(await beforeResp.json());
          if (!beforeParsed.success) {
            throw new Error("before-previous schema");
          }
          if (!controller.signal.aborted) {
            setDayBeforePreviousSlots(beforeParsed.data.slots);
          }
        } catch {
          if (!controller.signal.aborted) {
            setDayBeforePreviousSlots([]);
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          setPreviousDaySlots([]);
          setDayBeforePreviousSlots([]);
        }
      }
    };
    void loadTrail();
    return () => controller.abort();
  }, [selectorMode, selectedDate, selectedWeek]);

  useLayoutEffect(() => {
    const resetChanged = prevDayModeResetAtStartRef.current !== dayModeResetAtStart;
    prevDayModeResetAtStartRef.current = dayModeResetAtStart;

    let nextFleet: number | null = null;
    let nextPractical: number | null = null;
    let didNavigate = false;

    if (selectorMode !== "day") {
      priorBerlinDayForNavigationRef.current = selectedDate;
      nextFleet = null;
      nextPractical = null;
      didNavigate = true;
    } else if (dayModeResetAtStart) {
      priorBerlinDayForNavigationRef.current = selectedDate;
      nextFleet = null;
      nextPractical = null;
      didNavigate = true;
    } else if (resetChanged) {
      nextFleet = null;
      nextPractical = null;
      didNavigate = true;
    } else {
      const from = priorBerlinDayForNavigationRef.current;
      if (from !== selectedDate) {
        didNavigate = true;
        if (selectedDate === addBerlinCalendarDays(from, 1)) {
          const fleetStored = endFleetSocMwhByDateRef.current.get(from);
          nextFleet =
            fleetStored !== undefined && Number.isFinite(fleetStored) ? Math.max(0, fleetStored) : null;
          const practicalStored = endPracticalSocMwhByDateRef.current.get(from);
          nextPractical =
            practicalStored !== undefined && Number.isFinite(practicalStored)
              ? Math.max(0, practicalStored)
              : null;
        }
        priorBerlinDayForNavigationRef.current = selectedDate;
      }
    }

    if (didNavigate) {
      setFleetNavigateInitialMwh(nextFleet);
      setPracticalNavigateInitialMwh(nextPractical);
    }
  }, [selectorMode, selectedDate, dayModeResetAtStart]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setIsRecommendationLoading(true);
      setRecommendationLoadError(false);
      try {
        const response = await fetch("/api/market/de/energy-flow?recommendation=trailing_12m", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`recommendation ${response.status}`);
        }
        const raw: unknown = await response.json();
        const parsed = bessRecommendationApiSchema.safeParse(raw);
        if (!parsed.success) {
          log("recommendation schema failed %o", { errors: parsed.error.flatten() });
          throw new Error("recommendation schema");
        }
        if (!controller.signal.aborted) {
          setRecommendation(parsed.data);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        log("recommendation fetch failed %o", { error });
        setRecommendation(null);
        setRecommendationLoadError(true);
      } finally {
        if (!controller.signal.aborted) {
          setIsRecommendationLoading(false);
        }
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setIsRevenueModelLoading(true);
      setRevenueModelLoadError(false);
      try {
        const response = await fetch("/api/revenue-model/de", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`revenue-model ${response.status}`);
        }
        const raw: unknown = await response.json();
        const parsed = revenueModelApiSchema.safeParse(raw);
        if (!parsed.success) {
          log("revenue model schema failed %o", { errors: parsed.error.flatten() });
          throw new Error("revenue model schema");
        }
        if (!controller.signal.aborted) {
          setRevenueModel(parsed.data);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        log("revenue model fetch failed %o", { error });
        setRevenueModel(null);
        setRevenueModelLoadError(true);
      } finally {
        if (!controller.signal.aborted) {
          setIsRevenueModelLoading(false);
        }
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  const t = useMemo(
    () =>
      language === "de"
      ? {
          eyebrow: "Energy-Charts Profile",
          title: "Deutschland-Tagesprofil – beobachteter Überschuss, Defizit & geschätzter Flotten-SoC",
          chartTitle: "Überschuss / Defizit",
          chartSimulatedPanelTitle: "Modellierte BESS · Leistung & SoC",
          legendNet: "Netto",
          legendNetHint: "+Überschuss / −Defizit (Erzeugung − Last)",
          legendNetSimulated: "Netto (sim.)",
          legendNetSimulatedHint: "Strukturelles Netto nach modellierter BESS-Schicht",
          legendFleetSoc: "Flotten-SoC",
          legendFleetSocHint: "Geschätzter SoC aus dem Flottenmodell",
          legendPracticalSoc: "SoC",
          legendPracticalCharge: "Laden",
          legendPracticalDischarge: "Entladen",
          legendEstimatedCharge: "Laden",
          legendEstimatedChargeHint: "Geschätzte Ladung (Flottenmodell)",
          legendEstimatedDischarge: "Entladen",
          legendEstimatedDischargeHint: "Geschätzte Entladung (Flottenmodell)",
          legendObservedImport: "Import",
          legendObservedExport: "Export",
          legendSimulatedImport: "Import (sim.)",
          legendSimulatedExport: "Export (sim.)",
          legendCurtailment: "Abregelung",
          observedChargeDischargeFootnote:
            "Laden/Entladen: gleiches Flottenmodell wie SoC (keine Echtzeitmesswerte).",
          curtailmentFootnote:
            "Abregelung: Zusatzreihe zur Ladechance; Nettolinie unverändert.",
          crossBorderFootnote:
            "Import/Export: Energy-Charts-Grenzhandel; simuliert: beobachtete Werte verschieben sich um BESS-Leistung, die nicht schon aus Inlandsüberschuss oder Abregelung gedeckt ist, zuzüglich Entladung (1:1 für diesen Rest).",
          legendSimulatedPrefix: "Simuliert:",
          legendEvening: "Abend",
          legendEveningHint: "Abendfenster (hervorgehoben)",
          toggleNetSimulation: "Praktische BESS-Simulation auf Netto anwenden",
          netFootnote: "Netto = Erzeugung − Last je Slot.",
          netFootnoteSimulated:
            "Netto = strukturelles Netto nach modelliertem BESS (nicht Roh-Gen−Last).",
          socFootnote: "SoC modelliert, kein Messwert.",
          kpiGross: "Brutto-Überschuss (Erz. − Last)",
          kpiAbsorbed: "Theoretisch speicherbar (Kap. + MW)",
          kpiMissed: "Verpasste Ladechance",
          kpiPracticalCap: "Praktische Tageszyklus-Kapazität (P95)",
          kpiRecommendedBalanced: "Empfehlung (12M, Balanced)",
          kpiRecommendedSelected: "Empfehlung (Auswahl, Balanced)",
          kpiRecommendationUnavailable:
            "12-Monats-Empfehlung aktuell nicht verfügbar (Upstream-Daten fehlen).",
          trailingKpiCapacity: "Empfohlene durchschnittliche Tagesgröße",
          trailingKpiDailyPercentileCaption: "P90 der modellierten Kalendertage",
          trailingKpiPayback: "Payback (Indikation)",
          trailingKpiImpact: "Abdeckung %",
          trailingBulletTier: "Balanced Tier aus täglichem Energie-/Leistungsbedarf (Percentil je Tag).",
          trailingChainPeakLabel: "Ketten-Spitzen-SoC (ohne täglichen Reset über das Fenster)",
          trailingNotAuditedNote:
            "Keine externe Plausibilisierung; rein aus Energy-Charts Gen−Last + Heuristik. Keine Beschaffungsempfehlung.",
          kpiPracticalCapMax: "Tages-Maximum",
          coverage: (n: number, pct: string, date: string, multi: boolean) =>
            multi
              ? `${n} Viertelstunden (${pct}% des gewählten Fensters) · ${date}`
              : `${n} Viertelstunden beobachtet (${pct}% des Tages) · ${date}`,
          axisMw: "MW",
          axisSoc: "SoC (%)",
          unavailable:
            "Für keine Berlin-Tag-Linie reichen zeitlich genug brauchbare Viertelstunden — bitte später erneut laden.",
          timeframe: "Zeitraum",
          dayMode: "Tag",
          weekMode: "Woche",
          monthMode: "Monat",
          customMode: "Zeitraum",
          previousRange: "Zurück",
          nextRange: "Weiter",
          dayResetToggleLabel:
            "Tagesstart-SoC in der Simulation bei 0 % (optional)",
          fetchError:
            "Energy-Charts-Zeitreihe konnte nicht geladen werden — bitte Verbindung prüfen und erneut versuchen.",
          dataNote: "Nur veröffentlichte Energy-Charts-Viertelstunden; keine interpolierten Werte.",
          loadingEyebrow: "Energy-Charts werden geladen",
          keyMetricsTitle: "Kennzahlen",
          kpiRecommendedP95Eyebrow: "Empfohlene Kapazität (P95)",
          kpiRecommendedP95Subtitle: "Pragmatischer täglicher Speicherbedarf (95. Perzentil)",
          kpiGrossSurplusEyebrow: "Ladechance",
          kpiGrossSurplusSubtitle: "Zeitraum",
          kpiMissedSurplusEyebrow: "Verpasste Ladechance",
          kpiMissedSurplusSubtitle: "Nicht aufnehmbar aus Überschuss + Abregelung",
          kpiMissedOfGross: (pct: string) => `${pct}% der Ladechance`,
          kpiSelfConsumptionEyebrow: "Eigenverbrauchsquote (optimales BESS)",
          kpiSelfConsumptionSubtitle: "Der erzeugten Energie vor Ort verwendet",
          kpiFleetRequiredShort: "Flotten-Leistung und -Kapazität aus dem Snapshot für dieses KPI nötig.",
          profileTitle: "Deutschland-Tagesprofil",
          profileSubtitle:
            "Live-Snapshot, Ausgangslage, Flotte, verpasste Chance, Kurven, modellierte Systemwirkung — zuletzt Fazit und Skalierung (Europa/Berlin).",
          modeObserved: "Beobachtet",
          modeSimulated: "Simuliertes BESS",
          timeframeLabelShort: "Zeitraum",
          timeRangeControlTitle: "Tag, Woche, Monat oder Zeitraum wählen",
          timeRangeTapToChange: "Tippen zum Ändern",
          dataCoverageInfoAria: "Was bedeutet die Datenabdeckung?",
          dataCoverageTooltip:
            "Anteil der erwarteten Viertelstunden im gewählten Zeitraum, für die Energy-Charts veröffentlichte Messreihen liefern (keine interpolierten Lücken).",
          coverageBadgeSuffix: "Datenabdeckung",
          observedChartTitle: "Netto, Flotten-SoC & Grenzfluss",
          recoImpactEyebrow: "Unter der Kurve",
          recoImpactTitle: "Simulation & BESS-Empfehlung",
          recoImpactLead:
            "Dieser Block fasst die simulierte Fenstersicht zusammen: empfohlene Größe, Modellwirkung und optionales Kapazitäts-Override.",
          simulatedCtaObserved: "Zu Beobachtet wechseln",
          kpiCurtailmentEyebrow: "Abregelung",
          kpiCurtailmentSubtitle: "Zusatzreihe; Nettolinie bleibt roh",
          kpiCapturedSurplusEyebrow: "Ladechance (aufgenommen)",
          kpiCapturedSurplusSubtitle: "Greedy-Simulation aus Überschuss + Abregelung",
          curtailmentStatusConfigured: "Abregelung geladen",
          curtailmentStatusMissingConfig: "Abregelung nicht konfiguriert",
          curtailmentStatusUpstream: "Abregelungsdaten fehlen",
          kpiDeficitCoveredEyebrow: "Gedecktes Defizit",
          kpiDeficitCoveredSubtitle: "Aus Speicher gefüllt",
          kpiNewSelfConsumptionEyebrow: "Neue Eigenverbrauchsquote",
          kpiNewSelfConsumptionSubtitle: "Mit modelliertem BESS",
          kpiGridImpactEyebrow: "Dämpfung |Netto| je Slot",
          kpiGridImpactSubtitle: "Vs. Roh-Nettos (Viertelstunden)",
          kpiGridImpactValue: (pct: string) =>
            `Summe der Absolutbeträge ~${pct} % niedriger (nach modelliertem BESS)`,
          kpiObservedImportsEyebrow: "Beobachtete Importe",
          kpiObservedExportsEyebrow: "Beobachtete Exporte",
          kpiImportsAfterBessEyebrow: "Importe nach BESS",
          kpiExportsAfterBessEyebrow: "Exporte nach BESS",
          kpiCrossBorderObservedSubtitle: "Energy-Charts Grenzhandel",
          kpiCrossBorderDeltaSubtitle: (observed: string, delta: string) =>
            `Beobachtet ${observed} · Δ ${delta} ggü. Ist`,
          observedModeLead:
            "P95 aus diesem Fenster. Simulation zeigt Überschussaufnahme und Netzwirkung.",
          capacityBadgeUnavailable: "Keine berechenbare Simulationskapazität",
          simulatedCapacityBadgeLabel: (capacity: string) => `Simulierte Kapazität: ${capacity}`,
          simulatedCapacityModeAutoWindow: "Automatik · Fenster-P95",
          simulatedCapacityModeAuto12m: "Automatik · 12M balanced",
          simulatedCapacityModeCustom: "Manuell gesetzt",
          simulatedCapacityPowerBadge: (power: string) => `Leistungslimit: ${power}`,
          simulatedCapacityControlEyebrow: "Kapazität überschreiben",
          simulatedCapacityControlTitle: "Simulierte BESS-Kapazität anpassen",
          simulatedCapacityInputLabel: "Kapazität (GWh)",
          simulatedCapacityInputHint: (power: string) =>
            `Das Leistungslimit bleibt bei ${power} (balanced).`,
          simulatedCapacityInputHintUnavailable:
            "Das Leistungsmodell wird geladen. Sobald die Fenster-Empfehlung da ist, erscheint hier das Power-Limit.",
          simulatedCapacityReset: "Automatik wiederherstellen",
          simulatedCapacityApply: "Übernehmen",
          simulatedCapacityInputInvalid:
            "Bitte eine positive GWh-Zahl eingeben, z. B. 2,5.",
          simulatedCapacitySourceAuto: "Automatik",
          simulatedCapacitySourceCustom: "Manuell",
          aiInsightTitle: "KI-Einblick",
          insightRuleBasedTitle: "Kurzfazit",
          bottomControlsHint:
            "Beobachtete Daten stehen oben; die modellierte BESS-Simulation mit ihren KPIs folgt direkt darunter.",
          chartFullscreenExpand: "Diagramm im Vollbild",
          chartFullscreenClose: "Schließen",
          chartFullscreenTitle: "Tagesprofil",
          chartFullscreenEscHint: "Escape schließt die Ansicht.",
          onePagerStructuralEyebrow: "Ausgangslage heute",
          onePagerStructuralLead:
            "Nettobilanz und strukturelle Spannungen fassen das Fenster zusammen; der Grenzhandel zeigt den beobachteten Import- und Exportrahmen.",
          onePagerBorderTradeTitle: "Beobachteter Grenzhandel (Import + Export)",
          onePagerInstalledFleetEyebrow: "Performance der aktuellen Flotte",
          onePagerInstalledFleetLead:
            "So nutzt die installierte DE-BESS-Schicht die Ladechance, wie viel Brutto-Defizit sie deckt, und ein kompakter SoC-Snapshot — direkt aus dem gleichen Slot-Modell wie die Kurven.",
          onePagerMissedEyebrow: "Verpasste Opportunität",
          onePagerMissedLead:
            "Was bei der aktuell modellierten Kapazität (Slider) nicht mehr in den Speicher passt — Energie, indikativer Marktwert und Anteil der Rest-Chance.",
          onePagerStructuralDeficitEyebrow: "Brutto-Defizit",
          onePagerStructuralDeficitSubtitle: "Energie in strukturellen Minus-Slots",
          kpiInstalledFleetAbsorbedEyebrow: "Ladechance aufgenommen (Flotte)",
          kpiInstalledFleetAbsorbedSubtitle: "Greedy-Walk mit installierter Schicht",
          onePagerChartsIntro: "Kurven: beobachtete Flotte, darunter modellierte BESS.",
          workspaceLiveSnapshotEyebrow: "Live-Snapshot",
          workspaceLiveSnapshotLead:
            "Kurzer Lagebericht aus denselben Viertelstunden — die Kennzahlen darunter quantifizieren dieselbe Fensterrechnung.",
          workspaceChartsEyebrow: "Kurven",
          workspaceChartsLead:
            "Zwei Panels im gewählten Zeitraum: oben beobachtete Flotte (Energy-Charts), darunter modellierte BESS mit einstellbarer Kapazität.",
          workspaceConclusionEyebrow: "Fazit & Empfehlungen",
          workspaceConclusionLead:
            "Ein-Tages-Optimum und 12-Monats-Balanced nutzen dieselbe Flottenlogik — der Zeithorizont unterscheidet die Größe.",
          workspaceTechnicalImpactEyebrow: "Systemwirkung (Technisch)",
          workspaceIndicativeEconomicsEyebrow: "Indikativer wirtschaftlicher Nutzen",
          kpiIndicativeDisclaimerTitle: "Indikativer Nutzen — keine Erlösprognose",
          kpiIndicativeValueDisclaimerProminent:
            "Kein Vertrags-, Prognose- oder Handelserlös. Vereinfachtes Proxy-Modell (SMARD-Spread, Abregelung/Redispatch) für die Einordnung im gewählten Fenster.",
          workspaceModeledBorderEyebrow: "Grenzfluss (modelliert)",
          workspaceModeledBorderSubtitle:
            "Import- und Exportänderung vs. beobachtet (Grenzproxy: nur grenzkoppelnde BESS-Leistung plus Entladung).",
          onePagerImpactHeading: "Systemwirkung & Wert",
          onePagerImpactLead:
            "Was die Simulation im gewählten Fenster leistet — technisch und als indikativer Euro-Proxy (SMARD-Spread, keine Garantie).",
          onePagerImpactTechTitle: "Technische Wirkung",
          onePagerImpactValueTitle: "Indikativer Nutzen",
          onePagerImpactEnergyTitle: "Eingelagerte Energie",
          onePagerImpactBorderTitle: "Grenzfluss (modelliert)",
          kpiIndicativeValueDisclaimer:
            "Indikativ = vereinfachtes Modell (Spread + Abregelung), nicht Vertrags- oder Prognoseerlös.",
          kpiValueBreakdownTitle: "Zusammensetzung des modellierten Nutzens",
          kpiValueBreakdownFootnote:
            "Details per Zeile im Tooltip. Abregelung/Redispatch nur für aufgenommene Abregel-MWh.",
          twelveMonthKpiPaybackDetail:
            "Vereinfachte Amortisation: geschätzte Investitionskosten ÷ modellierter Jahreserlös (12M-Balanced, illustrative CAPEX-Annahmen). Keine Finanzierungs-, Steuer- oder Netzentgeltlogik.",
          twelveMonthKpiRevenueDetail:
            "Jahreserlös aus dem gleichen Vorverkaufsmodell wie der Konfigurator — nicht der Tageswert oben.",
          marginalImpactInterpretation:
            "Lesen Sie die Spalten als „was passiert, wenn die installierte Flotte wächst“. Steigt die aufgenommene Energie kaum, ist die Ladechance im Fenster fast erschöpft. Die Umsatzzeile ist ein Proxy pro eingelagerter MWh — kein Börsenerlös. Der größte Sprung liegt oft zwischen Flotte und +30 %.",
          simulatedCapacityExtrapolationWarning:
            "Sehr hohe GWh-Werte erzeugen oft unrealistisch hohe Euro-Summen, weil der Proxy linear mit eingelagerter MWh skaliert.",
          onePagerNetPeakEyebrow: "Netzentlastung & Peak-Shaving",
          onePagerNetPeakPeakLine: (peak: string) => `Peak-Reduktion ${peak}`,
          onePagerFinalActionHint:
            "Kurz: verbleibende Ladechance sinkt mit mehr Energie oder Leistungskopf; die Kurven oben zeigen slotweise, wo die Flotte und die Simulation greifen.",
          onePagerDetailsSummary: "Hintergrund & Methodik",
          twelveMonthSectionEyebrow: "Langfristige Balanced-Empfehlung",
          twelveMonthSectionTitle: "Empfohlene BESS-Größe für die letzten 12 Monate",
          twelveMonthBalancedTag: "(Balanced)",
          twelveMonthExplainerSmallerThanDay:
            "Dies ist die empfohlene durchschnittliche Tagesgröße über die letzten 12 Monate (P90 der modellierten Kalendertage). Sie liegt etwas unter der optimalen Ein-Tages-Größe oben, weil sie über viele Tage gemittelt ist.",
          twelveMonthExplainerLargerThanDay:
            "Dies ist die empfohlene durchschnittliche Tagesgröße über die letzten 12 Monate (P90 der modellierten Kalendertage). Sie liegt etwas über der optimalen Ein-Tages-Größe oben, weil ein einzelner ruhiger Tag weniger strukturelle Speicherarbeit verlangt als der Jahres-P90.",
          twelveMonthExplainerNeutral:
            "Dies ist die empfohlene durchschnittliche Tagesgröße über die letzten 12 Monate (P90 der modellierten Kalendertage). Sie liegt in derselben Größenordnung wie die Ein-Tages-Optimallösung.",
          twelveMonthKpiPayback: "Amortisation (indik.)",
          twelveMonthKpiCoverage: "Abdeckung",
          twelveMonthKpiRevenue: "12M Balanced · Erlös",
          twelveMonthKpiPeakSoc: "Peak SoC über das Jahr",
          bridgeDayOptimalAboveYear: (day: string, year: string) =>
            `Die optimale Größe für den heutigen Tag (${day}) liegt etwas über der langfristig empfohlenen Balanced-Größe (${year}), weil heute ein besonders hoher struktureller Überschuss herrscht.`,
          bridgeDayOptimalBelowYear: (day: string, year: string) =>
            `Die optimale Größe für den heutigen Tag (${day}) liegt etwas unter der langfristig empfohlenen Balanced-Größe (${year}), weil das heutige Tagesprofil weniger strukturelle Speicherarbeit verlangt als der P90 über die Beobachtungsmonate.`,
          bridgeDayOptimalNearYear: (day: string, year: string) =>
            `Die Ein-Tages-Optimallösung (${day}) liegt nahe der empfohlenen 12-Monats-Balanced-Größe (${year}) — das heutige Tagesprofil entspricht dem Jahres-P90 gut.`,
          twelveMonthHeuristicNote: (window: string) =>
            `${window} · Balanced-Tier aus täglichem Energie- und Leistungsbedarf (Perzentil je Kalendertag).`,
          onePagerExportHint:
            "Bildexport: beide Kurven-Panels (Beobachtung und Simulation) aus diesem Bereich — kein Bezug zu Strom-Exporten.",
          marketBasisIntro:
            "Indikative Euro-Beträge auf dieser Seite (z. B. Wert bei der Systemwirkung oder verpasste Chance) stammen aus SMARD-Spotviertelstunden und — wo die Logik es nutzt — Netztransparenz-Redispatch. Es ist ein repräsentatives Marktbild über die angezeigte Stichprobe — nicht der einzelne Energy-Charts-Tag Ihrer Kurven oben.",
          marketBasisSpreadDetail:
            "Pro Kalendertag: höchster minus niedrigster durchschnittlicher Viertelstunden-Spotpreis. Über alle SMARD-Tage der Stichprobe gemittelt — grobe Größe für Spread-/Arbitrage-Raum im Modell.",
          marketBasisEveningDetail:
            "Differenz: mittlerer Spotpreis im Abendfenster minus mittlerer Preis am Mittag. Positiv, wenn der Abend teurer ist — grober Indikator für Günstigkeit von Zeitverlagerung.",
          marketBasisRedispatchDetail:
            "Positiver Mittel der berechneten Redispatch-Preise als €/MWh-Ansatz, wenn Abregelung in die Bewertung fließt. Der Energiewert darunter schätzt die durchschnittliche tägliche Abregel-Menge im Referenzfenster.",
          marketBasisChartHeading: "Typischer Tagespreis (vier Buckets)",
          marketBasisChartExplainer:
            "Die vier Balken sind jeweils der mittlere Spot €/MWh in Niedrig-, Mittag-, Abend- und Hoch-Last-Slots — gemittelt über die SMARD-Stichprobe. So sieht man die Tagesform des Marktes im Referenzfenster, unabhängig vom gewählten Kurven-Datum.",
          kpiStoredEndEyebrow: "Energie im Speicher (Ende Fenster)",
          kpiSimAbsorbedEyebrow: "Eingelagert (Simulation, Fenster)",
          kpiSimAbsorbedSubtitle:
            "Summe der im Modell aufgenommenen Ladechance (struktureller Überschuss + zuordenbare Abregelung), nicht der Speicherstand am Ende.",
          kpiSimVsFleetMissing:
            "Keine hinterlegte installierte Flotten-Kapazität — nur Simulationswert oben.",
          kpiSimVsFleetLine: (p: {
            fleetStored: string;
            simStored: string;
            capMult: string;
            energyMult: string;
            simCap: string;
            instCap: string;
          }) =>
            `Flotte (gleiches Fenster): ${p.fleetStored} eingelagert · Simulationskapazität ${p.simCap} zu installiert ${p.instCap} (${p.capMult}) · eingelagerte Energie ${p.simStored} zu ${p.fleetStored} (${p.energyMult})`,
          aiInsightPlaceholder:
            "Keine Zahlenbasis für diese Kurzfassung. Nach Anbindung eines LLM kann zusätzlicher Text uber die Prop simulationAiInsight kommen.",
          observedCtaSimulated: "Zu Simulation wechseln",
          technicalDisclaimer: "Illustratives Modell, keine Beschaffungsempfehlung.",
        }
      : {
          eyebrow: "Energy-Charts Profile",
          title: "Germany Day Profile – Observed Surplus, Deficit & Estimated Fleet SoC",
          chartTitle: "Surplus / deficit",
          chartSimulatedPanelTitle: "Modeled BESS · power & SoC",
          legendNet: "Net",
          legendNetHint: "+surplus / −deficit (generation − load)",
          legendNetSimulated: "Net (sim.)",
          legendNetSimulatedHint: "Structural net after modeled BESS layer",
          legendFleetSoc: "Fleet SoC",
          legendFleetSocHint: "Estimated fleet state of charge from the model",
          legendPracticalSoc: "SoC",
          legendPracticalCharge: "Charge",
          legendPracticalDischarge: "Discharge",
          legendEstimatedCharge: "Charge",
          legendEstimatedChargeHint: "Estimated charge (fleet model)",
          legendEstimatedDischarge: "Discharge",
          legendEstimatedDischargeHint: "Estimated discharge (fleet model)",
          legendObservedImport: "Import",
          legendObservedExport: "Export",
          legendSimulatedImport: "Import (sim.)",
          legendSimulatedExport: "Export (sim.)",
          legendCurtailment: "Curtailment",
          observedChargeDischargeFootnote:
            "Charge/discharge: same fleet model as SoC (not real-time telemetry).",
          curtailmentFootnote:
            "Curtailment: extra charge-opportunity series; net line unchanged.",
          crossBorderFootnote:
            "Import/export: Energy-Charts border trade; simulated series shift observed values by BESS power not already covered by structural surplus or curtailment, plus discharge (1:1 for that remainder).",
          legendSimulatedPrefix: "Simulated:",
          legendEvening: "Evening",
          legendEveningHint: "Evening window (highlighted)",
          toggleNetSimulation: "Apply practical BESS simulation to net line",
          netFootnote: "Net = generation − load per slot.",
          netFootnoteSimulated:
            "Net = structural net after modeled BESS in this view (not raw gen − load).",
          socFootnote: "SoC is modeled, not measured.",
          kpiGross: "Charge opportunity",
          kpiAbsorbed: "Theoretically storable (cap + MW)",
          kpiMissed: "Missed charge opportunity",
          kpiPracticalCap: "Practical daily-cycle capacity (P95)",
          kpiRecommendedBalanced: "Recommendation (12M, balanced)",
          kpiRecommendedSelected: "Recommendation (selection, balanced)",
          kpiRecommendationUnavailable:
            "Trailing-12-month recommendation unavailable right now (upstream data gap).",
          trailingKpiCapacity: "Recommended average daily size",
          trailingKpiDailyPercentileCaption: "P90 across modelled Berlin days",
          trailingKpiPayback: "Payback (indic.)",
          trailingKpiImpact: "Coverage %",
          trailingBulletTier: "Balanced tier from per-day energy and power need (per-day percentile).",
          trailingChainPeakLabel: "Peak SoC across full chain (no nightly SOC reset)",
          trailingNotAuditedNote:
            "Not externally audited; derived from Energy-Charts gen − load plus heuristics. Not procurement advice.",
          kpiPracticalCapMax: "Daily maximum",
          coverage: (n: number, pct: string, date: string, multi: boolean) =>
            multi
              ? `${n} quarter-hours (${pct}% of the selected window) · ${date}`
              : `${n} quarter-hours observed (${pct}% of day) · ${date}`,
          axisMw: "MW",
          axisSoc: "SoC (%)",
          unavailable: "Not enough usable quarter-hours for a Berlin-day series yet — try again shortly.",
          timeframe: "Timeframe",
          dayMode: "Day",
          weekMode: "Week",
          monthMode: "Month",
          customMode: "Range",
          previousRange: "Previous",
          nextRange: "Next",
          dayResetToggleLabel:
            "Reset simulated day-start SoC to 0% (optional)",
          fetchError: "Could not load the Energy-Charts series — check your connection and retry.",
          dataNote: "Published Energy-Charts quarter-hours only; no interpolated values.",
          loadingEyebrow: "Loading Energy-Charts",
          keyMetricsTitle: "Key Metrics",
          kpiRecommendedP95Eyebrow: "Recommended capacity (P95)",
          kpiRecommendedP95Subtitle: "Practical daily storage need (95th percentile)",
          kpiGrossSurplusEyebrow: "Charge opportunity",
          kpiGrossSurplusSubtitle: "This window",
          kpiMissedSurplusEyebrow: "Missed charge opportunity",
          kpiMissedSurplusSubtitle: "Not storable from surplus + curtailment",
          kpiMissedOfGross: (pct: string) => `${pct}% of charge opportunity`,
          kpiSelfConsumptionEyebrow: "Self-consumption rate (optimal BESS)",
          kpiSelfConsumptionSubtitle: "Of generated energy used locally",
          kpiFleetRequiredShort: "Fleet power and capacity from the snapshot are required for this KPI.",
          profileTitle: "Germany Day Profile",
          profileSubtitle:
            "Live snapshot, starting position, fleet, missed opportunity, charts, modeled system impact — then conclusion and scaling (Europe/Berlin).",
          modeObserved: "Observed",
          modeSimulated: "Simulated BESS",
          timeframeLabelShort: "Period",
          timeRangeControlTitle: "Choose day, week, month, or custom range",
          timeRangeTapToChange: "Tap to change",
          dataCoverageInfoAria: "What does data coverage mean?",
          dataCoverageTooltip:
            "Share of expected quarter-hours in the selected window that have published Energy-Charts data (missing slots are not interpolated).",
          coverageBadgeSuffix: "data coverage",
          observedChartTitle: "Net, fleet SoC & border flow",
          recoImpactEyebrow: "Below the chart",
          recoImpactTitle: "Simulation & BESS recommendation",
          recoImpactLead:
            "This block summarizes the simulated window view: recommended size, modeled impact, and an optional capacity override.",
          simulatedCtaObserved: "Back to Observed mode",
          kpiCurtailmentEyebrow: "Curtailment",
          kpiCurtailmentSubtitle: "Aux feed; raw net stays unchanged",
          kpiCapturedSurplusEyebrow: "Charge opportunity absorbed",
          kpiCapturedSurplusSubtitle: "Greedy simulation from surplus + curtailment",
          curtailmentStatusConfigured: "Curtailment loaded",
          curtailmentStatusMissingConfig: "Curtailment not configured",
          curtailmentStatusUpstream: "Curtailment upstream unavailable",
          kpiDeficitCoveredEyebrow: "Deficit covered",
          kpiDeficitCoveredSubtitle: "From discharged storage",
          kpiNewSelfConsumptionEyebrow: "Self-consumption (with modeled BESS)",
          kpiNewSelfConsumptionSubtitle: "With modeled BESS",
          kpiGridImpactEyebrow: "Imbalance damping (Σ|slot|)",
          kpiGridImpactSubtitle: "Vs raw structural net per quarter-hour",
          kpiGridImpactValue: (pct: string) =>
            `Summed |structural net| ~${pct}% lower after modeled BESS`,
          kpiObservedImportsEyebrow: "Observed imports",
          kpiObservedExportsEyebrow: "Observed exports",
          kpiImportsAfterBessEyebrow: "Imports after BESS",
          kpiExportsAfterBessEyebrow: "Exports after BESS",
          kpiCrossBorderObservedSubtitle: "Energy-Charts cross-border flow",
          kpiCrossBorderDeltaSubtitle: (observed: string, delta: string) =>
            `Observed ${observed} · Δ ${delta} vs actual`,
          observedModeLead:
            "P95 for this window. Simulated mode shows surplus capture and grid impact.",
          capacityBadgeUnavailable: "Simulation capacity not computable yet",
          simulatedCapacityBadgeLabel: (capacity: string) => `Simulated capacity: ${capacity}`,
          simulatedCapacityModeAutoWindow: "Auto · window P95",
          simulatedCapacityModeAuto12m: "Auto · 12M balanced",
          simulatedCapacityModeCustom: "Manual override",
          simulatedCapacityPowerBadge: (power: string) => `Power cap: ${power}`,
          simulatedCapacityControlEyebrow: "Capacity override",
          simulatedCapacityControlTitle: "Adjust simulated BESS capacity",
          simulatedCapacityInputLabel: "Capacity (GWh)",
          simulatedCapacityInputHint: (power: string) =>
            `The power cap stays at ${power} (balanced).`,
          simulatedCapacityInputHintUnavailable:
            "The power model is still loading. The power cap appears here once the window recommendation is ready.",
          simulatedCapacityReset: "Restore auto",
          simulatedCapacityApply: "Apply",
          simulatedCapacityInputInvalid:
            "Enter a positive GWh value, for example 2.5.",
          simulatedCapacitySourceAuto: "Auto",
          simulatedCapacitySourceCustom: "Manual",
          aiInsightTitle: "AI insight",
          insightRuleBasedTitle: "Takeaway",
          bottomControlsHint:
            "Observed data stays on top; the modeled BESS simulation with its KPIs sits directly below.",
          chartFullscreenExpand: "Fullscreen chart",
          chartFullscreenClose: "Close",
          chartFullscreenTitle: "Day profile",
          chartFullscreenEscHint: "Press Escape to close.",
          onePagerStructuralEyebrow: "Starting position today",
          onePagerStructuralLead:
            "Net balance and structural tensions summarize the window; cross-border trade frames observed import and export energy in the same period.",
          onePagerBorderTradeTitle: "Observed cross-border trade (imports + exports)",
          onePagerInstalledFleetEyebrow: "Current fleet performance",
          onePagerInstalledFleetLead:
            "How the installed German BESS layer uses charge opportunity, how much gross deficit it covers, and a compact SoC snapshot—using the same slot model as the charts.",
          onePagerMissedEyebrow: "Missed opportunity",
          onePagerMissedLead:
            "What no longer fits into storage at the modeled capacity (slider)—energy, indicative market value, and share of the remaining charge opportunity.",
          onePagerStructuralDeficitEyebrow: "Gross structural deficit",
          onePagerStructuralDeficitSubtitle: "Energy in negative structural slots",
          kpiInstalledFleetAbsorbedEyebrow: "Charge opportunity absorbed (fleet)",
          kpiInstalledFleetAbsorbedSubtitle: "Greedy walk at installed layer",
          onePagerChartsIntro: "Charts: observed fleet, then modeled BESS below.",
          workspaceLiveSnapshotEyebrow: "Live snapshot",
          workspaceLiveSnapshotLead:
            "A concise read on the same published quarter-hours—the KPI blocks below quantify that same window math.",
          workspaceChartsEyebrow: "Charts",
          workspaceChartsLead:
            "Two panels for the selected window: observed fleet (Energy-Charts) above, modeled BESS with adjustable capacity below.",
          workspaceConclusionEyebrow: "Conclusion & recommendations",
          workspaceConclusionLead:
            "Single-day optimum and 12‑month balanced use the same fleet logic — the time horizon drives the size difference.",
          workspaceTechnicalImpactEyebrow: "System impact (technical)",
          workspaceIndicativeEconomicsEyebrow: "Indicative economic benefit",
          kpiIndicativeDisclaimerTitle: "Indicative benefit — not a revenue forecast",
          kpiIndicativeValueDisclaimerProminent:
            "Not contract, forecast, or trading revenue. Simplified proxy model (SMARD spread, curtailment/redispatch) for context in the selected window only.",
          workspaceModeledBorderEyebrow: "Border flow (modeled)",
          workspaceModeledBorderSubtitle:
            "Import and export change vs observed (border proxy: border-coupled BESS power plus discharge).",
          onePagerImpactHeading: "System impact & value",
          onePagerImpactLead:
            "What the simulation does in the selected window — technical effect and an indicative € proxy (SMARD spread, not guaranteed revenue).",
          onePagerImpactTechTitle: "Technical impact",
          onePagerImpactValueTitle: "Indicative benefit",
          onePagerImpactEnergyTitle: "Energy stored",
          onePagerImpactBorderTitle: "Border flow (modeled)",
          kpiIndicativeValueDisclaimer:
            "Indicative = simplified model (spread + curtailment), not contract or forecast revenue.",
          kpiValueBreakdownTitle: "What makes up the modeled benefit",
          kpiValueBreakdownFootnote:
            "Hover a row for detail. Curtailment/redispatch rows use absorbed curtailment MWh only.",
          twelveMonthKpiPaybackDetail:
            "Simple payback: illustrative capex ÷ modeled annual revenue (12M balanced tier, pre-sales assumptions). Excludes financing, tax, and grid charges.",
          twelveMonthKpiRevenueDetail:
            "Annual revenue from the same pre-sales model as the configurator — not the window total above.",
          marginalImpactInterpretation:
            "Read columns as “what changes if the installed fleet grows”. Flat absorbed energy means charge opportunity in this window is nearly exhausted. Revenue is a per-MWh-stored proxy — not exchange revenue. The largest step is often fleet → +30%.",
          simulatedCapacityExtrapolationWarning:
            "Very large GWh inputs often produce unrealistic € totals because the proxy scales almost linearly with stored MWh.",
          onePagerNetPeakEyebrow: "Grid relief & peak shaving",
          onePagerNetPeakPeakLine: (peak: string) => `Peak reduction ${peak}`,
          onePagerFinalActionHint:
            "In short: add energy or power headroom to capture more of the remaining charge opportunity—the charts above show where the fleet and simulation engage slot by slot.",
          onePagerDetailsSummary: "Background & methodology",
          twelveMonthSectionEyebrow: "Long-term balanced recommendation",
          twelveMonthSectionTitle: "Recommended BESS size over the last 12 months",
          twelveMonthBalancedTag: "(Balanced)",
          twelveMonthExplainerSmallerThanDay:
            "This is the recommended average daily size over the trailing 12 months (P90 across modeled calendar days). It sits a little below the single-day optimum above because it averages many days.",
          twelveMonthExplainerLargerThanDay:
            "This is the recommended average daily size over the trailing 12 months (P90 across modeled calendar days). It can sit above the single-day optimum when today’s profile carries less structural storage work than the annual P90.",
          twelveMonthExplainerNeutral:
            "This is the recommended average daily size over the trailing 12 months (P90 across modeled calendar days). It is in the same ballpark as the single-day optimum.",
          twelveMonthKpiPayback: "Payback (indic.)",
          twelveMonthKpiCoverage: "Coverage",
          twelveMonthKpiRevenue: "12M balanced revenue",
          twelveMonthKpiPeakSoc: "Peak SoC over the year",
          bridgeDayOptimalAboveYear: (day: string, year: string) =>
            `Today’s single-day optimum (${day}) is a little above the long-run balanced recommendation (${year}) because today’s structural surplus is unusually large.`,
          bridgeDayOptimalBelowYear: (day: string, year: string) =>
            `Today’s single-day optimum (${day}) is a little below the long-run balanced recommendation (${year}) because today’s profile asks for less structural storage work than the annual P90.`,
          bridgeDayOptimalNearYear: (day: string, year: string) =>
            `The single-day optimum (${day}) is close to the 12‑month balanced size (${year})—today’s profile is representative of the annual P90.`,
          twelveMonthHeuristicNote: (window: string) =>
            `${window} · Balanced tier from per-day energy and power need (per-day percentile).`,
          onePagerExportHint:
            "Image export: both chart panels (observed and simulated) from this block — not electricity exports.",
          marketBasisIntro:
            "Indicative € figures on this page (for example Value under system impact or missed opportunity) come from SMARD spot quarter-hours and — where the model uses it — Netztransparenz redispatch. This is a representative market snapshot over the sample shown — not the single Energy-Charts calendar day in your charts above.",
          marketBasisSpreadDetail:
            "Per calendar day: highest minus lowest average quarter-hour spot price. Averaged across SMARD sample days — a coarse gauge of spread / arbitrage headroom in the model.",
          marketBasisEveningDetail:
            "Difference between average spot in the evening window and average at midday. Positive when evenings are pricier — a coarse cue for time-shifting value.",
          marketBasisRedispatchDetail:
            "Positive mean of calculated redispatch prices as a €/MWh lever when curtailment feeds valuation. The energy line below estimates average daily curtailment energy in the reference window.",
          marketBasisChartHeading: "Typical day shape (four buckets)",
          marketBasisChartExplainer:
            "Each bar is the mean spot €/MWh in low-, midday-, evening- and high-load slots — averaged across the SMARD sample. You see the market’s typical daily profile in the reference window, independent of the date you picked for the curves.",
          kpiStoredEndEyebrow: "Energy in store (end of window)",
          kpiSimAbsorbedEyebrow: "Stored (simulation, window)",
          kpiSimAbsorbedSubtitle:
            "Total charge opportunity absorbed in the model (structural surplus + allocated curtailment) — not state of charge at period end.",
          kpiSimVsFleetMissing:
            "No installed fleet capacity on file — simulation-only value above.",
          kpiSimVsFleetLine: (p: {
            fleetStored: string;
            simStored: string;
            capMult: string;
            energyMult: string;
            simCap: string;
            instCap: string;
          }) =>
            `Installed fleet (same window): ${p.fleetStored} stored · simulated energy capacity ${p.simCap} vs installed ${p.instCap} (${p.capMult}) · stored energy ${p.simStored} vs ${p.fleetStored} (${p.energyMult})`,
          aiInsightPlaceholder:
            "Not enough KPI context to summarise. Pass narrative text via the simulationAiInsight prop once an LLM route exists.",
          observedCtaSimulated: "Switch to Simulated mode to see impact at this size.",
          technicalDisclaimer:
            "Illustrative heuristic — not procurement or forecasting advice.",
        },
    [language]
  );

  const fleetEnergyCapacityMwh =
    fleetCapacityGwh !== null &&
    fleetCapacityGwh !== undefined &&
    Number.isFinite(fleetCapacityGwh) &&
    fleetCapacityGwh > 0
      ? fleetCapacityGwh * 1_000
      : null;

  const fleetPowerMw =
    fleetPowerGw !== null && fleetPowerGw !== undefined && Number.isFinite(fleetPowerGw) && fleetPowerGw > 0
      ? fleetPowerGw * 1_000
      : null;

  const isMultiDayFlow = useMemo(
    () =>
      flow !== null &&
      flow.rangeStartBerlin !== undefined &&
      flow.rangeEndBerlin !== undefined &&
      flow.rangeStartBerlin !== flow.rangeEndBerlin,
    [flow]
  );

  const practicalCapacity = useMemo(() => {
    if (!flow?.slots.length) {
      return null;
    }
    return computePracticalDailyCycleCapacityMwh(flow.slots);
  }, [flow]);

  const previousDayPracticalCapacity = useMemo(() => {
    if (selectorMode !== "day" || previousDaySlots.length === 0) {
      return null;
    }
    return computePracticalDailyCycleCapacityMwh(previousDaySlots);
  }, [selectorMode, previousDaySlots]);

  const autoSimulatedBaselineMwh = useMemo(() => {
    if (selectorMode === "day" && recommendation) {
      const balanced = recommendation.tiers.find((entry) => entry.label === "balanced");
      if (balanced && balanced.recommendedEnergyMwh > 0) {
        return balanced.recommendedEnergyMwh;
      }
    }
    const current = practicalCapacity?.practicalCapacityMwh ?? 0;
    if (current > 0) {
      return current;
    }
    const fallback = previousDayPracticalCapacity?.practicalCapacityMwh ?? 0;
    return fallback > 0 ? fallback : 0;
  }, [selectorMode, recommendation, practicalCapacity, previousDayPracticalCapacity]);

  const customSimulatedCapacityMwh = useMemo(
    () => parseCapacityGwhInput(customSimulatedCapacityGwhApplied),
    [customSimulatedCapacityGwhApplied]
  );
  const customSimulatedCapacityDraftInvalid =
    customSimulatedCapacityGwhDraft.trim().length > 0 &&
    parseCapacityGwhInput(customSimulatedCapacityGwhDraft) === null;
  const hasPendingCapacityApply =
    customSimulatedCapacityGwhDraft.trim() !== customSimulatedCapacityGwhApplied.trim();
  const canApplyCustomSimulatedCapacity =
    hasPendingCapacityApply && !customSimulatedCapacityDraftInvalid;
  const hasCustomSimulatedCapacity = customSimulatedCapacityMwh !== null;

  const applyCustomSimulatedCapacity = () => {
    if (customSimulatedCapacityDraftInvalid) {
      return;
    }
    setCustomSimulatedCapacityGwhApplied(customSimulatedCapacityGwhDraft.trim());
  };

  const resetCustomSimulatedCapacity = () => {
    setCustomSimulatedCapacityGwhApplied("");
    setCustomSimulatedCapacityGwhDraft("");
  };
  const usesTwelveMonthAutoSizing = useMemo(() => {
    if (selectorMode !== "day" || hasCustomSimulatedCapacity || !recommendation) {
      return false;
    }
    const balanced = recommendation.tiers.find((entry) => entry.label === "balanced");
    return (
      balanced !== undefined &&
      balanced.recommendedEnergyMwh > 0 &&
      balanced.recommendedPowerMw > 0 &&
      Number.isFinite(balanced.recommendedPowerMw)
    );
  }, [selectorMode, hasCustomSimulatedCapacity, recommendation]);

  const twelveMonthBalancedSizing = useMemo(() => {
    if (!recommendation) {
      return null;
    }
    const balanced = recommendation.tiers.find((entry) => entry.label === "balanced");
    if (
      !balanced ||
      balanced.recommendedEnergyMwh <= 0 ||
      balanced.recommendedPowerMw <= 0 ||
      !Number.isFinite(balanced.recommendedPowerMw)
    ) {
      return null;
    }
    return {
      energyMwh: balanced.recommendedEnergyMwh,
      powerMw: balanced.recommendedPowerMw,
    };
  }, [recommendation]);
  const effectivePracticalCapacityMwh = hasCustomSimulatedCapacity
    ? customSimulatedCapacityMwh
    : autoSimulatedBaselineMwh;

  const recommendationByTier = useMemo(() => {
    if (!recommendation) {
      return null;
    }
    const byLabel = new Map(recommendation.tiers.map((entry) => [entry.label, entry] as const));
    return {
      aggressive: byLabel.get("aggressive") ?? null,
      balanced: byLabel.get("balanced") ?? null,
      conservative: byLabel.get("conservative") ?? null,
    };
  }, [recommendation]);

  const liveBalancedEconomics = useMemo(() => {
    if (
      revenueModel?.marketReference.spotPriceStatus !== "live" ||
      !recommendationByTier?.balanced
    ) {
      return null;
    }
    return computeEconomics(
      {
        totalPowerMw: recommendationByTier.balanced.recommendedPowerMw,
        totalEnergyMwh: recommendationByTier.balanced.recommendedEnergyMwh,
        roundTripEfficiency: 90,
      },
      defaultEconomicsAssumptions
    );
  }, [recommendationByTier, revenueModel]);

  const balancedRevenueTileValue =
    liveBalancedEconomics?.annualRevenue ??
    recommendation?.indicativeEconomicsAtBalancedTier?.annualRevenueEur ??
    null;

  const selectedWindowRecommendation = useMemo(() => {
    if (!flow?.slots.length) {
      return null;
    }
    const rec = computeLogicalBessRecommendation(flow.slots);
    const byLabel = new Map(rec.tiers.map((entry) => [entry.label, entry] as const));
    return {
      aggressive: byLabel.get("aggressive") ?? null,
      balanced: byLabel.get("balanced") ?? null,
      conservative: byLabel.get("conservative") ?? null,
    };
  }, [flow]);
  const selectedWindowBalancedPowerMw = selectedWindowRecommendation?.balanced?.recommendedPowerMw ?? null;

  const practicalDispatchBalancedPowerMw = useMemo(() => {
    if (selectorMode === "day" && recommendation) {
      const balanced = recommendation.tiers.find((entry) => entry.label === "balanced");
      if (
        balanced &&
        balanced.recommendedPowerMw > 0 &&
        Number.isFinite(balanced.recommendedPowerMw)
      ) {
        return balanced.recommendedPowerMw;
      }
    }
    return selectedWindowBalancedPowerMw;
  }, [selectorMode, recommendation, selectedWindowBalancedPowerMw]);

  const visualizationResetDailyByBerlin = selectorMode === "day" ? dayModeResetAtStart : false;

  const estimatedInitialFleetSocMwh = useMemo(() => {
    if (
      fleetEnergyCapacityMwh === null ||
      fleetEnergyCapacityMwh <= 0 ||
      fleetPowerMw === null ||
      fleetPowerMw <= 0
    ) {
      return 0;
    }
    if (selectorMode === "week" && previousWeekSlots.length > 0) {
      const endMwh = computeEndPracticalSocMwh(previousWeekSlots, fleetEnergyCapacityMwh, {
        initialSocMwh: 0,
        maxPowerMw: fleetPowerMw,
        resetDailyByBerlin: false,
      });
      return Math.min(fleetEnergyCapacityMwh, Math.max(0, endMwh));
    }
    if (
      selectorMode !== "day" ||
      dayModeResetAtStart
    ) {
      return 0;
    }
    if (fleetNavigateInitialMwh !== null && Number.isFinite(fleetNavigateInitialMwh)) {
      return Math.min(fleetEnergyCapacityMwh, Math.max(0, fleetNavigateInitialMwh));
    }
    if (previousDaySlots.length === 0) {
      return 0;
    }
    /** Start-of-yesterday SOC (API fallback): walk D−2 then D−1 when we did not step here from yesterday’s rendered chart. */
    let startYesterdayMwh = 0;
    if (dayBeforePreviousSlots.length > 0) {
      const stitch = simulatePracticalDispatchAtCapacity(
        dayBeforePreviousSlots,
        fleetEnergyCapacityMwh,
        {
          resetDailyByBerlin: true,
          initialSocMwh: 0,
          maxPowerMw: fleetPowerMw,
        }
      );
      const lastStitch = stitch[stitch.length - 1];
      if (lastStitch !== undefined) {
        startYesterdayMwh =
          (Math.min(100, Math.max(0, lastStitch.socPct)) / 100) * fleetEnergyCapacityMwh;
      }
    }
    const prevWalk = simulatePracticalDispatchAtCapacity(previousDaySlots, fleetEnergyCapacityMwh, {
      resetDailyByBerlin: true,
      initialSocMwh: startYesterdayMwh,
      maxPowerMw: fleetPowerMw,
    });
    const last = prevWalk[prevWalk.length - 1];
    return last !== undefined ? (Math.min(100, Math.max(0, last.socPct)) / 100) * fleetEnergyCapacityMwh : 0;
  }, [
    selectorMode,
    dayModeResetAtStart,
    fleetNavigateInitialMwh,
    previousWeekSlots,
    previousDaySlots,
    dayBeforePreviousSlots,
    fleetEnergyCapacityMwh,
    fleetPowerMw,
  ]);

  const absorption = useMemo(() => {
    if (!flow?.slots.length) {
      return null;
    }
    if (
      fleetEnergyCapacityMwh !== null &&
      fleetEnergyCapacityMwh > 0 &&
      fleetPowerMw !== null &&
      fleetPowerMw > 0
    ) {
      return computeCyclingFleetSurplusAbsorption(flow.slots, fleetEnergyCapacityMwh, fleetPowerMw, {
        initialSocMwh: estimatedInitialFleetSocMwh,
        resetDailyByBerlin: visualizationResetDailyByBerlin,
      });
    }
    return computeNetSurplusFleetAbsorption(flow.slots, fleetEnergyCapacityMwh, fleetPowerMw, {
      initialSocMwh: estimatedInitialFleetSocMwh,
    });
  }, [
    flow,
    fleetEnergyCapacityMwh,
    fleetPowerMw,
    estimatedInitialFleetSocMwh,
    visualizationResetDailyByBerlin,
  ]);

  const estimatedInitialSocMwh = useMemo(() => {
    if (effectivePracticalCapacityMwh <= 0) {
      return 0;
    }
    if (selectorMode === "week" && previousWeekSlots.length > 0 && twelveMonthBalancedSizing !== null) {
      const endMwh = computeEndPracticalSocMwh(
        previousWeekSlots,
        twelveMonthBalancedSizing.energyMwh,
        {
          initialSocMwh: 0,
          maxPowerMw: twelveMonthBalancedSizing.powerMw,
          resetDailyByBerlin: false,
        }
      );
      return Math.min(effectivePracticalCapacityMwh, Math.max(0, endMwh));
    }
    if (selectorMode !== "day" || dayModeResetAtStart) {
      return 0;
    }
    if (practicalNavigateInitialMwh !== null && Number.isFinite(practicalNavigateInitialMwh)) {
      return Math.min(effectivePracticalCapacityMwh, Math.max(0, practicalNavigateInitialMwh));
    }
    return computeStitchedPracticalInitialSocMwh({
      dayBeforePreviousSlots,
      previousDaySlots,
      capacityMwh: effectivePracticalCapacityMwh,
      maxPowerMw: practicalDispatchBalancedPowerMw,
    });
  }, [
    selectorMode,
    dayModeResetAtStart,
    practicalNavigateInitialMwh,
    effectivePracticalCapacityMwh,
    previousWeekSlots,
    twelveMonthBalancedSizing,
    previousDaySlots,
    dayBeforePreviousSlots,
    practicalDispatchBalancedPowerMw,
  ]);

  const recommendedCoverage = useMemo(() => {
    if (!flow?.slots.length || effectivePracticalCapacityMwh <= 0) {
      return null;
    }
    const initialSocMwh = Math.min(
      effectivePracticalCapacityMwh,
      Math.max(0, estimatedInitialSocMwh)
    );
    return computeCoverageAtCapacityMwh(flow.slots, effectivePracticalCapacityMwh, {
      resetDailyByBerlin: visualizationResetDailyByBerlin,
      maxPowerMw: practicalDispatchBalancedPowerMw,
      initialSocMwh,
    });
  }, [
    flow,
    effectivePracticalCapacityMwh,
    visualizationResetDailyByBerlin,
    practicalDispatchBalancedPowerMw,
    estimatedInitialSocMwh,
  ]);

  const chartRows: ChartRow[] = useMemo(() => {
    if (!flow?.slots.length || !absorption) {
      return [];
    }
    const labeler = isMultiDayFlow ? timeFormatterMultiDay : timeFormatterSingleDay;
    const practicalDispatchSeries =
      effectivePracticalCapacityMwh > 0
        ? simulatePracticalDispatchAtCapacity(flow.slots, effectivePracticalCapacityMwh, {
            resetDailyByBerlin: visualizationResetDailyByBerlin,
            initialSocMwh: estimatedInitialSocMwh,
            maxPowerMw: practicalDispatchBalancedPowerMw,
          })
        : [];
    const practicalSocSeries = practicalDispatchSeries.map((d) =>
      Math.min(100, Math.max(0, d.socPct))
    );
    const adjustedNetSeries =
      effectivePracticalCapacityMwh > 0
        ? simulateAdjustedNetMwAtCapacity(flow.slots, effectivePracticalCapacityMwh, {
            resetDailyByBerlin: visualizationResetDailyByBerlin,
            initialSocMwh: estimatedInitialSocMwh,
            maxPowerMw: practicalDispatchBalancedPowerMw,
          })
        : [];
    const fleetDispatchSeries =
      fleetEnergyCapacityMwh !== null && fleetEnergyCapacityMwh > 0
        ? simulatePracticalDispatchAtCapacity(flow.slots, fleetEnergyCapacityMwh, {
            resetDailyByBerlin: visualizationResetDailyByBerlin,
            initialSocMwh: estimatedInitialFleetSocMwh,
            maxPowerMw: fleetPowerMw,
          })
        : [];
    const estimatedFleetSocSeries = fleetDispatchSeries.map((d) =>
      Math.min(100, Math.max(0, d.socPct))
    );
    return flow.slots.map((s, i) => {
      const netBalanceMw = s.totalGenerationMw - s.loadMw;
      const practicalChargeMw = practicalDispatchSeries[i]?.chargeMw ?? 0;
      const practicalDischargeMw = practicalDispatchSeries[i]?.dischargeMw ?? 0;
      const borderCoupledChargeMw = borderCoupledBatteryChargeMw(s, practicalChargeMw);
      const observedCrossBorderMw =
        s.crossBorderElectricityTradingMw !== null &&
        s.crossBorderElectricityTradingMw !== undefined &&
        Number.isFinite(s.crossBorderElectricityTradingMw)
          ? s.crossBorderElectricityTradingMw
          : null;
      return {
        ...s,
        timeLabel: labeler.format(new Date(s.timestampIso)),
        netBalanceMw,
        netAfterPracticalBessMw: adjustedNetSeries[i] ?? netBalanceMw,
        observedCrossBorderMw,
        simulatedCrossBorderMw:
          observedCrossBorderMw === null
            ? null
            : observedCrossBorderMw + borderCoupledChargeMw - practicalDischargeMw,
        observedImportMw: observedCrossBorderMw !== null ? Math.max(0, observedCrossBorderMw) : 0,
        observedExportSignedMw:
          observedCrossBorderMw !== null ? Math.min(0, observedCrossBorderMw) : 0,
        simulatedImportMw:
          observedCrossBorderMw !== null
            ? Math.max(0, observedCrossBorderMw + borderCoupledChargeMw - practicalDischargeMw)
            : 0,
        simulatedExportSignedMw:
          observedCrossBorderMw !== null
            ? Math.min(0, observedCrossBorderMw + borderCoupledChargeMw - practicalDischargeMw)
            : 0,
        curtailmentDisplayMw:
          s.curtailmentMw !== null && s.curtailmentMw !== undefined && Number.isFinite(s.curtailmentMw)
            ? Math.max(0, s.curtailmentMw)
            : 0,
        inferredFleetSocPct: absorption.inferredFleetSocPctSeries[i] ?? 0,
        estimatedFleetSocPct: estimatedFleetSocSeries[i] ?? 0,
        simulatedPracticalSocPct: practicalSocSeries[i] ?? 0,
        practicalChargeSignedMw: -practicalChargeMw,
        practicalChargeMw,
        practicalDischargeMw,
        fleetChargeSignedMw: -(fleetDispatchSeries[i]?.chargeMw ?? 0),
        fleetChargeMw: fleetDispatchSeries[i]?.chargeMw ?? 0,
        fleetDischargeMw: fleetDispatchSeries[i]?.dischargeMw ?? 0,
      };
    });
  }, [
    flow,
    absorption,
    isMultiDayFlow,
    effectivePracticalCapacityMwh,
    visualizationResetDailyByBerlin,
    estimatedInitialSocMwh,
    practicalDispatchBalancedPowerMw,
    fleetEnergyCapacityMwh,
    estimatedInitialFleetSocMwh,
    fleetPowerMw,
  ]);

  const currentFleetMode = useMemo(() => {
    if (chartRows.length === 0) {
      return null;
    }
    const last = chartRows[chartRows.length - 1]!;
    const previous = chartRows.length > 1 ? chartRows[chartRows.length - 2]! : null;
    return inferFleetModeFromChartTail({
      showSimulatedNet: false,
      last: {
        estimatedFleetSocPct: last.estimatedFleetSocPct,
        simulatedPracticalSocPct: last.simulatedPracticalSocPct,
        netBalanceMw: last.netBalanceMw,
        practicalChargeMw: last.practicalChargeMw,
        practicalDischargeMw: last.practicalDischargeMw,
        fleetChargeMw: last.fleetChargeMw,
        fleetDischargeMw: last.fleetDischargeMw,
      },
      previous:
        previous === null
          ? null
          : {
              estimatedFleetSocPct: previous.estimatedFleetSocPct,
              simulatedPracticalSocPct: previous.simulatedPracticalSocPct,
              netBalanceMw: previous.netBalanceMw,
              practicalChargeMw: previous.practicalChargeMw,
              practicalDischargeMw: previous.practicalDischargeMw,
              fleetChargeMw: previous.fleetChargeMw,
              fleetDischargeMw: previous.fleetDischargeMw,
            },
    });
  }, [chartRows]);

  const windowNetStructuralBalanceGwh = useMemo(() => {
    if (!chartRows.length) {
      return 0;
    }
    let mwh = 0;
    for (const r of chartRows) {
      mwh += r.netBalanceMw * QUARTER_HOUR_H;
    }
    return mwh / 1000;
  }, [chartRows]);

  const borderTradeTotals = useMemo((): BorderTradeTotals | null => {
    if (chartRows.length === 0) {
      return null;
    }
    let hasObservedBorderFlow = false;
    let observedImportEnergyMwh = 0;
    let observedExportEnergyMwh = 0;
    let simulatedImportEnergyMwh = 0;
    let simulatedExportEnergyMwh = 0;
    for (const row of chartRows) {
      if (row.observedCrossBorderMw !== null) {
        hasObservedBorderFlow = true;
        observedImportEnergyMwh += Math.max(0, row.observedCrossBorderMw) * QUARTER_HOUR_H;
        observedExportEnergyMwh += Math.max(0, -row.observedCrossBorderMw) * QUARTER_HOUR_H;
      }
      if (row.simulatedCrossBorderMw !== null) {
        simulatedImportEnergyMwh += Math.max(0, row.simulatedCrossBorderMw) * QUARTER_HOUR_H;
        simulatedExportEnergyMwh += Math.max(0, -row.simulatedCrossBorderMw) * QUARTER_HOUR_H;
      }
    }
    if (!hasObservedBorderFlow) {
      return null;
    }
    return {
      observedImportEnergyMwh,
      observedExportEnergyMwh,
      simulatedImportEnergyMwh,
      simulatedExportEnergyMwh,
      importDeltaEnergyMwh: simulatedImportEnergyMwh - observedImportEnergyMwh,
      exportDeltaEnergyMwh: simulatedExportEnergyMwh - observedExportEnergyMwh,
    };
  }, [chartRows]);

  const storedPracticalEndMwh = useMemo(() => {
    if (!chartRows.length || effectivePracticalCapacityMwh <= 0) {
      return null;
    }
    const last = chartRows[chartRows.length - 1]!;
    return (Math.max(0, Math.min(100, last.simulatedPracticalSocPct)) / 100) * effectivePracticalCapacityMwh;
  }, [chartRows, effectivePracticalCapacityMwh]);

  useEffect(() => {
    if (selectorMode !== "day" || chartRows.length === 0) {
      return;
    }
    const last = chartRows[chartRows.length - 1];
    if (fleetEnergyCapacityMwh !== null && fleetEnergyCapacityMwh > 0) {
      endFleetSocMwhByDateRef.current.set(
        selectedDate,
        (Math.max(0, last.estimatedFleetSocPct) / 100) * fleetEnergyCapacityMwh
      );
    }
    if (effectivePracticalCapacityMwh > 0) {
      endPracticalSocMwhByDateRef.current.set(
        selectedDate,
        (Math.max(0, last.simulatedPracticalSocPct) / 100) * effectivePracticalCapacityMwh
      );
    }
  }, [
    chartRows,
    effectivePracticalCapacityMwh,
    fleetEnergyCapacityMwh,
    selectedDate,
    selectorMode,
  ]);

  useEffect(() => {
    const publish = onChartFleetSocSnapshot;
    if (!publish) {
      return undefined;
    }
    if (!chartRows.length) {
      publish(null);
      return () => {
        publish(null);
      };
    }
    const last = chartRows[chartRows.length - 1];
    const prev = chartRows.length > 1 ? chartRows[chartRows.length - 2] : null;
    const toTail = (row: ChartRow): ChartRowTailForFleetMode => ({
      estimatedFleetSocPct: row.estimatedFleetSocPct,
      simulatedPracticalSocPct: row.simulatedPracticalSocPct,
      netBalanceMw: row.netBalanceMw,
      practicalChargeMw: row.practicalChargeMw,
      practicalDischargeMw: row.practicalDischargeMw,
      fleetChargeMw: row.fleetChargeMw,
      fleetDischargeMw: row.fleetDischargeMw,
    });
    const fleetMode = inferFleetModeFromChartTail({
      showSimulatedNet: false,
      last: toTail(last),
      previous: prev ? toTail(prev) : null,
    });
    publish({
      socPct: last.estimatedFleetSocPct,
      mode: "fleet",
      lastSlotTimestampIso: last.timestampIso,
      fleetMode,
    });
    return () => {
      publish(null);
    };
  }, [chartRows, onChartFleetSocSnapshot]);

  const showObservedCurtailmentSeries = chartRows.some((row) => row.curtailmentDisplayMw > 1e-6);
  const showCrossBorderSeries = chartRows.some((row) => row.observedCrossBorderMw !== null);

  const eveningBounds = useMemo(() => {
    if (isMultiDayFlow || chartRows.length === 0) {
      return null;
    }
    const idxs = chartRows
      .map((row, i) =>
        row.hourBerlin >= EVENING_HOUR_START && row.hourBerlin < EVENING_HOUR_END ? i : -1
      )
      .filter((i) => i >= 0);
    if (idxs.length === 0) {
      return null;
    }
    return { startIdx: idxs[0], endIdx: idxs[idxs.length - 1] };
  }, [chartRows, isMultiDayFlow]);

  const xEveningStart = eveningBounds ? chartRows[eveningBounds.startIdx]?.timeLabel : undefined;
  const xEveningEnd = eveningBounds ? chartRows[eveningBounds.endIdx]?.timeLabel : undefined;

  const chartRenderCompact = chartLayoutCompact && !flowChartFullscreenOpen;

  /** Recharts `interval` = show every (interval+1)-th tick; fewer labels on narrow viewports. */
  const maxVisibleXLabels = (() => {
    if (!isMultiDayFlow) {
      return chartRenderCompact ? 8 : 12;
    }
    if (chartRenderCompact) {
      if (selectorMode === "month") return 8;
      if (selectorMode === "week") return 7;
      if (selectorMode === "custom") return 8;
      return 8;
    }
    if (selectorMode === "month") return 12;
    if (selectorMode === "custom") return 10;
    return 10;
  })();
  const xAxisInterval =
    chartRows.length === 0
      ? 0
      : Math.max(0, Math.ceil(chartRows.length / maxVisibleXLabels) - 1);

  const chartMargin = isMultiDayFlow
    ? chartRenderCompact
      ? { top: 4, right: 4, bottom: 58, left: 2 }
      : { top: 8, right: 8, bottom: 42, left: 4 }
    : chartRenderCompact
      ? { top: 4, right: 2, bottom: 18, left: 2 }
      : { top: 8, right: 8, bottom: 8, left: 4 };

  const xAxisAngle = isMultiDayFlow ? (chartRenderCompact ? -52 : -38) : 0;
  const xAxisTickFont = isMultiDayFlow ? (chartRenderCompact ? 7 : 8) : chartRenderCompact ? 8 : 9;
  const yNetWidth = chartRenderCompact ? 40 : 48;
  const ySocWidth = chartRenderCompact ? 36 : 44;

  if (isFlowLoading) {
    return (
      <article className="scroll-mt-8 space-y-5 rounded-2xl border-2 border-border/60 bg-card p-5 shadow-md md:p-6 dark:border-slate-500/40 dark:bg-slate-900/70 dark:shadow-black/35">
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
          {t.loadingEyebrow}
        </p>
        <Skeleton className="h-10 max-w-xl rounded-xl" />
        <Skeleton className="h-[min(460px,calc(72vw))] min-h-[320px] w-full rounded-2xl" />
      </article>
    );
  }

  if (flowLoadError) {
    return (
      <article className="scroll-mt-8 rounded-2xl border border-dashed border-rose-300/70 bg-rose-50/50 p-5 md:p-6 dark:border-rose-500/35 dark:bg-rose-950/30">
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{t.eyebrow}</p>
        <p className="mt-3 text-sm text-rose-900 dark:text-rose-100">{t.fetchError}</p>
      </article>
    );
  }

  if (!flow || chartRows.length === 0) {
    return (
      <article className="scroll-mt-8 rounded-2xl border border-dashed border-slate-300/65 bg-white/60 p-5 md:p-6 dark:border-slate-600/45 dark:bg-slate-900/40">
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{t.eyebrow}</p>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{t.unavailable}</p>
      </article>
    );
  }

  const coveragePct = pctFormatter.format(flow.pointFractionOfDay * 100);

  const showMissedKpis = fleetEnergyCapacityMwh !== null && absorption !== null;
  const todayKey = berlinTodayKey();
  const currentWeekKey = dateKeyToIsoWeekKey(todayKey);
  const currentMonthKey = todayKey.slice(0, 7);
  const selectorLabel =
    selectorMode === "day"
      ? selectedDate
      : selectorMode === "week"
        ? `${selectedWeek} (${isoWeekKeyToStartKey(selectedWeek)} - ${addBerlinCalendarDays(
            isoWeekKeyToStartKey(selectedWeek),
            6
          )})`
        : selectorMode === "month"
          ? monthLabelFormatter.format(new Date(`${selectedMonth}-01T00:00:00.000Z`))
          : `${customRangeStart} – ${customRangeEnd}`;
  const nextDisabled =
    selectorMode === "day"
      ? selectedDate >= todayKey
      : selectorMode === "week"
        ? selectedWeek >= currentWeekKey
        : selectorMode === "month"
          ? selectedMonth >= currentMonthKey
          : customRangeEnd >= todayKey;
  const timeRangeCenterLabel = formatTimeRangeCenterLabel({
    language,
    selectorMode,
    selectedDate,
    selectedWeek,
    selectedMonth,
    customRangeStart,
    customRangeEnd,
  });
  const timeRangeNavButtonClass =
    "inline-flex size-11 shrink-0 items-center justify-center rounded-xl border-2 border-slate-200/90 bg-white text-slate-700 shadow-sm transition hover:border-sky-300 hover:bg-sky-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-600/55 dark:bg-slate-900/90 dark:text-slate-100 dark:hover:border-sky-500/45 dark:hover:bg-sky-950/45";

  const simulatedCapacityGwhLabel =
    effectivePracticalCapacityMwh > 0
      ? `${energyFormatter.format(effectivePracticalCapacityMwh / 1_000)} GWh`
      : null;
  const autoSimulatedCapacityGwhLabel =
    autoSimulatedBaselineMwh > 0
      ? `${energyFormatter.format(autoSimulatedBaselineMwh / 1_000)} GWh`
      : null;
  const autoSimulatedCapacityInputPlaceholder =
    autoSimulatedBaselineMwh > 0
      ? energyFormatter.format(autoSimulatedBaselineMwh / 1_000)
      : undefined;
  const simulatedCapacityBadgeText = simulatedCapacityGwhLabel
    ? t.simulatedCapacityBadgeLabel(simulatedCapacityGwhLabel)
    : t.capacityBadgeUnavailable;

  const coverageSummaryLine = t.coverage(flow.samplePoints, coveragePct, flow.dateBerlin, isMultiDayFlow);

  const resolvedLlmInsightText = String(simulationAiInsight ?? "").trim();
  const balancedRecommendation = recommendationByTier?.balanced ?? null;
  const trailingPaybackLabel =
    recommendation?.indicativeEconomicsAtBalancedTier
      ? formatPaybackYears(
          recommendation.indicativeEconomicsAtBalancedTier.paybackYears,
          language
        )
      : "—";
  const trailingImpactLabel =
    recommendation?.impactAtBalancedTier
      ? `${pctFormatter.format(recommendation.impactAtBalancedTier.absorbedSurplusShare * 100)}% ${
          language === "de" ? "Ladechance" : "charge opportunity"
        } · ${pctFormatter.format(recommendation.impactAtBalancedTier.servedDeficitShare * 100)}% ${
          language === "de" ? "Defizit" : "deficit"
        }`
      : "—";
  const trailingChainPeakValue =
    recommendation && Number.isFinite(recommendation.continuousWindowRequiredEnergyMwh)
      ? formatEnergyFromMwh(recommendation.continuousWindowRequiredEnergyMwh)
      : "—";
  const trailingWindowLabel =
    recommendation !== null
      ? `${recommendation.rangeStartBerlin}–${recommendation.rangeEndBerlin} · ${recommendation.observedDays} ${
          language === "de" ? "Tage" : "days"
        }`
      : "—";
  const economicsReferenceCapacityMwh =
    autoSimulatedBaselineMwh > 0
      ? autoSimulatedBaselineMwh
      : balancedRecommendation && balancedRecommendation.recommendedEnergyMwh > 0
        ? balancedRecommendation.recommendedEnergyMwh
        : null;
  const simulatedCapacityCredibility = assessCapacityCredibility(
    effectivePracticalCapacityMwh,
    economicsReferenceCapacityMwh
  );
  const flowWindowDays =
    flow !== null
      ? countBerlinCalendarDaysInclusive(
          flow.rangeStartBerlin ?? flow.dateBerlin,
          flow.rangeEndBerlin ?? flow.dateBerlin
        )
      : 1;

  const marketReference = revenueModel?.marketReference ?? null;
  const currentFleetScenario =
    flow?.slots.length &&
    fleetEnergyCapacityMwh !== null &&
    fleetEnergyCapacityMwh > 0 &&
    fleetPowerMw !== null &&
    fleetPowerMw > 0
      ? evaluateBessScenario({
          slots: flow.slots,
          capacityMwh: fleetEnergyCapacityMwh,
          maxPowerMw: fleetPowerMw,
          initialSocMwh: estimatedInitialFleetSocMwh,
          resetDailyByBerlin: visualizationResetDailyByBerlin,
          marketReference,
        })
      : null;

  const modeledScenario =
    flow?.slots.length && effectivePracticalCapacityMwh > 0
      ? evaluateBessScenario({
          slots: flow.slots,
          capacityMwh: effectivePracticalCapacityMwh,
          maxPowerMw: practicalDispatchBalancedPowerMw,
          initialSocMwh: estimatedInitialSocMwh,
          resetDailyByBerlin: visualizationResetDailyByBerlin,
          marketReference,
        })
      : null;

  const slotStructuralTotalsForKpis = computeCoverageAtCapacityMwh(flow.slots, 0, {
    maxPowerMw: 1,
    initialSocMwh: 0,
    resetDailyByBerlin: visualizationResetDailyByBerlin,
  });
  const grossStructuralDeficitMwh =
    modeledScenario?.coverage.totalDeficitEnergyMwh ??
    currentFleetScenario?.coverage.totalDeficitEnergyMwh ??
    slotStructuralTotalsForKpis.totalDeficitEnergyMwh;
  const grossStructuralSurplusMwh =
    modeledScenario?.coverage.totalSurplusEnergyMwh ??
    currentFleetScenario?.coverage.totalSurplusEnergyMwh ??
    slotStructuralTotalsForKpis.totalSurplusEnergyMwh;

  const currentFleetStatusLabel =
    currentFleetMode === "charging"
      ? language === "de"
        ? "Laden"
        : "Charging"
      : currentFleetMode === "discharging"
        ? language === "de"
          ? "Entladen"
          : "Discharging"
        : currentFleetMode === "idle"
          ? language === "de"
            ? "Stillstand"
            : "Idle"
          : language === "de"
            ? "n. v."
            : "n/a";
  const currentFleetSocStatusValue =
    chartRows.length > 0
      ? `~${pctFormatter.format(chartRows[chartRows.length - 1]!.estimatedFleetSocPct)}% · ${currentFleetStatusLabel}`
      : currentFleetStatusLabel;

  const renderFlowChartSection = (
    mode: "observed" | "simulated",
    opts?: { chartActions?: ReactNode; chartAreaClassName?: string }
  ) => {
    const isSimulated = mode === "simulated";
    const chartActions = opts?.chartActions;
    const chartAreaClass =
      opts?.chartAreaClassName ??
      "min-h-[220px] h-[min(46dvh,380px)] w-full min-w-0 sm:min-h-[240px] sm:h-[min(48dvh,440px)] md:min-h-[260px] md:h-[min(50dvh,500px)] lg:h-[min(48dvh,480px)]";
    const activeNetLegend = isSimulated ? t.legendNetSimulated : t.legendNet;
    const activeNetLegendHint = isSimulated ? t.legendNetSimulatedHint : t.legendNetHint;
    const activeNetDataKey = isSimulated ? "netAfterPracticalBessMw" : "netBalanceMw";
    const activeSocLegend = isSimulated ? t.legendPracticalSoc : t.legendFleetSoc;
    const activeSocLegendHint = isSimulated ? undefined : t.legendFleetSocHint;
    const activeSocDataKey = isSimulated ? "simulatedPracticalSocPct" : "estimatedFleetSocPct";
    const activeImportDataKey = isSimulated ? "simulatedImportMw" : "observedImportMw";
    const activeExportDataKey = isSimulated ? "simulatedExportSignedMw" : "observedExportSignedMw";
    const activeImportLegend = isSimulated ? t.legendSimulatedImport : t.legendObservedImport;
    const activeExportLegend = isSimulated ? t.legendSimulatedExport : t.legendObservedExport;
    const activeSocCapacityMwh = isSimulated
      ? (effectivePracticalCapacityMwh > 0 ? effectivePracticalCapacityMwh : null)
      : fleetEnergyCapacityMwh;
    const netLineColor = isSimulated ? SIM_CHART_NET_STROKE : "rgb(51,104,247)";

    return (
      <div
        className={`rounded-xl border px-3 py-2.5 shadow-inner md:px-4 md:py-3 ${
          isSimulated
            ? "border-border/90 bg-card shadow-[inset_0_0_0_1px_rgb(34_193_115_/_0.05)] dark:border-slate-600/50 dark:bg-slate-950/78 dark:shadow-[inset_0_0_0_1px_rgba(52,211,153,0.08)]"
            : "border-border/80 bg-card/95 dark:border-slate-600/55 dark:bg-slate-950/70"
        }`}
      >
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between lg:max-w-[min(680px,calc(100%-10rem))]">
            <div className="min-w-0 flex-1">
            {isSimulated ? (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase leading-none tracking-[0.22em] text-emerald-700 dark:text-emerald-300">
                  {t.modeSimulated}
                </p>
                <p className="text-[13px] font-semibold leading-snug text-slate-600 dark:text-slate-300 md:text-[0.875rem]">
                  {t.chartSimulatedPanelTitle}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                      simulatedCapacityGwhLabel
                        ? "border-emerald-300/80 bg-emerald-50 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-200"
                        : "border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-100"
                    }`}
                  >
                    {simulatedCapacityBadgeText}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-slate-200/85 bg-white/90 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/55 dark:bg-slate-950/70 dark:text-slate-200">
                    {hasCustomSimulatedCapacity
                      ? t.simulatedCapacityModeCustom
                      : usesTwelveMonthAutoSizing
                        ? t.simulatedCapacityModeAuto12m
                        : t.simulatedCapacityModeAutoWindow}
                  </span>
                  {practicalDispatchBalancedPowerMw !== null ? (
                    <span className="inline-flex items-center rounded-full border border-slate-200/85 bg-white/90 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/55 dark:bg-slate-950/70 dark:text-slate-200">
                      {t.simulatedCapacityPowerBadge(formatPowerFromMw(practicalDispatchBalancedPowerMw))}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="space-y-0.5">
                <p className="text-[10px] font-semibold uppercase leading-none tracking-[0.22em] text-slate-500 dark:text-slate-400">
                  {language === "de" ? "Beobachtung" : "Observed"}
                </p>
                <p className="text-base font-semibold leading-snug text-slate-950 md:text-lg dark:text-white [font-family:var(--font-heading)]">
                  {t.observedChartTitle}
                </p>
              </div>
            )}
            </div>
            {chartActions ? (
              <div className="flex shrink-0 items-start justify-end sm:pt-0">{chartActions}</div>
            ) : null}
          </div>
          <div
            className={
              chartRenderCompact
                ? "flex max-w-full flex-nowrap items-center gap-x-2 gap-y-0 overflow-x-auto overscroll-x-contain pb-1 [-ms-overflow-style:none] [scrollbar-width:none] lg:max-w-none lg:flex-wrap lg:justify-end lg:gap-y-1.5 lg:overflow-visible lg:pb-0 [&::-webkit-scrollbar]:hidden"
                : "flex flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-2.5 lg:justify-end"
            }
          >
            <LegendDot color={netLineColor} label={activeNetLegend} hint={activeNetLegendHint} />
            <LegendDot
              color={isSimulated ? SIM_CHART_SOC_STROKE : "rgb(129,119,239)"}
              label={activeSocLegend}
              hint={activeSocLegendHint}
            />
            <LegendDot
              color={SIM_CHART_CHARGE_FILL}
              label={isSimulated ? t.legendPracticalCharge : t.legendEstimatedCharge}
              hint={isSimulated ? undefined : t.legendEstimatedChargeHint}
            />
            <LegendDot
              color={SIM_CHART_DISCHARGE_FILL}
              label={isSimulated ? t.legendPracticalDischarge : t.legendEstimatedDischarge}
              hint={isSimulated ? undefined : t.legendEstimatedDischargeHint}
            />
            {showCrossBorderSeries ? (
              <>
                <LegendDot color={CROSS_BORDER_IMPORT_FILL} label={activeImportLegend} />
                <LegendDot color={CROSS_BORDER_EXPORT_FILL} label={activeExportLegend} />
              </>
            ) : null}
            {!isSimulated && showObservedCurtailmentSeries ? (
              <LegendDot color={OBSERVED_CURTAILMENT_FILL} label={t.legendCurtailment} />
            ) : null}
            <LegendDot color="rgba(251,191,36,0.95)" label={t.legendEvening} hint={t.legendEveningHint} />
          </div>
        </div>
        <div
          className={`${chartAreaClass} ${
            isSimulated ? "mt-3" : "mt-4"
          }`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartRows} margin={chartMargin}>
              <CartesianGrid
                stroke={isSimulated ? "rgba(148,163,184,0.13)" : "rgba(148,163,184,0.18)"}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="timeLabel"
                tick={{
                  fontSize: xAxisTickFont,
                  fill: "rgb(100,116,139)",
                }}
                angle={xAxisAngle}
                textAnchor={isMultiDayFlow ? "end" : "middle"}
                height={isMultiDayFlow ? (chartRenderCompact ? 54 : 48) : chartRenderCompact ? 28 : undefined}
                interval={xAxisInterval}
                minTickGap={chartRenderCompact ? (isMultiDayFlow ? 24 : 6) : isMultiDayFlow ? 18 : 8}
              />
              <YAxis
                yAxisId="net"
                tick={{ fontSize: chartRenderCompact ? 9 : 10, fill: "rgb(100,116,139)" }}
                width={yNetWidth}
                tickFormatter={(v) => integerFormatter.format(typeof v === "number" ? v : 0)}
                label={{
                  value: t.axisMw,
                  angle: -90,
                  position: "insideLeft",
                  fontSize: 9,
                  fill: "rgb(100,116,139)",
                }}
              />
              <YAxis
                yAxisId="soc"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: chartRenderCompact ? 8 : 9, fill: "rgb(100,116,139)" }}
                width={ySocWidth}
                tickFormatter={(v) => `${typeof v === "number" ? v : Number(v ?? 0)}%`}
                label={{
                  value: t.axisSoc,
                  angle: 90,
                  position: "insideRight",
                  fontSize: 9,
                  fill: "rgb(100,116,139)",
                }}
              />
              {xEveningStart !== undefined && xEveningEnd !== undefined ? (
                <ReferenceArea
                  x1={xEveningStart}
                  x2={xEveningEnd}
                  yAxisId="net"
                  fill="rgba(251,191,36,0.16)"
                  stroke="rgba(245,158,11,0.28)"
                />
              ) : null}
              <ReferenceLine
                yAxisId="net"
                y={0}
                stroke="rgba(148,163,184,0.55)"
                strokeDasharray="4 4"
              />
              <Tooltip
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  fontSize: 12,
                  color: "var(--popover-foreground)",
                  boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
                }}
                labelStyle={{ color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 4 }}
                formatter={(value, name) => {
                  const n = typeof value === "number" ? value : Number(value ?? 0);
                  const label = typeof name === "string" ? name : String(name ?? "");
                  if (label === activeSocLegend) {
                    if (activeSocCapacityMwh !== null && activeSocCapacityMwh > 0) {
                      const socMwh = (n / 100) * activeSocCapacityMwh;
                      return [`${pctFormatter.format(n)}% (${formatEnergyFromMwh(socMwh)})`, label];
                    }
                    return [`${pctFormatter.format(n)}%`, label];
                  }
                  if (label === t.legendCurtailment) {
                    return [formatPowerFromMw(Math.max(0, n)), label];
                  }
                  return [formatSignedMw(n), label];
                }}
              />
              <Line
                yAxisId="net"
                type="monotone"
                dataKey={activeNetDataKey}
                name={activeNetLegend}
                stroke={netLineColor}
                strokeWidth={isSimulated ? 1.65 : 2.25}
                dot={false}
                isAnimationActive={!chartRenderCompact}
                animationDuration={chartRenderCompact ? 0 : 180}
              />
              {isSimulated ? (
                <>
                  <Bar
                    yAxisId="net"
                    dataKey="practicalChargeSignedMw"
                    name={t.legendPracticalCharge}
                    fill={SIM_CHART_CHARGE_FILL}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={8}
                  />
                  <Bar
                    yAxisId="net"
                    dataKey="practicalDischargeMw"
                    name={t.legendPracticalDischarge}
                    fill={SIM_CHART_DISCHARGE_FILL}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={8}
                  />
                  {showCrossBorderSeries ? (
                    <>
                      <Bar
                        yAxisId="net"
                        dataKey={activeImportDataKey}
                        name={activeImportLegend}
                        fill={CROSS_BORDER_IMPORT_FILL}
                        fillOpacity={0.32}
                        maxBarSize={5}
                      />
                      <Bar
                        yAxisId="net"
                        dataKey={activeExportDataKey}
                        name={activeExportLegend}
                        fill={CROSS_BORDER_EXPORT_FILL}
                        fillOpacity={0.32}
                        maxBarSize={5}
                      />
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {showObservedCurtailmentSeries ? (
                    <Bar
                      yAxisId="net"
                      dataKey="curtailmentDisplayMw"
                      name={t.legendCurtailment}
                      fill={OBSERVED_CURTAILMENT_FILL}
                      fillOpacity={0.55}
                      radius={[3, 3, 0, 0]}
                      maxBarSize={5}
                    />
                  ) : null}
                  {fleetEnergyCapacityMwh !== null && fleetEnergyCapacityMwh > 0 ? (
                    <>
                      <Bar
                        yAxisId="net"
                        dataKey="fleetChargeSignedMw"
                        name={t.legendEstimatedCharge}
                        fill={SIM_CHART_CHARGE_FILL}
                        radius={[3, 3, 0, 0]}
                        maxBarSize={8}
                      />
                      <Bar
                        yAxisId="net"
                        dataKey="fleetDischargeMw"
                        name={t.legendEstimatedDischarge}
                        fill={SIM_CHART_DISCHARGE_FILL}
                        radius={[3, 3, 0, 0]}
                        maxBarSize={8}
                      />
                    </>
                  ) : null}
                  {showCrossBorderSeries ? (
                    <>
                      <Bar
                        yAxisId="net"
                        dataKey={activeImportDataKey}
                        name={activeImportLegend}
                        fill={CROSS_BORDER_IMPORT_FILL}
                        fillOpacity={0.32}
                        maxBarSize={5}
                      />
                      <Bar
                        yAxisId="net"
                        dataKey={activeExportDataKey}
                        name={activeExportLegend}
                        fill={CROSS_BORDER_EXPORT_FILL}
                        fillOpacity={0.32}
                        maxBarSize={5}
                      />
                    </>
                  ) : null}
                </>
              )}
              <Line
                yAxisId="soc"
                type="monotone"
                dataKey={activeSocDataKey}
                name={activeSocLegend}
                stroke={isSimulated ? SIM_CHART_SOC_STROKE : "rgb(133,117,239)"}
                strokeWidth={isSimulated ? 2 : 1.55}
                strokeLinecap={isSimulated ? "round" : undefined}
                strokeLinejoin={isSimulated ? "round" : undefined}
                strokeDasharray={isSimulated ? undefined : "5 4"}
                dot={false}
                isAnimationActive={!chartRenderCompact}
                animationDuration={chartRenderCompact ? 0 : 180}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-4 text-[11px] leading-snug tracking-wide text-slate-400 dark:text-slate-500">
          {isSimulated ? t.netFootnoteSimulated : t.netFootnote} {t.socFootnote}
          {!isSimulated && fleetEnergyCapacityMwh !== null && fleetEnergyCapacityMwh > 0 ? (
            <> {t.observedChargeDischargeFootnote}</>
          ) : null}
          {showCrossBorderSeries ? <> {t.crossBorderFootnote}</> : null}
          {!isSimulated && showObservedCurtailmentSeries ? <> {t.curtailmentFootnote}</> : null}
        </p>
      </div>
    );
  };

  const handlePreviousWindow = () => {
    if (selectorMode === "day") {
      setSelectedDate((current) => addBerlinCalendarDays(current, -1));
      return;
    }
    if (selectorMode === "week") {
      const currentStart = isoWeekKeyToStartKey(selectedWeek);
      setSelectedWeek(dateKeyToIsoWeekKey(addBerlinCalendarDays(currentStart, -7)));
      return;
    }
    if (selectorMode === "month") {
      setSelectedMonth((current) => shiftMonthKey(current, -1));
      return;
    }
    const spanDays = countBerlinCalendarDaysInclusive(customRangeStart, customRangeEnd);
    setCustomRangeStart((current) => addBerlinCalendarDays(current, -spanDays));
    setCustomRangeEnd((current) => addBerlinCalendarDays(current, -spanDays));
  };

  const handleNextWindow = () => {
    if (selectorMode === "day") {
      setSelectedDate((current) => {
        const next = addBerlinCalendarDays(current, 1);
        return next > todayKey ? todayKey : next;
      });
      return;
    }
    if (selectorMode === "week") {
      const currentStart = isoWeekKeyToStartKey(selectedWeek);
      const nextWeek = dateKeyToIsoWeekKey(addBerlinCalendarDays(currentStart, 7));
      setSelectedWeek(nextWeek > currentWeekKey ? currentWeekKey : nextWeek);
      return;
    }
    if (selectorMode === "month") {
      setSelectedMonth((current) => {
        const next = shiftMonthKey(current, 1);
        return next > currentMonthKey ? currentMonthKey : next;
      });
      return;
    }
    const spanDays = countBerlinCalendarDaysInclusive(customRangeStart, customRangeEnd);
    const shiftedEnd = addBerlinCalendarDays(customRangeEnd, spanDays);
    if (shiftedEnd > todayKey) {
      setCustomRangeEnd(todayKey);
      setCustomRangeStart(addBerlinCalendarDays(todayKey, -(spanDays - 1)));
      return;
    }
    setCustomRangeStart((current) => addBerlinCalendarDays(current, spanDays));
    setCustomRangeEnd(shiftedEnd);
  };

  const renderSimulatedCapacityOverridePanel = () => (
    <section
      aria-labelledby="simulated-capacity-override-heading"
      className="rounded-2xl border border-emerald-400/45 bg-gradient-to-br from-emerald-50/95 via-white to-slate-50/90 p-4 shadow-[0_12px_40px_-24px_rgba(16,185,129,0.45)] md:p-5 dark:border-emerald-500/30 dark:from-emerald-950/50 dark:via-slate-950/90 dark:to-slate-950/80 dark:shadow-[0_16px_48px_-28px_rgba(16,185,129,0.35)]"
    >
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="space-y-4"
      >
        <motion.div className="flex flex-wrap items-start gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-emerald-300/70 bg-emerald-100/90 text-emerald-800 shadow-sm dark:border-emerald-500/35 dark:bg-emerald-500/15 dark:text-emerald-200">
            <SlidersHorizontal className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[10px] font-semibold tracking-[0.2em] text-emerald-800 uppercase dark:text-emerald-300">
              {t.simulatedCapacityControlEyebrow}
            </p>
            <h3
              id="simulated-capacity-override-heading"
              className="text-base font-semibold leading-snug text-slate-950 md:text-lg dark:text-white [font-family:var(--font-heading)]"
            >
              {t.simulatedCapacityControlTitle}
            </h3>
          </div>
        </motion.div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label htmlFor={simulatedCapacityInputId} className="min-w-0 flex-1 space-y-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              {t.simulatedCapacityInputLabel}
            </span>
            <div className="relative">
              <input
                id={simulatedCapacityInputId}
                ref={simulatedCapacityInputRef}
                type="text"
                inputMode="decimal"
                value={customSimulatedCapacityGwhDraft}
                onChange={(event) => setCustomSimulatedCapacityGwhDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canApplyCustomSimulatedCapacity) {
                    event.preventDefault();
                    applyCustomSimulatedCapacity();
                  }
                }}
                placeholder={autoSimulatedCapacityInputPlaceholder}
                aria-describedby={simulatedCapacityHintId}
                aria-invalid={customSimulatedCapacityDraftInvalid}
                className={`h-12 w-full rounded-xl border-2 bg-white pr-16 pl-4 text-lg font-bold tabular-nums text-slate-900 shadow-inner outline-none transition placeholder:text-base placeholder:font-medium placeholder:text-slate-400 focus-visible:ring-4 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 ${
                  customSimulatedCapacityDraftInvalid
                    ? "border-rose-400/90 focus-visible:border-rose-400 focus-visible:ring-rose-400/25 dark:border-rose-400/50"
                    : "border-emerald-400/80 focus-visible:border-emerald-500 focus-visible:ring-emerald-400/30 dark:border-emerald-500/45"
                }`}
              />
              <span
                className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4 text-sm font-bold tracking-wide text-emerald-700 dark:text-emerald-300"
                aria-hidden
              >
                GWh
              </span>
            </div>
          </label>
          <div className="flex shrink-0 flex-wrap gap-2 sm:pb-0.5">
            <Button
              type="button"
              size="lg"
              disabled={!canApplyCustomSimulatedCapacity}
              className="h-12 min-w-[8.5rem] rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white shadow-md hover:bg-emerald-500 disabled:opacity-45 dark:bg-emerald-500 dark:hover:bg-emerald-400"
              onClick={applyCustomSimulatedCapacity}
            >
              {t.simulatedCapacityApply}
            </Button>
            {hasCustomSimulatedCapacity || hasPendingCapacityApply ? (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-12 rounded-xl border-slate-300/90 bg-white/90 px-4 text-sm font-semibold dark:border-slate-600/60 dark:bg-slate-950/70"
                onClick={resetCustomSimulatedCapacity}
              >
                {t.simulatedCapacityReset}
              </Button>
            ) : null}
          </div>
        </div>

        <p
          id={simulatedCapacityHintId}
          className="text-sm leading-relaxed text-slate-600 dark:text-slate-300"
        >
          {hasCustomSimulatedCapacity
            ? language === "de"
              ? `Manuelle Kapazität aktiv. Automatik-Vorschlag: ${autoSimulatedCapacityGwhLabel ?? "—"}.`
              : `Manual capacity active. Auto suggestion: ${autoSimulatedCapacityGwhLabel ?? "—"}.`
            : autoSimulatedCapacityGwhLabel
              ? language === "de"
                ? `Automatik aktiv (${autoSimulatedCapacityGwhLabel}). Wert eingeben und „Übernehmen“ — oder Feld leer lassen für Automatik.`
                : `Auto sizing active (${autoSimulatedCapacityGwhLabel}). Enter a value and press Apply, or leave empty for auto.`
              : t.simulatedCapacityInputHintUnavailable}
          {practicalDispatchBalancedPowerMw !== null
            ? ` ${t.simulatedCapacityInputHint(formatPowerFromMw(practicalDispatchBalancedPowerMw))}`
            : null}
        </p>
        {customSimulatedCapacityDraftInvalid ? (
          <p className="text-xs font-medium text-rose-700 dark:text-rose-200">
            {t.simulatedCapacityInputInvalid}
          </p>
        ) : null}
        {hasPendingCapacityApply && !customSimulatedCapacityDraftInvalid ? (
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
            {language === "de"
              ? "Änderung noch nicht übernommen — „Übernehmen“ aktualisiert die Simulation darunter."
              : "Change not applied yet — press Apply to update the simulation below."}
          </p>
        ) : null}
        {simulatedCapacityCredibility.isExtrapolated ? (
          <p className="rounded-lg border border-amber-300/70 bg-amber-50/85 px-3 py-2 text-xs leading-relaxed text-amber-950 dark:border-amber-500/35 dark:bg-amber-950/40 dark:text-amber-100">
            {t.simulatedCapacityExtrapolationWarning}
          </p>
        ) : null}
      </motion.div>
    </section>
  );

  const renderDualFlowChartsBlock = (missedBetweenCharts?: ReactNode) => (
    <div
      id="speicherpilot-germany-flow-capture"
      className="space-y-4 rounded-[28px] border border-slate-200/90 bg-gradient-to-b from-white via-slate-50/98 to-white p-4 shadow-[0_24px_56px_-30px_rgb(15_23_42_/_0.26)] md:p-5 dark:border-slate-600/45 dark:from-[#0d121f] dark:via-slate-950 dark:to-[#0a1622] dark:shadow-[0_28px_64px_-28px_rgb(0_0_0_/_0.72)]"
    >
      <div className="flex min-w-0 flex-col gap-6">
        {renderFlowChartSection("observed", {
          chartActions: (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full border-border/70 bg-background/80 shadow-sm dark:bg-slate-950/60"
              aria-label={t.chartFullscreenExpand}
              onClick={() => {
                setFlowChartFullscreenMode("observed");
                onSimulatedModeChange?.(false);
                setFlowChartFullscreenOpen(true);
              }}
            >
              <Maximize2 className="size-4" aria-hidden />
            </Button>
          ),
        })}
        {missedBetweenCharts}
        {renderSimulatedCapacityOverridePanel()}
        {renderFlowChartSection("simulated", {
          chartActions: (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full border-border/70 bg-background/80 shadow-sm dark:bg-slate-950/60"
              aria-label={t.chartFullscreenExpand}
              onClick={() => {
                setFlowChartFullscreenMode("simulated");
                onSimulatedModeChange?.(true);
                setFlowChartFullscreenOpen(true);
              }}
            >
              <Maximize2 className="size-4" aria-hidden />
            </Button>
          ),
        })}
      </div>
    </div>
  );

  const renderDashboard = () => {
    const modeledMissedChargeMwh =
      modeledScenario !== null
        ? Math.max(
            0,
            modeledScenario.coverage.totalChargeOpportunityEnergyMwh -
              modeledScenario.coverage.absorbedSurplusEnergyMwh
          )
        : null;
    const modeledMissedChargeSharePct =
      modeledScenario !== null &&
      modeledScenario.coverage.totalChargeOpportunityEnergyMwh > 1e-9 &&
      modeledMissedChargeMwh !== null
        ? (modeledMissedChargeMwh / modeledScenario.coverage.totalChargeOpportunityEnergyMwh) * 100
        : null;

    const modeledMissedOpportunityValuePerMwh =
      modeledScenario !== null
        ? computeOpportunityValuePerMwh(
            marketReference,
            modeledScenario.coverage.totalChargeOpportunityEnergyMwh,
            modeledScenario.coverage.totalCurtailmentEnergyMwh
          )
        : null;
    const missedOpportunityFootnote = buildMissedOpportunityFootnote(
      language,
      marketReference,
      modeledMissedOpportunityValuePerMwh
    );

    const workspaceMissedOpportunityBlock = (
      <section
        className="rounded-2xl border border-amber-400/45 bg-gradient-to-br from-amber-50/80 via-background/50 to-orange-50/30 p-3 shadow-sm dark:border-amber-500/35 dark:from-amber-950/40 dark:via-slate-950/30 dark:to-slate-950/25 md:p-4"
        aria-labelledby="workspace-missed-heading"
      >
        <p
          id="workspace-missed-heading"
          className="text-[10px] font-semibold tracking-[0.2em] text-amber-900/90 uppercase dark:text-amber-200/90"
        >
          {t.onePagerMissedEyebrow}
        </p>
        <div
          className="mt-3 flex flex-col divide-y divide-amber-200/60 dark:divide-amber-600/35 sm:flex-row sm:divide-x sm:divide-y-0"
          role="group"
          aria-label={t.onePagerMissedEyebrow}
        >
          <WindowMetricCell
            label={language === "de" ? "Nicht gespeichert" : "Not stored"}
            value={modeledMissedChargeMwh !== null ? formatEnergyFromMwh(modeledMissedChargeMwh) : "—"}
            hint={language === "de" ? "Überschuss + Abregelung" : "Surplus + curtailment"}
            tone="amber"
          />
          <WindowMetricCell
            label={language === "de" ? "Indik. Wert" : "Indic. value"}
            value={formatCurrencyCompact(modeledScenario?.missedOpportunityEur ?? null)}
            hint={
              modeledMissedOpportunityValuePerMwh !== null
                ? `${priceFormatter.format(modeledMissedOpportunityValuePerMwh)} EUR/MWh`
                : language === "de"
                  ? "Kein SMARD-Spread"
                  : "No SMARD spread"
            }
            tone="amber"
          />
          <WindowMetricCell
            label={language === "de" ? "Anteil" : "Share"}
            value={
              modeledMissedChargeSharePct !== null
                ? `${pctFormatter.format(modeledMissedChargeSharePct)}%`
                : "—"
            }
            hint={language === "de" ? "der Ladechance" : "of charge opportunity"}
            tone="amber"
          />
        </div>
        <p className="mt-3 border-t border-amber-200/60 pt-3 text-[10px] leading-relaxed text-amber-950/85 dark:border-amber-600/30 dark:text-amber-100/80">
          {missedOpportunityFootnote}
        </p>
      </section>
    );

    const simAbsorbedMwh = modeledScenario?.coverage.absorbedSurplusEnergyMwh ?? null;
    const fleetAbsorbedMwh = currentFleetScenario?.coverage.absorbedSurplusEnergyMwh ?? null;
    const energyCapacityRatio =
      fleetEnergyCapacityMwh != null &&
      fleetEnergyCapacityMwh > 0 &&
      effectivePracticalCapacityMwh > 0
        ? effectivePracticalCapacityMwh / fleetEnergyCapacityMwh
        : null;
    const absorbedEnergyRatio =
      fleetAbsorbedMwh != null &&
      fleetAbsorbedMwh > 1e-3 &&
      simAbsorbedMwh != null &&
      Number.isFinite(simAbsorbedMwh / fleetAbsorbedMwh)
        ? simAbsorbedMwh / fleetAbsorbedMwh
        : null;
    const formatGrowthRatio = (r: number) =>
      `${new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 0,
      }).format(r)}×`;

    const indicativeValuePresentation =
      modeledScenario !== null
        ? presentIndicativeEurTotal({
            language,
            valueEur: modeledScenario.totalValueCreatedEur,
            windowDays: flowWindowDays,
            absorbedMwh: modeledScenario.coverage.absorbedSurplusEnergyMwh,
            capacityMwh: effectivePracticalCapacityMwh,
            referenceCapacityMwh: economicsReferenceCapacityMwh,
          })
        : null;
    const valueBreakdownLines =
      modeledScenario !== null
        ? buildValueBreakdownLines(
            extractValueBreakdown(modeledScenario),
            language,
            formatCurrencyCompact
          )
        : [];

    const valueBreakdownTotalEur = modeledScenario?.totalValueCreatedEur ?? null;
    const fleetComparisonDetail =
      fleetEnergyCapacityMwh != null &&
      fleetEnergyCapacityMwh > 0 &&
      currentFleetScenario != null &&
      energyCapacityRatio != null &&
      simAbsorbedMwh != null
        ? absorbedEnergyRatio != null
          ? language === "de"
            ? `Flotte ${formatEnergyFromMwh(fleetAbsorbedMwh ?? 0)} · Simulation ${formatEnergyFromMwh(simAbsorbedMwh)} (${formatGrowthRatio(absorbedEnergyRatio)} Energie, ${formatGrowthRatio(energyCapacityRatio)} Kapazität)`
            : `Fleet ${formatEnergyFromMwh(fleetAbsorbedMwh ?? 0)} · simulation ${formatEnergyFromMwh(simAbsorbedMwh)} (${formatGrowthRatio(absorbedEnergyRatio)} energy, ${formatGrowthRatio(energyCapacityRatio)} capacity)`
          : language === "de"
            ? `Kapazität ×${formatGrowthRatio(energyCapacityRatio)} — Flotte nimmt im Fenster kaum Energie auf (${formatEnergyFromMwh(fleetAbsorbedMwh ?? 0)}).`
            : `Capacity ×${formatGrowthRatio(energyCapacityRatio)} — fleet stores almost nothing this window (${formatEnergyFromMwh(fleetAbsorbedMwh ?? 0)}).`
        : t.kpiSimVsFleetMissing;

    const lowerWorkspaceImpactSections = (
      <motion.div className="space-y-4">
        <WorkspaceSection
          eyebrow={t.workspaceTechnicalImpactEyebrow}
          headingId="workspace-technical-impact-heading"
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <CompactDetailStat
              label={t.onePagerNetPeakEyebrow}
              value={
                modeledScenario?.gridImpactReductionPct !== null &&
                modeledScenario?.gridImpactReductionPct !== undefined
                  ? `${pctFormatter.format(modeledScenario.gridImpactReductionPct)}%`
                  : "—"
              }
              subtitle={
                modeledScenario !== null
                  ? t.onePagerNetPeakPeakLine(formatPowerFromMw(modeledScenario.peakReductionMw))
                  : undefined
              }
            />
            <CompactDetailStat
              label={t.kpiStoredEndEyebrow}
              value={storedPracticalEndMwh !== null ? formatEnergyFromMwh(storedPracticalEndMwh) : "—"}
              subtitle={simulatedCapacityGwhLabel ?? undefined}
            />
            <CompactDetailStat
              label="Δ Import"
              value={
                borderTradeTotals !== null
                  ? formatSignedEnergyFromMwh(borderTradeTotals.importDeltaEnergyMwh)
                  : "—"
              }
              subtitle={language === "de" ? "vs. beobachtet" : "vs. observed"}
            />
            <CompactDetailStat
              label="Δ Export"
              value={
                borderTradeTotals !== null
                  ? formatSignedEnergyFromMwh(borderTradeTotals.exportDeltaEnergyMwh)
                  : "—"
              }
              subtitle={language === "de" ? "vs. beobachtet" : "vs. observed"}
            />
          </div>
          <p className="mt-2 text-[10px] leading-snug text-slate-500 dark:text-slate-400">
            {t.workspaceModeledBorderSubtitle}
          </p>
        </WorkspaceSection>

        <WorkspaceSection
          eyebrow={t.workspaceIndicativeEconomicsEyebrow}
          headingId="workspace-indicative-economics-heading"
        >
          <div
            className="space-y-3"
            role="region"
            aria-label={t.workspaceIndicativeEconomicsEyebrow}
          >
            <motion.div className="rounded-2xl border-2 border-emerald-300/70 bg-gradient-to-br from-emerald-50/90 via-white to-emerald-50/40 px-4 py-4 dark:border-emerald-500/35 dark:from-emerald-950/40 dark:via-slate-950/80 dark:to-emerald-950/20 md:px-5 md:py-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-900/85 dark:text-emerald-200/85">
                {indicativeValuePresentation?.primaryLabel ??
                  (language === "de" ? "Modellierter Nutzen (indik.)" : "Modeled benefit (indic.)")}
              </p>
              <p className="mt-1 text-4xl font-black tabular-nums leading-none text-slate-950 dark:text-white md:text-[2.75rem]">
                {indicativeValuePresentation?.primaryValue ?? "—"}
              </p>
              {indicativeValuePresentation?.perMwhValue ? (
                <p className="mt-2 text-base font-bold tabular-nums text-emerald-900 dark:text-emerald-200">
                  {indicativeValuePresentation.perMwhValue}
                </p>
              ) : null}
              {indicativeValuePresentation?.secondaryValue ? (
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                  {indicativeValuePresentation.secondaryValue}
                </p>
              ) : null}
            </motion.div>

            <IndicativeDisclaimerBanner
              title={t.kpiIndicativeDisclaimerTitle}
              body={t.kpiIndicativeValueDisclaimerProminent}
            />

            {indicativeValuePresentation?.warning ? (
              <p className="rounded-lg border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-xs leading-relaxed text-amber-950 dark:border-amber-500/35 dark:bg-amber-950/40 dark:text-amber-100">
                {indicativeValuePresentation.warning}
              </p>
            ) : simulatedCapacityCredibility.isExtrapolated ? (
              <p className="rounded-lg border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-xs leading-relaxed text-amber-950 dark:border-amber-500/35 dark:bg-amber-950/40 dark:text-amber-100">
                {t.simulatedCapacityExtrapolationWarning}
              </p>
            ) : null}

            {modeledScenario !== null && simAbsorbedMwh !== null ? (
              <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {t.kpiSimAbsorbedEyebrow}:
                </span>{" "}
                {formatEnergyFromMwh(simAbsorbedMwh)}
                {fleetComparisonDetail !== t.kpiSimVsFleetMissing ? ` · ${fleetComparisonDetail}` : null}
              </p>
            ) : null}

            {valueBreakdownLines.length > 0 ? (
              <div className="rounded-xl border border-border/70 bg-white/70 px-3.5 py-3 dark:border-slate-600/45 dark:bg-slate-950/50">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                  {t.kpiValueBreakdownTitle}
                </p>
                <table className="mt-2 w-full text-sm">
                  <tbody>
                    {valueBreakdownLines.map((line) => {
                      const sharePct =
                        valueBreakdownTotalEur !== null &&
                        line.amountEur !== null &&
                        valueBreakdownTotalEur > 1e-6
                          ? Math.round((line.amountEur / valueBreakdownTotalEur) * 100)
                          : null;
                      return (
                        <tr
                          key={line.id}
                          className="border-b border-border/50 last:border-0 dark:border-slate-600/35"
                        >
                          <th
                            scope="row"
                            className="py-1.5 pr-2 text-left font-medium text-slate-800 dark:text-slate-100"
                            title={line.hint}
                          >
                            {line.label}
                          </th>
                          <td className="py-1.5 text-right tabular-nums font-semibold text-slate-950 dark:text-white">
                            {line.value}
                          </td>
                          <td className="w-10 py-1.5 pl-2 text-right text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                            {sharePct !== null ? `${sharePct}%` : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {t.kpiValueBreakdownFootnote}
                </p>
              </div>
            ) : null}
          </div>
        </WorkspaceSection>

        {resolvedLlmInsightText.length > 0 ? (
          <div className="rounded-2xl border border-indigo-200/60 bg-card px-4 py-4 shadow-sm dark:border-indigo-500/35 dark:bg-indigo-950/35">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex h-2 w-2 shrink-0 rounded-full bg-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.65)]"
                aria-hidden
              />
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-800 dark:text-indigo-200">
                {t.aiInsightTitle}
              </p>
            </div>
            <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-slate-800 dark:text-slate-100">
              {resolvedLlmInsightText}
            </p>
          </div>
        ) : null}
      </motion.div>
    );

    const workspaceStructuralFleetMissedBlock = (
      <div className="space-y-5">
        <section
          className="rounded-2xl border border-border/70 bg-background/45 p-3 shadow-sm dark:border-slate-600/40 dark:bg-slate-950/30 md:p-4"
          aria-labelledby="workspace-structural-heading"
        >
          <p
            id="workspace-structural-heading"
            className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400"
          >
            {t.onePagerStructuralEyebrow}
          </p>
          <div
            className="mt-3 flex flex-col divide-y divide-border/55 dark:divide-slate-600/40 sm:flex-row sm:divide-x sm:divide-y-0"
            role="group"
            aria-label={t.onePagerStructuralEyebrow}
          >
            <WindowMetricCell
              label={language === "de" ? "Nettobilanz" : "Net balance"}
              value={formatSignedEnergyFromMwh(windowNetStructuralBalanceGwh * 1_000)}
              hint={language === "de" ? "Σ Erzeugung − Last" : "Σ generation − load"}
              tone="sky"
            />
            <WindowMetricCell
              label={language === "de" ? "Struktureller Überschuss" : "Structural surplus"}
              value={formatEnergyFromMwh(grossStructuralSurplusMwh)}
              hint={language === "de" ? "Plus-Slots" : "Positive slots"}
              tone="emerald"
            />
            <WindowMetricCell
              label={t.onePagerStructuralDeficitEyebrow}
              value={formatEnergyFromMwh(grossStructuralDeficitMwh)}
              hint={language === "de" ? "Minus-Slots" : "Negative slots"}
              tone="amber"
            />
          </div>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border/50 pt-3 text-sm dark:border-slate-600/35">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
              {language === "de" ? "Grenzhandel" : "Border trade"}
            </span>
            <span className="tabular-nums text-slate-800 dark:text-slate-100">
              <span className="font-semibold text-amber-900/90 dark:text-amber-100/90">Import</span>{" "}
              {borderTradeTotals !== null
                ? formatEnergyFromMwh(borderTradeTotals.observedImportEnergyMwh)
                : "—"}
            </span>
            <span className="text-slate-400 dark:text-slate-500" aria-hidden>
              ·
            </span>
            <span className="tabular-nums text-slate-800 dark:text-slate-100">
              <span className="font-semibold text-slate-600 dark:text-slate-300">
                {language === "de" ? "Export" : "Export"}
              </span>{" "}
              {borderTradeTotals !== null
                ? formatEnergyFromMwh(borderTradeTotals.observedExportEnergyMwh)
                : "—"}
            </span>
            <span className="w-full text-[10px] text-slate-500 sm:ml-auto sm:w-auto dark:text-slate-400">
              {t.kpiCrossBorderObservedSubtitle}
            </span>
          </p>
        </section>

        <section
          className="rounded-2xl border border-border/70 bg-background/45 p-3 shadow-sm dark:border-slate-600/40 dark:bg-slate-950/30 md:p-4"
          aria-labelledby="workspace-fleet-heading"
        >
          <p
            id="workspace-fleet-heading"
            className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400"
          >
            {t.onePagerInstalledFleetEyebrow}
          </p>
          <div
            className="mt-3 flex flex-col divide-y divide-border/55 dark:divide-slate-600/40 sm:flex-row sm:divide-x sm:divide-y-0"
            role="group"
            aria-label={t.onePagerInstalledFleetEyebrow}
          >
            <WindowMetricCell
              label={language === "de" ? "Ladechance (Flotte)" : "Charge opp. (fleet)"}
              value={
                currentFleetScenario !== null
                  ? `${formatEnergyFromMwh(currentFleetScenario.coverage.absorbedSurplusEnergyMwh)} · ${pctFormatter.format(
                      currentFleetScenario.coverage.absorbedSurplusShare * 100
                    )}%`
                  : "—"
              }
              hint={
                currentFleetScenario !== null
                  ? language === "de"
                    ? "Greedy-Walk"
                    : "Greedy walk"
                  : t.kpiFleetRequiredShort
              }
              tone="emerald"
            />
            <WindowMetricCell
              label={language === "de" ? "Defizit gedeckt" : "Deficit served"}
              value={
                currentFleetScenario !== null
                  ? `${formatEnergyFromMwh(currentFleetScenario.coverage.servedDeficitEnergyMwh)} · ${
                      currentFleetScenario.coverage.totalDeficitEnergyMwh > 1e-9
                        ? `${pctFormatter.format(currentFleetScenario.coverage.servedDeficitShare * 100)}%`
                        : "0%"
                    }`
                  : "—"
              }
              hint={language === "de" ? "Installierte Kapazität" : "Installed layer"}
              tone="sky"
            />
            <WindowMetricCell
              label={language === "de" ? "Flotten-SoC" : "Fleet SoC"}
              value={currentFleetSocStatusValue}
              hint={language === "de" ? "Schätzung aus Chart" : "From chart"}
              tone="violet"
            />
          </div>
          <p className="mt-3 border-t border-border/50 pt-3 text-[10px] leading-snug text-slate-500 dark:border-slate-600/35 dark:text-slate-400">
            {language === "de"
              ? "Installierte DE-BESS-Schicht · gleiches Slot-Modell wie die Kurven"
              : "Installed German BESS layer · same slot model as the charts"}
          </p>
        </section>
      </div>
    );

    const renderTwelveMonthBalancedSection = () => {
      if (isRecommendationLoading) {
        return <Skeleton className="h-56 w-full rounded-2xl" />;
      }
      if (recommendationLoadError || !recommendation || !balancedRecommendation) {
        return (
          <div className="rounded-2xl border border-dashed border-slate-300/70 bg-white/60 p-5 text-sm text-slate-500 dark:border-slate-600/45 dark:bg-slate-950/35 dark:text-slate-400">
            {t.kpiRecommendationUnavailable}
          </div>
        );
      }
      const revenueDisplay =
        balancedRevenueTileValue !== null
          ? euroCurrencyFormatter.format(Math.round(balancedRevenueTileValue))
          : "—";
      const revenueSubtitle = liveBalancedEconomics
        ? language === "de"
          ? "Mit Live-Preisreferenz"
          : "Using the live price reference"
        : language === "de"
          ? "Fallback auf 12M-Heuristik"
          : "Fallback to the 12M heuristic";

      return (
        <section
          className="rounded-2xl border border-emerald-200/75 bg-gradient-to-br from-emerald-50/80 via-white to-sky-50/35 p-4 shadow-sm dark:border-emerald-500/28 dark:from-emerald-500/10 dark:via-slate-950/70 dark:to-slate-950/85 md:p-5"
          aria-labelledby="twelve-month-balanced-heading"
        >
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-200">
              {t.twelveMonthSectionEyebrow}
            </p>
            <h3
              id="twelve-month-balanced-heading"
              className="text-lg font-semibold text-slate-900 dark:text-white md:text-xl [font-family:var(--font-heading)]"
            >
              {t.twelveMonthSectionTitle}
            </h3>
          </div>

          <div className="mt-4 rounded-2xl border border-emerald-200/75 bg-white/80 px-4 py-4 shadow-sm dark:border-emerald-400/30 dark:bg-slate-950/55">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
              {t.trailingKpiCapacity}
            </p>
            <p className="mt-2 text-3xl font-black leading-none tabular-nums text-slate-950 dark:text-white md:text-[2.85rem]">
              {formatEnergyFromMwh(balancedRecommendation.recommendedEnergyMwh)}
              <span className="text-slate-400 dark:text-slate-500"> / </span>
              {formatPowerFromMw(balancedRecommendation.recommendedPowerMw)}
            </p>
            <p className="mt-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">
              {t.twelveMonthBalancedTag}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {t.twelveMonthExplainerNeutral}
            </p>
            <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
              {t.trailingKpiDailyPercentileCaption}
            </p>
          </div>

          <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <CompactDetailStat
              label={t.twelveMonthKpiPayback}
              value={trailingPaybackLabel}
              detail={t.twelveMonthKpiPaybackDetail}
            />
            <CompactDetailStat label={t.twelveMonthKpiCoverage} value={trailingImpactLabel} />
            <CompactDetailStat
              label={t.twelveMonthKpiRevenue}
              value={revenueDisplay}
              subtitle={revenueSubtitle}
              detail={t.twelveMonthKpiRevenueDetail}
            />
            <CompactDetailStat label={t.twelveMonthKpiPeakSoc} value={trailingChainPeakValue} />
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {t.twelveMonthHeuristicNote(trailingWindowLabel)}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
            {t.trailingNotAuditedNote}
          </p>
        </section>
      );
    };

    return (
    <>
      <div className="min-w-0 space-y-4">
        <div className="rounded-2xl border border-border/75 bg-card/70 p-4 shadow-[0_22px_52px_-30px_rgba(15,23,42,0.4)] backdrop-blur-xl md:p-5 dark:border-white/[0.06] dark:bg-[rgba(10,16,28,0.76)] dark:shadow-[0_28px_64px_-30px_rgba(0,0,0,0.78)]">
          <div className="flex flex-col gap-2.5 border-b border-border/55 pb-4 dark:border-slate-600/35">
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4 sm:gap-y-1">
              <div className="min-w-0">
                <p className="text-[9px] font-semibold tracking-[0.16em] text-slate-500 uppercase dark:text-slate-400">
                  {language === "de" ? "Analyse-Arbeitsplatz" : "Analyst workspace"}
                </p>
                <h2 className="mt-0.5 text-xl font-semibold leading-tight tracking-tight text-slate-950 md:text-2xl dark:text-white [font-family:var(--font-heading)]">
                  {t.profileTitle}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/55 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-200">
                  <CalendarDays className="size-3.5" aria-hidden />
                  {selectorLabel}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/55 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-200">
                  {coveragePct}% {language === "de" ? "Abdeckung" : "coverage"}
                </span>
                {lastUpdatedIso ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/55 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-200">
                    {language === "de" ? "Live" : "Live"} ·{" "}
                    {timeFormatterSingleDay.format(new Date(lastUpdatedIso))}
                  </span>
                ) : null}
                {onRefresh ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-full px-3 text-[11px]"
                    disabled={isRefreshing}
                    onClick={onRefresh}
                  >
                    {language === "de" ? "Aktualisieren" : "Refresh"}
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="max-w-4xl text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              {t.profileSubtitle}
            </p>
            <section
              aria-labelledby="time-range-selector-heading"
              className="mx-auto w-full max-w-2xl rounded-2xl border border-sky-400/45 bg-gradient-to-br from-sky-50/95 via-white to-slate-50/90 p-4 text-center shadow-[0_12px_40px_-24px_rgba(14,165,233,0.4)] md:p-5 dark:border-sky-500/30 dark:from-sky-950/45 dark:via-slate-950/90 dark:to-slate-950/80 dark:shadow-[0_16px_48px_-28px_rgba(14,165,233,0.35)]"
            >
              <div className="flex flex-col items-center gap-2">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-300/70 bg-sky-100/90 text-sky-800 shadow-sm dark:border-sky-500/35 dark:bg-sky-500/15 dark:text-sky-200">
                  <CalendarDays className="size-5" aria-hidden />
                </span>
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold tracking-[0.2em] text-sky-800 uppercase dark:text-sky-300">
                    {t.timeframeLabelShort}
                  </p>
                  <h3
                    id="time-range-selector-heading"
                    className="text-base font-semibold leading-snug text-slate-950 md:text-lg dark:text-white [font-family:var(--font-heading)]"
                  >
                    {t.timeRangeControlTitle}
                  </h3>
                </div>
              </div>
              <motion.div
                className="mt-4 inline-flex min-h-10 w-full overflow-x-auto rounded-full border border-sky-200/90 bg-sky-100/60 p-1 shadow-[inset_0_1px_2px_rgba(14,116,144,0.08)] [-ms-overflow-style:none] [scrollbar-width:none] dark:border-sky-600/40 dark:bg-sky-950/50 dark:shadow-[inset_0_2px_6px_rgba(0,0,0,0.35)] [&::-webkit-scrollbar]:hidden"
                role="tablist"
                aria-label={t.timeframeLabelShort}
              >
                      {(
                        [
                          { mode: "day", label: t.dayMode },
                          { mode: "week", label: t.weekMode },
                          { mode: "month", label: t.monthMode },
                          { mode: "custom", label: t.customMode },
                        ] as const
                      ).map((option) => (
                        <button
                          key={option.mode}
                          type="button"
                          role="tab"
                          aria-selected={selectorMode === option.mode}
                          onClick={() => setSelectorMode(option.mode)}
                          className={`min-h-9 min-w-[4.5rem] flex-1 rounded-full px-3 py-1.5 text-xs font-bold tracking-tight transition sm:text-sm ${
                            selectorMode === option.mode
                              ? "bg-white text-sky-950 shadow-md ring-1 ring-sky-200/90 dark:bg-slate-950 dark:text-white dark:ring-sky-500/40"
                              : "text-sky-900/70 hover:text-sky-950 dark:text-sky-200/75 dark:hover:text-white"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
              </motion.div>

              <div className="mt-4 flex w-full items-stretch gap-2 sm:gap-3">
                <button
                  type="button"
                  onClick={handlePreviousWindow}
                  className={timeRangeNavButtonClass}
                  aria-label={t.previousRange}
                >
                  <ChevronLeft className="size-5" aria-hidden />
                </button>

                <div className="min-w-0 flex-1">
                  {selectorMode === "day" ? (
                    <BerlinDayCalendarButton
                      value={selectedDate}
                      max={todayKey}
                      onChange={setSelectedDate}
                      language={language}
                      prominent
                    />
                  ) : selectorMode === "custom" ? (
                    <BerlinDateRangeCalendarButton
                      start={customRangeStart}
                      end={customRangeEnd}
                      max={todayKey}
                      onChange={({ start, end }) => {
                        const spanDays = countBerlinCalendarDaysInclusive(start, end);
                        if (spanDays > BERLIN_CUSTOM_RANGE_MAX_DAYS) {
                          setCustomRangeStart(
                            addBerlinCalendarDays(end, -(BERLIN_CUSTOM_RANGE_MAX_DAYS - 1))
                          );
                          setCustomRangeEnd(end);
                          return;
                        }
                        setCustomRangeStart(start);
                        setCustomRangeEnd(end);
                      }}
                      language={language}
                      prominent
                    />
                  ) : (
                    <label className="group relative flex h-12 min-h-12 w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-sky-300/75 bg-white px-3 text-center shadow-inner transition hover:border-sky-400 hover:bg-sky-50/80 focus-within:ring-4 focus-within:ring-sky-400/30 dark:border-sky-500/40 dark:bg-slate-950/90 dark:hover:border-sky-400/55 dark:hover:bg-sky-950/50">
                      <span className="pointer-events-none text-sm font-bold leading-snug text-slate-900 sm:text-base dark:text-white">
                        {timeRangeCenterLabel}
                      </span>
                      <span className="pointer-events-none mt-0.5 text-[10px] font-semibold tracking-wide text-sky-700 uppercase dark:text-sky-300">
                        {t.timeRangeTapToChange}
                      </span>
                      <input
                        type={selectorMode === "week" ? "week" : "month"}
                        value={selectorMode === "week" ? selectedWeek : selectedMonth}
                        max={selectorMode === "week" ? currentWeekKey : currentMonthKey}
                        onChange={(event) =>
                          selectorMode === "week"
                            ? setSelectedWeek(event.target.value)
                            : setSelectedMonth(event.target.value)
                        }
                        className="absolute inset-0 cursor-pointer opacity-0"
                        aria-label={t.timeRangeControlTitle}
                      />
                    </label>
                  )}
                </div>

                <button
                  type="button"
                  disabled={nextDisabled}
                  onClick={handleNextWindow}
                  className={timeRangeNavButtonClass}
                  aria-label={t.nextRange}
                >
                  <ChevronRight className="size-5" aria-hidden />
                </button>
              </div>

              <p className="mt-3 flex flex-wrap items-center justify-center gap-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                <span className="inline-flex items-center rounded-full border border-sky-200/80 bg-sky-50/90 px-2.5 py-0.5 text-xs font-semibold text-sky-900 dark:border-sky-500/35 dark:bg-sky-950/60 dark:text-sky-100">
                  {coveragePct}% {language === "de" ? "Abdeckung" : "coverage"}
                </span>
                <span>{coverageSummaryLine}</span>
              </p>
            </section>
          </div>

          <div className="space-y-10 pt-4 md:pt-5">
            {workspaceStructuralFleetMissedBlock}

            <section
              className="space-y-3 border-t border-border/40 pt-8 dark:border-slate-600/30"
              aria-labelledby="workspace-charts-heading"
            >
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
                  {t.workspaceChartsEyebrow}
                </p>
                <p
                  id="workspace-charts-heading"
                  className="max-w-4xl text-xs leading-relaxed text-slate-600 dark:text-slate-400"
                >
                  {t.workspaceChartsLead}
                </p>
              </div>
              {renderDualFlowChartsBlock(workspaceMissedOpportunityBlock)}
            </section>

            <div className="border-t border-border/40 pt-8 dark:border-slate-600/30">
              {lowerWorkspaceImpactSections}
            </div>

            <div className="border-t border-border/40 pt-8 dark:border-slate-600/30">
              {renderTwelveMonthBalancedSection()}
            </div>
          </div>

          <p className="text-[10px] text-slate-400 dark:text-slate-600">{t.technicalDisclaimer}</p>
        </div>
      </div>

    {flowChartFullscreenOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[2000] flex max-h-[100dvh] flex-col overflow-hidden bg-background/98 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            aria-label={t.chartFullscreenTitle}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <p className="text-sm font-semibold text-slate-900 dark:text-white">{t.chartFullscreenTitle}</p>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-10 w-10 shrink-0 rounded-full"
                aria-label={t.chartFullscreenClose}
                onClick={() => setFlowChartFullscreenOpen(false)}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden overscroll-y-contain px-4 py-3">
              <div className="flex shrink-0 justify-center">
                <div
                  role="tablist"
                  aria-label={language === "de" ? "Kurvenmodus" : "Chart mode"}
                  className="inline-flex w-full max-w-md rounded-full border border-border/70 bg-background/55 p-1 dark:border-slate-600/40 dark:bg-slate-950/35"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={flowChartFullscreenMode === "observed"}
                    className={`min-w-0 flex-1 rounded-full px-3 py-2.5 text-center text-[12px] font-semibold transition ${
                      flowChartFullscreenMode === "observed"
                        ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white"
                        : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                    onClick={() => {
                      setFlowChartFullscreenMode("observed");
                      onSimulatedModeChange?.(false);
                    }}
                  >
                    {t.modeObserved}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={flowChartFullscreenMode === "simulated"}
                    className={`min-w-0 flex-1 rounded-full px-3 py-2.5 text-center text-[12px] font-semibold transition ${
                      flowChartFullscreenMode === "simulated"
                        ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white"
                        : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                    onClick={() => {
                      setFlowChartFullscreenMode("simulated");
                      onSimulatedModeChange?.(true);
                    }}
                  >
                    {t.modeSimulated}
                  </button>
                </div>
              </div>
              <div className="mx-auto w-full max-w-[min(100%,1240px)] shrink-0">
                {renderFlowChartSection(flowChartFullscreenMode, {
                  chartAreaClassName:
                    "h-[min(78dvh,900px)] min-h-[320px] w-full sm:min-h-[360px]",
                })}
              </div>
              <p className="shrink-0 pb-1 text-center text-[11px] text-slate-500 dark:text-slate-400">
                {t.chartFullscreenEscHint}
              </p>
            </div>
          </div>,
          document.body
        )
      : null}
    </>
    );
  };

  return (
    <article id="germany-day-energy-flow" className="scroll-mt-24">
      {renderDashboard()}
    </article>
  );
}
