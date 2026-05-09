"use client";

import { Info } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  simulateAdjustedNetMwAtCapacity,
  simulatePracticalDispatchAtCapacity,
} from "@/lib/optimalBessCapacity";
import {
  inferFleetModeFromChartTail,
  type ChartFleetSocSnapshot,
  type ChartRowTailForFleetMode,
} from "@/lib/chartFleetSocSnapshot";
import { BerlinDayCalendarButton } from "@/components/briefing/BerlinDayCalendarButton";
import { FlowExportButtons } from "@/components/briefing/FlowExportButtons";

const log = createLogger("germany-day-energy-flow");

const EVENING_HOUR_START = 17;
const EVENING_HOUR_END = 21;
const QUARTER_HOUR_H = 0.25;

/** Simulated chart palette: strong SoC stroke + lighter charge bars only (discharge stays orange). */
const SIM_CHART_SOC_STROKE = "#22C173";
const SIM_CHART_CHARGE_FILL = "#34D399";

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

const germanyDispatchSlotSchema = z.object({
  timestampIso: z.string(),
  hourBerlin: z.number(),
  residualLoadMw: z.number(),
  loadMw: z.number(),
  totalGenerationMw: z.number(),
  renewableGenerationMw: z.number().nullable(),
});

const germanyEnergyFlowApiSchema = z.object({
  dateBerlin: z.string(),
  samplePoints: z.number(),
  pointFractionOfDay: z.number(),
  source: z.literal("energy-charts.total_power"),
  slots: z.array(germanyDispatchSlotSchema),
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

type SelectorMode = "day" | "week" | "month";
type BessRecommendation = z.infer<typeof bessRecommendationApiSchema>;

const monthLabelFormatter = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  month: "long",
  year: "numeric",
});

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
  inferredFleetSocPct: number;
  estimatedFleetSocPct: number;
  simulatedPracticalSocPct: number;
  practicalChargeSignedMw: number;
  practicalChargeMw: number;
  practicalDischargeMw: number;
};

export type GermanyDayEnergyFlowProps = {
  fleetCapacityGwh?: number | null;
  fleetPowerGw?: number | null;
  language: "en" | "de";
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
  /** Start in simulated-BESS view (e.g. `?sim=1` for morning export screenshots). */
  initialSimulatedNet?: boolean;
};

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
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

type AbsorptionTotals = {
  grossSurplusEnergyMwh: number;
  missedSurplusEnergyMwh: number;
};

type CoverageTotals = Pick<
  ReturnType<typeof computeCoverageAtCapacityMwh>,
  "absorbedSurplusShare" | "servedDeficitShare" | "totalSurplusEnergyMwh" | "totalDeficitEnergyMwh"
>;

/**
 * Deterministic prose when `simulationAiInsight` prop is unset — no backend LLM wired yet from the dashboard.
 */
