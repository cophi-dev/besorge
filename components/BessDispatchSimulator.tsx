"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BatteryCharging, Loader2, Zap } from "lucide-react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { z } from "zod";

import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage, type AppLanguage } from "@/components/language-context";
import { createLogger } from "@/lib/debug";

const log = createLogger("dispatch-simulator");

const STRATEGY_VALUE = "arbitrage_evening_priority" as const;

const POWER_MIN_MW = 50;
const POWER_MAX_MW = 2_000;
const CAPACITY_MIN_MWH = 100;
const CAPACITY_MAX_MWH = 8_000;
const RTE_MIN_PCT = 80;
const RTE_MAX_PCT = 99;

const DEFAULT_INPUTS = {
  powerMw: 500,
  capacityMwh: 2_000,
  rteEfficiencyPct: 92,
  strategy: STRATEGY_VALUE,
} as const;

const responseSchema = z.object({
  inputs: z.object({
    powerMw: z.number(),
    capacityMwh: z.number(),
    rteEfficiencyPct: z.number(),
    strategy: z.literal(STRATEGY_VALUE),
  }),
  dataset: z.object({
    dateBerlin: z.string(),
    samplePoints: z.number(),
    pointFractionOfDay: z.number(),
    source: z.literal("energy-charts.total_power"),
  }),
  schedule: z.array(
    z.object({
      timestampIso: z.string(),
      hourBerlin: z.number(),
      residualLoadMw: z.number(),
      priceProxyEurPerMwh: z.number(),
      action: z.enum(["charge", "discharge", "idle"]),
      powerMw: z.number(),
      socMwh: z.number(),
      socPct: z.number(),
    })
  ),
  results: z.object({
    energyChargedFromGridMwh: z.number(),
    energyDischargedToGridMwh: z.number(),
    avgChargePriceEurPerMwh: z.number(),
    avgDischargePriceEurPerMwh: z.number(),
    grossRevenueEur: z.number(),
    cycles: z.number(),
    eveningDeliveredMwh: z.number(),
    eveningCoveragePct: z.number(),
    averageSpreadEurPerMwh: z.number(),
    roundTripLossPct: z.number(),
  }),
  diagnostics: z.object({
    samplePoints: z.number(),
    chargeSlots: z.number(),
    dischargeSlots: z.number(),
    priceProxyMinEurPerMwh: z.number(),
    priceProxyMaxEurPerMwh: z.number(),
  }),
});

type DispatchResponse = z.infer<typeof responseSchema>;

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const INTEGER_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const EUR_FORMATTER = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const MWH_DETAIL_FORMATTER = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 3,
});

const QUARTER_HOUR_HOURS_DISPATCH = 0.25;

const EVENING_GAP_HOUR_START = 17;

