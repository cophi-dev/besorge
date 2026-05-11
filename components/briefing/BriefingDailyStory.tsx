"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
    analysisLabel: "Aether analysis",
    counterfactualLabel: "What an optimal BESS would have done",
    poweredBy: "Aether analyst (LLM)",
    poweredByFallback: "Aether analyst (deterministic — model offline)",
    loading: "Drafting today's analyst note…",
    windowLoading: "Drafting the window analyst note…",
    error: "Could not draft today's analyst note.",
    windowError: "Could not draft the window analyst note.",
    retry: "Retry",
    asOfPrefix: "As of",
    absorbedSurplusCaption: "Absorbed (gross surplus)",
    servedDeficitCaption: "Served (gross deficit)",
    gridImpactCaption: "Imbalance smoothing",
    kpiFootnote: "Same published quarter-hours as the signals above.",
    windowKpiFootnote:
      "Net = sum of generation minus load over the whole window. Clock-band and renewables lines slice the same series differently—they are not three parts of a second total.",
    kpiHintGrid:
      "Share by which the modeled BESS reduces the sum of absolute per-slot structural net vs the unstored trace, for this window.",
    kpiHintAbsorbed:
      "Modeled share of gross structural surplus energy (slots where generation exceeds load) stored in this window.",
    kpiHintServed:
      "Modeled share of gross structural deficit energy (slots where load exceeds generation) met from modeled storage discharge.",
    netBalanceLabel: "Net balance",
    dayCoreLabel: "Day core (10–16)",
    renewableNetLabel: "Renewables minus load",
    peakHoursLabel: "Peak hours",
    peakHoursSubtitle: "surplus / deficit",
    fleetLabel: "Fleet context",
    coverageLabel: "Coverage",
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
    analysisLabel: "Aether-Analyse",
    counterfactualLabel: "Was ein optimaler BESS bewirkt hätte",
    poweredBy: "AETHER-Analyst (LLM)",
    poweredByFallback: "AETHER-Analyst (deterministisch — Modell offline)",
    loading: "Analystennotiz wird erstellt…",
    windowLoading: "Fenster-Analystennotiz wird erstellt…",
    error: "Heutige Analystennotiz konnte nicht erstellt werden.",
    windowError: "Fenster-Analystennotiz konnte nicht erstellt werden.",
    retry: "Erneut versuchen",
    asOfPrefix: "Stand",
    absorbedSurplusCaption: "Aufgenommen (Brutto-\u00dcberschuss)",
    servedDeficitCaption: "Gedeckt (Brutto-Defizit)",
    gridImpactCaption: "Netzentlastung (Modell)",
    kpiFootnote: "Gleiche ver\u00f6ffentlichte Viertelstunden wie die Signale oben.",
    windowKpiFootnote:
      "Netto = Summe (Erzeugung \u2212 Last) \u00fcber das ganze Fenster. Uhr-Band- und EE-Zeilen schneiden dieselbe Serie anders—keine drei Anteile eines zweiten Gesamt-Nettos.",
    kpiHintGrid:
      "Anteil, um den das modellierte BESS die Summe der Absolutbetr\u00e4ge der Viertelstunden-Nettos gegen\u00fcber der Rohspur im Fenster senkt.",
    kpiHintAbsorbed:
      "Modellierter Anteil der Brutto-\u00dcberschussenergie (Slots Erzeugung > Last), der in diesem Fenster eingelagert werden k\u00f6nnte.",
    kpiHintServed:
      "Modellierter Anteil der Brutto-Defizitenergie (Slots Last > Erzeugung), der aus dem modellierten Speicher gedeckt werden k\u00f6nnte.",
    netBalanceLabel: "Nettobilanz",
    dayCoreLabel: "Tageskern (10–16)",
    renewableNetLabel: "EE minus Last",
    peakHoursLabel: "Spitzenstunden",
    peakHoursSubtitle: "\u00dcberschuss / Defizit",
    fleetLabel: "Flottenkontext",
    coverageLabel: "Abdeckung",
    renewableCoverageSubtitle: (pct: string) => `${pct} mit EE-MW`,
    fleetSubtitle: (power: string, capacity: string) => `${power} GW / ${capacity} GWh`,
    modelCapacityLabel: "Modell-BESS",
    modelCapacitySubtitle: (power: string) => `${power} GW balanced`,
  },
} as const;

