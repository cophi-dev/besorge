"use client";

import { Maximize2, X } from "lucide-react";
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
  berlinDateKeyToIsoWeekKey,
  countBerlinCalendarDaysInclusive,
  formatBerlinDateKeyFromUtcDate,
  isoWeekKeyToBerlinStartKey,
} from "@/lib/berlinCalendar";
import {
  computeEconomics,
  defaultEconomicsAssumptions,
} from "@/lib/bessEconomics";
import { formatPaybackYears } from "@/lib/indicativeEconomicsDisplay";
import type { BriefingStoryWindow } from "@/lib/briefingStoryWindow";
import { energyFlowSelectorStateFromStoryWindow } from "@/lib/briefingStoryWindow";
import { createLogger } from "@/lib/debug";
import type { GermanyDispatchSlotsResponse } from "@/lib/energyChartsApi";
import { buildGermanyPerspectiveFallback } from "@/lib/germanyPerspectiveLlm";
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
import { Button } from "@/components/ui/button";

import { CompactDetailStat, PerspectiveNarrativeBody } from "@/components/germany-day-energy-flow/CompactDetailStat";
import {
  CROSS_BORDER_EXPORT_FILL,
  CROSS_BORDER_IMPORT_FILL,
  energyFormatter,
  EVENING_HOUR_END,
  EVENING_HOUR_START,
  euroCurrencyFormatter,
  integerFormatter,
  monthLabelFormatter,
  OBSERVED_CURTAILMENT_FILL,
  pctFormatter,
  priceFormatter,
  QUARTER_HOUR_H,
  SIM_CHART_CHARGE_FILL,
  SIM_CHART_DISCHARGE_FILL,
  SIM_CHART_NET_STROKE,
  SIM_CHART_SOC_STROKE,
  timeFormatterMultiDay,
  timeFormatterSingleDay,
  WORKSPACE_LIVE_SNAPSHOT_ENABLED,
} from "@/components/germany-day-energy-flow/constants";
import {
  berlinTodayKey,
  formatTimeRangeCenterLabel,
  previousIsoWeekKey,
  priorWindowMatchingSpan,
  resolveSeedDateKey,
  shiftMonthKey,
} from "@/components/germany-day-energy-flow/dateHelpers";
import {
  formatCurrencyCompact,
  formatEnergyFromMwh,
  formatPowerFromMw,
  formatSignedEnergyFromMwh,
  formatSignedMw,
  parseCapacityGwhInput,
} from "@/components/germany-day-energy-flow/formatters";
import { GermanyFlowPeriodSelector } from "@/components/germany-day-energy-flow/GermanyFlowPeriodSelector";
import { LegendDot } from "@/components/germany-day-energy-flow/LegendDot";
import { ObservedStressSection } from "@/components/germany-day-energy-flow/ObservedStressSection";
import {
  bessRecommendationApiSchema,
  germanyEnergyFlowApiSchema,
  revenueModelApiSchema,
  type BessRecommendation,
  type RevenueModelPayload,
} from "@/components/germany-day-energy-flow/schemas";
import { evaluateBessScenario } from "@/components/germany-day-energy-flow/scenarioEvaluation";
import { SimBenefitsSection } from "@/components/germany-day-energy-flow/SimBenefitsSection";
import { SimulatedFlowPngButton } from "@/components/germany-day-energy-flow/SimulatedFlowPngButton";
import type {
  BorderTradeTotals,
  ChartRow,
  GermanyDayEnergyFlowProps,
  SelectorMode,
} from "@/components/germany-day-energy-flow/types";

export type { GermanyDayEnergyFlowProps } from "@/components/germany-day-energy-flow/types";

const log = createLogger("germany-day-energy-flow");