const isEveningGapHour = (hourBerlin: number) =>
  hourBerlin >= EVENING_GAP_HOUR_START && hourBerlin < 21;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const copy = {
  en: {
    eyebrow: "Dispatch simulation",
    title: "BESS Dispatch Simulator",
    intro:
      "Run a real, daily dispatch simulation against today's quarter-hour Energy-Charts data. Pick a battery configuration and see how the asset would have charged, discharged, and earned across the day.",
    powerLabel: "Power (MW)",
    powerHint: "AC nameplate power, charge and discharge symmetric.",
    capacityLabel: "Capacity (MWh)",
    capacityHint: "Usable energy capacity. Default 2,000 MWh ≈ 4h at 500 MW.",
    rteLabel: "Round-trip efficiency (%)",
    rteHint: "Applied symmetrically as √η on each side.",
    strategyLabel: "Strategy",
    strategyOption: "Arbitrage + Evening Gap Priority",
    strategyDescription:
      "Charge during the cheapest residual-load slots, discharge into the most expensive slots with a strong bias toward the 17:00–21:00 evening flexibility gap.",
    runButton: "Run dispatch",
    runButtonLoading: "Running simulation...",
    sourceNote: "Simulation runs on today's real quarter-hour values from Energy-Charts.",
    durationLabel: "Duration",
    cyclesLabel: "Cycles",
    placeholderTitle: "Configure your battery and run a dispatch.",
    placeholderBody:
      "We will pull today's residual-load profile and walk an arbitrage schedule slot-by-slot, prioritizing the evening flexibility window.",
    errorTitle: "Could not run simulation",
    errorRetry: "Try again",
    kpiRevenue: "Gross revenue",
    kpiSpread: "Captured spread",
    kpiDelivered: "Delivered to grid",
    kpiEvening: "Evening coverage",
    kpiCharge: "Avg charge price",
    kpiDischarge: "Avg discharge price",
    kpiRteLoss: "Round-trip loss",
    kpiCycles: "Equivalent cycles",
    chartTitle: "Daily dispatch schedule",
    chartLegendCharge: "Charge",
    chartLegendDischarge: "Discharge",
    chartLegendSoc: "State of charge",
    chartLegendEvening: "Evening window",
    datasetLabel: "Berlin day",
    datasetSamples: (n: number, pct: number) =>
      `${n} quarter-hours observed (${INTEGER_FORMATTER.format(pct)}% of day)`,
    invalidInputs: "Inputs are out of range. Adjust and retry.",
    kpiEstimatedRevenueToday: "Estimated revenue today",
    kpiEveningGapCoverage: "Evening gap coverage",
    kpiCyclesToday: "Cycles today",
    kpiAvgEveningSoc: "Average SoC this evening",
    kpiPriceProxyHint: "Residual-load price proxy (larger deficit → higher assumed price). EPEX later.",
    chartSocTitle: "State of charge",
    chartDispatchTitle: "Dispatch timeline",
    chartAxisTime: "Time (Berlin)",
    chartAxisSoc: "SoC",
    chartAxisPowerDispatch: "Charge / discharge (MW)",
    chartLegendResidualOverlay: "Residual load",
    resultsMetaEyebrow: "Simulation result",
    kpiEveningGapFootnote: "Share of Σ max(0, residual) × ¼ h in 17–21 h (Berlin proxy).",
    kpiAvgEveningSocWindow: "17–21 h · average",
  },
  de: {
    eyebrow: "Dispatch-Simulation",
    title: "BESS Dispatch Simulator",
    intro:
      "Lassen Sie eine echte Tages-Dispatch-Simulation auf den heutigen Viertelstundenwerten von Energy-Charts laufen. Konfigurieren Sie die Batterie und sehen Sie, wie der Speicher heute geladen, entladen und Erlöse erzielt hätte.",
    powerLabel: "Leistung (MW)",
    powerHint: "AC-Nennleistung, symmetrisch für Lade- und Entladevorgang.",
    capacityLabel: "Kapazität (MWh)",
    capacityHint: "Nutzbare Energiekapazität. Default 2.000 MWh ≈ 4h bei 500 MW.",
    rteLabel: "Round-Trip Efficiency (%)",
    rteHint: "Symmetrisch als √η auf jeder Seite angewandt.",
    strategyLabel: "Strategie",
    strategyOption: "Arbitrage + Evening Gap Priorität",
    strategyDescription:
      "Laden in den günstigsten Restlast-Slots, Entladen in den teuersten Slots mit klarem Vorrang für die abendliche Flexibilitätslücke (17:00–21:00).",
    runButton: "Dispatch simulieren",
    runButtonLoading: "Simulation läuft...",
    sourceNote: "Simulation basiert auf heutigen realen Viertelstundenwerten (Energy-Charts).",
    durationLabel: "Dauer",
    cyclesLabel: "Zyklen",
    placeholderTitle: "Batterie konfigurieren und Dispatch starten.",
    placeholderBody:
      "Wir laden das heutige Restlastprofil und durchlaufen einen Arbitrage-Plan Slot für Slot, mit Priorität für das Abendfenster.",
    errorTitle: "Simulation konnte nicht ausgeführt werden",
    errorRetry: "Erneut versuchen",
    kpiRevenue: "Bruttoerlös",
    kpiSpread: "Eingefangener Spread",
    kpiDelivered: "Ans Netz geliefert",
    kpiEvening: "Abendabdeckung",
    kpiCharge: "Ø Ladepreis",
    kpiDischarge: "Ø Entladepreis",
    kpiRteLoss: "Round-Trip-Verlust",
    kpiCycles: "Äquivalente Zyklen",
    chartTitle: "Täglicher Dispatch-Plan",
    chartLegendCharge: "Laden",
    chartLegendDischarge: "Entladen",
    chartLegendSoc: "Ladezustand",
    chartLegendEvening: "Abendfenster",
    datasetLabel: "Berliner Tag",
    datasetSamples: (n: number, pct: number) =>
      `${n} Viertelstunden beobachtet (${INTEGER_FORMATTER.format(pct)}% des Tages)`,
    invalidInputs: "Eingaben außerhalb des Bereichs. Bitte anpassen und erneut versuchen.",
    kpiEstimatedRevenueToday: "Geschätzte Revenue heute",
    kpiEveningGapCoverage: "Evening-Gap-Abdeckung",
    kpiCyclesToday: "Zyklen heute",
    kpiAvgEveningSoc: "Ø SoC am Abend",
    kpiPriceProxyHint:
      "Preis-Proxy aus Restlast (höheres Defizit → höherer angenommener Preis). Später EPEX.",
    chartSocTitle: "SoC-Verlauf",
    chartDispatchTitle: "Dispatch-Zeitleiste",
    chartAxisTime: "Uhrzeit (Berlin)",
    chartAxisSoc: "SoC",
    chartAxisPowerDispatch: "Laden / Entladen (MW)",
    chartLegendResidualOverlay: "Restlast",
    resultsMetaEyebrow: "Simulationsergebnis",
    kpiEveningGapFootnote: "Anteil am Proxy Σ Restlast⁺ · ¼ h (17–21 Uhr, Berlin).",
    kpiAvgEveningSocWindow: "17–21 Uhr · Durchschnitt",
  },
} as const;

