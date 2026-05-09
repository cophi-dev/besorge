"use client";

import { useEffect, useMemo, useState } from "react";
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
import { createLogger } from "@/lib/debug";
import type { GermanyDispatchSlotsResponse } from "@/lib/energyChartsApi";
import { germanyEnergyFlowPeriodSchema } from "@/lib/germanyEnergyFlowPeriod";
import { computeNetSurplusFleetAbsorption } from "@/lib/netSurplusFleetAbsorption";
import {
  computeCoverageAtCapacityMwh,
  computePracticalDailyCycleCapacityMwh,
  simulateAdjustedNetMwAtCapacity,
  simulatePracticalDispatchAtCapacity,
  simulateSocPctAtCapacityMwh,
} from "@/lib/optimalBessCapacity";

const log = createLogger("germany-day-energy-flow");

const EVENING_HOUR_START = 17;
const EVENING_HOUR_END = 21;

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

type SelectorMode = "day" | "week" | "month";

const monthLabelFormatter = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  month: "long",
  year: "numeric",
});

function berlinTodayKey(): string {
  return formatBerlinDateKeyFromUtcDate(new Date());
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

export default function GermanyDayEnergyFlow({
  fleetCapacityGwh,
  fleetPowerGw,
  language,
}: GermanyDayEnergyFlowProps) {
  const initialDateKey = berlinTodayKey();
  const [selectorMode, setSelectorMode] = useState<SelectorMode>("day");
  const [selectedDate, setSelectedDate] = useState(initialDateKey);
  const [selectedWeek, setSelectedWeek] = useState(dateKeyToIsoWeekKey(initialDateKey));
  const [selectedMonth, setSelectedMonth] = useState(initialDateKey.slice(0, 7));
  const [showSimulatedNet, setShowSimulatedNet] = useState(false);
  const [flow, setFlow] = useState<GermanyDispatchSlotsResponse | null>(null);
  const [previousDaySlots, setPreviousDaySlots] = useState<GermanyDispatchSlotsResponse["slots"]>([]);
  const [isFlowLoading, setIsFlowLoading] = useState(true);
  const [flowLoadError, setFlowLoadError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setIsFlowLoading(true);
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
        if (selectorMode === "day") {
          try {
            const previousDate = addBerlinCalendarDays(selectedDate, -1);
            const prevResp = await fetch(`/api/market/de/energy-flow?date=${previousDate}`, {
              cache: "no-store",
              signal: controller.signal,
            });
            if (!prevResp.ok) {
              throw new Error(`energy flow yesterday ${prevResp.status}`);
            }
            const prevRaw: unknown = await prevResp.json();
            const prevParsed = germanyEnergyFlowApiSchema.safeParse(prevRaw);
            if (!prevParsed.success) {
              throw new Error("yesterday schema");
            }
            if (!controller.signal.aborted) {
              setPreviousDaySlots(prevParsed.data.slots);
            }
          } catch {
            if (!controller.signal.aborted) {
              setPreviousDaySlots([]);
            }
          }
        } else if (!controller.signal.aborted) {
          setPreviousDaySlots([]);
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

  const t = useMemo(
    () =>
      language === "de"
      ? {
          eyebrow: "Energy-Charts Profile",
          title: "Deutschland-Tagesprofil – beobachteter Ueberschuss, Defizit & geschaetzter Flotten-SoC",
          subtitleFallback:
            "Kombinierte Darstellung: domestische Erzeugung minus Last aus Energy-Charts (Viertelstunden), plus geschaetzter Flotten-SoC aus einem praktischen Lade-/Entladepfad ueber dieselben Slots.",
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
          netFootnote:
            "Nettobilanz = Summe inländischer Erzeugung (Alle Erzeugungsreihen wie im Snapshot) minus Last. Positive Werte sind strukturelle Ueberschuss-Leistung im Slot vor Nettoimport/Export; negative Werte strukturelle Luecke.",
          socFootnote:
            "Geschaetzte SoC-Kurve: Reihenfolge der Viertelstunden wie im Chart; je Slot Begrenzung durch installierte Energiekapazitaet sowie AC-Leistung (MW × ¼ h) der Flotte — keine gemessenen Einzel-Anlagen-Staende.",
          kpiGross: "Brutto-Ueberschuss (Erz. − Last)",
          kpiAbsorbed: "Theoretisch speicherbar (Kap. + MW)",
          kpiMissed: "Verpasste Ueberschuss-Energie",
          kpiPracticalCap: "Praktische Tageszyklus-Kapazitaet (P95)",
          kpiPracticalCapNote:
            "Praktische Speichergroesse ist das 95. Perzentil des taeglichen Speicherbedarfs im gewaehlten Fenster; bei Tagesansicht mit fruehen Defizit-Stunden nutzen wir als Fallback die Vortags-Schaetzung.",
          kpiPracticalCapMax: "Tages-Maximum",
          recCoverage: (defPct: string, surPct: string) =>
            `Mit dieser empfohlenen Speichergroesse waeren rund ${defPct}% der Defizitenergie und ${surPct}% der Ueberschussenergie im beobachteten Fenster abgedeckt.`,
          kpiMethod:
            "Vereinfachtes Ladebandmodell ueber das beobachtete Fenster; keine Netzengpaesse, keine beobachteten Ladearbeitspunkte. Teil-Zeitraeume proportional.",
          coverage: (n: number, pct: string, date: string, multi: boolean) =>
            multi
              ? `${n} Viertelstunden (${pct}% des gewaehlten Fensters) · ${date}`
              : `${n} Viertelstunden beobachtet (${pct}% des Tages) · ${date}`,
          axisMw: "MW",
          axisSoc: "SoC (%)",
          practicalHint:
            "Bei aktivierter praktischer Simulation zeigt die praktische SoC-Linie auf derselben Viertelstunden-Reihe, wie Zusatzspeicher in Ueberschuss- und Defizitfenstern laden bzw. entladen wuerde.",
          carryoverEstimate: (pct: string) =>
            `Geschaetzter Start-SoC inkl. modelliertem Rest vom Vortag: ${pct}. Hinweis: keine gemessenen BESS-SoC-Daten, nur Modell-Schaetzung.`,
          marketDynamicsTeaser:
            "Preis- und Marktdynamik-Analyse folgt in einem kommenden Update.",
          unavailable:
            "Für keine Berlin-Tag-Linie reichenzeitig genug brauchbare Viertelstunden — bitte später erneut laden.",
          timeframe: "Zeitraum",
          dayMode: "Tag",
          weekMode: "Woche",
          monthMode: "Monat",
          previousRange: "Zurueck",
          nextRange: "Weiter",
          detailsLabel: "Details anzeigen",
          summaryLabel: "Kurzfassung",
          fetchError:
            "Energy-Charts-Zeitreihe konnte nicht geladen werden — bitte Verbindung prüfen und erneut versuchen.",
          dataNote: "Nur veroeffentlichte Energy-Charts-Viertelstunden; keine interpolierten Werte.",
          loadingEyebrow: "Energy-Charts werden geladen",
        }
      : {
          eyebrow: "Energy-Charts Profile",
          title: "Germany Day Profile – Observed Surplus, Deficit & Estimated Fleet SoC",
          subtitleFallback:
            "One combined line: domestic generation minus load from Energy-Charts (15-minute steps), plus estimated fleet SoC from a practical charge/discharge path over the same slots.",
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
          netFootnote:
            "Net balance = summed domestic generation in the snapshot stack minus load. Positive slots are structural surplus power before netting cross-border flows; negative slots structural shortfall.",
          socFootnote:
            "Estimated SoC path: walks quarter-hours in order; each slot is limited by fleet energy capacity and fleet AC power (MW × ¼ h) — not metered asset-level SOC.",
          kpiGross: "Gross surplus (gen − load)",
          kpiAbsorbed: "Theoretically storable (cap + MW)",
          kpiMissed: "Missed surplus energy",
          kpiPracticalCap: "Practical daily-cycle capacity (P95)",
          kpiPracticalCapNote:
            "Practical storage size is the 95th percentile of daily required storage in the selected window; in day view with early deficit-only hours we fall back to yesterday's estimate.",
          kpiPracticalCapMax: "Daily maximum",
          recCoverage: (defPct: string, surPct: string) =>
            `With this recommended storage size, about ${defPct}% of deficit energy and ${surPct}% of surplus energy would be covered in the observed window.`,
          kpiMethod:
            "Simplified greedy charge model over the observed window; ignores grid/export constraints and actual dispatch states. Partial-window caveat applies.",
          coverage: (n: number, pct: string, date: string, multi: boolean) =>
            multi
              ? `${n} quarter-hours (${pct}% of the selected window) · ${date}`
              : `${n} quarter-hours observed (${pct}% of day) · ${date}`,
          axisMw: "MW",
          axisSoc: "SoC (%)",
          practicalHint:
            "With practical simulation enabled, the practical SoC line uses the same quarter-hour series to show how incremental storage would charge during surplus and discharge during deficit windows.",
          carryoverEstimate: (pct: string) =>
            `Estimated starting SoC includes modeled carry-over from the previous day: ${pct}. Note: no measured BESS SoC telemetry, model estimate only.`,
          marketDynamicsTeaser:
            "Market price dynamics and financial modeling will be added in a coming update.",
          unavailable: "Not enough usable quarter-hours for a Berlin-day series yet — try again shortly.",
          timeframe: "Timeframe",
          dayMode: "Day",
          weekMode: "Week",
          monthMode: "Month",
          previousRange: "Previous",
          nextRange: "Next",
          detailsLabel: "Show details",
          summaryLabel: "Summary",
          fetchError: "Could not load the Energy-Charts series — check your connection and retry.",
          dataNote: "Published Energy-Charts quarter-hours only; no interpolated values.",
          loadingEyebrow: "Loading Energy-Charts",
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

  const effectivePracticalMaxDailyRequiredMwh = useMemo(() => {
    const current = practicalCapacity?.maxDailyRequiredMwh ?? 0;
    if (current > 0) {
      return current;
    }
    return previousDayPracticalCapacity?.maxDailyRequiredMwh ?? 0;
  }, [practicalCapacity, previousDayPracticalCapacity]);

  const estimatedInitialFleetSocMwh = useMemo(() => {
    if (
      selectorMode !== "day" ||
      fleetEnergyCapacityMwh === null ||
      fleetEnergyCapacityMwh <= 0 ||
      previousDaySlots.length === 0
    ) {
      return 0;
    }
    return computeNetSurplusFleetAbsorption(
      previousDaySlots,
      fleetEnergyCapacityMwh,
      fleetPowerMw
    ).endSocMwh;
  }, [selectorMode, previousDaySlots, fleetEnergyCapacityMwh, fleetPowerMw]);

  const absorption = useMemo(() => {
    if (!flow?.slots.length) {
      return null;
    }
    return computeNetSurplusFleetAbsorption(flow.slots, fleetEnergyCapacityMwh, fleetPowerMw, {
      initialSocMwh: estimatedInitialFleetSocMwh,
    });
  }, [flow, fleetEnergyCapacityMwh, fleetPowerMw, estimatedInitialFleetSocMwh]);

  const estimatedInitialSocMwh = useMemo(() => {
    if (
      selectorMode !== "day" ||
      effectivePracticalCapacityMwh <= 0 ||
      previousDaySlots.length === 0
    ) {
      return 0;
    }
    const prevSeries = simulatePracticalDispatchAtCapacity(
      previousDaySlots,
      effectivePracticalCapacityMwh,
      { resetDailyByBerlin: true }
    );
    const prevEndSocPct = prevSeries[prevSeries.length - 1]?.socPct ?? 0;
    return (prevEndSocPct / 100) * effectivePracticalCapacityMwh;
  }, [selectorMode, effectivePracticalCapacityMwh, previousDaySlots]);

  const recommendedCoverage = useMemo(() => {
    if (!flow?.slots.length || effectivePracticalCapacityMwh <= 0) {
      return null;
    }
    return computeCoverageAtCapacityMwh(flow.slots, effectivePracticalCapacityMwh, {
      resetDailyByBerlin: true,
    });
  }, [flow, effectivePracticalCapacityMwh]);

  const chartRows: ChartRow[] = useMemo(() => {
    if (!flow?.slots.length || !absorption) {
      return [];
    }
    const labeler = isMultiDayFlow ? timeFormatterMultiDay : timeFormatterSingleDay;
    const practicalSocSeries =
      effectivePracticalCapacityMwh > 0
        ? simulateSocPctAtCapacityMwh(flow.slots, effectivePracticalCapacityMwh, {
            resetDailyByBerlin: true,
            initialSocMwh: estimatedInitialSocMwh,
          })
        : [];
    const adjustedNetSeries =
      effectivePracticalCapacityMwh > 0
        ? simulateAdjustedNetMwAtCapacity(flow.slots, effectivePracticalCapacityMwh, {
            resetDailyByBerlin: true,
            initialSocMwh: estimatedInitialSocMwh,
          })
        : [];
    const practicalDispatchSeries =
      effectivePracticalCapacityMwh > 0
        ? simulatePracticalDispatchAtCapacity(flow.slots, effectivePracticalCapacityMwh, {
            resetDailyByBerlin: true,
            initialSocMwh: estimatedInitialSocMwh,
          })
        : [];
    const estimatedFleetSocSeries =
      fleetEnergyCapacityMwh !== null && fleetEnergyCapacityMwh > 0
        ? simulateSocPctAtCapacityMwh(flow.slots, fleetEnergyCapacityMwh, {
            resetDailyByBerlin: true,
            initialSocMwh: estimatedInitialFleetSocMwh,
          })
        : [];
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
    estimatedInitialSocMwh,
    fleetEnergyCapacityMwh,
    estimatedInitialFleetSocMwh,
  ]);

  const activeNetLegend = showSimulatedNet ? t.legendNetSimulated : t.legendNet;
  const activeNetDataKey = showSimulatedNet ? "netAfterPracticalBessMw" : "netBalanceMw";
  const activeSocLegend = showSimulatedNet ? t.legendPracticalSoc : t.legendFleetSoc;
  const activeSocDataKey = showSimulatedNet ? "simulatedPracticalSocPct" : "estimatedFleetSocPct";
  const activeSocCapacityMwh = showSimulatedNet
    ? (effectivePracticalCapacityMwh > 0 ? effectivePracticalCapacityMwh : null)
    : fleetEnergyCapacityMwh;
  const estimatedInitialSocPct =
    effectivePracticalCapacityMwh > 0
      ? (estimatedInitialSocMwh / effectivePracticalCapacityMwh) * 100
      : 0;
  const estimatedInitialFleetSocPct =
    fleetEnergyCapacityMwh !== null && fleetEnergyCapacityMwh > 0
      ? (estimatedInitialFleetSocMwh / fleetEnergyCapacityMwh) * 100
      : 0;

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

  const xAxisInterval = Math.max(0, Math.floor(chartRows.length / (isMultiDayFlow ? 24 : 12)) - 1);

  const dayStoryParagraphs = useMemo(() => {
    if (!flow?.slots.length || !absorption) {
      return null;
    }
    const pctWindow = pctFormatter.format(flow.pointFractionOfDay * 100);
    const grossFmt = formatEnergyFromMwh(absorption.grossSurplusEnergyMwh);
    const hasFleetKpis =
      fleetEnergyCapacityMwh !== null &&
      fleetEnergyCapacityMwh > 0 &&
      fleetPowerMw !== null &&
      fleetPowerMw > 0;
    const dateLine = isMultiDayFlow
      ? language === "de"
        ? `Im gewaehlten Fenster ${flow.dateBerlin} liegen ${flow.samplePoints.toString()} veroeffentlichte Viertelstunden (${pctWindow}% der erwarteten Slots in diesem Zeitraum). `
        : `Across ${flow.dateBerlin}, Energy-Charts published ${flow.samplePoints.toString()} quarter-hours (${pctWindow}% of the slots expected in this window). `
      : language === "de"
        ? `Am Berlin-Referenzdatum ${flow.dateBerlin} liegen ${flow.samplePoints.toString()} Viertelstunden vor (${pctWindow}% des Kalendertages). `
        : `On the Berlin reference day ${flow.dateBerlin}, we have ${flow.samplePoints.toString()} quarter-hours (${pctWindow}% of the calendar day). `;
    const deficitSharePct = recommendedCoverage
      ? pctFormatter.format(recommendedCoverage.servedDeficitShare * 100)
      : null;
    const surplusSharePct = recommendedCoverage
      ? pctFormatter.format(recommendedCoverage.absorbedSurplusShare * 100)
      : null;
    if (language === "de") {
      const spine =
        `${dateLine}Die Netz-Kurve zeigt strukturelle Ueber- oder Unterdeckung der Last durch die domestische Viertelstunden-Erzeugung aus Energy-Charts, bevor Imports/Exports einkalkuliert sind.`;
      if (!hasFleetKpis) {
        return {
          primary: spine,
          secondary:
            "Kombinierte Darstellung: domestische Erzeugung minus Last aus Energy-Charts (Viertelstunden), plus theoretischer Flotten-Lade-SoC, wenn Ueberschuss-Leistung voll mit der heutigen Kapazitaet aufgenommen werden koennte.",
        };
      }
      return {
        primary: spine,
        secondary: `Als erste Energiesumme liegen etwa ${grossFmt} strukturelle Brutto-Ueberschussenergie ueber einen reinen Laden-Pfad ohne Netzkupplungen. Unter heute angenommenen Flotten-MW plus Energiekappe sind davon etwa ${formatEnergyFromMwh(
          absorption.absorbedEnergyMwh
        )} theoretisch speicherbar — rund ${formatEnergyFromMwh(
          absorption.missedSurplusEnergyMwh
        )} verbleiben in diesem Vereinfachungsmodell.`,
        ...(deficitSharePct !== null && surplusSharePct !== null
          ? { tertiary: t.recCoverage(deficitSharePct, surplusSharePct) }
          : {}),
        ...(isMultiDayFlow
          ? {}
          : {
              quaternary:
                "Der violett gestrichelte SoC folgt denselben Viertelstunden ohne Netzzwang; das gelbe Abendfenster hebt das typische Spannungsband fuer Entladung hervor.",
            }),
      };
    }
    const spineEn = `${dateLine}The balance trace alternates structural surplus versus structural deficit (generation vs load within Energy-Charts totals) before imports and exports re-balance flows.`;
    if (!hasFleetKpis) {
      return {
        primary: spineEn,
        secondary:
          "One combined line: domestic generation minus load from Energy-Charts (15-minute steps), plus a theoretical fleet charging SoC if surplus power could be fully absorbed with today's nameplate capacity.",
      };
    }
    return {
      primary: spineEn,
      secondary: `Gross daytime structural surplus aggregates to roughly ${grossFmt} before cross-border netting. Against today's nominal fleet MW and energy cap about ${formatEnergyFromMwh(
        absorption.absorbedEnergyMwh
      )} could enter a hypothetical charge-only funnel, leaving ~${formatEnergyFromMwh(
        absorption.missedSurplusEnergyMwh
      )} outside this simplification.`,
      ...(deficitSharePct !== null && surplusSharePct !== null
        ? { tertiary: t.recCoverage(deficitSharePct, surplusSharePct) }
        : {}),
      ...(isMultiDayFlow
        ? {}
        : {
            quaternary:
              "The dashed violet SoC path mirrors the same chronological order without grid/export constraints—the amber evening band anchors the habitual discharge-pressure window.",
          }),
    };
  }, [absorption, flow, fleetEnergyCapacityMwh, fleetPowerMw, language, isMultiDayFlow, recommendedCoverage, t]);

  if (isFlowLoading) {
    return (
      <article className="scroll-mt-8 space-y-6 rounded-3xl border-2 border-slate-300/50 bg-white/80 p-6 shadow-lg md:p-8 dark:border-slate-500/40 dark:bg-slate-900/70 dark:shadow-black/35">
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
  const summaryLinePrimary = dayStoryParagraphs?.primary ?? t.subtitleFallback;
  const summaryLineSecondary = t.coverage(flow.samplePoints, coveragePct, flow.dateBerlin, isMultiDayFlow);

  return (
    <article
      id="germany-day-energy-flow"
      className="scroll-mt-8 space-y-8 rounded-3xl border border-slate-300/60 bg-white/95 p-5 shadow-[0_20px_48px_rgba(15,23,42,0.08)] md:p-8 lg:p-10 dark:border-slate-500/45 dark:bg-slate-900/90 dark:shadow-[0_24px_64px_rgba(0,0,0,0.4)]"
    >
      <header className="space-y-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase dark:text-slate-400">
              {t.eyebrow}
            </p>
            <h2 className="text-2xl font-semibold leading-tight tracking-tight text-slate-950 md:text-[2rem] dark:text-white">
              {t.title}
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-300">{summaryLineSecondary}</p>
          </div>
          <div className="w-full max-w-md rounded-2xl border border-slate-300/70 bg-slate-50/80 p-3 dark:border-slate-500/40 dark:bg-slate-950/60">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase dark:text-slate-400">
                {t.timeframe}
              </span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">{selectorLabel}</span>
            </div>
            <div className="mt-2 inline-flex rounded-xl border border-slate-300/80 bg-white p-1 dark:border-slate-500/50 dark:bg-slate-900">
            {([
              { mode: "day", label: t.dayMode },
              { mode: "week", label: t.weekMode },
              { mode: "month", label: t.monthMode },
            ] as const).map((option) => (
              <button
                key={option.mode}
                type="button"
                onClick={() => setSelectorMode(option.mode)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  selectorMode === option.mode
                    ? "bg-indigo-100 text-indigo-900 dark:bg-indigo-500/25 dark:text-indigo-100"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                }`}
              >
                {option.label}
              </button>
            ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
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
                className="rounded-lg border border-slate-300/70 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-indigo-400 hover:text-indigo-700 dark:border-slate-500/40 dark:bg-slate-900 dark:text-slate-200"
                aria-label={t.previousRange}
              >
                ←
              </button>
              {selectorMode === "day" ? (
                <input
                  type="date"
                  value={selectedDate}
                  max={todayKey}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="flex-1 rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/80 dark:border-slate-500/50 dark:bg-slate-900 dark:text-slate-100"
                />
              ) : null}
              {selectorMode === "week" ? (
                <input
                  type="week"
                  value={selectedWeek}
                  max={currentWeekKey}
                  onChange={(event) => setSelectedWeek(event.target.value)}
                  className="flex-1 rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/80 dark:border-slate-500/50 dark:bg-slate-900 dark:text-slate-100"
                />
              ) : null}
              {selectorMode === "month" ? (
                <input
                  type="month"
                  value={selectedMonth}
                  max={currentMonthKey}
                  onChange={(event) => setSelectedMonth(event.target.value)}
                  className="flex-1 rounded-xl border border-slate-300/80 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/80 dark:border-slate-500/50 dark:bg-slate-900 dark:text-slate-100"
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
                className="rounded-lg border border-slate-300/70 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-indigo-400 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-500/40 dark:bg-slate-900 dark:text-slate-200"
                aria-label={t.nextRange}
              >
                →
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
              {language === "de"
                ? "Diese Auswahl aktualisiert Chart und die drei KPI-Karten."
                : "This selection updates the chart and the three KPI cards."}
            </p>
          </div>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-indigo-200/80 bg-indigo-50/80 p-3.5 dark:border-indigo-400/25 dark:bg-indigo-400/10">
          <p className="text-[10px] font-medium tracking-[0.14em] text-indigo-950/80 uppercase dark:text-indigo-200/90">
            {t.kpiPracticalCap}
          </p>
          <p className="mt-1.5 text-xl font-bold tabular-nums text-indigo-950 md:text-2xl dark:text-indigo-50">
            {effectivePracticalCapacityMwh > 0 ? formatEnergyFromMwh(effectivePracticalCapacityMwh) : "—"}
          </p>
          <p className="mt-2 text-[11px] font-medium text-indigo-950/75 dark:text-indigo-50/75">
            {t.kpiPracticalCapNote}
          </p>
          {effectivePracticalMaxDailyRequiredMwh > 0 ? (
            <p className="mt-2 text-[11px] font-medium text-indigo-950/75 dark:text-indigo-50/75">
              {t.kpiPracticalCapMax}: {formatEnergyFromMwh(effectivePracticalMaxDailyRequiredMwh)}
            </p>
          ) : null}
        </div>
        <div className="rounded-xl border border-slate-200/85 bg-white/90 p-3.5 dark:border-slate-500/35 dark:bg-slate-900/50">
          <p className="text-[10px] font-medium tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
            {t.kpiGross}
          </p>
          <p className="mt-1.5 text-xl font-bold tabular-nums text-slate-900 md:text-2xl dark:text-white">
            {showMissedKpis && absorption ? formatEnergyFromMwh(absorption.grossSurplusEnergyMwh) : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-amber-200/80 bg-amber-50/95 p-3.5 dark:border-amber-400/25 dark:bg-amber-400/12">
          <p className="text-[10px] font-medium tracking-[0.14em] text-amber-900/80 uppercase dark:text-amber-200/90">
            {t.kpiMissed}
          </p>
          <p className="mt-1.5 text-xl font-bold tabular-nums text-amber-950 md:text-2xl dark:text-amber-50">
            {showMissedKpis && absorption ? formatEnergyFromMwh(absorption.missedSurplusEnergyMwh) : "—"}
          </p>
          {showMissedKpis && absorption && absorption.grossSurplusEnergyMwh > 1e-6 ? (
            <p className="mt-2 text-[11px] font-medium text-amber-950/85 dark:text-amber-50/85">
              {pctFormatter.format((absorption.missedSurplusEnergyMwh / absorption.grossSurplusEnergyMwh) * 100)}%{" "}
              {language === "de" ? "des Brutto-Ueberschusses" : "of gross surplus"}
            </p>
          ) : null}
        </div>
      </div>
      {showMissedKpis ? (
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t.kpiMethod}</p>
      ) : null}

      <div className="rounded-2xl border border-slate-300/55 bg-white/95 p-4 shadow-inner dark:border-slate-500/35 dark:bg-slate-950/55 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {t.chartTitle}
          </p>
          <button
            type="button"
            onClick={() => setShowSimulatedNet((current) => !current)}
            className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold transition ${
              showSimulatedNet
                ? "border-emerald-300/80 bg-emerald-50 text-emerald-900 dark:border-emerald-300/40 dark:bg-emerald-400/10 dark:text-emerald-100"
                : "border-slate-300/75 bg-white/80 text-slate-700 dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200"
            }`}
          >
            {t.toggleNetSimulation}
          </button>
          <div className="flex flex-wrap items-center gap-3">
            {showSimulatedNet ? (
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-300">
                {t.legendSimulatedPrefix}
              </span>
            ) : null}
            <LegendDot color="rgb(71,85,105)" label={activeNetLegend} />
            <LegendDot
              color={showSimulatedNet ? "rgb(16,185,129)" : "rgb(79,70,229)"}
              label={activeSocLegend}
            />
            {showSimulatedNet ? <LegendDot color="rgb(34,197,94)" label={t.legendPracticalCharge} /> : null}
            {showSimulatedNet ? <LegendDot color="rgb(249,115,22)" label={t.legendPracticalDischarge} /> : null}
            <LegendDot color="rgba(251,191,36,0.95)" label={t.legendEvening} />
          </div>
        </div>
        <div className="mt-3 h-[420px] w-full md:h-[520px] lg:h-[620px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartRows} margin={{ top: 8, right: 8, bottom: 6, left: 4 }}>
              <CartesianGrid stroke="rgba(148,163,184,0.18)" strokeDasharray="3 3" />
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 9, fill: "rgb(100,116,139)" }}
                interval={xAxisInterval}
              />
              <YAxis
                yAxisId="net"
                tick={{ fontSize: 10, fill: "rgb(100,116,139)" }}
                width={48}
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
                tick={{ fontSize: 9, fill: "rgb(100,116,139)" }}
                width={44}
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
                  background: "rgba(255,255,255,0.97)",
                  border: "1px solid rgba(148,163,184,0.45)",
                  borderRadius: 12,
                  fontSize: 12,
                }}
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
                stroke="rgb(71,85,105)"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive
                animationDuration={480}
              />
              {showSimulatedNet ? (
                <>
                  <Bar
                    yAxisId="net"
                    dataKey="practicalChargeSignedMw"
                    name={t.legendPracticalCharge}
                    fill="rgb(34,197,94)"
                    maxBarSize={8}
                  />
                  <Bar
                    yAxisId="net"
                    dataKey="practicalDischargeMw"
                    name={t.legendPracticalDischarge}
                    fill="rgb(249,115,22)"
                    maxBarSize={8}
                  />
                </>
              ) : null}
              <Line
                yAxisId="soc"
                type="monotone"
                dataKey={activeSocDataKey}
                name={activeSocLegend}
                stroke={showSimulatedNet ? "rgb(16,185,129)" : "rgb(79,70,229)"}
                strokeWidth={showSimulatedNet ? 1.6 : 1.5}
                strokeDasharray={showSimulatedNet ? undefined : "4 3"}
                dot={false}
                isAnimationActive
                animationDuration={480}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t.netFootnote}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t.socFootnote}</p>
      </div>
      <section className="max-w-4xl space-y-2 rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 dark:border-slate-600/40 dark:bg-slate-900/45">
        <p className="text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase dark:text-slate-400">
          {t.summaryLabel}
        </p>
        <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">{summaryLinePrimary}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{summaryLineSecondary}</p>
        <details className="group rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2 dark:border-slate-600/35 dark:bg-slate-900/50">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600 list-none dark:text-slate-300">
            {t.detailsLabel}
          </summary>
          <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            {dayStoryParagraphs ? (
              <>
                <p>{dayStoryParagraphs.primary}</p>
                <p>{dayStoryParagraphs.secondary}</p>
                {dayStoryParagraphs.tertiary ? <p>{dayStoryParagraphs.tertiary}</p> : null}
                {dayStoryParagraphs.quaternary ? <p>{dayStoryParagraphs.quaternary}</p> : null}
              </>
            ) : (
              <p>{t.subtitleFallback}</p>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">{t.dataNote}</p>
          </div>
        </details>
      </section>

      <p className="text-xs text-slate-600 dark:text-slate-400">{t.practicalHint}</p>
      {selectorMode === "day" && effectivePracticalCapacityMwh > 0 ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          {t.carryoverEstimate(
            `${pctFormatter.format(showSimulatedNet ? estimatedInitialSocPct : estimatedInitialFleetSocPct)}%`
          )}
        </p>
      ) : null}
      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t.marketDynamicsTeaser}</p>
    </article>
  );
}
