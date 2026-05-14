"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Sparkles, Zap } from "lucide-react";
import { z } from "zod";

import { Skeleton } from "@/components/ui/skeleton";
import { createLogger } from "@/lib/debug";
import type { BriefingStoryWindow } from "@/lib/briefingStoryWindow";
import { serializeBriefingStoryWindow } from "@/lib/briefingStoryWindow";

const log = createLogger("daily-story");

const storyShape = z.object({
  headline: z.string(),
  insights: z.array(z.string()).length(3),
  narrative: z.string(),
  counterfactual: z.string(),
  dataAsOfNote: z.string().optional(),
});

const responseShape = z.object({
  dateBerlin: z.string(),
  language: z.enum(["en", "de"]),
  source: z.enum(["llm", "fallback_numeric"]),
  retrievedAtIso: z.string(),
  context: z.object({
    netStructuralBalanceGwh: z.number(),
    curtailedEnergyGwh: z.number().nullable().optional().default(null),
    curtailmentSlotFractionOfSampled: z.number().optional().default(0),
    curtailmentStatus: z
      .enum(["loaded", "unavailable_not_configured", "unavailable_upstream"])
      .optional()
      .default("unavailable_upstream"),
    pointFractionOfDay: z.number(),
    samplePoints: z.number(),
    fleet: z.object({
      powerGw: z.number(),
      capacityGwh: z.number(),
    }),
    simulated: z.object({
      practicalCapacityGwh: z.number(),
      balancedPowerMw: z.number(),
      gridImpactReductionPct: z.number().nullable(),
      absorbedSurplusShare: z.number().nullable(),
      servedDeficitShare: z.number().nullable(),
    }),
    dayShape: z.object({
      structuralNetGwhByWindow: z.object({
        dayCoreGwh: z.number(),
        eveningRampGwh: z.number(),
        overnightBaseGwh: z.number(),
      }),
      renewableNetStructuralBalanceGwh: z.number().nullable(),
      renewableSlotFractionOfSampled: z.number(),
      peakSurplusHourBerlin: z.number().nullable(),
      peakDeficitHourBerlin: z.number().nullable(),
    }),
    isMultiDayWindow: z.boolean(),
    rangeStartBerlin: z.string(),
    rangeEndBerlin: z.string(),
  }),
  story: storyShape,
});

type StoryResponse = z.infer<typeof responseShape>;

type BriefingDailyStoryProps = {
  language: "en" | "de";
  /** Day / week / month window aligned with the Germany flow chart selector. */
  storyWindow: BriefingStoryWindow;
  /** Bumped to force a refetch (e.g. user pressed "Refresh"). */
  refreshNonce?: number;
  /**
   * When true, the three headline KPI tiles inside the intro (net balance, modeled BESS, coverage)
   * are omitted — use when the parent surface already shows those numbers.
   */
  hideIntroHeroStats?: boolean;
  children?: (sections: BriefingDailyStorySections) => ReactNode;
};

export type BriefingStoryDayOptimalContext = {
  dateBerlin: string;
  dayCapacityGwh: number;
  dayPowerGw: number;
};

type BriefingDailyStorySections = {
  introSection: ReactNode;
  counterfactualSection: ReactNode;
  footerSection: ReactNode;
  /** Present for a single-calendar-day story once data is loaded — matches counterfactual headline numbers. */
  dayOptimalContext: BriefingStoryDayOptimalContext | null;
};

const FETCH_TIMEOUT_MS = 18_000;