function deriveGermanyFlowRuleBasedInsightText(options: {
  language: "en" | "de";
  modeSimulated: boolean;
  conservativeRecommendedMwh: number | null;
  absorption: AbsorptionTotals | null;
  fleetSizingAvailable: boolean;
  recommendedCoverageSim: CoverageTotals | null;
  gridImpactReductionPct: number | null;
}): string | null {
  const {
    language,
    modeSimulated,
    conservativeRecommendedMwh,
    absorption,
    fleetSizingAvailable,
    recommendedCoverageSim,
    gridImpactReductionPct,
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
      recommendedCoverageSim.totalSurplusEnergyMwh > 1e-9 &&
      recommendedCoverageSim.totalDeficitEnergyMwh > 1e-9
    ) {
      const as = pctFormatter.format(recommendedCoverageSim.absorbedSurplusShare * 100);
      const sd = pctFormatter.format(recommendedCoverageSim.servedDeficitShare * 100);
      parts.push(
        language === "de"
          ? `Bei dieser modellierten Schicht sind ~${as} % der Brutto-Ueberschussenergie eingelagert und ~${sd} % der strukturellen Defizitenergie ausgeliefert (Idealbilanz ohne Verluste).`
          : `At this modeled size ~${as}% of gross surplus energy is stored and ~${sd}% of structural deficit energy is met from storage (lossless heuristic).`
      );
    }
    return parts.length > 0 ? parts.join(" ") : null;
  }

  if (conservativeRecommendedMwh !== null && conservativeRecommendedMwh > 0) {
    parts.push(
      language === "de"
        ? `Konservative P95-Bandbreite fuer dieses Fenster: ${formatEnergyFromMwh(conservativeRecommendedMwh)}.`
        : `Conservative P95 sizing for this window: ${formatEnergyFromMwh(conservativeRecommendedMwh)}.`
    );
  }
  if (absorption !== null) {
    parts.push(
      language === "de"
        ? `Brutto-Ueberschuss im Fenster: ${formatEnergyFromMwh(absorption.grossSurplusEnergyMwh)}.`
        : `Gross surplus in window: ${formatEnergyFromMwh(absorption.grossSurplusEnergyMwh)}.`
    );
    if (
      fleetSizingAvailable &&
      absorption.grossSurplusEnergyMwh > 1e-6 &&
      Number.isFinite(absorption.missedSurplusEnergyMwh)
    ) {
      const pct = pctFormatter.format(
        Math.min(
          100,
          Math.max(0, (absorption.missedSurplusEnergyMwh / absorption.grossSurplusEnergyMwh) * 100)
        )
      );
      parts.push(
        language === "de"
          ? `Mit der uebergebenen Flotten-Schicht bleiben ${formatEnergyFromMwh(absorption.missedSurplusEnergyMwh)} nicht aufnehmbar (~${pct} % des Brutto-Ueberschusses).`
          : `${formatEnergyFromMwh(absorption.missedSurplusEnergyMwh)} cannot be stored with the modeled fleet (~${pct}% of gross surplus).`
      );
    } else if (!fleetSizingAvailable) {
      parts.push(
        language === "de"
          ? "Installierte GW/GWh-Schicht fehlen — keine verpassten-Ueberschuss-Schaetzung."
          : "Installed GW/GWh not provided — cannot quantify missed surplus against a fleet envelope."
      );
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export default function GermanyDayEnergyFlow({
  fleetCapacityGwh,
  fleetPowerGw,
  language,
  onChartFleetSocSnapshot,
  simulationAiInsight = null,
  initialEnergyFlow = null,
  initialBerlinDateKey = null,
  seedDateKey = null,
  onBerlinDateChange,
  initialSimulatedNet = false,
}: GermanyDayEnergyFlowProps) {
  const resolvedSeedKey = resolveSeedDateKey(seedDateKey ?? undefined);
  const [selectorMode, setSelectorMode] = useState<SelectorMode>("day");
  const [selectedDate, setSelectedDate] = useState(resolvedSeedKey);
  const [selectedWeek, setSelectedWeek] = useState(dateKeyToIsoWeekKey(resolvedSeedKey));
  const [selectedMonth, setSelectedMonth] = useState(resolvedSeedKey.slice(0, 7));
  const [dayModeResetAtStart, setDayModeResetAtStart] = useState(false);
  const [showSimulatedNet, setShowSimulatedNet] = useState(initialSimulatedNet);
  const serverHydratedFirstLoad =
    initialEnergyFlow !== null &&
    initialBerlinDateKey !== null &&
    initialBerlinDateKey === resolvedSeedKey;
  const softFirstLoadRef = useRef(serverHydratedFirstLoad);

  const [flow, setFlow] = useState<GermanyDispatchSlotsResponse | null>(() =>
    serverHydratedFirstLoad ? initialEnergyFlow : null
  );
  const [recommendation, setRecommendation] = useState<BessRecommendation | null>(null);
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
  const [flowLoadError, setFlowLoadError] = useState(false);
  const [recommendationLoadError, setRecommendationLoadError] = useState(false);
  const dataCoverageTooltipId = useId();
  const [chartLayoutCompact, setChartLayoutCompact] = useState(false);

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

  const t = useMemo(
    () =>
      language === "de"
      ? {
          eyebrow: "Energy-Charts Profile",
          title: "Deutschland-Tagesprofil – beobachteter Ueberschuss, Defizit & geschaetzter Flotten-SoC",
          chartTitle: "Ueberschuss / Defizit",
          legendNet: "+Ueberschuss / −Defizit (Erz. − Last)",
          legendNetSimulated: "Netto",
          legendFleetSoc: "Geschaetzter SoC",
          legendPracticalSoc: "SoC",
          legendPracticalCharge: "Laden",
          legendPracticalDischarge: "Entladen",
          legendSimulatedPrefix: "Simuliert:",
          legendEvening: "Abendfenster",
          toggleNetSimulation: "Praktische BESS-Simulation auf Netto anwenden",
          netFootnote: "Netto = Erzeugung − Last je Slot.",
          socFootnote: "SoC: Modell ueber Reihenvolge der Viertelstunden, nicht Messwert.",
          kpiGross: "Brutto-Ueberschuss (Erz. − Last)",
          kpiAbsorbed: "Theoretisch speicherbar (Kap. + MW)",
          kpiMissed: "Verpasste Ueberschuss-Energie",
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
          kpiGrossSurplusEyebrow: "Brutto-Ueberschuss",
          kpiGrossSurplusSubtitle: "Zeitraum",
          kpiMissedSurplusEyebrow: "Verpasster Ueberschuss",
          kpiMissedSurplusSubtitle: "Nicht aufnehmbar mit heutiger Flotte",
          kpiMissedOfGross: (pct: string) => `${pct}% des Brutto-Ueberschusses`,
          kpiSelfConsumptionEyebrow: "Eigenverbrauchsquote (optimales BESS)",
          kpiSelfConsumptionSubtitle: "Der erzeugten Energie vor Ort verwendet",
          kpiFleetRequiredShort: "Flotten-Leistung und -Kapazitaet aus dem Snapshot fuer dieses KPI noetig.",
          profileTitle: "Deutschland-Tagesprofil",
          profileSubtitle: "Energy-Charts · strukturelle Bilanz · Europa/Berlin",
          modeObserved: "Beobachtet",
          modeSimulated: "Simuliert (optimales BESS)",
          timeframeLabelShort: "Zeitraum",
          dataCoverageInfoAria: "Was bedeutet die Datenabdeckung?",
          dataCoverageTooltip:
            "Anteil der erwarteten Viertelstunden im gewaehlten Zeitraum, fuer die Energy-Charts veroeffentlichte Messreihen liefern (keine interpolierten Luecken).",
          coverageBadgeSuffix: "Datenabdeckung",
          observedChartTitle:
            "Beobachteter Ueberschuss, Defizit & geschaetzter Flotten-SoC",
          storyStepIndicatorsLead: "Was zeigt diese Auswahl?",
          keyMetricsEyebrow: "Indikatoren",
          recoImpactEyebrow: "Aus diesem Profil",
          recoImpactTitle: "Empfehlung · Wirkung",
          simulatedCtaObserved: "Zu Beobachtet wechseln",
          longTermEyebrow: "Langfristige Einordnung",
          longTermTitle: "Zwölf Monate · BESS-Analyse",
          kpiBaselineSelfConsumptionEyebrow: "Eigenverbrauchsquote (jetzt)",
          kpiBaselineSelfConsumptionSubtitle: "Erzeugung deckt Last direkt",
          kpiCapturedSurplusEyebrow: "Aufgenommener Ueberschuss",
          kpiCapturedSurplusSubtitle: "In modelliertem BESS",
          kpiDeficitCoveredEyebrow: "Gedecktes Defizit",
          kpiDeficitCoveredSubtitle: "Aus Speicher gefüllt",
          kpiNewSelfConsumptionEyebrow: "Neue Eigenverbrauchsquote",
          kpiNewSelfConsumptionSubtitle: "Mit optimalem BESS",
          kpiGridImpactEyebrow: "Netzauswirkung",
          kpiGridImpactSubtitle: "Strukturelle Lücke",
          kpiGridImpactValue: (pct: string) => `Nettaustauschbedarf strukturell ~${pct} % niedriger`,
          observedModeLead:
            "P95 aus diesem Fenster. Simulation zeigt Überschussaufnahme und Netzwirkung.",
          capacityBadgeUnavailable: "Keine berechenbare Simulationskapazitaet",
          aiInsightTitle: "KI-Einblick",
          insightRuleBasedTitle: "Automatische Kurzfassung",
          aiInsightPlaceholder:
            "Keine Zahlenbasis fuer diese Kurzfassung. Nach Anbindung eines LLM kann zusätzlicher Text uber die Prop simulationAiInsight kommen.",
          observedCtaSimulated: "Zu Simulation wechseln",
          technicalDisclaimer: "Illustratives Modell, keine Beschaffungsempfehlung.",
        }
      : {
          eyebrow: "Energy-Charts Profile",
          title: "Germany Day Profile – Observed Surplus, Deficit & Estimated Fleet SoC",
          chartTitle: "Surplus / deficit",
          legendNet: "+surplus / −deficit (gen − load)",
          legendNetSimulated: "Net",
          legendFleetSoc: "Estimated SoC",
          legendPracticalSoc: "SoC",
          legendPracticalCharge: "Charge",
          legendPracticalDischarge: "Discharge",
          legendSimulatedPrefix: "Simulated:",
          legendEvening: "Evening window",
          toggleNetSimulation: "Apply practical BESS simulation to net line",
          netFootnote: "Net = generation − load per slot.",
          socFootnote: "SoC modeled over quarter-hour order, not SCADA telemetry.",
          kpiGross: "Gross surplus (gen − load)",
          kpiAbsorbed: "Theoretically storable (cap + MW)",
          kpiMissed: "Missed surplus energy",
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
          kpiGrossSurplusEyebrow: "Gross surplus",
          kpiGrossSurplusSubtitle: "This window",
          kpiMissedSurplusEyebrow: "Missed surplus",
          kpiMissedSurplusSubtitle: "Not storable at today’s fleet limits",
          kpiMissedOfGross: (pct: string) => `${pct}% of gross surplus`,
          kpiSelfConsumptionEyebrow: "Self-consumption rate (optimal BESS)",
          kpiSelfConsumptionSubtitle: "Of generated energy used locally",
          kpiFleetRequiredShort: "Fleet power and capacity from the snapshot are required for this KPI.",
          profileTitle: "Germany Day Profile",
          profileSubtitle: "Energy-Charts · structural balance · Europe/Berlin",
          modeObserved: "Observed",
          modeSimulated: "Simulated with optimal BESS",
          timeframeLabelShort: "Period",
          dataCoverageInfoAria: "What does data coverage mean?",
          dataCoverageTooltip:
            "Share of expected quarter-hours in the selected window that have published Energy-Charts data (missing slots are not interpolated).",
          coverageBadgeSuffix: "data coverage",
          observedChartTitle: "Observed Surplus, Deficit & Estimated Fleet SoC",
          storyStepIndicatorsLead: "What this selection shows",
          keyMetricsEyebrow: "Key indicators",
          recoImpactEyebrow: "From this profile",
          recoImpactTitle: "Recommendation & impact",
          simulatedCtaObserved: "Back to Observed mode",
          longTermEyebrow: "Long-term view",
          longTermTitle: "12-month BESS analysis",
          kpiBaselineSelfConsumptionEyebrow: "Self-consumption rate (baseline)",
          kpiBaselineSelfConsumptionSubtitle: "Gen meets load directly",
          kpiCapturedSurplusEyebrow: "Surplus captured",
          kpiCapturedSurplusSubtitle: "Into modeled BESS",
          kpiDeficitCoveredEyebrow: "Deficit covered",
          kpiDeficitCoveredSubtitle: "From discharged storage",
          kpiNewSelfConsumptionEyebrow: "Self-consumption (with optimal BESS)",
          kpiNewSelfConsumptionSubtitle: "With optimal BESS",
          kpiGridImpactEyebrow: "Grid impact proxy",
          kpiGridImpactSubtitle: "Structural gap",
          kpiGridImpactValue: (pct: string) => `Reduced structural imbalance ~${pct}%`,
          observedModeLead:
            "P95 for this window. Simulated mode shows surplus capture and grid impact.",
          capacityBadgeUnavailable: "Simulation capacity not computable yet",
          aiInsightTitle: "AI insight",
          insightRuleBasedTitle: "Rule-based insight",
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

  const effectivePracticalCapacityMwh = useMemo(() => {
    const current = practicalCapacity?.practicalCapacityMwh ?? 0;
    if (current > 0) {
      return current;
    }
    const fallback = previousDayPracticalCapacity?.practicalCapacityMwh ?? 0;
    return fallback > 0 ? fallback : 0;
  }, [practicalCapacity, previousDayPracticalCapacity]);

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
    if (previousDaySlots.length === 0) {
      return 0;
    }
    let startYesterdayMwh = 0;
    if (dayBeforePreviousSlots.length > 0) {
      const stitch = simulatePracticalDispatchAtCapacity(
        dayBeforePreviousSlots,
        effectivePracticalCapacityMwh,
        {
          resetDailyByBerlin: true,
          initialSocMwh: 0,
          maxPowerMw: selectedWindowBalancedPowerMw,
        }
      );
      const lastStitch = stitch[stitch.length - 1];
      if (lastStitch !== undefined) {
        startYesterdayMwh =
          (Math.min(100, Math.max(0, lastStitch.socPct)) / 100) * effectivePracticalCapacityMwh;
      }
    }
    const prevSeries = simulatePracticalDispatchAtCapacity(
      previousDaySlots,
      effectivePracticalCapacityMwh,
      {
        resetDailyByBerlin: true,
        initialSocMwh: startYesterdayMwh,
        maxPowerMw: selectedWindowBalancedPowerMw,
      }
    );
    const prevEndSocPct = prevSeries[prevSeries.length - 1]?.socPct ?? 0;
    return (Math.min(100, Math.max(0, prevEndSocPct)) / 100) * effectivePracticalCapacityMwh;
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
    return computeCoverageAtCapacityMwh(flow.slots, effectivePracticalCapacityMwh, {
      resetDailyByBerlin: true,
    });
  }, [flow, effectivePracticalCapacityMwh]);

  /** Balanced-tier BESS sizing: share of generation that serves load directly or via time-shifted discharge. */
  const selfConsumptionOptimalPct = useMemo(() => {
    if (!flow?.slots.length || !selectedWindowRecommendation?.balanced) {
      return null;
    }
    const cap = selectedWindowRecommendation.balanced.recommendedEnergyMwh;
    const pw = selectedWindowRecommendation.balanced.recommendedPowerMw;
    if (!Number.isFinite(cap) || cap <= 0) {
      return null;
    }
    const coverage = computeCoverageAtCapacityMwh(flow.slots, cap, {
      resetDailyByBerlin: true,
      maxPowerMw: pw > 0 && Number.isFinite(pw) ? pw : null,
    });
    let directLocalMwh = 0;
    let totalGenMwh = 0;
    for (const s of flow.slots) {
      totalGenMwh += s.totalGenerationMw * QUARTER_HOUR_H;
      directLocalMwh += Math.min(s.totalGenerationMw, s.loadMw) * QUARTER_HOUR_H;
    }
    if (totalGenMwh <= 0) {
      return null;
    }
    const numerator = directLocalMwh + coverage.servedDeficitEnergyMwh;
    return Math.min(100, Math.max(0, (numerator / totalGenMwh) * 100));
  }, [flow, selectedWindowRecommendation]);

  /** Share of domestic generation paired directly to contemporaneous demand (before BESS reshaping). */
  const baselineSelfConsumptionPct = useMemo(() => {
    if (!flow?.slots.length) {
      return null;
    }
    let directLocalMwh = 0;
    let totalGenMwh = 0;
    for (const s of flow.slots) {
      totalGenMwh += s.totalGenerationMw * QUARTER_HOUR_H;
      directLocalMwh += Math.min(s.totalGenerationMw, s.loadMw) * QUARTER_HOUR_H;
    }
    if (totalGenMwh <= 0) {
      return null;
    }
    return Math.min(100, Math.max(0, (directLocalMwh / totalGenMwh) * 100));
  }, [flow]);

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
      return {
        ...s,
        timeLabel: labeler.format(new Date(s.timestampIso)),
        netBalanceMw,
        netAfterPracticalBessMw: adjustedNetSeries[i] ?? netBalanceMw,
        inferredFleetSocPct: absorption.inferredFleetSocPctSeries[i] ?? 0,
        estimatedFleetSocPct: estimatedFleetSocSeries[i] ?? 0,
        simulatedPracticalSocPct: practicalSocSeries[i] ?? 0,
        practicalChargeSignedMw: -(practicalDispatchSeries[i]?.chargeMw ?? 0),
        practicalChargeMw: practicalDispatchSeries[i]?.chargeMw ?? 0,
        practicalDischargeMw: practicalDispatchSeries[i]?.dischargeMw ?? 0,
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
    const socPct = showSimulatedNet ? last.simulatedPracticalSocPct : last.estimatedFleetSocPct;
    const toTail = (row: ChartRow): ChartRowTailForFleetMode => ({
      estimatedFleetSocPct: row.estimatedFleetSocPct,
      simulatedPracticalSocPct: row.simulatedPracticalSocPct,
      netBalanceMw: row.netBalanceMw,
      practicalChargeMw: row.practicalChargeMw,
      practicalDischargeMw: row.practicalDischargeMw,
    });
    const fleetMode = inferFleetModeFromChartTail({
      showSimulatedNet,
      last: toTail(last),
      previous: prev ? toTail(prev) : null,
    });
    publish({
      socPct,
      mode: showSimulatedNet ? "practical" : "fleet",
      lastSlotTimestampIso: last.timestampIso,
      fleetMode,
    });
    return () => {
      publish(null);
    };
  }, [chartRows, showSimulatedNet, onChartFleetSocSnapshot]);

  const activeNetLegend = showSimulatedNet ? t.legendNetSimulated : t.legendNet;
  const activeNetDataKey = showSimulatedNet ? "netAfterPracticalBessMw" : "netBalanceMw";
  const activeSocLegend = showSimulatedNet ? t.legendPracticalSoc : t.legendFleetSoc;
  const activeSocDataKey = showSimulatedNet ? "simulatedPracticalSocPct" : "estimatedFleetSocPct";
  const activeSocCapacityMwh = showSimulatedNet
    ? (effectivePracticalCapacityMwh > 0 ? effectivePracticalCapacityMwh : null)
    : fleetEnergyCapacityMwh;

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

  /** Recharts `interval` = show every (interval+1)-th tick; fewer labels on narrow viewports. */
  const maxVisibleXLabels = (() => {
    if (!isMultiDayFlow) {
      return chartLayoutCompact ? 8 : 12;
    }
    if (chartLayoutCompact) {
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
    ? chartLayoutCompact
      ? { top: 4, right: 4, bottom: 58, left: 2 }
      : { top: 8, right: 8, bottom: 42, left: 4 }
    : chartLayoutCompact
      ? { top: 4, right: 2, bottom: 18, left: 2 }
      : { top: 8, right: 8, bottom: 8, left: 4 };

  const xAxisAngle = isMultiDayFlow ? (chartLayoutCompact ? -52 : -38) : 0;
  const xAxisTickFont = isMultiDayFlow ? (chartLayoutCompact ? 7 : 8) : chartLayoutCompact ? 8 : 9;
  const yNetWidth = chartLayoutCompact ? 40 : 48;
  const ySocWidth = chartLayoutCompact ? 36 : 44;

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

  const chartHeading = showSimulatedNet
    ? simulatedCapacityGwhLabel !== null
      ? language === "de"
        ? `${simulatedCapacityGwhLabel} BESS · Simulation`
        : `${simulatedCapacityGwhLabel} BESS · simulated`
      : language === "de"
        ? "Simulation · Kapazität offen"
        : "Simulation · sizing pending"
    : t.observedChartTitle;

  const netLineColor = showSimulatedNet ? "rgb(8,143,143)" : "rgb(51,104,247)";
  const coverageSummaryLine = t.coverage(flow.samplePoints, coveragePct, flow.dateBerlin, isMultiDayFlow);
  const simulatedBriefCopy =
    simulatedCapacityGwhLabel !== null
      ? language === "de"
        ? `Mit der empfohlenen ${simulatedCapacityGwhLabel} BESS wird nahezu der gesamte Überschuss genutzt; die strukturelle Netzunbalance sinkt deutlich.`
        : `With the recommended ${simulatedCapacityGwhLabel} BESS we capture nearly all surplus and significantly reduce grid imbalance.`
      : language === "de"
        ? "Kapazitaet noch nicht ableitbar — Kurve zeigt nur die strukturelle Bilanz."
        : "Sizing unavailable — curve shows structural balance only.";

  const resolvedLlmInsightText = String(simulationAiInsight ?? "").trim();
  const heuristicInsightParagraph = deriveGermanyFlowRuleBasedInsightText({
    language,
    modeSimulated: showSimulatedNet,
    conservativeRecommendedMwh:
      selectedWindowRecommendation?.conservative?.recommendedEnergyMwh ?? null,
    absorption,
    fleetSizingAvailable: showMissedKpis,
    recommendedCoverageSim: recommendedCoverage,
    gridImpactReductionPct,
  });
  const insightPanelTitle =
    resolvedLlmInsightText.length > 0 ? t.aiInsightTitle : t.insightRuleBasedTitle;
  const insightPanelBody =
    resolvedLlmInsightText || heuristicInsightParagraph || t.aiInsightPlaceholder;

  return (
    <article
      id="germany-day-energy-flow"
      className="scroll-mt-8 space-y-6 rounded-2xl border border-border/80 bg-card p-5 shadow-[0_1px_0_rgb(255_255_255_/_0.7)_inset,0_12px_36px_rgb(15_23_42_/_0.06)] md:space-y-8 md:p-6 lg:p-8 dark:border-slate-600/35 dark:bg-[linear-gradient(180deg,rgb(13_19_33_/_0.98),rgb(15_23_42_/_0.94))] dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05),0_16px_44px_rgb(0_0_0_/_0.38)]"
    >
      <header className="flex flex-col gap-4 md:gap-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
          <div className="min-w-0 space-y-1 lg:max-w-xl">
            <h2 className="text-2xl font-bold leading-tight tracking-tight text-slate-950 md:text-3xl dark:text-white [font-family:var(--font-heading)]">
              {t.profileTitle}
            </h2>
            <p className="max-w-xl text-xs leading-relaxed text-slate-500 md:text-[0.8125rem] dark:text-slate-400">
              {t.profileSubtitle}
            </p>
          </div>

          <div
            role="radiogroup"
            aria-label={language === "de" ? "Anzeige-Modus" : "Presentation mode"}
            className="w-full min-w-0 shrink-0 lg:max-w-[min(100%,28rem)] xl:max-w-[32rem]"
          >
            <div className="flex rounded-[0.88rem] border border-slate-200/95 bg-slate-100/95 p-1 shadow-[inset_0_2px_4px_rgba(15,23,42,0.06)] dark:border-slate-600/60 dark:bg-slate-800/95 dark:shadow-[inset_0_2px_6px_rgba(0,0,0,0.35)]">
              <button
                type="button"
                role="radio"
                aria-checked={!showSimulatedNet}
                onClick={() => setShowSimulatedNet(false)}
                className={`relative min-h-[3rem] flex-1 rounded-[0.65rem] px-3 py-2.5 text-center text-sm font-semibold leading-snug outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-slate-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-100 sm:min-h-[3.35rem] sm:px-4 sm:text-[0.9375rem] dark:focus-visible:ring-offset-slate-900 ${
                  !showSimulatedNet
                    ? "bg-white text-slate-900 shadow-[0_2px_8px_rgba(15,23,42,0.12),0_1px_2px_rgba(15,23,42,0.06)] dark:bg-slate-950 dark:text-white dark:shadow-[0_4px_14px_rgba(0,0,0,0.4)]"
                    : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                {t.modeObserved}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={showSimulatedNet}
                onClick={() => setShowSimulatedNet(true)}
                className={`relative min-h-[3rem] flex-1 rounded-[0.65rem] px-3 py-2.5 text-center text-sm font-semibold leading-snug outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-100 sm:min-h-[3.35rem] sm:px-4 sm:text-[0.9375rem] dark:focus-visible:ring-offset-slate-900 ${
                  showSimulatedNet
                    ? "bg-gradient-to-b from-emerald-500 to-emerald-600 text-white shadow-[0_4px_20px_rgba(16,185,129,0.45),0_2px_6px_rgba(5,150,105,0.35),inset_0_1px_0_rgba(255,255,255,0.2)] ring-2 ring-emerald-400/35 ring-offset-2 ring-offset-slate-100 dark:from-emerald-500 dark:to-emerald-600 dark:shadow-[0_6px_28px_rgba(16,185,129,0.5)] dark:ring-emerald-300/35 dark:ring-offset-2 dark:ring-offset-slate-950"
                    : "text-slate-500 hover:text-emerald-800 dark:text-slate-400 dark:hover:text-emerald-200/95"
                }`}
              >
                {t.modeSimulated}
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-border/70 pt-3 dark:border-slate-600/40">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1.5">
            <div
              className="inline-flex shrink-0 rounded-lg border border-slate-200/90 bg-slate-100/90 p-[3px] dark:border-slate-600/55 dark:bg-slate-800/90"
              role="tablist"
              aria-label={t.timeframeLabelShort}
            >
              {([
                { mode: "day", label: t.dayMode },
                { mode: "week", label: t.weekMode },
                { mode: "month", label: t.monthMode },
              ] as const).map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  role="tab"
                  aria-selected={selectorMode === option.mode}
                  onClick={() => setSelectorMode(option.mode)}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-semibold transition sm:px-3.5 sm:text-xs ${
                    selectorMode === option.mode
                      ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:min-w-0">
              <button
                type="button"
                onClick={() => {
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
                }}
                className="rounded-md border border-slate-200/90 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-600 dark:border-slate-600/70 dark:bg-slate-950 dark:text-slate-300"
                aria-label={t.previousRange}
              >
                ←
              </button>
              {selectorMode === "day" ? (
                <BerlinDayCalendarButton
                  value={selectedDate}
                  max={todayKey}
                  onChange={setSelectedDate}
                  language={language}
                  className="min-w-[8.5rem] flex-1"
                />
              ) : null}
              {selectorMode === "week" ? (
                <input
                  type="week"
                  value={selectedWeek}
                  max={currentWeekKey}
                  onChange={(event) => setSelectedWeek(event.target.value)}
                  className="min-w-[9.5rem] flex-1 rounded-md border border-slate-200/90 bg-white px-2 py-1.5 text-xs font-medium text-slate-900 outline-none focus-visible:ring-1 focus-visible:ring-slate-400/60 dark:border-slate-600/70 dark:bg-slate-950 dark:text-slate-100"
                />
              ) : null}
              {selectorMode === "month" ? (
                <input
                  type="month"
                  value={selectedMonth}
                  max={currentMonthKey}
                  onChange={(event) => setSelectedMonth(event.target.value)}
                  className="min-w-[9rem] flex-1 rounded-md border border-slate-200/90 bg-white px-2 py-1.5 text-xs font-medium text-slate-900 outline-none focus-visible:ring-1 focus-visible:ring-slate-400/60 dark:border-slate-600/70 dark:bg-slate-950 dark:text-slate-100"
                />
              ) : null}
              <button
                type="button"
                disabled={nextDisabled}
                onClick={() => {
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
                }}
                className="rounded-md border border-slate-200/90 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600/70 dark:bg-slate-950 dark:text-slate-300"
                aria-label={t.nextRange}
              >
                →
              </button>
            </div>

            <div
              className="group/cov relative inline-flex w-full min-w-0 flex-wrap items-center gap-1 sm:ml-auto sm:w-auto"
              title={t.dataCoverageTooltip}
            >
              <span className="inline-flex min-w-0 items-baseline gap-x-1.5 text-xs leading-snug text-slate-600 dark:text-slate-300">
                <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{coveragePct}%</span>
                <span className="text-slate-400 dark:text-slate-500">·</span>
                <span className="min-w-0 text-slate-500 dark:text-slate-400">{t.coverageBadgeSuffix}</span>
              </span>
              <button
                type="button"
                className="shrink-0 rounded-full p-1 text-slate-400 outline-none transition hover:bg-slate-200/80 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-slate-400/60 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                aria-label={t.dataCoverageInfoAria}
                aria-describedby={dataCoverageTooltipId}
                title={t.dataCoverageTooltip}
              >
                <Info className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              </button>
              <span
                id={dataCoverageTooltipId}
                role="tooltip"
                className="pointer-events-none invisible absolute bottom-[calc(100%+8px)] right-0 z-[80] w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-slate-200/95 bg-white px-3 py-2 text-[11px] leading-snug text-slate-600 opacity-0 shadow-lg transition duration-100 group-hover/cov:visible group-hover/cov:opacity-100 group-focus-within/cov:visible group-focus-within/cov:opacity-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 sm:right-auto sm:left-0"
              >
                {t.dataCoverageTooltip}
              </span>
            </div>
          </div>

          {selectorMode === "day" ? (
            <label className="flex max-w-3xl cursor-pointer items-start gap-2 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
              <input
                type="checkbox"
                checked={dayModeResetAtStart}
                onChange={(event) => setDayModeResetAtStart(event.target.checked)}
                className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded border-slate-300 text-slate-500 focus-visible:ring-1 focus-visible:ring-slate-400 dark:border-slate-600 dark:bg-slate-900"
              />
              <span>{t.dayResetToggleLabel}</span>
            </label>
          ) : null}
        </div>
      </header>

      <div
        id="aether-germany-flow-capture"
        className={`rounded-2xl border p-4 shadow-inner md:p-6 ${
          showSimulatedNet
            ? "border-border/90 bg-card shadow-[inset_0_0_0_1px_rgb(34_193_115_/_0.05)] dark:border-slate-600/50 dark:bg-slate-950/78 dark:shadow-[inset_0_0_0_1px_rgba(52,211,153,0.08)]"
            : "border-border/80 bg-card/95 dark:border-slate-600/55 dark:bg-slate-950/70"
        }`}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1 lg:max-w-[min(680px,calc(100%-10rem))]">
            <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-slate-500 dark:text-slate-400">
              {showSimulatedNet
                ? language === "de"
                  ? "Simulations-Overlay"
                  : "Simulation overlay"
                : language === "de"
                  ? "Beobachtung"
                  : "Observed focus"}
            </p>
            <p className="text-lg font-semibold leading-snug text-slate-950 md:text-xl dark:text-white [font-family:var(--font-heading)]">
              {chartHeading}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2">
            <FlowExportButtons
              language={language}
              flow={flow}
              captureElementId="aether-germany-flow-capture"
            />
            <LegendDot color={netLineColor} label={activeNetLegend} />
            <LegendDot
              color={showSimulatedNet ? SIM_CHART_SOC_STROKE : "rgb(129,119,239)"}
              label={activeSocLegend}
            />
            {showSimulatedNet ? <LegendDot color={SIM_CHART_CHARGE_FILL} label={t.legendPracticalCharge} /> : null}
            {showSimulatedNet ? <LegendDot color="rgb(249,115,22)" label={t.legendPracticalDischarge} /> : null}
            <LegendDot color="rgba(251,191,36,0.95)" label={t.legendEvening} />
          </div>
        </div>
        <div className="mt-6 h-[min(68vh,600px)] min-h-[260px] w-full min-w-0 sm:min-h-[300px] md:h-[540px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartRows} margin={chartMargin}>
              <CartesianGrid
                stroke={
                  showSimulatedNet ? "rgba(148,163,184,0.13)" : "rgba(148,163,184,0.18)"
                }
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
                height={isMultiDayFlow ? (chartLayoutCompact ? 54 : 48) : chartLayoutCompact ? 28 : undefined}
                interval={xAxisInterval}
                minTickGap={chartLayoutCompact ? (isMultiDayFlow ? 24 : 6) : isMultiDayFlow ? 18 : 8}
              />
              <YAxis
                yAxisId="net"
                tick={{ fontSize: chartLayoutCompact ? 9 : 10, fill: "rgb(100,116,139)" }}
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
                tick={{ fontSize: chartLayoutCompact ? 8 : 9, fill: "rgb(100,116,139)" }}
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
                  return [formatSignedMw(n), label];
                }}
              />
              <Line
                yAxisId="net"
                type="monotone"
                dataKey={activeNetDataKey}
                name={activeNetLegend}
                stroke={netLineColor}
                strokeWidth={showSimulatedNet ? 3 : 2.5}
                dot={false}
                isAnimationActive={!chartLayoutCompact}
                animationDuration={chartLayoutCompact ? 0 : 180}
              />
              {showSimulatedNet ? (
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
                    fill="rgb(249,115,22)"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={8}
                  />
                </>
              ) : null}
              <Line
                yAxisId="soc"
                type="monotone"
                dataKey={activeSocDataKey}
                name={activeSocLegend}
                stroke={showSimulatedNet ? SIM_CHART_SOC_STROKE : "rgb(133,117,239)"}
                strokeWidth={showSimulatedNet ? 2.65 : 1.55}
                strokeLinecap={showSimulatedNet ? "round" : undefined}
                strokeLinejoin={showSimulatedNet ? "round" : undefined}
                strokeDasharray={showSimulatedNet ? undefined : "5 4"}
                dot={false}
                isAnimationActive={!chartLayoutCompact}
                animationDuration={chartLayoutCompact ? 0 : 180}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-4 text-[11px] leading-snug tracking-wide text-slate-400 dark:text-slate-500">
          {t.netFootnote} {t.socFootnote}
        </p>
      </div>

      <section className="space-y-4 md:space-y-5" aria-labelledby="germany-energy-key-metrics-heading">
        <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between">
          <h3
            id="germany-energy-key-metrics-heading"
            className="text-base font-semibold tracking-tight text-slate-800 md:text-[1.0625rem] dark:text-slate-100 [font-family:var(--font-heading)]"
          >
            {t.storyStepIndicatorsLead}
            <span className="sr-only"> · </span>
            <span className="mt-1 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400 md:mt-0 md:inline md:before:mx-2 md:before:content-['·']">
              {t.keyMetricsEyebrow}
              {" · "}
              {showSimulatedNet
                ? language === "de"
                  ? "Simulation"
                  : "Simulation"
                : language === "de"
                  ? "Beobachtung"
                  : "Observed"}
            </span>
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{selectorLabel}</p>
        </div>

        {!showSimulatedNet ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
            <div className="flex min-h-[100px] flex-col justify-between rounded-xl border border-emerald-200/80 bg-card px-4 py-3 shadow-sm transition-shadow hover:shadow-md dark:border-emerald-600/28 dark:bg-emerald-950/18">
              <div className="pointer-events-none h-1 w-14 rounded-full bg-emerald-400/80 dark:bg-emerald-300/60" aria-hidden />
              <div>
                <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-900 dark:text-emerald-200">{t.kpiGrossSurplusEyebrow}</p>
                <p className="mt-1.5 text-2xl font-extrabold tabular-nums text-emerald-950 dark:text-emerald-50 [font-family:var(--font-sans)]">
                  {absorption ? formatEnergyFromMwh(absorption.grossSurplusEnergyMwh) : "—"}
                </p>
              </div>
              <p className="mt-3 text-xs leading-snug text-muted-foreground dark:text-slate-300">{t.kpiGrossSurplusSubtitle}</p>
            </div>

            <div className="relative flex min-h-[100px] flex-col justify-between overflow-hidden rounded-xl border border-amber-200/85 bg-card px-4 py-3 shadow-sm transition-shadow hover:shadow-md dark:border-amber-500/42 dark:bg-amber-950/28">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-gradient-to-r from-amber-400 via-amber-500 to-orange-400" aria-hidden />
              <div>
                <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-950 dark:text-amber-100">{t.kpiMissedSurplusEyebrow}</p>
                <p className="mt-1.5 text-2xl font-extrabold tabular-nums text-amber-950 dark:text-amber-50 [font-family:var(--font-sans)]">
                  {showMissedKpis && absorption ? formatEnergyFromMwh(absorption.missedSurplusEnergyMwh) : "—"}
                </p>
                {showMissedKpis && absorption && absorption.grossSurplusEnergyMwh > 1e-6 ? (
                  <p className="mt-1.5 text-sm font-bold tabular-nums text-amber-900 dark:text-amber-50">
                    {t.kpiMissedOfGross(pctFormatter.format((absorption.missedSurplusEnergyMwh / absorption.grossSurplusEnergyMwh) * 100))}
                  </p>
                ) : showMissedKpis ? (
                  <p className="mt-1.5 text-xs font-semibold text-amber-900/80 dark:text-amber-200/85">—</p>
                ) : (
                  <p className="mt-1.5 text-[11px] leading-snug text-amber-900/85 dark:text-amber-50/85">{t.kpiFleetRequiredShort}</p>
                )}
              </div>
              <p className="mt-3 text-xs leading-snug text-amber-950/92 dark:text-amber-100/90">{t.kpiMissedSurplusSubtitle}</p>
            </div>

            <div className="flex min-h-[100px] flex-col justify-between rounded-xl border border-border/80 bg-card px-4 py-3 shadow-sm transition-shadow hover:shadow-md dark:border-slate-600/55 dark:bg-slate-950/70">
              <div className="pointer-events-none h-1 w-14 rounded-full bg-sky-500/70 dark:bg-sky-500/50" aria-hidden />
              <div>
                <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t.kpiBaselineSelfConsumptionEyebrow}</p>
                <p className="mt-1.5 text-2xl font-extrabold tabular-nums text-slate-950 dark:text-white [font-family:var(--font-sans)]">
                  {baselineSelfConsumptionPct !== null ? `${integerFormatter.format(Math.round(baselineSelfConsumptionPct))}%` : "—"}
                </p>
              </div>
              <p className="mt-3 text-xs leading-snug text-muted-foreground dark:text-slate-300">{t.kpiBaselineSelfConsumptionSubtitle}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
            <div className="flex min-h-[100px] flex-col justify-between rounded-xl border border-emerald-200/85 bg-emerald-50/50 px-4 py-3 shadow-sm transition-shadow hover:shadow-md dark:border-emerald-500/38 dark:bg-emerald-950/30">
              <div className="pointer-events-none h-1 w-14 rounded-full bg-emerald-500/90" aria-hidden />
              <div>
                <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-900 dark:text-emerald-100">{t.kpiCapturedSurplusEyebrow}</p>
                <p className="mt-1.5 text-2xl font-extrabold tabular-nums text-emerald-950 dark:text-emerald-50 [font-family:var(--font-sans)]">
                  {recommendedCoverage ? formatEnergyFromMwh(recommendedCoverage.absorbedSurplusEnergyMwh) : "—"}
                </p>
                {recommendedCoverage && recommendedCoverage.totalSurplusEnergyMwh > 1e-9 ? (
                  <p className="mt-1 text-sm font-semibold tabular-nums text-emerald-900 dark:text-emerald-100">
                    {pctFormatter.format(recommendedCoverage.absorbedSurplusShare * 100)}%{" "}
                    {language === "de" ? "des Brutto-Ueberschusses" : "of gross surplus"}
                  </p>
                ) : null}
              </div>
              <p className="mt-3 text-xs leading-snug text-emerald-950/92 dark:text-emerald-100/90">{t.kpiCapturedSurplusSubtitle}</p>
            </div>

            <div className="flex min-h-[100px] flex-col justify-between rounded-xl border border-sky-200/90 bg-card px-4 py-3 shadow-sm transition-shadow hover:shadow-md dark:border-sky-700/55 dark:bg-slate-950/70">
              <div className="pointer-events-none h-1 w-14 rounded-full bg-sky-500/75" aria-hidden />
              <div>
                <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-950 dark:text-sky-100">{t.kpiDeficitCoveredEyebrow}</p>
                <p className="mt-2 text-2xl font-extrabold tabular-nums text-sky-950 dark:text-sky-50 [font-family:var(--font-sans)]">
                  {recommendedCoverage ? formatEnergyFromMwh(recommendedCoverage.servedDeficitEnergyMwh) : "—"}
                </p>
                {recommendedCoverage && recommendedCoverage.totalDeficitEnergyMwh > 1e-9 ? (
                  <p className="mt-1 text-sm font-semibold tabular-nums text-sky-900 dark:text-sky-50">
                    {pctFormatter.format(recommendedCoverage.servedDeficitShare * 100)}%{" "}
                    {language === "de" ? "der Defizitenergie" : "of deficit energy"}
                  </p>
                ) : null}
              </div>
              <p className="mt-3 text-xs leading-snug text-slate-700 dark:text-slate-300">{t.kpiDeficitCoveredSubtitle}</p>
            </div>

            <div className="flex min-h-[100px] flex-col justify-between rounded-xl border border-teal-200/85 bg-card px-4 py-3 shadow-sm transition-shadow hover:shadow-md dark:border-teal-700/55 dark:bg-slate-950/65">
              <div className="pointer-events-none h-1 w-14 rounded-full bg-teal-500/80" aria-hidden />
              <div>
                <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-950 dark:text-teal-100">{t.kpiNewSelfConsumptionEyebrow}</p>
                <p className="mt-2 text-2xl font-extrabold tabular-nums text-teal-950 dark:text-teal-50 [font-family:var(--font-sans)]">
                  {selfConsumptionOptimalPct !== null ? `${integerFormatter.format(Math.round(selfConsumptionOptimalPct))}%` : "—"}
                </p>
              </div>
              <p className="mt-3 text-xs leading-snug text-slate-700 dark:text-slate-300">{t.kpiNewSelfConsumptionSubtitle}</p>
            </div>

            <div className="flex min-h-[100px] flex-col justify-between rounded-xl border border-border/80 bg-card px-4 py-3 shadow-sm transition-shadow hover:shadow-md dark:border-slate-600/55 dark:bg-slate-950/70">
              <div className="pointer-events-none h-1 w-14 rounded-full bg-fuchsia-500/70" aria-hidden />
              <div>
                <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-700 dark:text-slate-300">{t.kpiGridImpactEyebrow}</p>
                <p className="mt-2 text-2xl font-extrabold tabular-nums text-slate-950 dark:text-white [font-family:var(--font-sans)]">
                  {gridImpactReductionPct !== null ? `${integerFormatter.format(Math.round(gridImpactReductionPct))}%` : "—"}
                </p>
                {gridImpactReductionPct !== null ? (
                  <p className="mt-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {t.kpiGridImpactValue(pctFormatter.format(gridImpactReductionPct))}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">—</p>
                )}
              </div>
              <p className="mt-3 text-xs leading-snug text-slate-600 dark:text-slate-300">{t.kpiGridImpactSubtitle}</p>
            </div>
          </div>
        )}
      </section>

      <section
        className="space-y-4 rounded-xl border border-border/80 bg-muted/30 px-4 py-5 md:space-y-5 md:px-6 md:py-6 dark:border-slate-600/45 dark:bg-slate-950/45"
        aria-labelledby="reco-impact-heading"
      >
        <header className="space-y-0.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
            {t.recoImpactEyebrow}
          </p>
          <h3
            id="reco-impact-heading"
            className="text-lg font-semibold text-slate-900 md:text-xl dark:text-white [font-family:var(--font-heading)]"
          >
            {t.recoImpactTitle}
          </h3>
        </header>

        <div className="space-y-2 border-b border-border/70 pb-4 dark:border-slate-600/40">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1" aria-live="polite">
            {showSimulatedNet ? (
              simulatedCapacityGwhLabel ? (
                <>
                  <span className="text-[2.5rem] font-extrabold leading-none tracking-tight text-emerald-700 tabular-nums dark:text-emerald-300 sm:text-[2.85rem] [font-family:var(--font-sans)]">
                    {simulatedCapacityGwhLabel}
                  </span>
                  <span className="mb-2 text-base font-semibold tracking-wide text-slate-700 dark:text-slate-300">
                    BESS
                  </span>
                </>
              ) : (
                <span className="text-base font-semibold text-amber-800 dark:text-amber-100">{t.capacityBadgeUnavailable}</span>
              )
            ) : selectedWindowRecommendation?.conservative ? (
              <>
                <span className="text-[2.5rem] font-extrabold leading-none tracking-tight text-violet-950 tabular-nums dark:text-violet-100 sm:text-[2.85rem] [font-family:var(--font-sans)]">
                  {formatEnergyFromMwh(selectedWindowRecommendation.conservative.recommendedEnergyMwh)}
                </span>
                <span className="mb-2 rounded-md bg-violet-600/14 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-violet-900 dark:bg-violet-400/28 dark:text-violet-50">
                  P95
                </span>
              </>
            ) : (
              <span className="text-xl font-semibold text-slate-400">—</span>
            )}
          </div>
          {!showSimulatedNet && selectedWindowRecommendation?.conservative?.recommendedPowerMw ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {language === "de"
                ? `Begleit-Leistung (konservativ): ${formatPowerFromMw(selectedWindowRecommendation.conservative.recommendedPowerMw)}`
                : `Companion power (conservative): ${formatPowerFromMw(selectedWindowRecommendation.conservative.recommendedPowerMw)}`}
            </p>
          ) : null}
          {showSimulatedNet && selectedWindowBalancedPowerMw !== null ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {language === "de"
                ? `Modell-Leistung (balanced): ${formatPowerFromMw(selectedWindowBalancedPowerMw)}`
                : `Modeled power (balanced): ${formatPowerFromMw(selectedWindowBalancedPowerMw)}`}
            </p>
          ) : null}
        </div>

        <p className="max-w-[40rem] text-[0.9375rem] leading-relaxed text-slate-700 dark:text-slate-300">
          {showSimulatedNet ? simulatedBriefCopy : t.observedModeLead}
        </p>

        <div className="rounded-lg border border-indigo-200/60 bg-card px-3.5 py-3 shadow-sm dark:border-indigo-500/35 dark:bg-indigo-950/35">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.65)]" aria-hidden />
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-800 dark:text-indigo-200">
              {insightPanelTitle}
            </p>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-slate-800 dark:text-slate-100">
            {insightPanelBody}
          </p>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/70 pt-4 dark:border-slate-600/40 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          <div className="flex flex-wrap gap-3">
            {!showSimulatedNet ? (
              <button
                type="button"
                onClick={() => setShowSimulatedNet(true)}
                className="rounded-xl bg-gradient-to-b from-emerald-500 to-emerald-600 px-6 py-3 text-center text-sm font-semibold text-white shadow-[0_4px_14px_rgba(16,185,129,0.35)] transition hover:from-emerald-600 hover:to-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 dark:shadow-[0_4px_18px_rgba(6,95,70,0.45)] dark:focus-visible:ring-offset-slate-950"
              >
                {t.observedCtaSimulated}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowSimulatedNet(false)}
                className="rounded-xl border border-slate-300/90 bg-white px-6 py-3 text-center text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/70 focus-visible:ring-offset-2 dark:border-slate-600/75 dark:bg-slate-950 dark:text-slate-100 dark:hover:bg-slate-900 dark:focus-visible:ring-offset-slate-950"
              >
                {t.simulatedCtaObserved}
              </button>
            )}
          </div>
          <p className="max-w-xl text-[11px] leading-snug text-slate-400 dark:text-slate-500 sm:text-right">
            {coverageSummaryLine}
            <span aria-hidden> · </span>
            <span>{t.dataNote}</span>
          </p>
        </div>
      </section>

      <section
        className="space-y-3 border-t border-border/70 pt-6 dark:border-slate-600/40"
        aria-labelledby="trailing-bess-analysis-heading"
      >
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
            {t.longTermEyebrow}
          </p>
          <h3
            id="trailing-bess-analysis-heading"
            className="text-base font-semibold text-slate-800 dark:text-slate-100 md:text-[1.0625rem] [font-family:var(--font-heading)]"
          >
            {t.longTermTitle}
          </h3>
        </div>

        {isRecommendationLoading ? (
          <Skeleton className="h-14 w-full max-w-5xl rounded-lg" />
        ) : recommendationLoadError || !recommendation || !recommendationByTier?.balanced ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t.kpiRecommendationUnavailable}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200/90 bg-white/90 px-3.5 py-3 shadow-sm dark:border-slate-600/50 dark:bg-slate-950/70">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t.trailingKpiCapacity}
                </p>
                <p className="mt-1.5 text-lg font-bold tabular-nums text-slate-900 dark:text-white [font-family:var(--font-sans)] md:text-xl">
                  {formatEnergyFromMwh(recommendationByTier.balanced.recommendedEnergyMwh)}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  {formatPowerFromMw(recommendationByTier.balanced.recommendedPowerMw)}
                </p>
                <p className="mt-2 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
                  {t.trailingKpiDailyPercentileCaption}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200/90 bg-white/90 px-3.5 py-3 shadow-sm dark:border-slate-600/50 dark:bg-slate-950/70">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t.trailingKpiPayback}
                </p>
                <p className="mt-1.5 text-lg font-bold tabular-nums text-slate-900 dark:text-white md:text-xl [font-family:var(--font-sans)]">
                  {recommendation.indicativeEconomicsAtBalancedTier
                    ? language === "de"
                      ? `${pctFormatter.format(recommendation.indicativeEconomicsAtBalancedTier.paybackYears)} J`
                      : `${pctFormatter.format(recommendation.indicativeEconomicsAtBalancedTier.paybackYears)} yr`
                    : "—"}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200/90 bg-white/90 px-3.5 py-3 shadow-sm dark:border-slate-600/50 dark:bg-slate-950/70">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t.trailingKpiImpact}
                </p>
                <p className="mt-2 text-sm font-semibold leading-snug text-slate-800 dark:text-slate-100">
                  {recommendation.impactAtBalancedTier
                    ? `${pctFormatter.format(recommendation.impactAtBalancedTier.absorbedSurplusShare * 100)}% ${
                        language === "de" ? "Überschuss ·" : "surplus ·"
                      } ${pctFormatter.format(recommendation.impactAtBalancedTier.servedDeficitShare * 100)}% ${
                        language === "de" ? "Defizit" : "deficit"
                      }`
                    : "—"}
                </p>
              </div>
            </div>
            <div className="max-w-4xl space-y-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              <p>
                {recommendation.rangeStartBerlin}–{recommendation.rangeEndBerlin} · {recommendation.observedDays}{" "}
                {language === "de" ? "Tage" : "days"} · {t.trailingBulletTier}
              </p>
              <p>
                <span className="font-medium text-slate-600 dark:text-slate-300">{t.trailingChainPeakLabel}:</span>{" "}
                {Number.isFinite(recommendation.continuousWindowRequiredEnergyMwh) &&
                recommendation.continuousWindowRequiredEnergyMwh >= 0
                  ? formatEnergyFromMwh(recommendation.continuousWindowRequiredEnergyMwh)
                  : "—"}
                <span aria-hidden> · </span>
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
          </>
        )}
      </section>

      <p className="text-[10px] text-slate-400 dark:text-slate-600">{t.technicalDisclaimer}</p>
    </article>
  );
}
