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
  formatBerlinDateKeyFromUtcDate,
  mondayBerlinIsoWeekContaining,
} from "@/lib/berlinCalendar";
import {
  computeEconomics,
  defaultEconomicsAssumptions,
} from "@/lib/bessEconomics";
import type { BriefingStoryWindow } from "@/lib/briefingStoryWindow";
import { berlinDateKeySchema } from "@/lib/germanyEnergyFlowPeriod";
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
  computeStitchedPracticalInitialSocMwh,
  simulateAdjustedNetMwAtCapacity,
  simulatePracticalDispatchAtCapacity,
} from "@/lib/optimalBessCapacity";
import {
  inferFleetModeFromChartTail,
  type ChartFleetSocSnapshot,
  type ChartRowTailForFleetMode,
} from "@/lib/chartFleetSocSnapshot";
import { BerlinDayCalendarButton } from "@/components/briefing/BerlinDayCalendarButton";
import { BriefingDailyStory } from "@/components/briefing/BriefingDailyStory";
import { FlowExportButtons } from "@/components/briefing/FlowExportButtons";
import { Button } from "@/components/ui/button";

const log = createLogger("germany-day-energy-flow");

const EVENING_HOUR_START = 17;
const EVENING_HOUR_END = 21;
const QUARTER_HOUR_H = 0.25;

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

type SelectorMode = "day" | "week" | "month";
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