type ChartDatum = {
  index: number;
  /** Quarter-hour label HH:mm (Berlin). */
  timeLabel: string;
  hourBerlin: number;
  dischargeMw: number;
  /** Negative grid draw MW for bar chart. */
  chargeSignedMw: number;
  socPct: number;
  residualLoadMw: number;
};

export default function BessDispatchSimulator() {
  const { language } = useLanguage();
  const t = copy[language];
  const formId = useId();

  const [powerMw, setPowerMw] = useState<number>(DEFAULT_INPUTS.powerMw);
  const [capacityMwh, setCapacityMwh] = useState<number>(DEFAULT_INPUTS.capacityMwh);
  const [rteEfficiencyPct, setRteEfficiencyPct] = useState<number>(DEFAULT_INPUTS.rteEfficiencyPct);

  const [isRunning, setIsRunning] = useState(false);
  const [response, setResponse] = useState<DispatchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const durationHours = capacityMwh > 0 && powerMw > 0 ? capacityMwh / powerMw : 0;

  const inputsValid =
    Number.isFinite(powerMw) &&
    Number.isFinite(capacityMwh) &&
    Number.isFinite(rteEfficiencyPct) &&
    powerMw >= POWER_MIN_MW &&
    powerMw <= POWER_MAX_MW &&
    capacityMwh >= CAPACITY_MIN_MWH &&
    capacityMwh <= CAPACITY_MAX_MWH &&
    rteEfficiencyPct >= RTE_MIN_PCT &&
    rteEfficiencyPct <= RTE_MAX_PCT;

  const runSimulation = async () => {
    if (!inputsValid) {
      setError(t.invalidInputs);
      return;
    }
    setIsRunning(true);
    setError(null);
    try {
      const apiResponse = await fetch("/api/dispatch/de", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          powerMw,
          capacityMwh,
          rteEfficiencyPct,
          strategy: STRATEGY_VALUE,
        }),
        cache: "no-store",
      });

      if (!apiResponse.ok) {
        const payload = (await apiResponse.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? `Request failed with status ${apiResponse.status}`);
      }

      const payload = await apiResponse.json();
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) {
        log("dispatch response failed schema validation %o", {
          errors: parsed.error.flatten(),
        });
        throw new Error("Unexpected response shape from dispatch API.");
      }

      setResponse(parsed.data);
    } catch (caught) {
      log("dispatch simulation failed %o", { error: caught });
      setError(caught instanceof Error ? caught.message : language === "de" ? "Unbekannter Fehler" : "Unknown error");
    } finally {
      setIsRunning(false);
    }
  };

  const chartData = useMemo<ChartDatum[]>(() => {
    if (!response) {
      return [];
    }
    return response.schedule.map((entry, index) => {
      const date = new Date(entry.timestampIso);
      const timeLabel = new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
      const dischargeMw = entry.action === "discharge" ? entry.powerMw : 0;
      return {
        index,
        timeLabel,
        hourBerlin: entry.hourBerlin,
        dischargeMw,
        chargeSignedMw: entry.action === "charge" ? entry.powerMw : 0,
        socPct: entry.socPct,
        residualLoadMw: entry.residualLoadMw,
      };
    });
  }, [response]);

  const eveningBoundaries = useMemo(() => {
    if (chartData.length === 0) {
      return null;
    }
    const eveningSlots = chartData.filter((d) => isEveningGapHour(d.hourBerlin));
    if (eveningSlots.length === 0) {
      return null;
    }
    const startIndex = eveningSlots[0].index;
    const endIndex = eveningSlots[eveningSlots.length - 1].index;
    return { startIndex, endIndex };
  }, [chartData]);

  return (
    <section
      id="dispatch-simulator"
      className="glass-card relative overflow-hidden rounded-[2rem] p-6 md:p-10"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-emerald-300/20 via-transparent to-transparent dark:from-emerald-300/10" />

      <header className="relative">
        <p className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-emerald-700 uppercase dark:text-emerald-200">
          <Zap className="h-3.5 w-3.5" /> {t.eyebrow}
        </p>
        <h2 className="mt-3 max-w-3xl text-3xl text-slate-900 md:text-5xl dark:text-white [font-family:var(--font-heading)]">
          {t.title}
        </h2>
        <p className="mt-4 max-w-3xl text-base leading-relaxed text-slate-600 dark:text-slate-300 md:text-lg">
          {t.intro}
        </p>
      </header>

      <div
        className={`relative mt-8 grid min-w-0 gap-6 ${
          !response && !isRunning && !error
            ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
            : ""
        }`}
      >
        <form
          id={formId}
          className="min-w-0 rounded-2xl border border-slate-300/55 bg-white/85 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)] dark:border-slate-500/35 dark:bg-slate-900/70 md:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void runSimulation();
          }}
        >
          <NumberSliderField
            id={`${formId}-power`}
            label={t.powerLabel}
            unit="MW"
            min={POWER_MIN_MW}
            max={POWER_MAX_MW}
            step={10}
            value={powerMw}
            hint={t.powerHint}
            onChange={(value) => setPowerMw(clamp(value, POWER_MIN_MW, POWER_MAX_MW))}
          />

          <div className="mt-5">
            <NumberSliderField
              id={`${formId}-capacity`}
              label={t.capacityLabel}
              unit="MWh"
              min={CAPACITY_MIN_MWH}
              max={CAPACITY_MAX_MWH}
              step={50}
              value={capacityMwh}
              hint={t.capacityHint}
              onChange={(value) => setCapacityMwh(clamp(value, CAPACITY_MIN_MWH, CAPACITY_MAX_MWH))}
            />
          </div>

          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-300/60 bg-white/70 px-3 py-1 text-xs text-slate-600 dark:border-slate-500/40 dark:bg-slate-900/60 dark:text-slate-300">
            <span className="font-medium">{t.durationLabel}</span>
            <span className="font-semibold text-slate-900 dark:text-white">
              {NUMBER_FORMATTER.format(durationHours)} h
            </span>
          </div>

          <div className="mt-5">
            <NumberSliderField
              id={`${formId}-rte`}
              label={t.rteLabel}
              unit="%"
              min={RTE_MIN_PCT}
              max={RTE_MAX_PCT}
              step={1}
              value={rteEfficiencyPct}
              hint={t.rteHint}
              onChange={(value) =>
                setRteEfficiencyPct(clamp(value, RTE_MIN_PCT, RTE_MAX_PCT))
              }
            />
          </div>

          <label className="mt-5 block">
            <span className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
              {t.strategyLabel}
            </span>
            <select
              className="apple-input mt-2 cursor-not-allowed appearance-none"
              value={STRATEGY_VALUE}
              onChange={() => {
                /* Single strategy MVP — no-op handler keeps select controlled. */
              }}
            >
              <option value={STRATEGY_VALUE}>{t.strategyOption}</option>
            </select>
            <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {t.strategyDescription}
            </p>
          </label>

          <div className="mt-7 space-y-2">
            <button
              type="submit"
              disabled={isRunning || !inputsValid}
              className="group relative inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-4 text-base font-semibold text-white shadow-[0_18px_36px_rgba(5,150,105,0.35)] transition hover:-translate-y-0.5 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 dark:bg-emerald-500 dark:hover:bg-emerald-400 md:text-lg"
            >
              {isRunning ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {t.runButtonLoading}
                </>
              ) : (
                <>
                  <BatteryCharging className="h-5 w-5" />
                  {t.runButton}
                </>
              )}
            </button>
            <p className="text-center text-xs text-slate-500 dark:text-slate-400">
              {t.sourceNote}
            </p>
          </div>
        </form>

        {!response && !isRunning && !error ? (
          <div className="min-w-0 rounded-2xl border border-slate-300/55 bg-white/65 p-5 dark:border-slate-500/35 dark:bg-slate-900/55 md:p-6">
            <PlaceholderState title={t.placeholderTitle} body={t.placeholderBody} />
          </div>
        ) : null}
      </div>

      <div className="relative mt-8 min-w-0">
        <AnimatePresence mode="wait">
          {isRunning ? (
            <ResultsLoadingSkeleton key="loading" />
          ) : error ? (
            <div
              key="error"
              className="rounded-2xl border border-slate-300/55 bg-white/65 p-6 dark:border-slate-500/35 dark:bg-slate-900/55 md:p-8"
            >
              <ErrorState
                title={t.errorTitle}
                message={error}
                retryLabel={t.errorRetry}
                onRetry={() => void runSimulation()}
              />
            </div>
          ) : response ? (
            <ResultsPanel
              key={`results-${response.dataset.dateBerlin}-${response.inputs.powerMw}-${response.inputs.capacityMwh}-${response.results.grossRevenueEur}`}
              language={language}
              response={response}
              chartData={chartData}
              eveningBoundaries={eveningBoundaries}
              t={t}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

function NumberSliderField({
  id,
  label,
  unit,
  min,
  max,
  step,
  value,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor={id}
          className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300"
        >
          {label}
        </label>
        <span className="text-sm font-semibold text-slate-900 dark:text-white">
          {INTEGER_FORMATTER.format(value)} {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) {
            onChange(parsed);
          }
        }}
        className="mt-2 w-full accent-emerald-600 dark:accent-emerald-300"
      />
      <div className="mt-2 flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) {
              onChange(parsed);
            }
          }}
          className="apple-input h-9 w-28 text-sm"
        />
        <span className="text-xs text-slate-500 dark:text-slate-400">{unit}</span>
      </div>
      {hint ? (
        <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

function PlaceholderState({ title, body }: { title: string; body: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      className="flex h-full min-h-[420px] flex-col items-center justify-center gap-4 text-center"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-300/60 bg-emerald-50/80 text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-400/10 dark:text-emerald-200">
        <BatteryCharging className="h-7 w-7" />
      </div>
      <p className="max-w-md text-base font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </p>
      <p className="max-w-md text-sm text-slate-600 dark:text-slate-300">{body}</p>
    </motion.div>
  );
}

function ResultsLoadingSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="space-y-4"
    >
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={`kpi-skel-${index}`} className="rounded-xl border border-slate-300/40 bg-white/70 p-4 dark:border-slate-500/35 dark:bg-slate-900/55">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="mt-3 h-7 w-2/3" />
            <Skeleton className="mt-2 h-3 w-3/4" />
          </div>
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-52 w-full rounded-xl" />
    </motion.div>
  );
}