export function BriefingDailyStory({ language, storyWindow, refreshNonce = 0 }: BriefingDailyStoryProps) {
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
  const insightsLabelText = showWindowChrome ? t.windowInsightsLabel : t.insightsLabel;
  const loadingText = showWindowChrome ? t.windowLoading : t.loading;
  const errorText = showWindowChrome ? t.windowError : t.error;

  const headerNumbers = useMemo(() => {
    if (!data) return null;
    const fmt = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
      maximumFractionDigits: 1,
    });
    const net = data.context.netStructuralBalanceGwh;
    return {
      netSign: net >= 0 ? "+" : "−",
      netAbs: fmt.format(Math.abs(net)),
      gridPct: data.context.simulated.gridImpactReductionPct,
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
      renewableCoverage: fmt.format(data.context.dayShape.renewableSlotFractionOfSampled * 100),
      peakHours: `${fmtHour(data.context.dayShape.peakSurplusHourBerlin, "+")} / ${fmtHour(
        data.context.dayShape.peakDeficitHourBerlin,
        "−"
      )}`,
      coverage: `${fmt.format(data.context.pointFractionOfDay * 100)}%`,
      fleetPower: fmt.format(data.context.fleet.powerGw),
      fleetCapacity: fmt.format(data.context.fleet.capacityGwh),
    };
  }, [data, language]);

  return (
    <section
      data-state={loadingState}
      className="group relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-emerald-50/30 px-5 py-5 shadow-[0_1px_0_rgb(255_255_255_/_0.6)_inset,0_18px_44px_-22px_rgb(15_23_42_/_0.18)] transition-shadow duration-300 dark:border-white/[0.06] dark:from-[rgba(13,19,36,0.92)] dark:via-[rgba(13,19,36,0.85)] dark:to-emerald-950/20 dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05),0_22px_60px_-28px_rgb(0_0_0_/_0.7)] md:px-7 md:py-6"
      aria-busy={loadingState === "loading"}
    >
      {/* Subtle ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-16 size-48 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-400/[0.08]"
      />

      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Sparkles
            className="size-3.5 text-emerald-600 dark:text-emerald-300"
            aria-hidden
          />
          <p className="text-[10.5px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            {kickerText}
          </p>
        </div>
        {data ? (
          <p className="text-[10.5px] tracking-[0.16em] text-muted-foreground/80 uppercase tabular-nums">
            {t.asOfPrefix} · {data.dateBerlin}
          </p>
        ) : null}
      </header>

      {loadingState === "loading" && !data ? (
        <div className="mt-5 space-y-3">
          <Skeleton className="h-7 w-3/4 max-w-2xl" />
          <div className="space-y-2 pt-2">
            <Skeleton className="h-4 w-[88%] max-w-3xl" />
            <Skeleton className="h-4 w-[82%] max-w-3xl" />
            <Skeleton className="h-4 w-[90%] max-w-3xl" />
          </div>
          <Skeleton className="h-4 w-full max-w-3xl" />
          <Skeleton className="h-4 w-5/6 max-w-2xl" />
          <div className="mt-5 rounded-xl border border-dashed border-border/60 p-3.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="mt-2 h-4 w-full max-w-xl" />
          </div>
          <p className="mt-4 text-[11px] text-muted-foreground/70">{loadingText}</p>
        </div>
      ) : loadingState === "error" ? (
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-300/40 bg-amber-50/40 p-3.5 dark:border-amber-500/30 dark:bg-amber-950/20">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300"
            aria-hidden
          />
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
      ) : data ? (
        <>
          <h2 className="mt-3 text-[19px] leading-snug font-medium tracking-tight text-foreground md:text-[22px] [font-family:var(--font-heading)]">
            {data.story.headline}
          </h2>
          {data.context.isMultiDayWindow ? (
            <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-muted-foreground/95 md:text-[12.75px] dark:text-slate-400/95">
              {language === "de" ? (
                <>
                  Die Nettobilanz ist die Summe (Erzeugung \u2212 Last) \u00fcber alle ver\u00f6ffentlichten Viertelstunden von{" "}
                  <strong className="font-medium text-foreground/90">{data.context.rangeStartBerlin}</strong> bis{" "}
                  <strong className="font-medium text-foreground/90">{data.context.rangeEndBerlin}</strong>. Die drei
                  Signale darunter zeigen, wo sich Spannung ballt\u2014sie sind keine drei Anteile, die sich zum Netto
                  \u201ezur\u00fcckrechnen\u201c lassen.
                </>
              ) : (
                <>
                  Net balance is generation minus load summed over every published quarter-hour from{" "}
                  <strong className="font-medium text-foreground/90">{data.context.rangeStartBerlin}</strong> through{" "}
                  <strong className="font-medium text-foreground/90">{data.context.rangeEndBerlin}</strong>. The three
                  signals below show where stress concentrates—they are not three slices that should add back up to that
                  headline net.
                </>
              )}
            </p>
          ) : null}
          {storyMetrics ? (
            <>
              <div className="mt-4">
                <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  {insightsLabelText}
                </p>
                <div
                  className="mt-2 grid grid-cols-2 gap-2.5 md:grid-cols-4"
                  role="group"
                  aria-label={insightsLabelText}
                >
                  <StoryMetricTile
                    label={t.netBalanceLabel}
                    value={storyMetrics.netBalance}
                    tone={data.context.netStructuralBalanceGwh >= 0 ? "positive" : "negative"}
                  />
                  <StoryMetricTile label={t.dayCoreLabel} value={storyMetrics.dayCore} tone="accent" />
                  <StoryMetricTile
                    label={t.renewableNetLabel}
                    value={storyMetrics.renewableNet}
                    subtitle={t.renewableCoverageSubtitle(storyMetrics.renewableCoverage)}
                  />
                  <StoryMetricTile
                    label={t.peakHoursLabel}
                    value={storyMetrics.peakHours}
                    subtitle={t.peakHoursSubtitle}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <StoryMetaPill
                    label={t.fleetLabel}
                    value={t.fleetSubtitle(storyMetrics.fleetPower, storyMetrics.fleetCapacity)}
                  />
                  <StoryMetaPill label={t.coverageLabel} value={storyMetrics.coverage} />
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-border/65 bg-background/45 px-4 py-3 dark:border-slate-600/45 dark:bg-slate-950/35">
                <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  {t.analysisLabel}
                </p>
                <p className="mt-1.5 max-w-3xl text-[12.75px] leading-relaxed text-muted-foreground/90 md:text-[13px] dark:text-slate-300/80">
                  {data.story.narrative}
                </p>
              </div>
            </>
          ) : null}

          {headerNumbers ? (
            <div className="mt-5">
              <div className="flex items-center gap-2">
                <Zap
                  className="size-3.5 text-emerald-700 dark:text-emerald-300"
                  aria-hidden
                />
                <p className="text-[10px] font-semibold tracking-[0.18em] text-emerald-800/90 uppercase dark:text-emerald-200/90">
                  {t.counterfactualLabel}
                </p>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2.5 md:grid-cols-4">
                <StoryMetricTile
                  label={t.modelCapacityLabel}
                  value={`${headerNumbers.capGwh} GWh`}
                  subtitle={t.modelCapacitySubtitle(headerNumbers.pwGw)}
                  tone="accent"
                />
                <StoryMetricTile
                  label={t.gridImpactCaption}
                  value={headerNumbers.gridPctText !== null ? `${headerNumbers.gridPctText}%` : "—"}
                  subtitle={data.context.isMultiDayWindow ? t.kpiHintGrid : undefined}
                  tone="accent"
                />
                <StoryMetricTile
                  label={t.absorbedSurplusCaption}
                  value={headerNumbers.absorbedSharePctText !== null ? `${headerNumbers.absorbedSharePctText}%` : "—"}
                  subtitle={data.context.isMultiDayWindow ? t.kpiHintAbsorbed : undefined}
                />
                <StoryMetricTile
                  label={t.servedDeficitCaption}
                  value={headerNumbers.servedSharePctText !== null ? `${headerNumbers.servedSharePctText}%` : "—"}
                  subtitle={data.context.isMultiDayWindow ? t.kpiHintServed : undefined}
                />
              </div>
              <p className="mt-3 max-w-3xl text-[12.75px] leading-relaxed text-emerald-950/90 md:text-[13px] dark:text-emerald-50/90">
                {data.story.counterfactual}
              </p>
              <p className="mt-2 text-[10px] leading-snug text-muted-foreground/75">
                {data.context.isMultiDayWindow ? t.windowKpiFootnote : t.kpiFootnote}
              </p>
            </div>
          ) : null}

          <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-muted-foreground/80">
            <span>
              {data.source === "llm" ? t.poweredBy : t.poweredByFallback}
            </span>
            {data.story.dataAsOfNote ? (
              <span className="text-muted-foreground/70">
                {data.story.dataAsOfNote}
              </span>
            ) : null}
          </footer>
        </>
      ) : null}
    </section>
  );
}

type StoryMetricTileProps = {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "positive" | "negative" | "accent" | "neutral";
};

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
      <p className={`mt-1 text-[1.05rem] font-extrabold leading-tight tabular-nums md:text-[1.15rem] ${toneClass}`}>
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