function formatInsightScopeLabel(options: {
  language: "en" | "de";
  selectorMode: SelectorMode;
  selectedDate: string;
  selectedWeek: string;
  selectedMonth: string;
}): string {
  const { language, selectorMode, selectedDate, selectedWeek, selectedMonth } = options;
  if (selectorMode === "day") {
    return selectedDate;
  }
  if (selectorMode === "week") {
    const match = selectedWeek.match(/^\d{4}-W(\d{2})$/);
    if (match) {
      return language === "de" ? `KW${Number(match[1])}` : `week ${Number(match[1])}`;
    }
    return selectedWeek;
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

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
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
}: {
  eyebrow: string;
  value: string;
  subtitle?: string;
  tone?: SectionKpiTone;
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

  return (
    <div className={`rounded-xl border px-3.5 py-3 shadow-sm ${toneClass}`}>
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">
        {eyebrow}
      </p>
      <p className="mt-1 text-[1.05rem] font-extrabold leading-tight tabular-nums md:text-[1.15rem]">
        {value}
      </p>
      {subtitle ? (
        <p className="mt-1 text-[10px] leading-snug text-slate-600/92 dark:text-slate-400/95">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

function CompactDetailStat({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string;
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
  return `${sign}${formatEnergyFromMwh(mwh)}`;
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
  totalValueCreatedEur: number | null;
  missedOpportunityEur: number | null;
  curtailedRecoveredToLoadEnergyMwh: number;
  gridReliefScore: number | null;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function formatCurrencyCompact(value: number | null): string {
  return value !== null && Number.isFinite(value) ? euroCurrencyFormatter.format(Math.round(value)) : "—";
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
      observedImportEnergyMwh += Math.max(0, observedCrossBorderMw) * QUARTER_HOUR_H;
      simulatedImportEnergyMwh +=
        Math.max(0, observedCrossBorderMw + practicalChargeMw - practicalDischargeMw) * QUARTER_HOUR_H;
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

  const curtailedShareOfOpportunity =
    coverage.totalChargeOpportunityEnergyMwh > 1e-9
      ? coverage.totalCurtailmentEnergyMwh / coverage.totalChargeOpportunityEnergyMwh
      : 0;
  const opportunityValuePerMwh =
    (spreadEurPerMwh ?? 0) + (redispatchEurPerMwh ?? 0) * curtailedShareOfOpportunity;
  const missedOpportunityEur =
    opportunityValuePerMwh > 0
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
    totalValueCreatedEur,
    missedOpportunityEur,
    curtailedRecoveredToLoadEnergyMwh,
    gridReliefScore,
  };
}

/**
 * Deterministic prose when `simulationAiInsight` prop is unset — no backend LLM wired yet from the dashboard.
 */
function deriveGermanyFlowRuleBasedInsightText(options: {
  language: "en" | "de";
  modeSimulated: boolean;
  scopeLabel: string;
  conservativeRecommendedMwh: number | null;
  absorption: AbsorptionTotals | null;
  fleetSizingAvailable: boolean;
  recommendedCoverageSim: CoverageTotals | null;
  gridImpactReductionPct: number | null;
  borderTradeTotals: BorderTradeTotals | null;
  curtailmentStatus: "loaded" | "unavailable_not_configured" | "unavailable_upstream";
}): string | null {
  const {
    language,
    modeSimulated,
    scopeLabel,
    conservativeRecommendedMwh,
    absorption,
    fleetSizingAvailable,
    recommendedCoverageSim,
    gridImpactReductionPct,
    borderTradeTotals,
    curtailmentStatus,
  } = options;
  const parts: string[] = [];

  if (modeSimulated) {
    if (gridImpactReductionPct !== null && Number.isFinite(gridImpactReductionPct)) {
      const pctRound = `${integerFormatter.format(Math.round(gridImpactReductionPct))}`;
      parts.push(
        language === "de"
          ? `Die Summe der absoluten strukturellen Nettobetraege im Fenster liegt im Modell rund ${pctRound} % unter der Roh-Netto-Reihe.`
          : `The sum of absolute structural net swings in the window sits ~${pctRound}% below the raw net trace in this proxy.`
      );
    }
    if (
      recommendedCoverageSim !== null &&
      recommendedCoverageSim.totalChargeOpportunityEnergyMwh > 1e-9 &&
      recommendedCoverageSim.totalDeficitEnergyMwh > 1e-9
    ) {
      const as = pctFormatter.format(recommendedCoverageSim.absorbedSurplusShare * 100);
      const sd = pctFormatter.format(recommendedCoverageSim.servedDeficitShare * 100);
      parts.push(
        language === "de"
          ? `Bei dieser modellierten Schicht sind ~${as} % der Ladechance (struktureller Ueberschuss plus ggf. Abregelung) eingelagert und ~${sd} % der Brutto-Defizitenergie ausgeliefert (Idealbilanz ohne Verluste).`
          : `At this modeled size ~${as}% of gross charge opportunity (structural surplus plus curtailment when present) is stored and ~${sd}% of gross deficit energy is met from storage (lossless heuristic).`
      );
    }
    if (borderTradeTotals !== null) {
      parts.push(
        language === "de"
          ? `Unter der 1:1-Annahme fuer verdraengten Grenzhandel laegen Importe bei ${formatEnergyFromMwh(borderTradeTotals.simulatedImportEnergyMwh)} (${formatSignedEnergyFromMwh(borderTradeTotals.importDeltaEnergyMwh)}) und Exporte bei ${formatEnergyFromMwh(borderTradeTotals.simulatedExportEnergyMwh)} (${formatSignedEnergyFromMwh(borderTradeTotals.exportDeltaEnergyMwh)}).`
          : `Under a 1:1 displaced-border-flow assumption, imports land at ${formatEnergyFromMwh(borderTradeTotals.simulatedImportEnergyMwh)} (${formatSignedEnergyFromMwh(borderTradeTotals.importDeltaEnergyMwh)}) and exports at ${formatEnergyFromMwh(borderTradeTotals.simulatedExportEnergyMwh)} (${formatSignedEnergyFromMwh(borderTradeTotals.exportDeltaEnergyMwh)}).`
      );
    }
    return parts.length > 0 ? parts.join(" ") : null;
  }

  if (conservativeRecommendedMwh !== null && conservativeRecommendedMwh > 0) {
    parts.push(
      language === "de"
        ? `Konservative P95-Kapazitaet fuer ${scopeLabel}: ${formatEnergyFromMwh(conservativeRecommendedMwh)}.`
        : `Conservative P95 capacity for ${scopeLabel}: ${formatEnergyFromMwh(conservativeRecommendedMwh)}.`
    );
  }
  if (absorption !== null) {
    if (borderTradeTotals !== null) {
      parts.push(
        language === "de"
          ? `- Beobachteter Grenzhandel im Fenster: ${formatEnergyFromMwh(borderTradeTotals.observedImportEnergyMwh)} Importe und ${formatEnergyFromMwh(borderTradeTotals.observedExportEnergyMwh)} Exporte.`
          : `- Observed border trading in the window: ${formatEnergyFromMwh(borderTradeTotals.observedImportEnergyMwh)} of imports and ${formatEnergyFromMwh(borderTradeTotals.observedExportEnergyMwh)} of exports.`
      );
    }
    parts.push(
      language === "de"
        ? `- Ladechance im Fenster: ${formatEnergyFromMwh(absorption.grossChargeOpportunityEnergyMwh)}.`
        : `- Charge opportunity in the window: ${formatEnergyFromMwh(absorption.grossChargeOpportunityEnergyMwh)}.`
    );
    if (curtailmentStatus === "loaded") {
      parts.push(
        language === "de"
          ? `- Darin ${formatEnergyFromMwh(absorption.curtailedEnergyMwh)} abgeregelte Energie.`
          : `- Including ${formatEnergyFromMwh(absorption.curtailedEnergyMwh)} of curtailed energy.`
      );
    }
    if (
      fleetSizingAvailable &&
      absorption.grossChargeOpportunityEnergyMwh > 1e-6 &&
      Number.isFinite(absorption.missedSurplusEnergyMwh)
    ) {
      const pct = pctFormatter.format(
        Math.min(
          100,
          Math.max(
            0,
            (absorption.missedSurplusEnergyMwh / absorption.grossChargeOpportunityEnergyMwh) * 100
          )
        )
      );
      parts.push(
        language === "de"
          ? `- Mit der vorhandenen Flotten-Kapazitaet bleiben ${formatEnergyFromMwh(absorption.missedSurplusEnergyMwh)} ungenutzt (~${pct} % der Ladechance).`
          : `- ${formatEnergyFromMwh(absorption.missedSurplusEnergyMwh)} remains unabsorbed with the current fleet (~${pct}% of charge opportunity).`
      );
    } else if (!fleetSizingAvailable) {
      parts.push(
        language === "de"
          ? "- Installierte GW/GWh-Schicht fehlen — keine verpassten-Ueberschuss-Schaetzung."
          : "- Installed GW/GWh not provided — cannot quantify missed surplus against a fleet envelope."
      );
    }
    if (curtailmentStatus !== "loaded") {
      parts.push(
        language === "de"
          ? curtailmentStatus === "unavailable_not_configured"
            ? "- Abregelungsdaten sind in dieser Laufzeit nicht konfiguriert."
            : "- Abregelungsdaten sind derzeit upstream nicht verfuegbar."
          : curtailmentStatus === "unavailable_not_configured"
            ? "- Curtailment data is not configured in this runtime."
            : "- Curtailment data is currently unavailable upstream."
      );
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
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
    briefingStoryWindow = null,
    briefingStoryRefreshNonce = 0,
    initialSimulatedNet = false,
    onSimulatedModeChange,
  } = props;
  const resolvedSeedKey = resolveSeedDateKey(seedDateKey ?? undefined);
  const [selectorMode, setSelectorMode] = useState<SelectorMode>("day");
  const [selectedDate, setSelectedDate] = useState(resolvedSeedKey);
  const [selectedWeek, setSelectedWeek] = useState(dateKeyToIsoWeekKey(resolvedSeedKey));
  const [selectedMonth, setSelectedMonth] = useState(resolvedSeedKey.slice(0, 7));
  const [dayModeResetAtStart] = useState(false);
  const [customSimulatedCapacityGwhInput, setCustomSimulatedCapacityGwhInput] = useState("");
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
              : `month=${selectedMonth}`;
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
        log("energy flow fetch failed %o", { selectorMode, selectedDate, selectedWeek, selectedMonth, error });
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
  }, [selectorMode, selectedDate, selectedWeek, selectedMonth]);

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
    return { type: "month", monthKey: selectedMonth };
  }, [selectorMode, selectedDate, selectedWeek, selectedMonth]);

  useEffect(() => {
    if (!onBriefingStoryWindowChange) {
      return;
    }
    onBriefingStoryWindowChange(currentBriefingStoryWindow);
  }, [currentBriefingStoryWindow, onBriefingStoryWindowChange]);

  /** Loads D−1 and D−2 for carry-in maths only — intentionally not keyed on the reset checkbox to avoid reloading the chart. */
  useEffect(() => {
    const controller = new AbortController();
    const loadTrail = async () => {
      if (selectorMode !== "day") {
        if (!controller.signal.aborted) {
          setPreviousDaySlots([]);
          setDayBeforePreviousSlots([]);
        }
        return;
      }
      try {
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
  }, [selectorMode, selectedDate]);

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
          title: "Deutschland-Tagesprofil – beobachteter Ueberschuss, Defizit & geschaetzter Flotten-SoC",
          chartTitle: "Ueberschuss / Defizit",
          chartSimulatedPanelTitle:
            "Viertelstunden-Leistung, SoC, modelliertes Laden und Entladen · Fenster",
          legendNet: "+Ueberschuss / −Defizit (Erz. − Last)",
          legendNetSimulated: "Netto (nach BESS)",
          legendFleetSoc: "Geschaetzter SoC",
          legendPracticalSoc: "SoC",
          legendPracticalCharge: "Laden",
          legendPracticalDischarge: "Entladen",
          legendEstimatedCharge: "Geschaetzte Ladung",
          legendEstimatedDischarge: "Geschaetzte Entladung",
          legendObservedImport: "Importe",
          legendObservedExport: "Exporte",
          legendSimulatedImport: "Importe (mit BESS)",
          legendSimulatedExport: "Exporte (mit BESS)",
          legendCurtailment: "Abregelung (MW)",
          observedChargeDischargeFootnote:
            "Laden und Entladen folgen demselben geschaetzten Flottenmodell wie der SoC (keine Echtzeitmesswerte).",
          curtailmentFootnote:
            "Abregelung erscheint als separate Zusatzreihe fuer Ladechance und veraendert die beobachtete Netto-Linie nicht.",
          crossBorderFootnote:
            "Import-/Export-Balken zeigen den Energy-Charts-Grenzhandel; in der Simulation als 1:1 verdraengter Grenzfluss aus Lade-/Entladeleistung.",
          legendSimulatedPrefix: "Simuliert:",
          legendEvening: "Abendfenster",
          toggleNetSimulation: "Praktische BESS-Simulation auf Netto anwenden",
          netFootnote: "Netto = Erzeugung − Last je Slot.",
          netFootnoteSimulated:
            "Netto = strukturelles Netto nach modelliertem BESS (nicht Roh-Gen−Last).",
          socFootnote: "SoC: Modell ueber Reihenvolge der Viertelstunden, nicht Messwert.",
          kpiGross: "Brutto-Ueberschuss (Erz. − Last)",
          kpiAbsorbed: "Theoretisch speicherbar (Kap. + MW)",
          kpiMissed: "Verpasste Ladechance",
          kpiPracticalCap: "Praktische Tageszyklus-Kapazitaet (P95)",
          kpiRecommendedBalanced: "Empfehlung (12M, Balanced)",
          kpiRecommendedSelected: "Empfehlung (Auswahl, Balanced)",
          kpiRecommendationUnavailable:
            "12-Monats-Empfehlung aktuell nicht verfuegbar (Upstream-Daten fehlen).",
          trailingKpiCapacity: "Tages-Energie (balanced)",
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
              ? `${n} Viertelstunden (${pct}% des gewaehlten Fensters) · ${date}`
              : `${n} Viertelstunden beobachtet (${pct}% des Tages) · ${date}`,
          axisMw: "MW",
          axisSoc: "SoC (%)",
          unavailable:
            "Für keine Berlin-Tag-Linie reichenzeitig genug brauchbare Viertelstunden — bitte später erneut laden.",
          timeframe: "Zeitraum",
          dayMode: "Tag",
          weekMode: "Woche",
          monthMode: "Monat",
          previousRange: "Zurueck",
          nextRange: "Weiter",
          dayResetToggleLabel:
            "Tagesstart-SoC in der Simulation bei 0 % (optional)",
          fetchError:
            "Energy-Charts-Zeitreihe konnte nicht geladen werden — bitte Verbindung prüfen und erneut versuchen.",
          dataNote: "Nur veroeffentlichte Energy-Charts-Viertelstunden; keine interpolierten Werte.",
          loadingEyebrow: "Energy-Charts werden geladen",
          keyMetricsTitle: "Key Metrics",
          kpiRecommendedP95Eyebrow: "Empfohlene Kapazitaet (P95)",
          kpiRecommendedP95Subtitle: "Pragmatischer taeglicher Speicherbedarf (95. Perzentil)",
          kpiGrossSurplusEyebrow: "Ladechance",
          kpiGrossSurplusSubtitle: "Zeitraum",
          kpiMissedSurplusEyebrow: "Verpasste Ladechance",
          kpiMissedSurplusSubtitle: "Nicht aufnehmbar aus Ueberschuss + Abregelung",
          kpiMissedOfGross: (pct: string) => `${pct}% der Ladechance`,
          kpiSelfConsumptionEyebrow: "Eigenverbrauchsquote (optimales BESS)",
          kpiSelfConsumptionSubtitle: "Der erzeugten Energie vor Ort verwendet",
          kpiFleetRequiredShort: "Flotten-Leistung und -Kapazitaet aus dem Snapshot fuer dieses KPI noetig.",
          profileTitle: "Deutschland-Tagesprofil",
          profileSubtitle:
            "Energy-Charts: strukturelle Lage, heutige Flotte, Kurven — dann modellierte Speicherwirkung (Europa/Berlin).",
          modeObserved: "Beobachtet",
          modeSimulated: "Simuliertes BESS",
          timeframeLabelShort: "Zeitraum",
          dataCoverageInfoAria: "Was bedeutet die Datenabdeckung?",
          dataCoverageTooltip:
            "Anteil der erwarteten Viertelstunden im gewaehlten Zeitraum, fuer die Energy-Charts veroeffentlichte Messreihen liefern (keine interpolierten Luecken).",
          coverageBadgeSuffix: "Datenabdeckung",
          observedChartTitle:
            "Beobachteter Ueberschuss, Defizit & geschaetzter Flotten-SoC",
          recoImpactEyebrow: "Unter der Kurve",
          recoImpactTitle: "Simulation & BESS-Empfehlung",
          recoImpactLead:
            "Dieser Block fasst die simulierte Fenstersicht zusammen: empfohlene Größe, Modellwirkung und optionales Kapazitäts-Override.",
          simulatedCtaObserved: "Zu Beobachtet wechseln",
          longTermEyebrow: "Langfristige Einordnung",
          longTermTitle: "Zwölf Monate · BESS-Analyse",
          kpiCurtailmentEyebrow: "Abregelung",
          kpiCurtailmentSubtitle: "Zusatzreihe; Nettolinie bleibt roh",
          kpiCapturedSurplusEyebrow: "Ladechance (aufgenommen)",
          kpiCapturedSurplusSubtitle: "Greedy-Simulation aus Ueberschuss + Abregelung",
          curtailmentStatusConfigured: "Curtailment geladen",
          curtailmentStatusMissingConfig: "Curtailment nicht konfiguriert",
          curtailmentStatusUpstream: "Curtailment-Upstream fehlt",
          kpiDeficitCoveredEyebrow: "Gedecktes Defizit",
          kpiDeficitCoveredSubtitle: "Aus Speicher gefüllt",
          kpiNewSelfConsumptionEyebrow: "Neue Eigenverbrauchsquote",
          kpiNewSelfConsumptionSubtitle: "Mit modelliertem BESS",
          kpiGridImpactEyebrow: "Daempfung |Netto| je Slot",
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
          capacityBadgeUnavailable: "Keine berechenbare Simulationskapazitaet",
          simulatedCapacityBadgeLabel: (capacity: string) => `Simulierte Kapazitaet: ${capacity}`,
          simulatedCapacityModeAuto: "Automatik · Fenster-P95",
          simulatedCapacityModeCustom: "Manuell gesetzt",
          simulatedCapacityPowerBadge: (power: string) => `Leistungslimit: ${power}`,
          simulatedCapacityControlEyebrow: "Kapazität überschreiben",
          simulatedCapacityControlTitle: "Simulierte BESS-Kapazitaet anpassen",
          simulatedCapacityControlHintAuto: (capacity: string) =>
            `Aktuell nutzt die Kurve automatisch ${capacity} (praktische Fenster-P95). Trage einen Wert ein, um die Simulation zu ueberschreiben.`,
          simulatedCapacityControlHintCustom: (capacity: string | null) =>
            capacity
              ? `Manuelle Kapazitaet aktiv. Die automatische Fenster-P95 waere ${capacity}.`
              : "Manuelle Kapazitaet aktiv. Fuer dieses Fenster ist derzeit keine automatische Groesse berechenbar.",
          simulatedCapacityInputLabel: "Kapazitaet (GWh)",
          simulatedCapacityInputHint: (power: string) =>
            `Das Leistungslimit bleibt bei ${power} (balanced).`,
          simulatedCapacityInputHintUnavailable:
            "Das Leistungsmodell wird geladen. Sobald die Fenster-Empfehlung da ist, erscheint hier das Power-Limit.",
          simulatedCapacityReset: "Automatik wiederherstellen",
          simulatedCapacityInputInvalid:
            "Bitte eine positive GWh-Zahl eingeben, z. B. 2,5.",
          simulatedCapacitySourceAuto: "Automatik",
          simulatedCapacitySourceCustom: "Manuell",
          aiInsightTitle: "KI-Einblick",
          insightRuleBasedTitle: "Kurzfazit",
          bottomControlsHint:
            "Beobachtete Daten stehen oben; die modellierte BESS-Simulation mit ihren KPIs folgt direkt darunter.",
          chartFullscreenExpand: "Diagramm im Vollbild",
          chartFullscreenClose: "Schliessen",
          chartFullscreenTitle: "Tagesprofil",
          chartFullscreenEscHint: "Escape schliesst die Ansicht.",
          onePagerStructuralEyebrow: "Struktur & Nachbarsystem",
          onePagerStructuralLead:
            "Bilanz und Brutto-Spannungen im gewaehlten Fenster — bevor Speicher eingreift — plus beobachteter Grenzhandel.",
          onePagerInstalledFleetEyebrow: "Heutige Speicherflotte (Snapshot)",
          onePagerInstalledFleetLead:
            "Was die installierte DE-BESS-Schicht in derselben Zeitreihe leistet (Kapazitaet & Leistung aus dem Markt-Snapshot, kein Kapazitaets-Slider).",
          onePagerStructuralDeficitEyebrow: "Brutto-Defizit",
          onePagerStructuralDeficitSubtitle: "Energie in strukturellen Minus-Slots",
          kpiInstalledFleetAbsorbedEyebrow: "Ladechance aufgenommen (Flotte)",
          kpiInstalledFleetAbsorbedSubtitle: "Greedy-Walk mit installierter Schicht",
          onePagerChartsIntro: "Kurven: beobachtet vs. modelliertes BESS im selben Fenster.",
          onePagerImpactHeading: "Modellierte Kapazitaet & Systemwirkung",
          onePagerImpactLead:
            "Slider-Kapazitaet: wie viel Ueberschuss genutzt wird, was uebrig bleibt, wie Netzstress und Grenzfluesse sich verschieben.",
          onePagerDetailsSummary: "Markt-Snapshot, 12M-Empfehlung & Skalierung",
          onePagerExportHint: "Exporte erfassen die beiden Diagrammfelder unten.",
          kpiStoredEndEyebrow: "Energie im Speicher (Ende Fenster)",
          aiInsightPlaceholder:
            "Keine Zahlenbasis fuer diese Kurzfassung. Nach Anbindung eines LLM kann zusätzlicher Text uber die Prop simulationAiInsight kommen.",
          observedCtaSimulated: "Zu Simulation wechseln",
          technicalDisclaimer: "Illustratives Modell, keine Beschaffungsempfehlung.",
        }
      : {
          eyebrow: "Energy-Charts Profile",
          title: "Germany Day Profile – Observed Surplus, Deficit & Estimated Fleet SoC",
          chartTitle: "Surplus / deficit",
          chartSimulatedPanelTitle:
            "Quarter-hour power, SoC · modeled charge & discharge · window",
          legendNet: "+surplus / −deficit (gen − load)",
          legendNetSimulated: "Net (after BESS)",
          legendFleetSoc: "Estimated SoC",
          legendPracticalSoc: "SoC",
          legendPracticalCharge: "Charge",
          legendPracticalDischarge: "Discharge",
          legendEstimatedCharge: "Estimated charge",
          legendEstimatedDischarge: "Estimated discharge",
          legendObservedImport: "Imports",
          legendObservedExport: "Exports",
          legendSimulatedImport: "Imports (with BESS)",
          legendSimulatedExport: "Exports (with BESS)",
          legendCurtailment: "Curtailment (MW)",
          observedChargeDischargeFootnote:
            "Charge/discharge bars use the same estimated fleet model as SoC (not real-time telemetry).",
          curtailmentFootnote:
            "Curtailment is shown as a separate extra charge-opportunity overlay and does not change the observed net line.",
          crossBorderFootnote:
            "Import/export bars show Energy-Charts cross-border trading; in simulation they are rendered as a 1:1 displaced border-flow estimate from charge/discharge power.",
          legendSimulatedPrefix: "Simulated:",
          legendEvening: "Evening window",
          toggleNetSimulation: "Apply practical BESS simulation to net line",
          netFootnote: "Net = generation − load per slot.",
          netFootnoteSimulated:
            "Net = structural net after modeled BESS in this view (not raw gen − load).",
          socFootnote: "SoC modeled over quarter-hour order, not SCADA telemetry.",
          kpiGross: "Charge opportunity",
          kpiAbsorbed: "Theoretically storable (cap + MW)",
          kpiMissed: "Missed charge opportunity",
          kpiPracticalCap: "Practical daily-cycle capacity (P95)",
          kpiRecommendedBalanced: "Recommendation (12M, balanced)",
          kpiRecommendedSelected: "Recommendation (selection, balanced)",
          kpiRecommendationUnavailable:
            "Trailing-12-month recommendation unavailable right now (upstream data gap).",
          trailingKpiCapacity: "Daily energy (balanced)",
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
            "Energy-Charts: structural setup, today’s fleet, charts — then modeled storage impact (Europe/Berlin).",
          modeObserved: "Observed",
          modeSimulated: "Simulated BESS",
          timeframeLabelShort: "Period",
          dataCoverageInfoAria: "What does data coverage mean?",
          dataCoverageTooltip:
            "Share of expected quarter-hours in the selected window that have published Energy-Charts data (missing slots are not interpolated).",
          coverageBadgeSuffix: "data coverage",
          observedChartTitle: "Observed Surplus, Deficit & Estimated Fleet SoC",
          recoImpactEyebrow: "Below the chart",
          recoImpactTitle: "Simulation & BESS recommendation",
          recoImpactLead:
            "This block summarizes the simulated window view: recommended size, modeled impact, and an optional capacity override.",
          simulatedCtaObserved: "Back to Observed mode",
          longTermEyebrow: "Long-term view",
          longTermTitle: "12-month BESS analysis",
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
          simulatedCapacityModeAuto: "Auto · window P95",
          simulatedCapacityModeCustom: "Manual override",
          simulatedCapacityPowerBadge: (power: string) => `Power cap: ${power}`,
          simulatedCapacityControlEyebrow: "Capacity override",
          simulatedCapacityControlTitle: "Adjust simulated BESS capacity",
          simulatedCapacityControlHintAuto: (capacity: string) =>
            `The chart currently auto-uses ${capacity} (practical window P95). Enter a value to override the simulation.`,
          simulatedCapacityControlHintCustom: (capacity: string | null) =>
            capacity
              ? `Manual capacity active. The automatic window P95 would be ${capacity}.`
              : "Manual capacity active. No automatic size is computable for this window yet.",
          simulatedCapacityInputLabel: "Capacity (GWh)",
          simulatedCapacityInputHint: (power: string) =>
            `The power cap stays at ${power} (balanced).`,
          simulatedCapacityInputHintUnavailable:
            "The power model is still loading. The power cap appears here once the window recommendation is ready.",
          simulatedCapacityReset: "Restore auto",
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
          onePagerStructuralEyebrow: "Structure & neighbors",
          onePagerStructuralLead:
            "Where the window sits structurally—balance, gross surplus and deficit, and observed cross-border trade—before storage acts.",
          onePagerInstalledFleetEyebrow: "Installed fleet (snapshot)",
          onePagerInstalledFleetLead:
            "What today’s installed German BESS layer can do on the same series (market snapshot power & energy—not the capacity slider).",
          onePagerStructuralDeficitEyebrow: "Gross structural deficit",
          onePagerStructuralDeficitSubtitle: "Energy in negative structural slots",
          kpiInstalledFleetAbsorbedEyebrow: "Charge opportunity absorbed (fleet)",
          kpiInstalledFleetAbsorbedSubtitle: "Greedy walk at installed layer",
          onePagerChartsIntro: "Charts: observed vs modeled BESS in the same window.",
          onePagerImpactHeading: "Modeled capacity & system impact",
          onePagerImpactLead:
            "At the slider capacity: surplus use, what’s left on the table, and how grid stress and border flows shift.",
          onePagerDetailsSummary: "Market snapshot, 12M recommendation & scaling",
          onePagerExportHint: "Exports capture the two chart panels below.",
          kpiStoredEndEyebrow: "Energy in store (end of window)",
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

  const autoPracticalCapacityMwh = useMemo(() => {
    const current = practicalCapacity?.practicalCapacityMwh ?? 0;
    if (current > 0) {
      return current;
    }
    const fallback = previousDayPracticalCapacity?.practicalCapacityMwh ?? 0;
    return fallback > 0 ? fallback : 0;
  }, [practicalCapacity, previousDayPracticalCapacity]);

  const customSimulatedCapacityMwh = useMemo(
    () => parseCapacityGwhInput(customSimulatedCapacityGwhInput),
    [customSimulatedCapacityGwhInput]
  );
  const customSimulatedCapacityInvalid =
    customSimulatedCapacityGwhInput.trim().length > 0 && customSimulatedCapacityMwh === null;
  const hasCustomSimulatedCapacity = customSimulatedCapacityMwh !== null;
  const effectivePracticalCapacityMwh = hasCustomSimulatedCapacity
    ? customSimulatedCapacityMwh
    : autoPracticalCapacityMwh;

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

  const liveMarketPriceChartData = useMemo(() => {
    if (revenueModel?.marketContext === null || revenueModel?.marketContext === undefined) {
      return [];
    }
    return [
      {
        label: language === "de" ? "Niedrig" : "Low",
        value: revenueModel.marketContext.averageLowPriceEurPerMwh,
      },
      {
        label: language === "de" ? "Mittag" : "Midday",
        value: revenueModel.marketContext.averageMiddayPriceEurPerMwh,
      },
      {
        label: language === "de" ? "Abend" : "Evening",
        value: revenueModel.marketContext.averageEveningPriceEurPerMwh,
      },
      {
        label: language === "de" ? "Hoch" : "High",
        value: revenueModel.marketContext.averageHighPriceEurPerMwh,
      },
    ];
  }, [language, revenueModel]);

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

  const visualizationResetDailyByBerlin = selectorMode === "day" ? dayModeResetAtStart : false;

  const estimatedInitialFleetSocMwh = useMemo(() => {
    if (
      selectorMode !== "day" ||
      dayModeResetAtStart ||
      fleetEnergyCapacityMwh === null ||
      fleetEnergyCapacityMwh <= 0 ||
      fleetPowerMw === null ||
      fleetPowerMw <= 0
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
    if (selectorMode !== "day" || dayModeResetAtStart || effectivePracticalCapacityMwh <= 0) {
      return 0;
    }
    if (practicalNavigateInitialMwh !== null && Number.isFinite(practicalNavigateInitialMwh)) {
      return Math.min(effectivePracticalCapacityMwh, Math.max(0, practicalNavigateInitialMwh));
    }
    return computeStitchedPracticalInitialSocMwh({
      dayBeforePreviousSlots,
      previousDaySlots,
      capacityMwh: effectivePracticalCapacityMwh,
      maxPowerMw: selectedWindowBalancedPowerMw,
    });
  }, [
    selectorMode,
    dayModeResetAtStart,
    practicalNavigateInitialMwh,
    effectivePracticalCapacityMwh,
    previousDaySlots,
    dayBeforePreviousSlots,
    selectedWindowBalancedPowerMw,
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
      maxPowerMw: selectedWindowBalancedPowerMw,
      initialSocMwh,
    });
  }, [
    flow,
    effectivePracticalCapacityMwh,
    visualizationResetDailyByBerlin,
    selectedWindowBalancedPowerMw,
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
            maxPowerMw: selectedWindowBalancedPowerMw,
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
            maxPowerMw: selectedWindowBalancedPowerMw,
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
            : observedCrossBorderMw + practicalChargeMw - practicalDischargeMw,
        observedImportMw: observedCrossBorderMw !== null ? Math.max(0, observedCrossBorderMw) : 0,
        observedExportSignedMw:
          observedCrossBorderMw !== null ? Math.min(0, observedCrossBorderMw) : 0,
        simulatedImportMw:
          observedCrossBorderMw !== null
            ? Math.max(0, observedCrossBorderMw + practicalChargeMw - practicalDischargeMw)
            : 0,
        simulatedExportSignedMw:
          observedCrossBorderMw !== null
            ? Math.min(0, observedCrossBorderMw + practicalChargeMw - practicalDischargeMw)
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
    selectedWindowBalancedPowerMw,
    fleetEnergyCapacityMwh,
    estimatedInitialFleetSocMwh,
    fleetPowerMw,
  ]);

  const gridImpactReductionPct = useMemo(() => {
    if (chartRows.length === 0 || effectivePracticalCapacityMwh <= 0) {
      return null;
    }
    let baselineAbs = 0;
    let adjustedAbs = 0;
    for (const row of chartRows) {
      baselineAbs += Math.abs(row.netBalanceMw * QUARTER_HOUR_H);
      adjustedAbs += Math.abs(row.netAfterPracticalBessMw * QUARTER_HOUR_H);
    }
    if (baselineAbs <= 0) {
      return null;
    }
    const reduction = Math.max(0, 1 - adjustedAbs / baselineAbs);
    return Math.min(100, Math.max(0, reduction * 100));
  }, [chartRows, effectivePracticalCapacityMwh]);

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
      return 8;
    }
    if (selectorMode === "month") return 12;
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
        : monthLabelFormatter.format(new Date(`${selectedMonth}-01T00:00:00.000Z`));
  const insightScopeLabel = formatInsightScopeLabel({
    language,
    selectorMode,
    selectedDate,
    selectedWeek,
    selectedMonth,
  });
  const nextDisabled =
    selectorMode === "day"
      ? selectedDate >= todayKey
      : selectorMode === "week"
        ? selectedWeek >= currentWeekKey
        : selectedMonth >= currentMonthKey;

  const simulatedCapacityGwhLabel =
    effectivePracticalCapacityMwh > 0
      ? `${energyFormatter.format(effectivePracticalCapacityMwh / 1_000)} GWh`
      : null;
  const autoSimulatedCapacityGwhLabel =
    autoPracticalCapacityMwh > 0
      ? `${energyFormatter.format(autoPracticalCapacityMwh / 1_000)} GWh`
      : null;
  const autoSimulatedCapacityInputPlaceholder =
    autoPracticalCapacityMwh > 0
      ? energyFormatter.format(autoPracticalCapacityMwh / 1_000)
      : undefined;
  const simulatedCapacityBadgeText = simulatedCapacityGwhLabel
    ? t.simulatedCapacityBadgeLabel(simulatedCapacityGwhLabel)
    : t.capacityBadgeUnavailable;

  const coverageSummaryLine = t.coverage(flow.samplePoints, coveragePct, flow.dateBerlin, isMultiDayFlow);

  const resolvedLlmInsightText = String(simulationAiInsight ?? "").trim();
  const heuristicInsightParagraph = deriveGermanyFlowRuleBasedInsightText({
    language,
    modeSimulated: true,
    scopeLabel: insightScopeLabel,
    conservativeRecommendedMwh:
      selectedWindowRecommendation?.conservative?.recommendedEnergyMwh ?? null,
    absorption,
    fleetSizingAvailable: showMissedKpis,
    recommendedCoverageSim: recommendedCoverage,
    gridImpactReductionPct,
    borderTradeTotals,
    curtailmentStatus: flow?.curtailmentStatus ?? "unavailable_upstream",
  });
  const insightPanelTitle =
    resolvedLlmInsightText.length > 0 ? t.aiInsightTitle : t.insightRuleBasedTitle;
  const insightPanelBody =
    resolvedLlmInsightText || heuristicInsightParagraph || t.aiInsightPlaceholder;
  const balancedRecommendation = recommendationByTier?.balanced ?? null;
  const trailingPaybackLabel =
    recommendation?.indicativeEconomicsAtBalancedTier
      ? language === "de"
        ? `${pctFormatter.format(recommendation.indicativeEconomicsAtBalancedTier.paybackYears)} J`
        : `${pctFormatter.format(recommendation.indicativeEconomicsAtBalancedTier.paybackYears)} yr`
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
          maxPowerMw: selectedWindowBalancedPowerMw,
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

  const scalingScenarioColumns =
    flow?.slots.length &&
    fleetEnergyCapacityMwh !== null &&
    fleetEnergyCapacityMwh > 0 &&
    fleetPowerMw !== null &&
    fleetPowerMw > 0
      ? [
          { label: language === "de" ? "Aktuelle Flotte" : "Current fleet", multiplier: 1 },
          { label: "+30%", multiplier: 1.3 },
          { label: "+50%", multiplier: 1.5 },
          { label: "+100%", multiplier: 2 },
        ].map((entry) => {
          const initialSocRatio =
            fleetEnergyCapacityMwh > 0 ? estimatedInitialFleetSocMwh / fleetEnergyCapacityMwh : 0;
          const capacityMwh = fleetEnergyCapacityMwh * entry.multiplier;
          const powerMw = fleetPowerMw * entry.multiplier;
          return {
            ...entry,
            scenario: evaluateBessScenario({
              slots: flow.slots,
              capacityMwh,
              maxPowerMw: powerMw,
              initialSocMwh: capacityMwh * initialSocRatio,
              resetDailyByBerlin: visualizationResetDailyByBerlin,
              marketReference,
            }),
          };
        })
      : [];

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
            ? "Leerlauf"
            : "Idle"
          : language === "de"
            ? "k. A."
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
    const activeNetDataKey = isSimulated ? "netAfterPracticalBessMw" : "netBalanceMw";
    const activeSocLegend = isSimulated ? t.legendPracticalSoc : t.legendFleetSoc;
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
                      : t.simulatedCapacityModeAuto}
                  </span>
                  {selectedWindowBalancedPowerMw !== null ? (
                    <span className="inline-flex items-center rounded-full border border-slate-200/85 bg-white/90 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/55 dark:bg-slate-950/70 dark:text-slate-200">
                      {t.simulatedCapacityPowerBadge(formatPowerFromMw(selectedWindowBalancedPowerMw))}
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
                ? "flex max-w-full flex-nowrap items-center gap-x-3 gap-y-0 overflow-x-auto overscroll-x-contain pb-1 [-ms-overflow-style:none] [scrollbar-width:none] lg:max-w-none lg:flex-wrap lg:justify-end lg:gap-y-2 lg:overflow-visible lg:pb-0 [&::-webkit-scrollbar]:hidden"
                : "flex flex-wrap items-center gap-2 sm:gap-x-4 sm:gap-y-2 lg:justify-end"
            }
          >
            <LegendDot color={netLineColor} label={activeNetLegend} />
            <LegendDot
              color={isSimulated ? SIM_CHART_SOC_STROKE : "rgb(129,119,239)"}
              label={activeSocLegend}
            />
            <LegendDot
              color={SIM_CHART_CHARGE_FILL}
              label={isSimulated ? t.legendPracticalCharge : t.legendEstimatedCharge}
            />
            <LegendDot
              color={SIM_CHART_DISCHARGE_FILL}
              label={isSimulated ? t.legendPracticalDischarge : t.legendEstimatedDischarge}
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
            <LegendDot color="rgba(251,191,36,0.95)" label={t.legendEvening} />
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
    setSelectedMonth((current) => shiftMonthKey(current, -1));
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
    setSelectedMonth((current) => {
      const next = shiftMonthKey(current, 1);
      return next > currentMonthKey ? currentMonthKey : next;
    });
  };

  const renderDualFlowChartsBlock = () => (
    <div className="space-y-2 pt-2 md:pt-4">
      <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
        {t.onePagerChartsIntro}
      </p>
      <div
        id="bessforge-germany-flow-capture"
        className="mt-3 space-y-4 rounded-[28px] border border-slate-200/90 bg-gradient-to-b from-white via-slate-50/98 to-white p-4 shadow-[0_24px_56px_-30px_rgb(15_23_42_/_0.26)] md:p-5 dark:border-slate-600/45 dark:from-[#0d121f] dark:via-slate-950 dark:to-[#0a1622] dark:shadow-[0_28px_64px_-28px_rgb(0_0_0_/_0.72)]"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-border/70 bg-background/55 px-3 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-200">
            {simulatedCapacityBadgeText}
          </span>
          {selectedWindowBalancedPowerMw !== null ? (
            <span className="inline-flex items-center rounded-full border border-border/70 bg-background/55 px-3 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-200">
              {t.simulatedCapacityPowerBadge(formatPowerFromMw(selectedWindowBalancedPowerMw))}
            </span>
          ) : null}
        </div>
        <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
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
    </div>
  );

  const renderDashboard = () => (
    <>
      <div className="min-w-0 space-y-6">
        <div className="rounded-[30px] border border-border/75 bg-card/70 p-5 shadow-[0_22px_52px_-30px_rgba(15,23,42,0.4)] backdrop-blur-xl md:p-6 lg:p-7 dark:border-white/[0.06] dark:bg-[rgba(10,16,28,0.76)] dark:shadow-[0_28px_64px_-30px_rgba(0,0,0,0.78)]">
          <div className="flex flex-col gap-4 border-b border-border/55 pb-5 dark:border-slate-600/35">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <p className="text-[10px] font-semibold tracking-[0.22em] text-slate-500 uppercase dark:text-slate-400">
                  {language === "de" ? "Analyst Workspace" : "Analyst workspace"}
                </p>
                <div className="space-y-1">
                  <h2 className="text-2xl font-semibold leading-tight tracking-tight text-slate-950 md:text-3xl dark:text-white [font-family:var(--font-heading)]">
                    {t.profileTitle}
                  </h2>
                  <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                    {t.profileSubtitle}
                  </p>
                </div>
              </div>
              <div className="flex w-full flex-col gap-3 lg:max-w-xl">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/55 px-3 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-200">
                    <CalendarDays className="size-3.5" aria-hidden />
                    {selectorLabel}
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/55 px-3 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-200">
                    {coveragePct}% {language === "de" ? "Abdeckung" : "coverage"}
                  </span>
                  {lastUpdatedIso ? (
                    <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/55 px-3 py-1 text-[11px] font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-200">
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
                <div className="rounded-2xl border border-border/70 bg-background/45 p-3 dark:border-slate-600/40 dark:bg-slate-950/25">
                  <div
                    className="inline-flex min-h-8 w-full overflow-x-auto rounded-full border border-slate-200/90 bg-slate-100/95 p-0.5 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] [-ms-overflow-style:none] [scrollbar-width:none] dark:border-slate-600/55 dark:bg-slate-900/80 dark:shadow-[inset_0_2px_6px_rgba(0,0,0,0.35)] [&::-webkit-scrollbar]:hidden"
                    role="tablist"
                    aria-label={t.timeframeLabelShort}
                  >
                    {(
                      [
                        { mode: "day", label: t.dayMode },
                        { mode: "week", label: t.weekMode },
                        { mode: "month", label: t.monthMode },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.mode}
                        type="button"
                        role="tab"
                        aria-selected={selectorMode === option.mode}
                        onClick={() => setSelectorMode(option.mode)}
                        className={`min-h-8 flex-1 rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-tight transition ${
                          selectorMode === option.mode
                            ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/90 dark:bg-slate-950 dark:text-white dark:ring-slate-600/70"
                            : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 inline-flex w-full items-center gap-1 rounded-2xl border border-slate-200/90 bg-white/95 p-1 shadow-sm dark:border-slate-600/60 dark:bg-slate-950/95">
                    <button
                      type="button"
                      onClick={handlePreviousWindow}
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-transparent text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                      aria-label={t.previousRange}
                    >
                      <ChevronLeft className="size-4" aria-hidden />
                    </button>
                    {selectorMode === "day" ? (
                      <BerlinDayCalendarButton
                        value={selectedDate}
                        max={todayKey}
                        onChange={setSelectedDate}
                        language={language}
                        className="min-w-0 flex-1 border-0 bg-transparent shadow-none dark:bg-transparent"
                      />
                    ) : null}
                    {selectorMode === "week" ? (
                      <input
                        type="week"
                        value={selectedWeek}
                        max={currentWeekKey}
                        onChange={(event) => setSelectedWeek(event.target.value)}
                        className="h-9 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-2 text-center text-xs font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/35 dark:text-slate-100"
                      />
                    ) : null}
                    {selectorMode === "month" ? (
                      <input
                        type="month"
                        value={selectedMonth}
                        max={currentMonthKey}
                        onChange={(event) => setSelectedMonth(event.target.value)}
                        className="h-9 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-2 text-center text-xs font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/35 dark:text-slate-100"
                      />
                    ) : null}
                    <button
                      type="button"
                      disabled={nextDisabled}
                      onClick={handleNextWindow}
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-transparent text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-35 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                      aria-label={t.nextRange}
                    >
                      <ChevronRight className="size-4" aria-hidden />
                    </button>
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                    {coverageSummaryLine}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/45 p-3 dark:border-slate-600/40 dark:bg-slate-950/25">
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className="size-4 text-emerald-600 dark:text-emerald-300" aria-hidden />
                    <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
                      {t.simulatedCapacityControlEyebrow}
                    </p>
                  </div>
                  <label htmlFor={simulatedCapacityInputId} className="mt-3 block space-y-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-700 dark:text-slate-200">
                      {t.simulatedCapacityInputLabel}
                    </span>
                    <input
                      id={simulatedCapacityInputId}
                      ref={simulatedCapacityInputRef}
                      type="text"
                      inputMode="decimal"
                      value={customSimulatedCapacityGwhInput}
                      onChange={(event) => setCustomSimulatedCapacityGwhInput(event.target.value)}
                      placeholder={autoSimulatedCapacityInputPlaceholder}
                      aria-describedby={simulatedCapacityHintId}
                      aria-invalid={customSimulatedCapacityInvalid}
                      className={`h-11 w-full rounded-xl border bg-white px-3 text-sm font-semibold tabular-nums text-slate-900 outline-none transition placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-emerald-400/70 dark:bg-slate-950/75 dark:text-white dark:placeholder:text-slate-500 ${
                        customSimulatedCapacityInvalid
                          ? "border-rose-300/90 focus-visible:border-rose-300 dark:border-rose-400/45"
                          : "border-emerald-300/80 dark:border-emerald-400/30"
                      }`}
                    />
                  </label>
                  <p id={simulatedCapacityHintId} className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    {hasCustomSimulatedCapacity
                      ? language === "de"
                        ? `Manuelle Schicht aktiv. Automatik: ${autoSimulatedCapacityGwhLabel ?? "—"}.`
                        : `Manual layer active. Auto size: ${autoSimulatedCapacityGwhLabel ?? "—"}.`
                      : autoSimulatedCapacityGwhLabel
                        ? language === "de"
                          ? `Automatik aktiv: ${autoSimulatedCapacityGwhLabel}.`
                          : `Auto sizing active: ${autoSimulatedCapacityGwhLabel}.`
                        : t.simulatedCapacityInputHintUnavailable}
                    {selectedWindowBalancedPowerMw !== null ? (
                      <>
                        {" "}
                        {language === "de"
                          ? `Leistung: ${formatPowerFromMw(selectedWindowBalancedPowerMw)}.`
                          : `Power cap: ${formatPowerFromMw(selectedWindowBalancedPowerMw)}.`}
                      </>
                    ) : null}
                  </p>
                  {customSimulatedCapacityInvalid ? (
                    <p className="mt-2 text-xs font-medium text-rose-700 dark:text-rose-200">
                      {t.simulatedCapacityInputInvalid}
                    </p>
                  ) : null}
                  {hasCustomSimulatedCapacity ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => setCustomSimulatedCapacityGwhInput("")}
                    >
                      {t.simulatedCapacityReset}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-8 pt-6">
            <div className="space-y-2">
              <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
                {t.onePagerStructuralEyebrow}
              </p>
              <p className="max-w-3xl text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {t.onePagerStructuralLead}
              </p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <SectionKpiTile
                  eyebrow={language === "de" ? "Nettobilanz" : "Net balance"}
                  value={formatSignedEnergyFromMwh(windowNetStructuralBalanceGwh * 1_000)}
                  subtitle={language === "de" ? "Σ Erzeugung − Last" : "Σ generation − load"}
                  tone="sky"
                />
                <SectionKpiTile
                  eyebrow={language === "de" ? "Struktureller Ueberschuss" : "Structural surplus"}
                  value={formatEnergyFromMwh(grossStructuralSurplusMwh)}
                  subtitle={language === "de" ? "Brutto in Plus-Slots" : "Gross energy in positive slots"}
                  tone="emerald"
                />
                <SectionKpiTile
                  eyebrow={t.onePagerStructuralDeficitEyebrow}
                  value={formatEnergyFromMwh(grossStructuralDeficitMwh)}
                  subtitle={t.onePagerStructuralDeficitSubtitle}
                  tone="amber"
                />
                <SectionKpiTile
                  eyebrow={t.kpiObservedImportsEyebrow}
                  value={
                    borderTradeTotals !== null
                      ? formatEnergyFromMwh(borderTradeTotals.observedImportEnergyMwh)
                      : "—"
                  }
                  subtitle={
                    borderTradeTotals !== null
                      ? language === "de"
                        ? "Grenzhandel im Fenster"
                        : "Border trade in window"
                      : language === "de"
                        ? "Keine Grenzdaten"
                        : "No border data"
                  }
                  tone="amber"
                />
                <SectionKpiTile
                  eyebrow={t.kpiObservedExportsEyebrow}
                  value={
                    borderTradeTotals !== null
                      ? formatEnergyFromMwh(borderTradeTotals.observedExportEnergyMwh)
                      : "—"
                  }
                  subtitle={
                    borderTradeTotals !== null
                      ? language === "de"
                        ? "Exportrichtung positiv"
                        : "Export direction positive"
                      : language === "de"
                        ? "Keine Grenzdaten"
                        : "No border data"
                  }
                  tone="slate"
                />
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
                {t.onePagerInstalledFleetEyebrow}
              </p>
              <p className="max-w-3xl text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {t.onePagerInstalledFleetLead}
              </p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <SectionKpiTile
                  eyebrow={language === "de" ? "Flotten-SoC" : "Fleet SoC"}
                  value={currentFleetSocStatusValue}
                  subtitle={language === "de" ? "Schaetzung aus Chart" : "Estimate from chart"}
                  tone="violet"
                />
                <SectionKpiTile
                  eyebrow={t.kpiInstalledFleetAbsorbedEyebrow}
                  value={
                    currentFleetScenario !== null
                      ? `${formatEnergyFromMwh(currentFleetScenario.coverage.absorbedSurplusEnergyMwh)} · ${pctFormatter.format(
                          currentFleetScenario.coverage.absorbedSurplusShare * 100
                        )}%`
                      : "—"
                  }
                  subtitle={
                    currentFleetScenario !== null
                      ? t.kpiInstalledFleetAbsorbedSubtitle
                      : t.kpiFleetRequiredShort
                  }
                  tone="emerald"
                />
                <SectionKpiTile
                  eyebrow={language === "de" ? "Defizit gedeckt (Flotte)" : "Deficit served (fleet)"}
                  value={
                    currentFleetScenario !== null
                      ? `${formatEnergyFromMwh(currentFleetScenario.coverage.servedDeficitEnergyMwh)} · ${
                          currentFleetScenario.coverage.totalDeficitEnergyMwh > 1e-9
                            ? `${pctFormatter.format(currentFleetScenario.coverage.servedDeficitShare * 100)}%`
                            : "0%"
                        }`
                      : "—"
                  }
                  subtitle={language === "de" ? "Installierte Schicht" : "Installed layer"}
                  tone="sky"
                />
              </div>
            </div>
          </div>

          {renderDualFlowChartsBlock()}

          {briefingStoryWindow ? (
            <BriefingDailyStory language={language} storyWindow={briefingStoryWindow} refreshNonce={briefingStoryRefreshNonce}>
              {({ introSection, counterfactualSection, footerSection }) => (
                <div className="space-y-6 pt-4 md:pt-6">
                  {introSection}

                  <div className="space-y-3">
                    <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
                      {t.onePagerImpactHeading}
                    </p>
                    <p className="max-w-3xl text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                      {t.onePagerImpactLead}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <SectionKpiTile
                        eyebrow={language === "de" ? "Ladechance genutzt (Modell)" : "Charge opportunity captured"}
                        value={
                          modeledScenario !== null
                            ? `${pctFormatter.format(modeledScenario.coverage.absorbedSurplusShare * 100)}%`
                            : "—"
                        }
                        subtitle={
                          modeledScenario !== null
                            ? formatEnergyFromMwh(modeledScenario.coverage.absorbedSurplusEnergyMwh)
                            : language === "de"
                              ? "Kapazitaet-Slider + Leistungslimit"
                              : "Capacity slider + power cap"
                        }
                        tone="emerald"
                      />
                      <SectionKpiTile
                        eyebrow={language === "de" ? "Verpasste Ladechance" : "Missed charge opportunity"}
                        value={formatEnergyFromMwh(
                          Math.max(
                            0,
                            (modeledScenario?.coverage.totalChargeOpportunityEnergyMwh ?? 0) -
                              (modeledScenario?.coverage.absorbedSurplusEnergyMwh ?? 0)
                          )
                        )}
                        subtitle={formatCurrencyCompact(modeledScenario?.missedOpportunityEur ?? null)}
                        tone="amber"
                      />
                      <SectionKpiTile
                        eyebrow={language === "de" ? "Defizit gedeckt (Modell)" : "Deficit served (modeled)"}
                        value={
                          modeledScenario !== null
                            ? `${formatEnergyFromMwh(modeledScenario.coverage.servedDeficitEnergyMwh)} · ${
                                modeledScenario.coverage.totalDeficitEnergyMwh > 1e-9
                                  ? `${pctFormatter.format(modeledScenario.coverage.servedDeficitShare * 100)}%`
                                  : "0%"
                              }`
                            : "—"
                        }
                        subtitle={t.kpiDeficitCoveredSubtitle}
                        tone="violet"
                      />
                      <SectionKpiTile
                        eyebrow={language === "de" ? "Netzentlastung (Modell)" : "Grid stress relief"}
                        value={
                          modeledScenario?.gridImpactReductionPct !== null &&
                          modeledScenario?.gridImpactReductionPct !== undefined
                            ? `${pctFormatter.format(modeledScenario.gridImpactReductionPct)}%`
                            : "—"
                        }
                        subtitle={language === "de" ? "Σ|Netto| vs Rohspur" : "Σ|net| vs raw trace"}
                        tone="sky"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                      <SectionKpiTile
                        eyebrow={language === "de" ? "Peak-Shaving" : "Peak shaving"}
                        value={modeledScenario !== null ? formatPowerFromMw(modeledScenario.peakReductionMw) : "—"}
                        subtitle={language === "de" ? "Max. Slot-Reduktion" : "Max slot reduction"}
                        tone="violet"
                      />
                      <SectionKpiTile
                        eyebrow={language === "de" ? "Import-Aenderung" : "Import change"}
                        value={
                          borderTradeTotals !== null
                            ? formatSignedEnergyFromMwh(borderTradeTotals.importDeltaEnergyMwh)
                            : "—"
                        }
                        subtitle={language === "de" ? "Modell 1:1 Grenzfluss" : "Modeled 1:1 border proxy"}
                        tone="amber"
                      />
                      <SectionKpiTile
                        eyebrow={language === "de" ? "Export-Aenderung" : "Export change"}
                        value={
                          borderTradeTotals !== null
                            ? formatSignedEnergyFromMwh(borderTradeTotals.exportDeltaEnergyMwh)
                            : "—"
                        }
                        subtitle={language === "de" ? "vs. beobachtet" : "vs observed"}
                        tone="slate"
                      />
                      <SectionKpiTile
                        eyebrow={t.kpiStoredEndEyebrow}
                        value={storedPracticalEndMwh !== null ? formatEnergyFromMwh(storedPracticalEndMwh) : "—"}
                        subtitle={
                          simulatedCapacityGwhLabel
                            ? language === "de"
                              ? `Bei ${simulatedCapacityGwhLabel}`
                              : `At ${simulatedCapacityGwhLabel}`
                            : undefined
                        }
                        tone="emerald"
                      />
                      <SectionKpiTile
                        eyebrow={language === "de" ? "Wert heute (indik.)" : "Value today (indic.)"}
                        value={formatCurrencyCompact(modeledScenario?.totalValueCreatedEur ?? null)}
                        subtitle={
                          language === "de" ? "Shift + Curtailment + Redispatch" : "Shift + curtailment + redispatch"
                        }
                        tone="emerald"
                      />
                    </div>
                    <div className="rounded-2xl border border-indigo-200/60 bg-card px-4 py-4 shadow-sm dark:border-indigo-500/35 dark:bg-indigo-950/35">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex h-2 w-2 shrink-0 rounded-full bg-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.65)]"
                          aria-hidden
                        />
                        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-800 dark:text-indigo-200">
                          {insightPanelTitle}
                        </p>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-slate-800 dark:text-slate-100">
                        {insightPanelBody}
                      </p>
                    </div>
                  </div>

                  {counterfactualSection}
                  {footerSection}
                </div>
              )}
            </BriefingDailyStory>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-border/50 pt-6 dark:border-slate-600/35">
            <FlowExportButtons language={language} flow={flow} captureElementId="bessforge-germany-flow-capture" />
            <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t.onePagerExportHint}</p>
          </div>

          <details className="group rounded-2xl border border-border/70 bg-background/40 p-4 dark:border-slate-600/40 dark:bg-slate-950/30">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-left">
              <div>
                <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
                  {t.onePagerDetailsSummary}
                </p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  {language === "de"
                    ? "12-Monats-Empfehlung, Marginal-Szenarien und Marktpreis-Snapshot."
                    : "12‑month recommendation, marginal fleet scenarios, and the live price snapshot."}
                </p>
              </div>
              <ChevronRight className="size-5 shrink-0 text-slate-400 transition group-open:rotate-90" aria-hidden />
            </summary>
            <div className="mt-4 border-t border-border/50 pt-4 dark:border-slate-600/35">

                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, ease: "easeOut" }}
                  className="space-y-5"
                >
                  <section
                    className="space-y-5 rounded-[28px] border border-border/75 bg-background/35 p-5 dark:border-slate-600/40 dark:bg-slate-950/25 md:space-y-6"
                    aria-labelledby="trailing-bess-analysis-heading"
                  >
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                        {t.longTermEyebrow}
                      </p>
                      <h3
                        id="trailing-bess-analysis-heading"
                        className="text-xl font-semibold text-slate-900 md:text-2xl dark:text-slate-100 [font-family:var(--font-heading)]"
                      >
                        {t.longTermTitle}
                      </h3>
                      <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                        {language === "de"
                          ? "Verdichtet die 12-Monats-Heuristik auf Marktbild, empfohlene Balanced-Groesse und deren grobe Wirkung."
                          : "Condenses the 12-month heuristic into market context, the balanced recommendation, and its indicative impact."}
                      </p>
                    </div>

                    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                      {isRevenueModelLoading ? (
                        <Skeleton className="h-[25rem] w-full rounded-2xl" />
                      ) : revenueModel && revenueModel.marketContext ? (
                        <div className="rounded-2xl border border-slate-200/90 bg-white/90 p-5 shadow-sm dark:border-slate-600/50 dark:bg-slate-950/70">
                          <div className="space-y-1">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              {language === "de" ? "Live-Preissnapshot" : "Live price snapshot"}
                            </p>
                            <p className="text-sm text-slate-600 dark:text-slate-300">
                              {language === "de"
                                ? "Kompakte Marktansicht aus aktuellen SMARD-Viertelstundenpreisen plus publizierter Redispatch-Basis."
                                : "Compact market view from recent SMARD quarter-hour prices plus the published redispatch basis."}
                            </p>
                          </div>

                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <CompactDetailStat
                              label={language === "de" ? "Spread-Basis" : "Spread basis"}
                              value={`${priceFormatter.format(revenueModel.marketReference.derivedSpotSpreadEurPerMwh)} EUR/MWh`}
                              subtitle={
                                language === "de"
                                  ? `${revenueModel.marketReference.sampledDays} Tage SMARD`
                                  : `${revenueModel.marketReference.sampledDays} SMARD day(s)`
                              }
                            />
                            <CompactDetailStat
                              label={language === "de" ? "Abend-Aufschlag" : "Evening premium"}
                              value={`${priceFormatter.format(revenueModel.marketContext.eveningPeakPremiumEurPerMwh)} EUR/MWh`}
                              subtitle={language === "de" ? "Ø Abend minus Ø Mittag" : "Avg evening minus avg midday"}
                            />
                            <CompactDetailStat
                              label={language === "de" ? "Redispatch-Basis" : "Redispatch basis"}
                              value={`${priceFormatter.format(revenueModel.marketReference.positiveRedispatchCostEurPerMwh)} EUR/MWh`}
                              subtitle={
                                language === "de"
                                  ? `${formatEnergyFromMwh(revenueModel.marketReference.averageDailyCurtailmentOpportunityMwh)} pro Tag`
                                  : `${formatEnergyFromMwh(revenueModel.marketReference.averageDailyCurtailmentOpportunityMwh)} per day`
                              }
                            />
                            <CompactDetailStat
                              label={language === "de" ? "12M Balanced · Erlös" : "12M balanced revenue"}
                              value={
                                balancedRevenueTileValue !== null
                                  ? euroCurrencyFormatter.format(Math.round(balancedRevenueTileValue))
                                  : "—"
                              }
                              subtitle={
                                liveBalancedEconomics
                                  ? language === "de"
                                    ? "Mit Live-Preisreferenz"
                                    : "Using the live price reference"
                                  : language === "de"
                                    ? "Fallback auf 12M-Heuristik"
                                    : "Fallback to the 12M heuristic"
                              }
                            />
                          </div>

                          <div className="mt-4 h-44 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <ComposedChart data={liveMarketPriceChartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                                <CartesianGrid stroke="rgba(148,163,184,0.18)" strokeDasharray="3 3" />
                                <XAxis
                                  dataKey="label"
                                  tick={{ fontSize: 11, fill: "rgb(100,116,139)" }}
                                  axisLine={{ stroke: "rgba(148,163,184,0.35)" }}
                                  tickLine={false}
                                />
                                <YAxis
                                  tick={{ fontSize: 11, fill: "rgb(100,116,139)" }}
                                  tickFormatter={(value) =>
                                    `${priceFormatter.format(typeof value === "number" ? value : 0)}`
                                  }
                                  width={56}
                                />
                                <Tooltip
                                  formatter={(value) => [
                                    `${priceFormatter.format(typeof value === "number" ? value : Number(value ?? 0))} EUR/MWh`,
                                    language === "de" ? "Preis" : "Price",
                                  ]}
                                  contentStyle={{
                                    background: "rgba(255,255,255,0.97)",
                                    border: "1px solid rgba(148,163,184,0.45)",
                                    borderRadius: 12,
                                    fontSize: 12,
                                  }}
                                />
                                <Bar dataKey="value" fill="#3b82f6" radius={[8, 8, 0, 0]} maxBarSize={42} />
                              </ComposedChart>
                            </ResponsiveContainer>
                          </div>

                          <p className="mt-3 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                            {language === "de"
                              ? "Preisprofil: niedrig / Mittag / Abend / hoch. Negative Preisanteile zuletzt "
                              : "Price profile: low / midday / evening / high. Recent negative-price share "}
                            <span className="font-medium text-slate-700 dark:text-slate-200">
                              {pctFormatter.format(revenueModel.marketContext.negativePriceSharePct)}%
                            </span>
                            . {revenueModel.marketReference.redispatchSourceLabel}.
                          </p>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-dashed border-slate-300/70 bg-white/60 p-5 text-sm text-slate-500 dark:border-slate-600/45 dark:bg-slate-950/35 dark:text-slate-400">
                          {revenueModelLoadError
                            ? language === "de"
                              ? "Live-Preissnapshot aktuell nicht verfuegbar."
                              : "Live price snapshot is unavailable right now."
                            : language === "de"
                              ? "Live-Preissnapshot derzeit ohne Daten."
                              : "Live price snapshot currently has no data."}
                        </div>
                      )}

                      {isRecommendationLoading ? (
                        <Skeleton className="h-[25rem] w-full rounded-2xl" />
                      ) : recommendationLoadError || !recommendation || !balancedRecommendation ? (
                        <div className="rounded-2xl border border-dashed border-slate-300/70 bg-white/60 p-5 text-sm text-slate-500 dark:border-slate-600/45 dark:bg-slate-950/35 dark:text-slate-400">
                          {t.kpiRecommendationUnavailable}
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-emerald-200/75 bg-gradient-to-br from-emerald-50/80 via-white to-sky-50/35 p-5 shadow-sm dark:border-emerald-500/28 dark:from-emerald-500/10 dark:via-slate-950/70 dark:to-slate-950/85">
                          <div className="space-y-1">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-200">
                              {language === "de" ? "Balanced-Empfehlung" : "Balanced recommendation"}
                            </p>
                            <h4 className="text-lg font-semibold text-slate-900 dark:text-white md:text-xl">
                              {language === "de"
                                ? "Empfohlene BESS-Groesse fuer die letzten 12 Monate"
                                : "Recommended BESS size across the last 12 months"}
                            </h4>
                          </div>

                          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1fr)]">
                            <div className="rounded-2xl border border-emerald-200/75 bg-white/80 px-4 py-4 shadow-sm dark:border-emerald-400/30 dark:bg-slate-950/55">
                              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                                {t.trailingKpiCapacity}
                              </p>
                              <p className="mt-2 text-4xl font-black leading-none tabular-nums text-slate-950 dark:text-white md:text-[3.35rem]">
                                {formatEnergyFromMwh(balancedRecommendation.recommendedEnergyMwh)}
                              </p>
                              <p className="mt-2 text-base font-semibold text-slate-700 dark:text-slate-200">
                                {formatPowerFromMw(balancedRecommendation.recommendedPowerMw)}
                              </p>
                              <p className="mt-3 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                                {t.trailingKpiDailyPercentileCaption}
                              </p>
                            </div>

                            <div className="grid gap-3 sm:grid-cols-2">
                              <CompactDetailStat label={t.trailingKpiPayback} value={trailingPaybackLabel} />
                              <CompactDetailStat label={t.trailingKpiImpact} value={trailingImpactLabel} />
                              <CompactDetailStat label={t.trailingChainPeakLabel} value={trailingChainPeakValue} />
                              <CompactDetailStat
                                label={language === "de" ? "Beobachtungsfenster" : "Observed window"}
                                value={trailingWindowLabel}
                              />
                            </div>
                          </div>

                          <div className="mt-4 space-y-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                            <p>{t.trailingBulletTier}</p>
                            <p>
                              {language === "de"
                                ? "Kann stark von „Tages-Energie“ abweichen — hier läuft dieselbe Bilanz ohne Mitternachts-Reset weiter."
                                : "Can diverge materially from the daily-energy row—the same heuristic here without nightly SOC resets."}
                            </p>
                            <p className="text-slate-400 dark:text-slate-500">
                              {language === "de"
                                ? "Ökonomie und Deckungsgrade mit idealisierten Annahmen; Marktpreise und Verluste ausgeschlossen."
                                : "Economics/coverage uses idealised assumptions; excludes market spreads and losses."}{" "}
                              {t.trailingNotAuditedNote}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="rounded-[28px] border border-border/75 bg-background/35 p-5 dark:border-slate-600/40 dark:bg-slate-950/25">
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                        {language === "de" ? "Marginal Impact of More Capacity" : "Marginal Impact of More Capacity"}
                      </p>
                      <h4 className="text-lg font-semibold text-slate-900 dark:text-white md:text-xl">
                        {language === "de"
                          ? "Wie mehr DE-BESS den Tageseffekt verschiebt"
                          : "How more German BESS shifts the daily effect"}
                      </h4>
                      <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                        {language === "de"
                          ? "Alle Szenarien skalieren Energie und Leistung der aktuellen Flotte gemeinsam."
                          : "All scenarios scale current fleet energy and power together."}
                      </p>
                    </div>

                    {scalingScenarioColumns.length > 0 ? (
                      <div className="mt-4 overflow-x-auto">
                        <table className="min-w-full border-separate border-spacing-0 text-sm">
                          <thead>
                            <tr>
                              <th className="sticky left-0 z-10 rounded-l-2xl border border-border/70 bg-background/95 px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:border-slate-600/40 dark:bg-slate-950/95 dark:text-slate-400">
                                {language === "de" ? "Metric" : "Metric"}
                              </th>
                              {scalingScenarioColumns.map((column, index) => (
                                <th
                                  key={column.label}
                                  className={`border border-border/70 bg-background/95 px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:border-slate-600/40 dark:bg-slate-950/95 dark:text-slate-400 ${index === scalingScenarioColumns.length - 1 ? "rounded-r-2xl" : ""}`}
                                >
                                  {column.label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              {
                                label: language === "de" ? "Absorbed Energy" : "Absorbed Energy",
                                render: (scenario: ScenarioImpactSnapshot) =>
                                  formatEnergyFromMwh(scenario.coverage.absorbedSurplusEnergyMwh),
                              },
                              {
                                label: language === "de" ? "Curtailment Avoided" : "Curtailment Avoided",
                                render: (scenario: ScenarioImpactSnapshot) =>
                                  formatEnergyFromMwh(scenario.absorbedCurtailmentEnergyMwh),
                              },
                              {
                                label: language === "de" ? "Revenue" : "Revenue",
                                render: (scenario: ScenarioImpactSnapshot) =>
                                  formatCurrencyCompact(
                                    (scenario.bessRevenueTodayEur ?? 0) +
                                      (scenario.avoidedCurtailmentValueEur ?? 0)
                                  ),
                              },
                              {
                                label: language === "de" ? "Avoided Costs" : "Avoided Costs",
                                render: (scenario: ScenarioImpactSnapshot) =>
                                  formatCurrencyCompact(scenario.avoidedRedispatchCostsEur),
                              },
                              {
                                label: language === "de" ? "Grid Relief" : "Grid Relief",
                                render: (scenario: ScenarioImpactSnapshot) =>
                                  scenario.gridReliefScore !== null ? `${scenario.gridReliefScore}/100` : "—",
                              },
                            ].map((row, rowIndex, rows) => (
                              <tr key={row.label}>
                                <th
                                  className={`sticky left-0 z-[1] border border-border/70 bg-background/95 px-4 py-3 text-left font-medium text-slate-700 dark:border-slate-600/40 dark:bg-slate-950/95 dark:text-slate-200 ${rowIndex === rows.length - 1 ? "rounded-bl-2xl" : ""}`}
                                >
                                  {row.label}
                                </th>
                                {scalingScenarioColumns.map((column, columnIndex) => (
                                  <td
                                    key={`${row.label}-${column.label}`}
                                    className={`border border-border/70 bg-background/60 px-4 py-3 text-slate-900 dark:border-slate-600/40 dark:bg-slate-950/35 dark:text-slate-100 ${rowIndex === rows.length - 1 && columnIndex === scalingScenarioColumns.length - 1 ? "rounded-br-2xl" : ""}`}
                                  >
                                    {row.render(column.scenario)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl border border-dashed border-slate-300/70 bg-white/60 p-5 text-sm text-slate-500 dark:border-slate-600/45 dark:bg-slate-950/35 dark:text-slate-400">
                        {language === "de"
                          ? "Skalierungstabelle derzeit nicht berechenbar."
                          : "Scaling table is not computable right now."}
                      </div>
                    )}
                  </section>

                </motion.div>
              
            </div>
          </details>

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

  return (
    <article id="germany-day-energy-flow" className="scroll-mt-24">
      {renderDashboard()}
    </article>
  );
}