function ErrorState({
  title,
  message,
  retryLabel,
  onRetry,
}: {
  title: string;
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="flex h-full min-h-[420px] flex-col items-center justify-center gap-4 text-center"
    >
      <p className="text-sm font-semibold text-red-700 dark:text-red-200">{title}</p>
      <p className="max-w-md rounded-xl border border-red-400/45 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-200">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-emerald-400 hover:text-emerald-700 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200"
      >
        {retryLabel}
      </button>
    </motion.div>
  );
}

function useAnimatedNumber(target: number, durationMs = 880) {
  const positionRef = useRef(target);
  const [display, setDisplay] = useState(target);

  useEffect(() => {
    const from = positionRef.current;
    let raf = 0;
    const start = performance.now();
    const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const v = from + (target - from) * easeOutCubic(t);
      positionRef.current = v;
      setDisplay(v);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        positionRef.current = target;
        setDisplay(target);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [target, durationMs]);

  return display;
}

function ResultsPanel({
  language,
  response,
  chartData,
  eveningBoundaries,
  t,
}: {
  language: AppLanguage;
  response: DispatchResponse;
  chartData: ChartDatum[];
  eveningBoundaries: { startIndex: number; endIndex: number } | null;
  t: (typeof copy)[keyof typeof copy];
}) {
  const gradientSuffix = useId().replace(/:/g, "");
  const socGradientId = `socfill-${gradientSuffix}`;
  const { results, dataset, inputs, schedule } = response;
  const samplePct = dataset.pointFractionOfDay * 100;

  const eveningResidualGapMwh = useMemo(
    () =>
      schedule
        .filter((s) => isEveningGapHour(s.hourBerlin))
        .reduce(
          (acc, s) => acc + Math.max(0, s.residualLoadMw) * QUARTER_HOUR_HOURS_DISPATCH,
          0
        ),
    [schedule]
  );

  const eveningGapCoveragePct = useMemo(() => {
    if (eveningResidualGapMwh > 1e-3) {
      return Math.min(100, (results.eveningDeliveredMwh / eveningResidualGapMwh) * 100);
    }
    return results.eveningCoveragePct;
  }, [
    eveningResidualGapMwh,
    results.eveningCoveragePct,
    results.eveningDeliveredMwh,
  ]);

  const avgEveningSocPct = useMemo(() => {
    const samples = schedule
      .filter((s) => isEveningGapHour(s.hourBerlin))
      .map((s) => s.socPct);
    if (samples.length === 0) {
      return 0;
    }
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }, [schedule]);

  const animRevenue = useAnimatedNumber(results.grossRevenueEur);
  const animEveningMwh = useAnimatedNumber(results.eveningDeliveredMwh);
  const animCoverage = useAnimatedNumber(eveningGapCoveragePct);
  const animCycles = useAnimatedNumber(results.cycles);
  const animAvgEveningSoc = useAnimatedNumber(avgEveningSocPct);

  const powerLim = inputs.powerMw * 1.08;
  const xAxisInterval = Math.max(0, Math.floor(chartData.length / 12) - 1);

  const xEveningStart = eveningBoundaries
    ? chartData[eveningBoundaries.startIndex]?.timeLabel
    : undefined;
  const xEveningEnd = eveningBoundaries
    ? chartData[eveningBoundaries.endIndex]?.timeLabel
    : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="space-y-6 rounded-[1.75rem] border border-slate-300/55 bg-white/80 p-5 shadow-[0_22px_50px_rgba(15,23,42,0.07)] dark:border-slate-500/35 dark:bg-slate-900/65 md:p-8"
    >
      <div className="flex flex-col gap-3 border-b border-slate-300/45 pb-5 dark:border-slate-500/35 md:flex-row md:flex-wrap md:items-center md:justify-between">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.2em] text-emerald-700 uppercase dark:text-emerald-300/90">
            {t.resultsMetaEyebrow}
          </p>
          <p className="mt-1 inline-flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
            <span className="rounded-full border border-emerald-300/55 bg-emerald-50/90 px-3 py-1 text-xs tracking-[0.06em] text-emerald-900 uppercase dark:border-emerald-400/35 dark:bg-emerald-400/10 dark:text-emerald-100">
              {t.datasetLabel}: {dataset.dateBerlin}
            </span>
          </p>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t.datasetSamples(dataset.samplePoints, samplePct)}
        </p>
      </div>

      <motion.div
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
        }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-slate-300/50 bg-white/90 p-5 shadow-sm dark:border-slate-500/35 dark:bg-slate-900/75"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
            {t.kpiEstimatedRevenueToday}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {EUR_FORMATTER.format(Math.round(animRevenue))}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {t.kpiPriceProxyHint}
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-amber-400/35 bg-gradient-to-br from-amber-50/90 to-white/90 p-5 shadow-sm dark:border-amber-400/25 dark:from-amber-500/10 dark:to-slate-900/80"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-amber-900/80 uppercase dark:text-amber-200/90">
            {t.kpiEveningGapCoverage}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {MWH_DETAIL_FORMATTER.format(animEveningMwh)} MWh
          </p>
          <p className="mt-2 text-sm font-semibold text-amber-900/90 dark:text-amber-100/90">
            ({NUMBER_FORMATTER.format(animCoverage)}%)
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
            {t.kpiEveningGapFootnote}
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-emerald-400/35 bg-white/90 p-5 shadow-sm dark:border-emerald-400/25 dark:bg-slate-900/75"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-emerald-800 uppercase dark:text-emerald-200/90">
            {t.kpiCyclesToday}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {NUMBER_FORMATTER.format(animCycles)}
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-sky-400/35 bg-white/90 p-5 shadow-sm dark:border-sky-400/25 dark:bg-slate-900/75"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-sky-900/80 uppercase dark:text-sky-200/90">
            {t.kpiAvgEveningSoc}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-sky-950 md:text-3xl dark:text-sky-100">
            {INTEGER_FORMATTER.format(Math.round(animAvgEveningSoc))}%
          </p>
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">{t.kpiAvgEveningSocWindow}</p>
        </motion.article>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.12, ease: "easeOut" }}
        className="rounded-2xl border border-slate-300/55 bg-white/92 p-4 md:p-5 dark:border-slate-500/35 dark:bg-slate-900/60"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {t.chartSocTitle}
          </p>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-300">
            <LegendDot color="rgb(37,99,235)" label={t.chartLegendSoc} />
            <LegendDot color="rgba(251,191,36,0.45)" label={t.chartLegendEvening} square />
          </div>
        </div>
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          {t.chartAxisTime} · 15&nbsp;min
        </p>
        <div className="mt-3 h-72 w-full min-h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 14, bottom: 6, left: 2 }}>
              <defs>
                <linearGradient id={socGradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(37,99,235)" stopOpacity={0.33} />
                  <stop offset="100%" stopColor="rgb(37,99,235)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(148,163,184,0.2)" strokeDasharray="3 3" />
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 10, fill: "rgb(100,116,139)" }}
                interval={xAxisInterval}
                axisLine={{ stroke: "rgba(148,163,184,0.45)" }}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: "rgb(100,116,139)" }}
                tickFormatter={(v) => `${v}%`}
                width={44}
                label={{
                  value: t.chartAxisSoc,
                  angle: -90,
                  position: "insideLeft",
                  fontSize: 10,
                  fill: "rgb(100,116,139)",
                }}
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(255,255,255,0.97)",
                  border: "1px solid rgba(148,163,184,0.45)",
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(value) => {
                  const n = typeof value === "number" ? value : Number(value ?? 0);
                  return [`${NUMBER_FORMATTER.format(n)}%`, t.chartLegendSoc];
                }}
                labelFormatter={(label) => String(label)}
              />
              {xEveningStart !== undefined && xEveningEnd !== undefined ? (
                <ReferenceArea
                  x1={xEveningStart}
                  x2={xEveningEnd}
                  fill="rgba(251,191,36,0.22)"
                  stroke="rgba(245,158,11,0.35)"
                />
              ) : null}
              <Area
                type="monotone"
                dataKey="socPct"
                stroke="transparent"
                fill={`url(#${socGradientId})`}
                isAnimationActive
                animationDuration={600}
              />
              <Line
                type="monotone"
                dataKey="socPct"
                stroke="rgb(37,99,235)"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive
                animationDuration={650}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.2, ease: "easeOut" }}
        className="rounded-2xl border border-slate-300/55 bg-white/92 p-4 md:p-5 dark:border-slate-500/35 dark:bg-slate-900/60"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {t.chartDispatchTitle}
          </p>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-300">
            <LegendDot color="rgb(34,197,94)" label={t.chartLegendCharge} />
            <LegendDot color="rgb(249,115,22)" label={t.chartLegendDischarge} />
            <LegendDot color="rgb(71,85,105)" label={t.chartLegendResidualOverlay} />
          </div>
        </div>
        <div className="mt-3 h-52 w-full min-h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 6, right: 14, bottom: 4, left: 2 }}>
              <CartesianGrid stroke="rgba(148,163,184,0.18)" strokeDasharray="3 3" />
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 9, fill: "rgb(100,116,139)" }}
                interval={xAxisInterval}
              />
              <YAxis
                yAxisId="p"
                domain={[-powerLim, powerLim]}
                tick={{ fontSize: 10, fill: "rgb(100,116,139)" }}
                width={42}
                label={{
                  value: t.chartAxisPowerDispatch,
                  angle: -90,
                  position: "insideLeft",
                  fontSize: 9,
                  fill: "rgb(100,116,139)",
                }}
              />
              <YAxis
                yAxisId="r"
                orientation="right"
                tick={{ fontSize: 9, fill: "rgb(100,116,139)" }}
                width={40}
                label={{
                  value: t.chartLegendResidualOverlay,
                  angle: 90,
                  position: "insideRight",
                  fontSize: 9,
                  fill: "rgb(100,116,139)",
                }}
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
                  if (label === t.chartLegendResidualOverlay) {
                    return [`${INTEGER_FORMATTER.format(n)} MW`, label];
                  }
                  return [`${NUMBER_FORMATTER.format(n)} MW`, label];
                }}
                labelFormatter={(label) => String(label)}
              />
              <Bar
                yAxisId="p"
                dataKey="chargeSignedMw"
                name={t.chartLegendCharge}
                fill="rgb(34,197,94)"
                radius={[3, 3, 0, 0]}
                maxBarSize={14}
              />
              <Bar
                yAxisId="p"
                dataKey="dischargeMw"
                name={t.chartLegendDischarge}
                fill="rgb(249,115,22)"
                radius={[3, 3, 0, 0]}
                maxBarSize={14}
              />
              <Line
                yAxisId="r"
                type="monotone"
                dataKey="residualLoadMw"
                name={t.chartLegendResidualOverlay}
                stroke="rgb(51,65,85)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive
                animationDuration={500}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.28 }}
        className="rounded-2xl border border-slate-300/40 bg-slate-50/90 p-5 text-sm leading-relaxed text-slate-700 dark:border-slate-500/30 dark:bg-slate-800/50 dark:text-slate-200 md:text-base"
      >
        {language === "de" ? (
          <>
            Dein virtuelles{" "}
            <span className="font-semibold text-slate-900 dark:text-white">
              {inputs.powerMw} MW / {INTEGER_FORMATTER.format(inputs.capacityMwh)} MWh
            </span>{" "}
            BESS hätte heute{" "}
            <span className="font-semibold text-emerald-800 dark:text-emerald-300">
              {MWH_DETAIL_FORMATTER.format(animEveningMwh)} MWh
            </span>{" "}
            des Evening Gaps abgedeckt und ca.{" "}
            <span className="font-semibold text-emerald-800 dark:text-emerald-300">
              {EUR_FORMATTER.format(Math.round(animRevenue))}
            </span>{" "}
            Revenue generiert. Der SoC wäre mit{" "}
            <span className="font-semibold text-sky-900 dark:text-sky-200">
              {INTEGER_FORMATTER.format(Math.round(animAvgEveningSoc))}%
            </span>{" "}
            relativ entspannt in den Abend gegangen.
          </>
        ) : (
          <>
            Your virtual{" "}
            <span className="font-semibold text-slate-900 dark:text-white">
              {inputs.powerMw} MW / {INTEGER_FORMATTER.format(inputs.capacityMwh)} MWh
            </span>{" "}
            BESS would have covered{" "}
            <span className="font-semibold text-emerald-800 dark:text-emerald-300">
              {MWH_DETAIL_FORMATTER.format(animEveningMwh)} MWh
            </span>{" "}
            of today&apos;s evening gap and about{" "}
            <span className="font-semibold text-emerald-800 dark:text-emerald-300">
              {EUR_FORMATTER.format(Math.round(animRevenue))}
            </span>{" "}
            in gross revenue. Average SoC through the evening window would have been near{" "}
            <span className="font-semibold text-sky-900 dark:text-sky-200">
              {INTEGER_FORMATTER.format(Math.round(animAvgEveningSoc))}%
            </span>
            .
          </>
        )}
      </motion.p>
    </motion.div>
  );
}

function LegendDot({ color, label, square = false }: { color: string; label: string; square?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={square ? "inline-block h-3 w-3 rounded-sm" : "inline-block h-2 w-2 rounded-full"}
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