async function fetchStory(
  storyWindow: BriefingStoryWindow,
  language: "en" | "de",
  signal: AbortSignal
): Promise<StoryResponse> {
  const params = new URLSearchParams({ language });
  if (storyWindow.type === "day") {
    params.set("date", storyWindow.date);
  } else if (storyWindow.type === "week") {
    params.set("week", storyWindow.weekKey);
  } else {
    params.set("month", storyWindow.monthKey);
  }
  const res = await fetch(`/api/briefing/story?${params.toString()}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  return responseShape.parse(json);
}

const labels = {
  en: {
    kicker: "Daily story · Berlin",
    windowKicker: "Window story · Berlin",
    insightsLabel: "Today's signals",
    windowInsightsLabel: "Window signals",
    keyInsightsLabel: "Key insights",
    snapshotLabel: "Data snapshot",
    howToReadLabel: "How to read this window",
    analysisLabel: "BESSForge analysis",
    counterfactualLabel: "What an optimal BESS would have done",
    counterfactualDayTitle: (date: string) => `Optimal BESS for this day (${date})`,
    counterfactualWindowTitle: "Optimal BESS for this window",
    counterfactualModelLine: (capGwh: string, powerGw: string) =>
      `Model BESS: ${capGwh} GWh / ${powerGw} GW balanced`,
    counterfactualDayExplainer: (gridPct: string, absorbedPct: string, servedPct: string) =>
      `A BESS sized optimally for this single day would have smoothed ${gridPct}% of net structural swings, captured ${absorbedPct}% of charge opportunity, and covered ${servedPct}% of gross deficit energy.`,
    poweredBy: "BESSForge analyst (LLM)",
    poweredByFallback: "BESSForge analyst (deterministic — model offline)",
    loading: "Drafting today's analyst note…",
    windowLoading: "Drafting the window analyst note…",
    error: "Could not draft today's analyst note.",
    windowError: "Could not draft the window analyst note.",
    retry: "Retry",
    asOfPrefix: "As of",
    absorbedSurplusCaption: "Absorbed (charge opportunity)",
    servedDeficitCaption: "Served (gross deficit)",
    gridImpactCaption: "Imbalance smoothing",
    kpiFootnote: "Same published quarter-hours as the signals above.",
    windowKpiFootnote:
      "Net = sum of generation minus load over the whole window. Clock-band and renewables lines slice the same series differently—they are not three parts of a second total.",
    kpiHintGrid:
      "Share by which the modeled BESS reduces the sum of absolute per-slot structural net vs the unstored trace, for this window.",
    kpiHintAbsorbed:
      "Modeled share of gross charge opportunity stored in this window: structural surplus plus curtailed renewable energy when curtailment data is available.",
    kpiHintServed:
      "Modeled share of gross structural deficit energy (slots where load exceeds generation) met from modeled storage discharge.",
    netBalanceLabel: "Net balance",
    dayCoreLabel: "Day core (10–16)",
    renewableNetLabel: "Renewables minus load",
    peakHoursLabel: "Peak hours",
    peakHoursSubtitle: "surplus / deficit",
    fleetLabel: "Fleet context",
    curtailedLabel: "Curtailment",
    curtailedUnavailable: "Not configured",
    curtailedUpstream: "Upstream unavailable",
    coverageLabel: "Coverage",
    curtailedSubtitle: (pct: string) => `${pct} with curtailment MW`,
    renewableCoverageSubtitle: (pct: string) => `${pct} with renewable MW`,
    fleetSubtitle: (power: string, capacity: string) => `${power} GW / ${capacity} GWh`,
    modelCapacityLabel: "Modeled BESS",
    modelCapacitySubtitle: (power: string) => `${power} GW balanced`,
  },
  de: {
    kicker: "Story des Tages · Berlin",
    windowKicker: "Fenster-Story · Berlin",
    insightsLabel: "Heutige Signale",
    windowInsightsLabel: "Signale im Fenster",
    keyInsightsLabel: "Wichtigste Erkenntnisse",
    snapshotLabel: "Datensnapshot",
    howToReadLabel: "So liest du das Fenster",
    analysisLabel: "BESSForge-Analyse",
    counterfactualLabel: "Was ein optimaler BESS bewirkt hätte",
    counterfactualDayTitle: (date: string) => `Optimaler BESS für diesen Tag (${date})`,
    counterfactualWindowTitle: "Optimaler BESS für dieses Fenster",
    counterfactualModelLine: (capGwh: string, powerGw: string) =>
      `Modell-BESS: ${capGwh} GWh / ${powerGw} GW balanced`,
    counterfactualDayExplainer: (gridPct: string, absorbedPct: string, servedPct: string) =>
      `Ein für diesen einzelnen Tag optimal dimensionierter BESS hätte ${gridPct}% der Netto-Schwankungen geglättet, ${absorbedPct}% der Ladechance genutzt und ${servedPct}% des Defizits gedeckt.`,
    poweredBy: "BESSForge-Analyst (LLM)",
    poweredByFallback: "BESSForge-Analyst (deterministisch — Modell offline)",
    loading: "Analystennotiz wird erstellt…",
    windowLoading: "Fenster-Analystennotiz wird erstellt…",
    error: "Heutige Analystennotiz konnte nicht erstellt werden.",
    windowError: "Fenster-Analystennotiz konnte nicht erstellt werden.",
    retry: "Erneut versuchen",
    asOfPrefix: "Stand",
    absorbedSurplusCaption: "Aufgenommen (Ladechance)",
    servedDeficitCaption: "Gedeckt (Brutto-Defizit)",
    gridImpactCaption: "Netzentlastung (Modell)",
    kpiFootnote: "Gleiche ver\u00f6ffentlichte Viertelstunden wie die Signale oben.",
    windowKpiFootnote:
      "Netto = Summe (Erzeugung \u2212 Last) \u00fcber das ganze Fenster. Uhr-Band- und EE-Zeilen schneiden dieselbe Serie anders—keine drei Anteile eines zweiten Gesamt-Nettos.",
    kpiHintGrid:
      "Anteil, um den das modellierte BESS die Summe der Absolutbetr\u00e4ge der Viertelstunden-Nettos gegen\u00fcber der Rohspur im Fenster senkt.",
    kpiHintAbsorbed:
      "Modellierter Anteil der Ladechance in diesem Fenster: struktureller \u00dcberschuss plus abgeregelte erneuerbare Energie, sofern Curtailment-Daten vorliegen.",
    kpiHintServed:
      "Modellierter Anteil der Brutto-Defizitenergie (Slots Last > Erzeugung), der aus dem modellierten Speicher gedeckt werden k\u00f6nnte.",
    netBalanceLabel: "Nettobilanz",
    dayCoreLabel: "Tageskern (10–16)",
    renewableNetLabel: "EE minus Last",
    peakHoursLabel: "Spitzenstunden",
    peakHoursSubtitle: "\u00dcberschuss / Defizit",
    fleetLabel: "Flottenkontext",
    curtailedLabel: "Abgeregelt",
    curtailedUnavailable: "Nicht konfiguriert",
    curtailedUpstream: "Upstream fehlt",
    coverageLabel: "Abdeckung",
    curtailedSubtitle: (pct: string) => `${pct} mit Curtailment-MW`,
    renewableCoverageSubtitle: (pct: string) => `${pct} mit EE-MW`,
    fleetSubtitle: (power: string, capacity: string) => `${power} GW / ${capacity} GWh`,
    modelCapacityLabel: "Modell-BESS",
    modelCapacitySubtitle: (power: string) => `${power} GW balanced`,
  },
} as const;

function summarizeNarrative(text: string, maxSentences = 2): string {
  const sentences =
    text
      .trim()
      .match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [];
  if (sentences.length <= maxSentences) {
    return text.trim();
  }
  return `${sentences.slice(0, maxSentences).join(" ")} …`;
}

export function BriefingDailyStory({
  language,
  storyWindow,
  refreshNonce = 0,
  hideIntroHeroStats = false,
  children,
}: BriefingDailyStoryProps) {
  const [data, setData] = useState<StoryResponse | null>(null);
  /**
   * Initial state is "loading" so the very first paint already renders the
   * skeleton. We only flip back into "loading" on subsequent dependency
   * changes (refresh / date / language), and that flip is deferred via a
   * rAF microtask to avoid the React 19 `set-state-in-effect` cascade
   * warning.
   */
  const [loadingState, setLoadingState] = useState<"idle" | "loading" | "error">("loading");
  const [retryNonce, setRetryNonce] = useState(0);
  const lastReqId = useRef(0);
  const hasMountedRef = useRef(false);
  const storyFetchKey = useMemo(() => serializeBriefingStoryWindow(storyWindow), [storyWindow]);
  const isWindowMode = storyWindow.type !== "day";

  useEffect(() => {
    const reqId = ++lastReqId.current;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let rafId = 0;
    if (hasMountedRef.current) {
      rafId = requestAnimationFrame(() => setLoadingState("loading"));
    } else {
      hasMountedRef.current = true;
    }

    fetchStory(storyWindow, language, controller.signal)
      .then((result) => {
        if (reqId !== lastReqId.current) {
          return;
        }
        setData(result);
        setLoadingState("idle");
      })
      .catch((err: unknown) => {
        if (reqId !== lastReqId.current) {
          return;
        }
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        log("daily story fetch failed %o", err);
        setLoadingState("error");
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [storyFetchKey, storyWindow, language, refreshNonce, retryNonce]);

  const t = labels[language];
  const showWindowChrome = isWindowMode || Boolean(data?.context.isMultiDayWindow);
  const kickerText = showWindowChrome ? t.windowKicker : t.kicker;
  const loadingText = showWindowChrome ? t.windowLoading : t.loading;
  const errorText = showWindowChrome ? t.windowError : t.error;

  const headerNumbers = useMemo(() => {
    if (!data) return null;
    const fmt = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
      maximumFractionDigits: 1,
    });
    return {
      gridPctText:
        data.context.simulated.gridImpactReductionPct !== null
          ? fmt.format(data.context.simulated.gridImpactReductionPct)
          : null,
      capGwh: fmt.format(data.context.simulated.practicalCapacityGwh),
      pwGw: fmt.format(data.context.simulated.balancedPowerMw / 1000),
      absorbedSharePctText:
        data.context.simulated.absorbedSurplusShare !== null
          ? fmt.format(data.context.simulated.absorbedSurplusShare * 100)
          : null,
      servedSharePctText:
        data.context.simulated.servedDeficitShare !== null
          ? fmt.format(data.context.simulated.servedDeficitShare * 100)
          : null,
    };
  }, [data, language]);

  const storyMetrics = useMemo(() => {
    if (!data) {
      return null;
    }
    const fmt = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
      maximumFractionDigits: 1,
    });
    const fmtSignedGwh = (value: number | null) =>
      value === null ? "—" : `${value >= 0 ? "+" : "−"}${fmt.format(Math.abs(value))} GWh`;
    const fmtHour = (value: number | null, sign: "+" | "−") =>
      value === null ? "—" : `${sign}${String(value).padStart(2, "0")}h`;

    return {
      netBalance: fmtSignedGwh(data.context.netStructuralBalanceGwh),
      dayCore: fmtSignedGwh(data.context.dayShape.structuralNetGwhByWindow.dayCoreGwh),
      renewableNet: fmtSignedGwh(data.context.dayShape.renewableNetStructuralBalanceGwh),
      hasRenewableNet: data.context.dayShape.renewableNetStructuralBalanceGwh !== null,
      renewableCoverage: fmt.format(data.context.dayShape.renewableSlotFractionOfSampled * 100),
      curtailedEnergy:
        data.context.curtailedEnergyGwh !== null
          ? `${fmt.format(data.context.curtailedEnergyGwh)} GWh`
          : "—",
      curtailedCoverage: fmt.format(data.context.curtailmentSlotFractionOfSampled * 100),
      peakHours: `${fmtHour(data.context.dayShape.peakSurplusHourBerlin, "+")} / ${fmtHour(
        data.context.dayShape.peakDeficitHourBerlin,
        "−"
      )}`,
      coverage: `${fmt.format(data.context.pointFractionOfDay * 100)}%`,
      fleetPower: fmt.format(data.context.fleet.powerGw),
      fleetCapacity: fmt.format(data.context.fleet.capacityGwh),
    };
  }, [data, language]);

  const condensedNarrative = data ? summarizeNarrative(data.story.narrative, data.context.isMultiDayWindow ? 3 : 2) : null;

  const headerBlock = (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-emerald-600 dark:text-emerald-300" aria-hidden />
        <p className="text-[10.5px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">{kickerText}</p>
      </div>
      {data ? (
        <p className="text-[10.5px] tracking-[0.16em] text-muted-foreground/80 uppercase tabular-nums">
          {t.asOfPrefix} · {data.dateBerlin}
        </p>
      ) : null}
    </header>
  );

  const windowNote =
    data?.context.isMultiDayWindow ? (
      <div className="rounded-xl border border-border/60 bg-background/55 px-4 py-3 dark:border-slate-600/45 dark:bg-slate-950/35">
        <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">{t.howToReadLabel}</p>
        <p className="mt-1.5 max-w-3xl text-[12px] leading-relaxed text-muted-foreground/95 md:text-[12.75px] dark:text-slate-400/95">
          {language === "de" ? (
            <>
              Die Nettobilanz ist die Summe (Erzeugung − Last) über alle veröffentlichten Viertelstunden von{" "}
              <strong className="font-medium text-foreground/90">{data.context.rangeStartBerlin}</strong> bis{" "}
              <strong className="font-medium text-foreground/90">{data.context.rangeEndBerlin}</strong>. Die drei Signale
              darunter markieren die Belastungsschwerpunkte im Fenster, nicht drei Anteile eines zweiten Gesamt-Nettos.
            </>
          ) : (
            <>
              Net balance is generation minus load summed over every published quarter-hour from{" "}
              <strong className="font-medium text-foreground/90">{data.context.rangeStartBerlin}</strong> through{" "}
              <strong className="font-medium text-foreground/90">{data.context.rangeEndBerlin}</strong>. The three signals
              below mark where stress clusters inside that window, not three slices of a second total.
            </>
          )}
        </p>
      </div>
    ) : null;

  const introSection =
    loadingState === "loading" && !data ? (
      <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-emerald-50/30 px-5 py-5 shadow-[0_1px_0_rgb(255_255_255_/_0.6)_inset,0_18px_44px_-22px_rgb(15_23_42_/_0.18)] dark:border-white/[0.06] dark:from-[rgba(13,19,36,0.92)] dark:via-[rgba(13,19,36,0.85)] dark:to-emerald-950/20 dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05),0_22px_60px_-28px_rgb(0_0_0_/_0.7)] md:px-7 md:py-6">
        {headerBlock}
        <div className="mt-5 space-y-3">
          <Skeleton className="h-8 w-3/4 max-w-2xl" />
          <div className="space-y-2 pt-2">
            <Skeleton className="h-4 w-[88%] max-w-3xl" />
            <Skeleton className="h-4 w-[82%] max-w-3xl" />
          </div>
          <div className="mt-5 rounded-2xl border border-dashed border-border/60 p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
            <div className="mt-4 space-y-2">
              <Skeleton className="h-4 w-full max-w-3xl" />
              <Skeleton className="h-4 w-[90%] max-w-3xl" />
              <Skeleton className="h-4 w-[84%] max-w-3xl" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/70">{loadingText}</p>
        </div>
      </div>
    ) : loadingState === "error" ? (
      <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-emerald-50/30 px-5 py-5 shadow-[0_1px_0_rgb(255_255_255_/_0.6)_inset,0_18px_44px_-22px_rgb(15_23_42_/_0.18)] dark:border-white/[0.06] dark:from-[rgba(13,19,36,0.92)] dark:via-[rgba(13,19,36,0.85)] dark:to-emerald-950/20 dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05),0_22px_60px_-28px_rgb(0_0_0_/_0.7)] md:px-7 md:py-6">
        {headerBlock}
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-300/40 bg-amber-50/40 p-3.5 dark:border-amber-500/30 dark:bg-amber-950/20">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden />
          <div className="flex-1 text-sm">
            <p className="text-amber-900 dark:text-amber-100">{errorText}</p>
            <button
              type="button"
              onClick={() => setRetryNonce((n) => n + 1)}
              className="mt-2 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-500/20 dark:text-amber-100"
            >
              {t.retry}
            </button>
          </div>
        </div>
      </div>
    ) : data && storyMetrics && headerNumbers && condensedNarrative ? (
      <div className="rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-emerald-50/30 px-5 py-5 shadow-[0_1px_0_rgb(255_255_255_/_0.6)_inset,0_18px_44px_-22px_rgb(15_23_42_/_0.18)] dark:border-white/[0.06] dark:from-[rgba(13,19,36,0.92)] dark:via-[rgba(13,19,36,0.85)] dark:to-emerald-950/20 dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05),0_22px_60px_-28px_rgb(0_0_0_/_0.7)] md:px-7 md:py-6">
        {headerBlock}
        <div className="mt-4 space-y-4">
          <div className="space-y-2.5">
            <h2 className="text-[1.55rem] font-semibold leading-tight tracking-tight text-foreground md:text-[2rem] [font-family:var(--font-heading)]">
              {data.story.headline}
            </h2>
            <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground/95 md:text-base dark:text-slate-300/90">
              {condensedNarrative}
            </p>
          </div>

          {windowNote}

          <div
            className="rounded-2xl border border-emerald-200/70 bg-white/75 px-4 py-4 shadow-sm dark:border-emerald-500/25 dark:bg-slate-950/45"
            role="group"
            aria-label={t.keyInsightsLabel}
          >
            <p className="text-[10px] font-semibold tracking-[0.18em] text-emerald-800 uppercase dark:text-emerald-200">
              {t.keyInsightsLabel}
            </p>

            {hideIntroHeroStats ? null : (
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <StoryHeroStat label={t.netBalanceLabel} value={storyMetrics.netBalance} />
                <StoryHeroStat
                  label={t.modelCapacityLabel}
                  value={`${headerNumbers.capGwh} GWh`}
                  subtitle={t.modelCapacitySubtitle(headerNumbers.pwGw)}
                />
                <StoryHeroStat
                  label={t.coverageLabel}
                  value={storyMetrics.coverage}
                  subtitle={`${t.peakHoursLabel}: ${storyMetrics.peakHours}`}
                />
              </div>
            )}

            <ol className="mt-4 space-y-3">
              {data.story.insights.map((insight, index) => (
                <li key={`${index}-${insight}`} className="flex items-start gap-3">
                  <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-200">
                    {index + 1}
                  </span>
                  <p className="min-w-0 text-[13px] leading-relaxed text-foreground/90 dark:text-slate-200/90">
                    {insight}
                  </p>
                </li>
              ))}
            </ol>

            <div className="mt-4 flex flex-wrap gap-2">
              <StoryMetaPill label={t.dayCoreLabel} value={storyMetrics.dayCore} />
              <StoryMetaPill
                label={t.fleetLabel}
                value={t.fleetSubtitle(storyMetrics.fleetPower, storyMetrics.fleetCapacity)}
              />
              {storyMetrics.hasRenewableNet ? (
                <StoryMetaPill
                  label={t.renewableNetLabel}
                  value={`${storyMetrics.renewableNet} · ${t.renewableCoverageSubtitle(storyMetrics.renewableCoverage)}`}
                />
              ) : null}
              {data.context.curtailedEnergyGwh !== null ? (
                <StoryMetaPill
                  label={t.curtailedLabel}
                  value={`${storyMetrics.curtailedEnergy} · ${t.curtailedSubtitle(storyMetrics.curtailedCoverage)}`}
                />
              ) : data.context.curtailmentStatus !== "loaded" ? (
                <StoryMetaPill
                  label={t.curtailedLabel}
                  value={
                    data.context.curtailmentStatus === "unavailable_not_configured"
                      ? t.curtailedUnavailable
                      : t.curtailedUpstream
                  }
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    ) : null;

  const dayOptimalContextForChildren: BriefingStoryDayOptimalContext | null =
    data && !data.context.isMultiDayWindow
      ? {
          dateBerlin: data.dateBerlin,
          dayCapacityGwh: data.context.simulated.practicalCapacityGwh,
          dayPowerGw: data.context.simulated.balancedPowerMw / 1000,
        }
      : null;

  const counterfactualSection =
    loadingState === "loading" && !data ? (
      <div className="rounded-2xl border border-emerald-200/65 bg-gradient-to-br from-emerald-50/80 via-background to-background px-4 py-4 dark:border-emerald-500/25 dark:from-emerald-500/10 dark:via-slate-950/40 dark:to-slate-950/35">
        <Skeleton className="h-4 w-44" />
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Skeleton className="h-40 rounded-2xl" />
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-1">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
        </div>
      </div>
    ) : data && headerNumbers ? (
      <div className="rounded-2xl border border-emerald-200/65 bg-gradient-to-br from-emerald-50/80 via-background to-background px-4 py-4 dark:border-emerald-500/25 dark:from-emerald-500/10 dark:via-slate-950/40 dark:to-slate-950/35">
        {data.context.isMultiDayWindow ? (
          <>
            <div className="flex items-center gap-2">
              <Zap className="size-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden />
              <p className="text-[10px] font-semibold tracking-[0.18em] text-emerald-800/90 uppercase dark:text-emerald-200/90">
                {t.counterfactualLabel}
              </p>
            </div>
            <h3 className="mt-3 text-lg font-semibold leading-snug text-slate-950 dark:text-white md:text-xl [font-family:var(--font-heading)]">
              {t.counterfactualWindowTitle}
            </h3>

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
              <div className="rounded-2xl border border-emerald-200/70 bg-white/80 px-4 py-4 shadow-sm dark:border-emerald-400/25 dark:bg-slate-950/45">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t.modelCapacityLabel}
                </p>
                <p className="mt-2 text-4xl font-black leading-none tabular-nums text-slate-950 dark:text-white md:text-[3.1rem]">
                  {headerNumbers.capGwh} GWh
                </p>
                <p className="mt-2 text-base font-semibold text-slate-700 dark:text-slate-200">
                  {t.modelCapacitySubtitle(headerNumbers.pwGw)}
                </p>
                <p className="mt-4 text-sm leading-relaxed text-emerald-950/90 dark:text-emerald-50/90">
                  {data.story.counterfactual}
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-1">
                <StoryMetricTile
                  label={t.gridImpactCaption}
                  value={headerNumbers.gridPctText !== null ? `${headerNumbers.gridPctText}%` : "—"}
                  subtitle={t.kpiHintGrid}
                  tone="accent"
                />
                <StoryMetricTile
                  label={t.absorbedSurplusCaption}
                  value={headerNumbers.absorbedSharePctText !== null ? `${headerNumbers.absorbedSharePctText}%` : "—"}
                  subtitle={t.kpiHintAbsorbed}
                />
                <StoryMetricTile
                  label={t.servedDeficitCaption}
                  value={headerNumbers.servedSharePctText !== null ? `${headerNumbers.servedSharePctText}%` : "—"}
                  subtitle={t.kpiHintServed}
                />
              </div>
            </div>

            <p className="mt-3 text-[10px] leading-snug text-muted-foreground/75">{t.windowKpiFootnote}</p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Zap className="size-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden />
              <p className="text-[10px] font-semibold tracking-[0.18em] text-emerald-800/90 uppercase dark:text-emerald-200/90">
                {t.analysisLabel}
              </p>
            </div>
            <h3 className="mt-3 text-lg font-semibold leading-snug text-slate-950 dark:text-white md:text-xl [font-family:var(--font-heading)]">
              {t.counterfactualDayTitle(data.dateBerlin)}
            </h3>

            <div className="mt-4 rounded-2xl border border-emerald-200/70 bg-white/80 px-4 py-4 shadow-sm dark:border-emerald-400/25 dark:bg-slate-950/45">
              <p className="text-[11px] font-semibold leading-snug text-slate-800 dark:text-slate-100">
                {t.counterfactualModelLine(headerNumbers.capGwh, headerNumbers.pwGw)}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-emerald-950/90 dark:text-emerald-50/90">
                {t.counterfactualDayExplainer(
                  headerNumbers.gridPctText ?? "—",
                  headerNumbers.absorbedSharePctText ?? "—",
                  headerNumbers.servedSharePctText ?? "—"
                )}
              </p>
            </div>

            <p className="mt-3 text-[10px] leading-snug text-muted-foreground/75">{t.kpiFootnote}</p>
          </>
        )}
      </div>
    ) : null;

  const footerSection =
    data ? (
      <footer className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-muted-foreground/80">
        <span>{data.source === "llm" ? t.poweredBy : t.poweredByFallback}</span>
        {data.story.dataAsOfNote ? <span className="text-muted-foreground/70">{data.story.dataAsOfNote}</span> : null}
      </footer>
    ) : null;

  if (children) {
    return <>{children({ introSection, counterfactualSection, footerSection, dayOptimalContext: dayOptimalContextForChildren })}</>;
  }

  return (
    <section data-state={loadingState} className="space-y-5" aria-busy={loadingState === "loading"}>
      {introSection}
      {counterfactualSection}
      {footerSection}
    </section>
  );
}

type StoryMetricTileProps = {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "positive" | "negative" | "accent" | "neutral";
};

function StoryHeroStat({ label, value, subtitle }: StoryMetricTileProps) {
  return (
    <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/55 px-3.5 py-3 shadow-sm dark:border-emerald-500/20 dark:bg-emerald-500/10">
      <p className="text-[9px] font-semibold tracking-[0.16em] text-emerald-900/80 uppercase dark:text-emerald-200/80">
        {label}
      </p>
      <p className="mt-1.5 text-[1.45rem] font-black leading-tight tabular-nums text-slate-950 dark:text-white md:text-[1.75rem]">
        {value}
      </p>
      {subtitle ? (
        <p className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-slate-300">{subtitle}</p>
      ) : null}
    </div>
  );
}

function StoryMetricTile({ label, value, subtitle, tone = "neutral" }: StoryMetricTileProps) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "negative"
        ? "text-rose-600 dark:text-rose-300"
        : tone === "accent"
          ? "text-slate-950 dark:text-white"
          : "text-foreground";
  return (
    <div className="rounded-xl border border-border/65 bg-background/45 px-3.5 py-3 shadow-sm dark:border-slate-600/45 dark:bg-slate-950/35">
      <p className="text-[9px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className={`mt-1.5 text-[1.3rem] font-extrabold leading-tight tabular-nums md:text-[1.55rem] ${toneClass}`}>
        {value}
      </p>
      {subtitle ? (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground/85 dark:text-slate-400/95">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

type StoryMetaPillProps = {
  label: string;
  value: string;
};

function StoryMetaPill({ label, value }: StoryMetaPillProps) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/65 bg-background/55 px-3 py-1 text-[10px] font-medium text-muted-foreground shadow-sm dark:border-slate-600/45 dark:bg-slate-950/35 dark:text-slate-300">
      <span className="font-semibold text-foreground/85 dark:text-slate-100">{label}:</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}