export const GERMANY_SIM_FLOW_CAPTURE_ID = "speicherpilot-germany-sim-capture";

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
    seedStoryWindow = null,
    seedDateKey = null,
    onStoryWindowUrlChange,
    onBriefingStoryWindowChange,
    briefingStoryWindow: _briefingStoryWindow = null,
    briefingStoryRefreshNonce: _briefingStoryRefreshNonce = 0,
    initialSimulatedNet = false,
    onSimulatedModeChange,
  } = props;
  const resolvedSeedKey = resolveSeedDateKey(seedDateKey ?? undefined);
  const initialSelector = useMemo(() => {
    const fallbackDay: BriefingStoryWindow = { type: "day", date: resolvedSeedKey };
    const window =
      seedStoryWindow ??
      (seedDateKey ? { type: "day", date: seedDateKey } : fallbackDay);
    return energyFlowSelectorStateFromStoryWindow(window, resolvedSeedKey);
  }, [seedStoryWindow, seedDateKey, resolvedSeedKey]);
  const [selectorMode, setSelectorMode] = useState<SelectorMode>(initialSelector.mode);
  const [selectedDate, setSelectedDate] = useState(initialSelector.selectedDate);
  const [selectedWeek, setSelectedWeek] = useState(initialSelector.selectedWeek);
  const [selectedMonth, setSelectedMonth] = useState(initialSelector.selectedMonth);
  const [customRangeStart, setCustomRangeStart] = useState(initialSelector.customRangeStart);
  const [customRangeEnd, setCustomRangeEnd] = useState(initialSelector.customRangeEnd);
  const [dayModeResetAtStart] = useState(false);
  const [customSimulatedCapacityGwhApplied, setCustomSimulatedCapacityGwhApplied] = useState("");
  const [customSimulatedCapacityGwhDraft, setCustomSimulatedCapacityGwhDraft] = useState("");
  const serverHydratedFirstLoad =
    initialEnergyFlow !== null &&
    initialBerlinDateKey !== null &&
    initialSelector.mode === "day" &&
    initialSelector.selectedDate === initialBerlinDateKey;
  const softFirstLoadRef = useRef(serverHydratedFirstLoad);

  const [flow, setFlow] = useState<GermanyDispatchSlotsResponse | null>(() =>
    serverHydratedFirstLoad ? initialEnergyFlow : null
  );
  const [recommendation, setRecommendation] = useState<BessRecommendation | null>(null);
  const [revenueModel, setRevenueModel] = useState<RevenueModelPayload | null>(null);
  const [previousDaySlots, setPreviousDaySlots] = useState<GermanyDispatchSlotsResponse["slots"]>([]);
  /** Berlin day D−2 slots; used only in day mode with carry-in to seed D−1’s starting SoC instead of forcing 0%. */
  const [dayBeforePreviousSlots, setDayBeforePreviousSlots] = useState<GermanyDispatchSlotsResponse["slots"]>([]);
  /** Slots for the window before the selected range; warm-starts multi-day SoC (week/custom). */
  const [socWarmupSlots, setSocWarmupSlots] = useState<GermanyDispatchSlotsResponse["slots"]>([]);
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
  const [perspectiveNarrative, setPerspectiveNarrative] = useState<string | null>(null);
  const [perspectiveSource, setPerspectiveSource] = useState<"llm" | "fallback_numeric" | null>(
    null
  );
  const [isPerspectiveLoading, setIsPerspectiveLoading] = useState(false);
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

  const skipStoryWindowUrlNotifyRef = useRef(true);
  useEffect(() => {
    if (!onStoryWindowUrlChange) {
      return;
    }
    if (skipStoryWindowUrlNotifyRef.current) {
      skipStoryWindowUrlNotifyRef.current = false;
      return;
    }
    onStoryWindowUrlChange(currentBriefingStoryWindow);
  }, [currentBriefingStoryWindow, onStoryWindowUrlChange]);

  useEffect(() => {
    if (!onBriefingStoryWindowChange) {
      return;
    }
    onBriefingStoryWindowChange(currentBriefingStoryWindow);
  }, [currentBriefingStoryWindow, onBriefingStoryWindowChange]);

  /** Loads trail windows for SoC carry-in (D−1/D−2 in day mode, prior week/month/custom span otherwise). */
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
            setSocWarmupSlots(parsed.data.slots);
            setPreviousDaySlots([]);
            setDayBeforePreviousSlots([]);
          }
        } catch {
          if (!controller.signal.aborted) {
            setSocWarmupSlots([]);
            setPreviousDaySlots([]);
            setDayBeforePreviousSlots([]);
          }
        }
        return;
      }
      if (selectorMode === "month") {
        try {
          const prevMonth = shiftMonthKey(selectedMonth, -1);
          const resp = await fetch(`/api/market/de/energy-flow?month=${prevMonth}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!resp.ok) {
            throw new Error(`energy flow prior month ${resp.status}`);
          }
          const parsed = germanyEnergyFlowApiSchema.safeParse(await resp.json());
          if (!parsed.success) {
            throw new Error("prior month schema");
          }
          if (!controller.signal.aborted) {
            setSocWarmupSlots(parsed.data.slots);
            setPreviousDaySlots([]);
            setDayBeforePreviousSlots([]);
          }
        } catch {
          if (!controller.signal.aborted) {
            setSocWarmupSlots([]);
            setPreviousDaySlots([]);
            setDayBeforePreviousSlots([]);
          }
        }
        return;
      }
      if (selectorMode === "custom") {
        try {
          const { warmupStart, warmupEnd } = priorWindowMatchingSpan(
            customRangeStart,
            customRangeEnd
          );
          const resp = await fetch(
            `/api/market/de/energy-flow?start=${warmupStart}&end=${warmupEnd}`,
            {
              cache: "no-store",
              signal: controller.signal,
            }
          );
          if (!resp.ok) {
            throw new Error(`energy flow prior custom window ${resp.status}`);
          }
          const parsed = germanyEnergyFlowApiSchema.safeParse(await resp.json());
          if (!parsed.success) {
            throw new Error("prior custom window schema");
          }
          if (!controller.signal.aborted) {
            setSocWarmupSlots(parsed.data.slots);
            setPreviousDaySlots([]);
            setDayBeforePreviousSlots([]);
          }
        } catch {
          if (!controller.signal.aborted) {
            setSocWarmupSlots([]);
            setPreviousDaySlots([]);
            setDayBeforePreviousSlots([]);
          }
        }
        return;
      }
      if (selectorMode !== "day") {
        if (!controller.signal.aborted) {
          setSocWarmupSlots([]);
          setPreviousDaySlots([]);
          setDayBeforePreviousSlots([]);
        }
        return;
      }
      try {
        if (!controller.signal.aborted) {
          setSocWarmupSlots([]);
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
  }, [selectorMode, selectedDate, selectedWeek, selectedMonth, customRangeStart, customRangeEnd]);

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
          profileSubtitle: "",
          simBenefitsEyebrow: "Fenster-Wirkung",
          simBenefitsNetLabel: "Nettobilanz (simuliert)",
          simBenefitsHeroLabel: "Netzentlastung",
          simBenefitsHeroDetail: "Summe |Netto| je Viertelstunde gesenkt",
          simBenefitsSwingCompare: (raw: string, simulated: string) => `${raw} Roh → ${simulated} simuliert`,
          simBenefitsNetBalanceNote: (net: string, endSoc: string) =>
            `Tages-Nettobilanz ${net} bleibt fast gleich — Speicher verschiebt Energie in der Zeit, erzeugt keine. End-SoC ~${endSoc}.`,
          simBenefitsNetVsObserved: (observed: string, simulated: string) =>
            `Beobachtet ${observed} → simuliert ${simulated}`,
          simBenefitsImpactEyebrow: "Modell-Wirkung",
          simBenefitsGridReliefLabel: "Netzentlastung",
          simBenefitsGridReliefDetail: "Summe |Netto| gesenkt",
          simBenefitsImportSavedDetail: "Grenzbezug reduziert",
          simBenefitsChargeDetail: (deltaPp: string) => `+${deltaPp} pp ggü. Flotte`,
          simBenefitsChargeDetailFallback: "Ladechance aufgenommen",
          simBenefitsMissedChargeLabel: "Verpasste Ladechance",
          simBenefitsMissedChargeDetail: "Rest trotz Kapazitätsgrenze",
          simBenefitsDeficitServedLabel: "Defizit gedeckt",
          simBenefitsDeficitServedDetail: "Aus Speicher geliefert",
          simBenefitsSurplusAbsorbedLabel: "Überschuss aufgenommen",
          simBenefitsSurplusAbsorbedDetail: "Ins BESS eingespeichert",
          simBenefitsCurtailmentAbsorbedLabel: "Abregelung vermieden",
          simBenefitsCurtailmentAbsorbedDetail: "Redispatch-Potenzial",
          simBenefitsLead:
            "Modelliertes BESS glättet Schwankungen, nutzt Ladechance und reduziert Importbedarf im selben Fenster.",
          simBenefitsPeakLabel: "Peak-Reduktion",
          simBenefitsImportLabel: "Import gespart",
          simBenefitsChargeLabel: "Ladechance genutzt",
          simBenefitsCurtailmentLabel: "Abregelung",
          simBenefitsCurtailmentUnavailable: "Keine Abregelungsdaten",
          simBenefitsCurtailmentDetail: (peak: string, absorbed: string, total: string) =>
            `${peak} Spitze · ${absorbed}/${total}`,
          simBenefitsCurtailmentSourceInfo:
            "Quelle: Netztransparenz.de · designierte Abregelung (nicht in Energy-Charts-Erzeugung)",
          simBenefitsRedispatchLabel: "Redispatch",
          simBenefitsRedispatchDetail: (price: string) => `${price} EUR/MWh · auf Abregelung`,
          simBenefitsRedispatchUnavailable: "Kein Redispatch-Proxy",
          simBenefitsRedispatchSourceInfo: (source: string) => `Quelle: ${source}`,
          simBenefitsRedispatchSourceFallback: "Quelle: Netztransparenz.de · berechnete Redispatch-Preise",
          simBenefitsAuxSourcesFootnote:
            "Abregelung & Redispatch: Netztransparenz.de — designierte Abregelung bzw. berechnete Redispatch-Preise, nicht in Energy-Charts-Erzeugung.",
          simBenefitsChargeDelta: (fleet: string, sim: string) => `${fleet} heute → ${sim} Simulation`,
          simBenefitsEconomicsLine: (perMwh: string) => `Indik. ${perMwh} · kein Prognoseerlös`,
          simBenefitsDisclaimer: "Modell · Energy-Charts · SMARD-Proxy",
          observedStressEyebrow: "System-Widersprüche",
          observedStressLead:
            "Gleichzeitig im Fenster: Überschuss, Import und Abregelung — slotweise nicht addierbar, systemisch widersprüchlich.",
          observedStressNetLabel: "Nettobilanz",
          observedStressNetSurplusBadge: "Überschuss",
          observedStressNetDeficitBadge: "Defizit",
          observedStressNetBalancedBadge: "Ausgeglichen",
          observedStressNetSurplusHint: "Erzeugung über Last (positiv)",
          observedStressNetDeficitHint: "Erzeugung unter Last (negativ)",
          observedStressNetBalancedHint: "Erzeugung ≈ Last",
          observedStressParadoxEyebrow: "Parallel im Fenster",
          observedStressSurplusLabel: "Überschuss",
          observedStressSurplusDetail: "Strukturelle Ladechance (+)",
          observedStressImportLabel: "Importe",
          observedStressImportDetail: "Grenzbezug trotz Inlandsüberschuss",
          observedStressImportUnavailable: "Keine Grenzdaten",
          observedStressCurtailmentLabel: "Abregelung",
          observedStressCurtailmentDetail: "EE verworfen",
          observedStressDeficitLabel: "Defizit",
          observedStressDeficitDetail: "Minus-Slots (−)",
          observedStressDisclaimer: "Beobachtet · Energy-Charts · Netztransparenz",
          twelveMonthDetailsSummary: "Jahresperspektive · 12M Balanced",
          perspectiveSectionTitle: "Jahresperspektive",
          perspectiveLoading: "Jahresperspektive wird formuliert …",
          perspectiveSourceLlm: "LLM-Einordnung · indikatives Modell",
          perspectiveSourceFallback: "Regelbasierte Einordnung · indikatives Modell",
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
          onePagerStructuralLead: "",
          onePagerBorderTradeTitle: "Beobachteter Grenzhandel (Import + Export)",
          onePagerInstalledFleetEyebrow: "Performance der aktuellen Flotte",
          onePagerInstalledFleetLead: "",
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
          workspaceChartsLead: "",
          chartBlockFootnote: "Energy-Charts · modelliert",
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
          profileSubtitle: "",
          simBenefitsEyebrow: "Window impact",
          simBenefitsNetLabel: "Net balance (simulated)",
          simBenefitsHeroLabel: "Grid relief",
          simBenefitsHeroDetail: "Sum of |net| per quarter-hour reduced",
          simBenefitsSwingCompare: (raw: string, simulated: string) => `${raw} raw → ${simulated} simulated`,
          simBenefitsNetBalanceNote: (net: string, endSoc: string) =>
            `Daily net balance ${net} stays nearly unchanged — storage shifts energy in time, it does not create any. End SoC ~${endSoc}.`,
          simBenefitsNetVsObserved: (observed: string, simulated: string) =>
            `Observed ${observed} → simulated ${simulated}`,
          simBenefitsImpactEyebrow: "Model impact",
          simBenefitsGridReliefLabel: "Grid relief",
          simBenefitsGridReliefDetail: "Sum of |net| reduced",
          simBenefitsImportSavedDetail: "Border inflow reduced",
          simBenefitsChargeDetail: (deltaPp: string) => `+${deltaPp} pp vs. fleet`,
          simBenefitsChargeDetailFallback: "Charge opportunity absorbed",
          simBenefitsMissedChargeLabel: "Missed charge opportunity",
          simBenefitsMissedChargeDetail: "Remainder despite capacity cap",
          simBenefitsDeficitServedLabel: "Deficit served",
          simBenefitsDeficitServedDetail: "Delivered from storage",
          simBenefitsSurplusAbsorbedLabel: "Surplus absorbed",
          simBenefitsSurplusAbsorbedDetail: "Stored in BESS",
          simBenefitsCurtailmentAbsorbedLabel: "Curtailment avoided",
          simBenefitsCurtailmentAbsorbedDetail: "Redispatch potential",
          simBenefitsLead:
            "Modeled BESS smooths swings, uses charge opportunity, and cuts import need in the same window.",
          simBenefitsPeakLabel: "Peak reduction",
          simBenefitsImportLabel: "Import avoided",
          simBenefitsChargeLabel: "Charge opportunity used",
          simBenefitsCurtailmentLabel: "Curtailment",
          simBenefitsCurtailmentUnavailable: "No curtailment data",
          simBenefitsCurtailmentDetail: (peak: string, absorbed: string, total: string) =>
            `${peak} peak · ${absorbed}/${total}`,
          simBenefitsCurtailmentSourceInfo:
            "Source: Netztransparenz.de · designated curtailment (not in Energy-Charts generation)",
          simBenefitsRedispatchLabel: "Redispatch",
          simBenefitsRedispatchDetail: (price: string) => `${price} EUR/MWh · on curtailment`,
          simBenefitsRedispatchUnavailable: "No redispatch proxy",
          simBenefitsRedispatchSourceInfo: (source: string) => `Source: ${source}`,
          simBenefitsRedispatchSourceFallback:
            "Source: Netztransparenz.de · calculated redispatch prices",
          simBenefitsAuxSourcesFootnote:
            "Curtailment & redispatch: Netztransparenz.de — designated curtailment and calculated redispatch prices, not in Energy-Charts generation.",
          simBenefitsChargeDelta: (fleet: string, sim: string) => `${fleet} today → ${sim} simulation`,
          simBenefitsEconomicsLine: (perMwh: string) => `Indic. ${perMwh} · not forecast revenue`,
          simBenefitsDisclaimer: "Model · Energy-Charts · SMARD proxy",
          observedStressEyebrow: "System paradoxes",
          observedStressLead:
            "In the same window: surplus, imports, and curtailment — not additive slot-by-slot, structurally contradictory.",
          observedStressNetLabel: "Net balance",
          observedStressNetSurplusBadge: "Surplus",
          observedStressNetDeficitBadge: "Deficit",
          observedStressNetBalancedBadge: "Balanced",
          observedStressNetSurplusHint: "Generation above load (positive)",
          observedStressNetDeficitHint: "Generation below load (negative)",
          observedStressNetBalancedHint: "Generation ≈ load",
          observedStressParadoxEyebrow: "In parallel in window",
          observedStressSurplusLabel: "Surplus",
          observedStressSurplusDetail: "Structural charge opportunity (+)",
          observedStressImportLabel: "Imports",
          observedStressImportDetail: "Border inflow despite domestic surplus",
          observedStressImportUnavailable: "No border data",
          observedStressCurtailmentLabel: "Curtailment",
          observedStressCurtailmentDetail: "Renewables curtailed",
          observedStressDeficitLabel: "Deficit",
          observedStressDeficitDetail: "Negative slots (−)",
          observedStressDisclaimer: "Observed · Energy-Charts · Netztransparenz",
          twelveMonthDetailsSummary: "Annual view · 12M balanced",
          perspectiveSectionTitle: "Annual perspective",
          perspectiveLoading: "Formulating annual perspective …",
          perspectiveSourceLlm: "LLM narrative · indicative model",
          perspectiveSourceFallback: "Rule-based narrative · indicative model",
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
          onePagerStructuralLead: "",
          onePagerBorderTradeTitle: "Observed cross-border trade (imports + exports)",
          onePagerInstalledFleetEyebrow: "Current fleet performance",
          onePagerInstalledFleetLead: "",
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
          workspaceChartsLead: "",
          chartBlockFootnote: "Energy-Charts · modeled",
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
    if (
      (selectorMode === "week" ||
        selectorMode === "month" ||
        selectorMode === "custom") &&
      socWarmupSlots.length > 0
    ) {
      const endMwh = computeEndPracticalSocMwh(socWarmupSlots, fleetEnergyCapacityMwh, {
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
    socWarmupSlots,
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
    if (
      (selectorMode === "week" ||
        selectorMode === "month" ||
        selectorMode === "custom") &&
      socWarmupSlots.length > 0
    ) {
      const dispatchPowerMw = practicalDispatchBalancedPowerMw;
      if (
        dispatchPowerMw === null ||
        dispatchPowerMw <= 0 ||
        !Number.isFinite(dispatchPowerMw)
      ) {
        return 0;
      }
      const endMwh = computeEndPracticalSocMwh(
        socWarmupSlots,
        effectivePracticalCapacityMwh,
        {
          initialSocMwh: 0,
          maxPowerMw: dispatchPowerMw,
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
    socWarmupSlots,
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

  const netSwingTotalsMwh = useMemo(() => {
    if (!chartRows.length) {
      return { baselineAbsMwh: 0, adjustedAbsMwh: 0 };
    }
    let baselineAbsMwh = 0;
    let adjustedAbsMwh = 0;
    for (const row of chartRows) {
      baselineAbsMwh += Math.abs(row.netBalanceMw) * QUARTER_HOUR_H;
      adjustedAbsMwh += Math.abs(row.netAfterPracticalBessMw) * QUARTER_HOUR_H;
    }
    return { baselineAbsMwh, adjustedAbsMwh };
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

  const selectorLabel =
    selectorMode === "day"
      ? selectedDate
      : selectorMode === "week"
        ? `${selectedWeek} (${isoWeekKeyToBerlinStartKey(selectedWeek)} - ${addBerlinCalendarDays(
            isoWeekKeyToBerlinStartKey(selectedWeek),
            6
          )})`
        : selectorMode === "month"
          ? monthLabelFormatter.format(new Date(`${selectedMonth}-01T00:00:00.000Z`))
          : `${customRangeStart} – ${customRangeEnd}`;
  const balancedRecommendation = recommendationByTier?.balanced ?? null;
  const marketReference = revenueModel?.marketReference ?? null;

  useEffect(() => {
    const balanced = recommendationByTier?.balanced;
    if (!recommendation || !balanced) {
      setPerspectiveNarrative(null);
      setPerspectiveSource(null);
      return;
    }

    const controller = new AbortController();
    const payload = {
      language,
      lookbackLabel: `${recommendation.rangeStartBerlin}–${recommendation.rangeEndBerlin}`,
      recommendedEnergyGwh: balanced.recommendedEnergyMwh / 1_000,
      recommendedPowerGw: balanced.recommendedPowerMw / 1_000,
      paybackYears: recommendation.indicativeEconomicsAtBalancedTier?.paybackYears ?? null,
      absorbedSurplusSharePct: recommendation.impactAtBalancedTier
        ? recommendation.impactAtBalancedTier.absorbedSurplusShare * 100
        : null,
      servedDeficitSharePct: recommendation.impactAtBalancedTier
        ? recommendation.impactAtBalancedTier.servedDeficitShare * 100
        : null,
      annualRevenueEur: balancedRevenueTileValue,
      peakSocGwh: recommendation.continuousWindowRequiredEnergyMwh / 1_000,
      windowLabel: selectorLabel,
    };

    setPerspectiveNarrative(buildGermanyPerspectiveFallback(payload));
    setPerspectiveSource("fallback_numeric");
    setIsPerspectiveLoading(true);

    const load = async () => {
      try {
        const response = await fetch("/api/briefing/germany-perspective", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`perspective ${response.status}`);
        }
        const raw: unknown = await response.json();
        const parsed = z
          .object({
            source: z.enum(["llm", "fallback_numeric"]),
            narrative: z.string().min(1),
          })
          .safeParse(raw);
        if (!parsed.success || controller.signal.aborted) {
          return;
        }
        setPerspectiveNarrative(parsed.data.narrative);
        setPerspectiveSource(parsed.data.source);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        log("germany perspective fetch failed %o", { error });
      } finally {
        if (!controller.signal.aborted) {
          setIsPerspectiveLoading(false);
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [
    recommendation,
    recommendationByTier,
    language,
    selectorLabel,
    balancedRevenueTileValue,
  ]);

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
  const currentWeekKey = berlinDateKeyToIsoWeekKey(todayKey);
  const currentMonthKey = todayKey.slice(0, 7);
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
  const currentFleetScenario = useMemo(() => {
    if (
      !flow?.slots.length ||
      fleetEnergyCapacityMwh === null ||
      fleetEnergyCapacityMwh <= 0 ||
      fleetPowerMw === null ||
      fleetPowerMw <= 0
    ) {
      return null;
    }
    return evaluateBessScenario({
      slots: flow.slots,
      capacityMwh: fleetEnergyCapacityMwh,
      maxPowerMw: fleetPowerMw,
      initialSocMwh: estimatedInitialFleetSocMwh,
      resetDailyByBerlin: visualizationResetDailyByBerlin,
      marketReference,
    });
  }, [
    flow?.slots,
    fleetEnergyCapacityMwh,
    fleetPowerMw,
    estimatedInitialFleetSocMwh,
    visualizationResetDailyByBerlin,
    marketReference,
  ]);

  const modeledScenario = useMemo(() => {
    if (!flow?.slots.length || effectivePracticalCapacityMwh <= 0) {
      return null;
    }
    const result = evaluateBessScenario({
      slots: flow.slots,
      capacityMwh: effectivePracticalCapacityMwh,
      maxPowerMw: practicalDispatchBalancedPowerMw,
      initialSocMwh: estimatedInitialSocMwh,
      resetDailyByBerlin: visualizationResetDailyByBerlin,
      marketReference,
    });
    return result;
  }, [
    flow?.slots,
    effectivePracticalCapacityMwh,
    practicalDispatchBalancedPowerMw,
    estimatedInitialSocMwh,
    visualizationResetDailyByBerlin,
    marketReference,
  ]);

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
                ? "flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 lg:flex-nowrap lg:justify-end lg:gap-y-1.5"
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
        <p className="mt-3 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
          {t.chartBlockFootnote}
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
      const currentStart = isoWeekKeyToBerlinStartKey(selectedWeek);
      setSelectedWeek(berlinDateKeyToIsoWeekKey(addBerlinCalendarDays(currentStart, -7)));
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
      const currentStart = isoWeekKeyToBerlinStartKey(selectedWeek);
      const nextWeek = berlinDateKeyToIsoWeekKey(addBerlinCalendarDays(currentStart, 7));
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
    <div
      aria-labelledby="simulated-capacity-override-heading"
      className="flex flex-col gap-2 rounded-xl border border-emerald-300/50 bg-emerald-50/40 px-3 py-2.5 dark:border-emerald-500/25 dark:bg-emerald-950/25 sm:flex-row sm:items-end"
    >
      <div className="min-w-0 flex-1">
        <p
          id="simulated-capacity-override-heading"
          className="text-[9px] font-semibold uppercase tracking-[0.14em] text-emerald-800 dark:text-emerald-300"
        >
          {t.simulatedCapacityControlEyebrow}
        </p>
        <label htmlFor={simulatedCapacityInputId} className="mt-1 block text-[11px] font-medium text-slate-600 dark:text-slate-300">
          {t.simulatedCapacityInputLabel}
        </label>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-md">
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
            className={`h-9 w-full rounded-lg border bg-white pr-12 pl-3 text-sm font-bold tabular-nums text-slate-900 outline-none focus-visible:ring-2 dark:bg-slate-950/90 dark:text-white ${
              customSimulatedCapacityDraftInvalid
                ? "border-rose-400/90 focus-visible:ring-rose-400/25"
                : "border-emerald-400/70 focus-visible:ring-emerald-400/30"
            }`}
          />
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            GWh
          </span>
        </div>
        <p id={simulatedCapacityHintId} className="text-[10px] text-slate-500 dark:text-slate-400">
          {autoSimulatedCapacityGwhLabel
            ? language === "de"
              ? `Auto: ${autoSimulatedCapacityGwhLabel}`
              : `Auto: ${autoSimulatedCapacityGwhLabel}`
            : t.simulatedCapacityInputHintUnavailable}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={!canApplyCustomSimulatedCapacity}
          className="h-9 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-500 dark:bg-emerald-500"
          onClick={applyCustomSimulatedCapacity}
        >
          {t.simulatedCapacityApply}
        </Button>
        {hasCustomSimulatedCapacity || hasPendingCapacityApply ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-lg px-3 text-xs font-semibold"
            onClick={resetCustomSimulatedCapacity}
          >
            {t.simulatedCapacityReset}
          </Button>
        ) : null}
      </div>
    </div>
  );

  const simCaptureDateKey =
    flow?.rangeStartBerlin &&
    flow?.rangeEndBerlin &&
    flow.rangeStartBerlin !== flow.rangeEndBerlin
      ? `${flow.rangeStartBerlin}_${flow.rangeEndBerlin}`
      : (flow?.dateBerlin ?? "germany");

  const renderDualFlowChartsBlock = (afterSimulatedChart?: ReactNode) => (
    <div
      id="speicherpilot-germany-flow-capture"
      className="space-y-3 rounded-2xl border border-border/70 bg-card/50 p-3 dark:border-slate-600/45 dark:bg-slate-950/40 md:p-4"
    >
      <div className="flex min-w-0 flex-col gap-4">
        {renderFlowChartSection("observed", {
          chartActions: (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full border-border/70 bg-background/80 shadow-sm dark:bg-slate-950/60"
              aria-label={t.chartFullscreenExpand}
              data-export-ignore
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
        {renderSimulatedCapacityOverridePanel()}
        <div id={GERMANY_SIM_FLOW_CAPTURE_ID} className="flex min-w-0 flex-col gap-3">
          {renderFlowChartSection("simulated", {
            chartActions: (
              <div className="flex shrink-0 items-start gap-2" data-export-ignore>
                <SimulatedFlowPngButton
                  language={language}
                  captureElementId={GERMANY_SIM_FLOW_CAPTURE_ID}
                  dateBerlin={simCaptureDateKey}
                  disabled={!flow?.slots.length || modeledScenario === null}
                />
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
              </div>
            ),
          })}
          {afterSimulatedChart}
        </div>
      </div>
    </div>
  );

  const renderDashboard = () => {
    const simChargeSharePct =
      modeledScenario !== null
        ? modeledScenario.coverage.absorbedSurplusShare * 100
        : null;

    const totalCurtailmentMwh =
      modeledScenario?.coverage.totalCurtailmentEnergyMwh ??
      slotStructuralTotalsForKpis.totalCurtailmentEnergyMwh;
    const curtailmentStatusHint =
      flow?.curtailmentStatus === "loaded"
        ? t.curtailmentStatusConfigured
        : flow?.curtailmentStatus === "unavailable_not_configured"
          ? t.curtailmentStatusMissingConfig
          : t.curtailmentStatusUpstream;
    const gridReliefPctForSim = modeledScenario?.gridImpactReductionPct ?? null;
    const hasDeficitToServe =
      modeledScenario !== null && modeledScenario.coverage.totalDeficitEnergyMwh > 1e-9;
    const hasSurplusToAbsorb =
      modeledScenario !== null && modeledScenario.coverage.totalChargeOpportunityEnergyMwh > 1e-9;
    const servedDeficitPctForSim =
      modeledScenario !== null && hasDeficitToServe
        ? modeledScenario.coverage.servedDeficitShare * 100
        : null;
    const absorbedSurplusMwh =
      modeledScenario !== null ? modeledScenario.coverage.absorbedSurplusEnergyMwh : null;
    const absorbedCurtailmentMwh =
      modeledScenario !== null ? modeledScenario.absorbedCurtailmentEnergyMwh : null;

    const simBenefitsMetrics: Array<{
      label: string;
      value: string;
      detail: string;
      tone: "surplus" | "warning" | "neutral";
    }> = hasSurplusToAbsorb && !hasDeficitToServe
      ? [
          {
            label: t.simBenefitsSurplusAbsorbedLabel,
            value:
              absorbedSurplusMwh !== null && absorbedSurplusMwh > 1e-6
                ? formatEnergyFromMwh(absorbedSurplusMwh)
                : "—",
            detail: t.simBenefitsSurplusAbsorbedDetail,
            tone: "surplus",
          },
          {
            label: t.simBenefitsChargeLabel,
            value:
              simChargeSharePct !== null ? `${pctFormatter.format(simChargeSharePct)}%` : "—",
            detail: t.simBenefitsChargeDetailFallback,
            tone: "surplus",
          },
          ...(absorbedCurtailmentMwh !== null && absorbedCurtailmentMwh > 1e-6
            ? [
                {
                  label: t.simBenefitsCurtailmentAbsorbedLabel,
                  value: formatEnergyFromMwh(absorbedCurtailmentMwh),
                  detail: t.simBenefitsCurtailmentAbsorbedDetail,
                  tone: "surplus" as const,
                },
              ]
            : []),
        ]
      : hasDeficitToServe
        ? [
            {
              label: t.simBenefitsDeficitServedLabel,
              value:
                servedDeficitPctForSim !== null
                  ? `${pctFormatter.format(servedDeficitPctForSim)}%`
                  : "—",
              detail: t.simBenefitsDeficitServedDetail,
              tone: "surplus",
            },
            {
              label: t.simBenefitsChargeLabel,
              value:
                simChargeSharePct !== null ? `${pctFormatter.format(simChargeSharePct)}%` : "—",
              detail: t.simBenefitsChargeDetailFallback,
              tone: "surplus",
            },
          ]
        : [
            {
              label: t.simBenefitsChargeLabel,
              value:
                simChargeSharePct !== null ? `${pctFormatter.format(simChargeSharePct)}%` : "—",
              detail: t.simBenefitsChargeDetailFallback,
              tone: "surplus",
            },
          ];

    const simBenefitsOverview = (
      <SimBenefitsSection
        selectorLabel={selectorLabel}
        capacitySuffix={simulatedCapacityGwhLabel}
        heroLabel={t.simBenefitsHeroLabel}
        heroValue={gridReliefPctForSim !== null ? `−${pctFormatter.format(gridReliefPctForSim)}%` : "—"}
        heroDetail={t.simBenefitsHeroDetail}
        impactEyebrow={t.simBenefitsImpactEyebrow}
        metrics={simBenefitsMetrics}
      />
    );

    const netMwhForObserved = windowNetStructuralBalanceGwh * 1_000;
    const netSignForObserved =
      netMwhForObserved > 1e-6 ? "surplus" : netMwhForObserved < -1e-6 ? "deficit" : "balanced";
    const hasSurplusForObserved = grossStructuralSurplusMwh > 1e-9;
    const hasDeficitForObserved = grossStructuralDeficitMwh > 1e-9;
    const hasImportsForObserved =
      borderTradeTotals !== null && borderTradeTotals.observedImportEnergyMwh > 1e-9;
    const hasCurtailmentForObserved = totalCurtailmentMwh > 1e-9;
    const workspaceContextStrip = (
      <ObservedStressSection
        selectorLabel={selectorLabel}
        netBalanceLabel={t.observedStressNetLabel}
        netBalanceValue={formatSignedEnergyFromMwh(netMwhForObserved)}
        netValueClass={
          netSignForObserved === "surplus"
            ? "text-emerald-600 dark:text-emerald-300"
            : netSignForObserved === "deficit"
              ? "text-rose-600 dark:text-rose-300"
              : "text-slate-700 dark:text-slate-200"
        }
        netBadgeClass={
          netSignForObserved === "surplus"
            ? "border-emerald-300/80 bg-emerald-50 text-emerald-900 dark:border-emerald-400/35 dark:bg-emerald-500/15 dark:text-emerald-100"
            : netSignForObserved === "deficit"
              ? "border-rose-300/80 bg-rose-50 text-rose-900 dark:border-rose-400/35 dark:bg-rose-500/15 dark:text-rose-100"
              : "border-slate-300/80 bg-slate-50 text-slate-800 dark:border-slate-500/35 dark:bg-slate-500/15 dark:text-slate-100"
        }
        netBadgeLabel={
          netSignForObserved === "surplus"
            ? t.observedStressNetSurplusBadge
            : netSignForObserved === "deficit"
              ? t.observedStressNetDeficitBadge
              : t.observedStressNetBalancedBadge
        }
        netHint={
          netSignForObserved === "surplus"
            ? t.observedStressNetSurplusHint
            : netSignForObserved === "deficit"
              ? t.observedStressNetDeficitHint
              : t.observedStressNetBalancedHint
        }
        sectionBorderClass={
          netSignForObserved === "surplus"
            ? "border-emerald-300/55 dark:border-emerald-500/30"
            : netSignForObserved === "deficit"
              ? "border-rose-300/55 dark:border-rose-500/30"
              : "border-slate-300/55 dark:border-slate-600/40"
        }
        sectionBgClass={
          netSignForObserved === "surplus"
            ? "from-emerald-50/90 dark:from-emerald-950/30"
            : netSignForObserved === "deficit"
              ? "from-rose-50/90 dark:from-rose-950/30"
              : "from-slate-50/90 dark:from-slate-900/40"
        }
        showParadoxLead={hasSurplusForObserved && hasImportsForObserved && hasCurtailmentForObserved}
        paradoxEyebrow={t.observedStressEyebrow}
        paradoxLead={t.observedStressLead}
        metricsEyebrow={t.observedStressParadoxEyebrow}
        metrics={[
          {
            label: t.observedStressSurplusLabel,
            value: hasSurplusForObserved
              ? `+${formatEnergyFromMwh(grossStructuralSurplusMwh)}`
              : formatEnergyFromMwh(0),
            detail: t.observedStressSurplusDetail,
            tone: "surplus",
          },
          {
            label: t.observedStressImportLabel,
            value: hasImportsForObserved
              ? formatEnergyFromMwh(borderTradeTotals!.observedImportEnergyMwh)
              : borderTradeTotals !== null
                ? formatEnergyFromMwh(0)
                : "—",
            detail: hasImportsForObserved
              ? t.observedStressImportDetail
              : borderTradeTotals !== null
                ? t.observedStressImportDetail
                : t.observedStressImportUnavailable,
            tone: "warning",
          },
          {
            label: t.observedStressCurtailmentLabel,
            value: hasCurtailmentForObserved
              ? formatEnergyFromMwh(totalCurtailmentMwh)
              : flow?.curtailmentStatus === "loaded"
                ? formatEnergyFromMwh(0)
                : "—",
            detail:
              hasCurtailmentForObserved || flow?.curtailmentStatus === "loaded"
                ? t.observedStressCurtailmentDetail
                : curtailmentStatusHint,
            tone: "warning",
          },
          {
            label: t.observedStressDeficitLabel,
            value: hasDeficitForObserved
              ? `−${formatEnergyFromMwh(grossStructuralDeficitMwh)}`
              : formatEnergyFromMwh(0),
            detail: t.observedStressDeficitDetail,
            tone: "deficit",
          },
        ]}
        disclaimer={t.observedStressDisclaimer}
      />
    );

    const renderTwelveMonthBalancedSection = () => {
      if (isRecommendationLoading) {
        return <Skeleton className="h-24 w-full rounded-xl" />;
      }
      if (recommendationLoadError || !recommendation || !balancedRecommendation) {
        return (
          <div className="rounded-xl border border-dashed border-slate-300/70 bg-white/60 p-4 text-sm text-slate-500 dark:border-slate-600/45 dark:bg-slate-950/35 dark:text-slate-400">
            {t.kpiRecommendationUnavailable}
          </div>
        );
      }

      const sourceLabel =
        perspectiveSource === "llm" ? t.perspectiveSourceLlm : t.perspectiveSourceFallback;

      return (
        <section
          className="rounded-xl border border-border/70 bg-muted/20 px-4 py-4 dark:border-slate-600/45 dark:bg-slate-950/25"
          aria-labelledby="twelve-month-perspective-heading"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p
              id="twelve-month-perspective-heading"
              className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400"
            >
              {t.perspectiveSectionTitle}
            </p>
            <p className="text-[9px] text-slate-400 dark:text-slate-500">
              {isPerspectiveLoading ? t.perspectiveLoading : sourceLabel}
            </p>
          </div>
          <PerspectiveNarrativeBody
            text={
              perspectiveNarrative ??
              buildGermanyPerspectiveFallback({
                language,
                lookbackLabel: `${recommendation.rangeStartBerlin}–${recommendation.rangeEndBerlin}`,
                recommendedEnergyGwh: balancedRecommendation.recommendedEnergyMwh / 1_000,
                recommendedPowerGw: balancedRecommendation.recommendedPowerMw / 1_000,
                paybackYears: recommendation.indicativeEconomicsAtBalancedTier?.paybackYears ?? null,
                absorbedSurplusSharePct: recommendation.impactAtBalancedTier
                  ? recommendation.impactAtBalancedTier.absorbedSurplusShare * 100
                  : null,
                servedDeficitSharePct: recommendation.impactAtBalancedTier
                  ? recommendation.impactAtBalancedTier.servedDeficitShare * 100
                  : null,
                annualRevenueEur: balancedRevenueTileValue,
                peakSocGwh: recommendation.continuousWindowRequiredEnergyMwh / 1_000,
                windowLabel: selectorLabel,
              })
            }
          />
        </section>
      );
    };

    return (
    <>
      <div className="min-w-0 space-y-4">
        <div className="rounded-2xl border border-border/75 bg-card/70 p-4 shadow-sm md:p-5 dark:border-white/[0.06] dark:bg-[rgba(10,16,28,0.76)]">
          <GermanyFlowPeriodSelector
            language={language}
            profileTitle={t.profileTitle}
            coverageSummaryLine={coverageSummaryLine}
            lastUpdatedIso={lastUpdatedIso}
            isRefreshing={isRefreshing}
            onRefresh={onRefresh}
            selectorMode={selectorMode}
            onSelectorModeChange={setSelectorMode}
            selectedDate={selectedDate}
            onSelectedDateChange={setSelectedDate}
            selectedWeek={selectedWeek}
            onSelectedWeekChange={setSelectedWeek}
            selectedMonth={selectedMonth}
            onSelectedMonthChange={setSelectedMonth}
            customRangeStart={customRangeStart}
            customRangeEnd={customRangeEnd}
            onCustomRangeChange={(start, end) => {
              setCustomRangeStart(start);
              setCustomRangeEnd(end);
            }}
            todayKey={todayKey}
            currentWeekKey={currentWeekKey}
            currentMonthKey={currentMonthKey}
            timeRangeCenterLabel={timeRangeCenterLabel}
            onPreviousWindow={handlePreviousWindow}
            onNextWindow={handleNextWindow}
            nextDisabled={nextDisabled}
            labels={{
              timeframeLabelShort: t.timeframeLabelShort,
              dayMode: t.dayMode,
              weekMode: t.weekMode,
              monthMode: t.monthMode,
              customMode: t.customMode,
              previousRange: t.previousRange,
              nextRange: t.nextRange,
            }}
          />

          <div className="space-y-4 pt-4">
            {workspaceContextStrip}

            {renderDualFlowChartsBlock(simBenefitsOverview)}

            <div className="pt-2">{renderTwelveMonthBalancedSection()}</div>
          </div>

          <p className="mt-3 text-[9px] text-slate-400 dark:text-slate-600">{t.technicalDisclaimer}</p>
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
