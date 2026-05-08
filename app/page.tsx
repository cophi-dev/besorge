"use client";

import { useEffect, useState } from "react";
import { Lightbulb, MessageCircle } from "lucide-react";
import dynamic from "next/dynamic";
import { z } from "zod";

import type { AssessmentResponse } from "@/components/BessAssessmentCenter";
import NewsPreviewSection from "@/components/NewsPreviewSection";
import { useLanguage } from "@/components/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { createLogger } from "@/lib/debug";
import { estimateEveningSoc, type SocBand } from "@/lib/socEstimator";

const log = createLogger("market-snapshot");

const MegapackMap = dynamic(() => import("@/components/MegapackMap"), {
  ssr: false,
});
const BessAssessmentCenter = dynamic(() => import("@/components/BessAssessmentCenter"), {
  ssr: false,
});
const BessDispatchSimulator = dynamic(() => import("@/components/BessDispatchSimulator"), {
  ssr: false,
});
const GermanyDayEnergyFlow = dynamic(() => import("@/components/GermanyDayEnergyFlow"), {
  ssr: false,
});

const marketSnapshotSchema = z.object({
  retrievedAtIso: z.string(),
  bess: z.object({
    capacityUnit: z.literal("GWh"),
    installedCapacityGwh: z.number(),
    capacityYear: z.string(),
    powerUnit: z.literal("GW"),
    installedPowerGw: z.number(),
    powerYear: z.string(),
  }),
  realtimeSystem: z.object({
    unit: z.literal("MW"),
    timestampIso: z.string(),
    loadMw: z.number(),
    domesticGenerationMw: z.number(),
    residualLoadMw: z.number().optional(),
    renewableShareOfLoadPct: z.number().optional(),
  }),
  eveningWindow: z
    .object({
      dateBerlin: z.string(),
      samplePoints: z.number(),
      avgResidualLoadMw: z.number(),
      avgConventionalGenerationMw: z.number().nullable(),
      avgRenewableGenerationMw: z.number().nullable(),
    })
    .nullable()
    .optional(),
  dailyEnergy: z
    .object({
      dateBerlin: z.string(),
      samplePoints: z.number(),
      pointFractionOfDay: z.number(),
      renewableGenerationGwh: z.number(),
      totalGenerationGwh: z.number(),
      demandGwh: z.number(),
      netBalanceGwh: z.number(),
      totalNetBalanceGwh: z.number(),
    })
    .nullable()
    .optional(),
  recentRenewablePatterns: z
    .object({
      windowDays: z.number(),
      solarRichDays: z.number().nullable(),
      inferredBatteryReadiness: z.enum(["high", "moderate", "low", "unknown"]),
    })
    .optional(),
  fleetStructuralSurplus: z
    .object({
      dateBerlin: z.string(),
      samplePoints: z.number(),
      pointFractionOfDay: z.number(),
      totalStructuralSurplusMwh: z.number(),
      observedBatteryAbsorptionInSurplusMwh: z.number(),
      uncapturedStructuralSurplusMwh: z.number(),
    })
    .nullable()
    .optional(),
  dayEnergyFlow: z
    .object({
      dateBerlin: z.string(),
      samplePoints: z.number(),
      pointFractionOfDay: z.number(),
      source: z.literal("energy-charts.total_power"),
      slots: z.array(
        z.object({
          timestampIso: z.string(),
          hourBerlin: z.number(),
          residualLoadMw: z.number(),
          loadMw: z.number(),
          totalGenerationMw: z.number(),
          renewableGenerationMw: z.number().nullable(),
        })
      ),
    })
    .nullable()
    .optional(),
});

type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const PERCENT_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const MWH_COMPACT_FORMATTER = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
const LIVE_UPDATE_LABEL: Record<"en" | "de", string> = {
  en: "Updated live",
  de: "Live aktualisiert",
};
const DATA_FETCH_RETRIES = 2;
/**
 * Conservative adjustment factor mapping evening residual load to the slice
 * that genuinely needs new flexibility (i.e. excluding must-run baseload that
 * runs anyway). The product spec allows 0.65-0.75; we centre at 0.70.
 */
const MUST_RUN_BASELOAD_FACTOR = 0.7;
const BESS_OVERVIEW = {
  power: {
    totalGw: 18.3,
    utilityScaleGw: 15.2,
    smallScaleGw: 3.1,
  },
  energy: {
    totalGwh: 27.9,
    utilityScaleGwh: 23.1,
    smallScaleGwh: 4.8,
  },
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function formatAdaptivePower(valueMw: number): string {
  if (Math.abs(valueMw) >= 1000) {
    return `${NUMBER_FORMATTER.format(valueMw / 1000)} GW`;
  }
  return `${NUMBER_FORMATTER.format(valueMw)} MW`;
}

function formatGw(valueGw: number): string {
  return `${NUMBER_FORMATTER.format(valueGw)} GW`;
}

function formatInstalledValue(value: number, unit: "GW" | "GWh"): string {
  return `${NUMBER_FORMATTER.format(value)} ${unit}`;
}

type FleetMode = "charging" | "discharging" | "idle";

function inferFleetMode(params: {
  netPositionMw: number | null;
  residualLoadMw: number | null;
}): FleetMode | null {
  const { netPositionMw, residualLoadMw } = params;
  if (netPositionMw === null && residualLoadMw === null) {
    return null;
  }
  if ((netPositionMw ?? 0) > 1200 || (residualLoadMw ?? 0) < -800) {
    return "charging";
  }
  if ((netPositionMw ?? 0) < -1200 || (residualLoadMw ?? 0) > 18000) {
    return "discharging";
  }
  return "idle";
}

export default function Home() {
  const { language } = useLanguage();
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [assessment, setAssessment] = useState<AssessmentResponse | null>(null);
  const [isAssessmentPending, setIsAssessmentPending] = useState(true);
  const [showAiAssessmentSection, setShowAiAssessmentSection] = useState(false);
  const [liveLoadProgress, setLiveLoadProgress] = useState(10);
  const [isLiveDataLoading, setIsLiveDataLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const fetchJsonWithRetry = async <T,>(url: string, cache: RequestCache = "default"): Promise<T> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= DATA_FETCH_RETRIES; attempt += 1) {
        try {
          const response = await fetch(url, { cache, signal: controller.signal });
          if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
          }
          return (await response.json()) as T;
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted || attempt >= DATA_FETCH_RETRIES) {
            break;
          }
          await sleep(250 * 2 ** attempt);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Unknown request failure");
    };

    const loadData = async () => {
      setIsLiveDataLoading(true);
      setIsAssessmentPending(true);
      setLiveLoadProgress(10);

      const marketPromise = fetchJsonWithRetry<unknown>("/api/market/de", "no-store");
      const assessmentPromise = fetchJsonWithRetry<AssessmentResponse>("/api/assessment/de");

      try {
        const marketResult = await marketPromise;
        const parsed = marketSnapshotSchema.safeParse(marketResult);
        if (parsed.success) {
          setMarket(parsed.data);
        } else {
          log("market snapshot failed schema validation %o", {
            request: { url: "/api/market/de" },
            errors: parsed.error.flatten(),
          });
        }
      } catch {
        // Individual cards fall back to temporary-unavailable messaging.
      }

      setLiveLoadProgress(100);
      window.setTimeout(() => {
        if (!controller.signal.aborted) {
          setIsLiveDataLoading(false);
        }
      }, 220);

      try {
        const assessmentResult = await assessmentPromise;
        if (!controller.signal.aborted) {
          setAssessment(assessmentResult);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsAssessmentPending(false);
        }
      }
    };
    const progressIntervalId = window.setInterval(() => {
      setLiveLoadProgress((current) => Math.min(92, current + (current < 55 ? 8 : 4)));
    }, 350);
    void loadData();
    return () => {
      window.clearInterval(progressIntervalId);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setShowAiAssessmentSection(true);
    }, 350);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  const openAiChat = () => {
    window.dispatchEvent(
      new CustomEvent("aether:open-ai-chat", {
        detail: {
          prompt:
            language === "de"
              ? "Frage Grok zu den Daten: Wo liegen aktuell die größten Chancen und Risiken?"
              : "Ask Grok about the data: what are the biggest opportunities and risks right now?",
        },
      })
    );
    window.location.hash = "ai-chat";
  };

  const renewableGenerationValue = market
    ? market.realtimeSystem.residualLoadMw !== undefined
      ? Math.max(0, market.realtimeSystem.loadMw - market.realtimeSystem.residualLoadMw)
      : market.realtimeSystem.renewableShareOfLoadPct !== undefined
        ? (market.realtimeSystem.loadMw * market.realtimeSystem.renewableShareOfLoadPct) / 100
        : null
    : null;
  const conventionalGenerationValue =
    market && renewableGenerationValue !== null
      ? Math.max(0, market.realtimeSystem.domesticGenerationMw - renewableGenerationValue)
      : null;
  const netPositionMw = market ? market.realtimeSystem.domesticGenerationMw - market.realtimeSystem.loadMw : null;
  const inferredFleetMode = inferFleetMode({
    netPositionMw,
    residualLoadMw: market?.realtimeSystem.residualLoadMw ?? null,
  });
  const fleetModeLabel =
    inferredFleetMode === null
      ? language === "de"
        ? "voruebergehend nicht verfuegbar"
        : "temporarily unavailable"
      : language === "de"
        ? inferredFleetMode === "charging"
          ? "Laden"
          : inferredFleetMode === "discharging"
            ? "Entladen"
            : "Leerlauf"
        : inferredFleetMode === "charging"
          ? "Charging"
          : inferredFleetMode === "discharging"
            ? "Discharging"
            : "Idle";
  const renewableGenerationDisplay =
    renewableGenerationValue !== null
      ? formatAdaptivePower(renewableGenerationValue)
      : market
        ? language === "de"
          ? "vorübergehend nicht verfügbar"
          : "temporarily unavailable"
        : language === "de"
          ? "voruebergehend nicht verfuegbar"
          : "temporarily unavailable";
  const conventionalGenerationDisplay =
    conventionalGenerationValue !== null
      ? formatAdaptivePower(conventionalGenerationValue)
      : market
        ? language === "de"
          ? "vorübergehend nicht verfügbar"
          : "temporarily unavailable"
        : language === "de"
          ? "voruebergehend nicht verfuegbar"
          : "temporarily unavailable";

  const liveUpdateLabel = market
    ? `${LIVE_UPDATE_LABEL[language]} • ${new Date(market.realtimeSystem.timestampIso).toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : `${LIVE_UPDATE_LABEL[language]} • ${language === "de" ? "Datenabruf läuft" : "fetch in progress"}`;
  const eveningResidualSourceMw =
    market?.eveningWindow?.avgResidualLoadMw ??
    (market?.realtimeSystem.residualLoadMw !== undefined
      ? market.realtimeSystem.residualLoadMw
      : market && renewableGenerationValue !== null
        ? Math.max(0, market.realtimeSystem.loadMw - renewableGenerationValue)
        : null);
  const eveningFlexibilityGapGw =
    eveningResidualSourceMw !== null && Number.isFinite(eveningResidualSourceMw)
      ? (eveningResidualSourceMw * MUST_RUN_BASELOAD_FACTOR) / 1000
      : null;

  const socBand: SocBand = estimateEveningSoc({
    renewableShareOfLoadPct: market?.realtimeSystem.renewableShareOfLoadPct ?? null,
    solarRichDays: market?.recentRenewablePatterns?.solarRichDays ?? null,
  });
  const socAvailable = market !== null && socBand.label !== "unknown";
  const dischargeHeadroomGw = market
    ? market.bess.installedPowerGw * (socBand.midpointPct / 100)
    : null;
  const effectiveGapGw =
    eveningFlexibilityGapGw !== null && dischargeHeadroomGw !== null
      ? Math.max(0, eveningFlexibilityGapGw - dischargeHeadroomGw)
      : null;

  const renewableSharePct = market?.realtimeSystem.renewableShareOfLoadPct ?? null;
  const unavailableShort = language === "de" ? "k. A." : "n/a";
  const renewableShareDisplay =
    renewableSharePct !== null ? `${PERCENT_FORMATTER.format(renewableSharePct)}%` : unavailableShort;

  const fleetStructuralSurplus = market?.fleetStructuralSurplus ?? null;
  const fleetUncapturedSurplusDisplay =
    fleetStructuralSurplus !== null
      ? `${MWH_COMPACT_FORMATTER.format(fleetStructuralSurplus.uncapturedStructuralSurplusMwh)} MWh`
      : unavailableShort;

  const fallbackTakeawayText =
    language === "de"
      ? "Live-Daten werden geladen — hier erscheinen gleich drei kompakte Linien zu Systemrichtung, adjustierter Abendluecke und Dispatch-Hinweis."
      : "Live data is loading — three compact lines will cover system direction, SoC-adjusted evening gap, and dispatch guidance.";

  /** Keep MW / GWh numbers out of the takeaway when they already appear in Live Metrics or the daily profile. */
  const takeawayLines =
    effectiveGapGw !== null && socAvailable && netPositionMw !== null
      ? language === "de"
        ? [
            netPositionMw >= 0
              ? `Strukturelle Ueberschusslage am Knoten; Flotte eher „${fleetModeLabel}“ — MW siehe Live Metrics.`
              : `Strukturelle Defizitlage am Knoten; Flotte eher „${fleetModeLabel}“ — MW siehe Live Metrics.`,
            `Effektive Abendluecke (SoC-adjustiert, einmaliger Kennwert): rund ${formatGw(effectiveGapGw)} — Restflexibilitaet nach geschaetztem Flotten-SoC.`,
            assessment?.shortTermSignal ?? "Dispatch-Empfehlung laedt noch …",
          ]
        : [
            netPositionMw >= 0
              ? `Structural surplus at the bus; fleet leaning “${fleetModeLabel}”—see Live Metrics for MW.`
              : `Structural deficit at the bus; fleet leaning “${fleetModeLabel}”—see Live Metrics for MW.`,
            `Effective evening gap (SoC-adjusted, single KPI): ~${formatGw(effectiveGapGw)}—residual flexibility after estimated fleet headroom.`,
            assessment?.shortTermSignal ?? "Dispatch guidance still loading…",
          ]
      : null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-8 pb-24 pt-16 md:gap-16 lg:px-12">
      {isLiveDataLoading ? (
        <div className="pointer-events-none fixed top-16 left-1/2 z-[1200] w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-slate-300/60 bg-white/90 p-3 shadow-lg backdrop-blur dark:border-slate-500/40 dark:bg-slate-900/85">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {language === "de"
              ? "Daten werden live von Energy-Charts & MaStR geladen..."
              : "Live data is loading from Energy-Charts & MaStR..."}
          </p>
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-200/90 dark:bg-slate-700/70">
            <div
              className="h-full bg-primary transition-[width] duration-300 ease-out dark:bg-emerald-300"
              style={{ width: `${Math.max(5, Math.min(100, liveLoadProgress))}%` }}
            />
          </div>
        </div>
      ) : null}
      <section id="overview" className="space-y-10 pb-4 md:space-y-12">
        <p className="text-xs tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{liveUpdateLabel}</p>
        <article className="relative overflow-hidden rounded-2xl border border-blue-200/80 bg-gradient-to-r from-blue-50 via-blue-50/80 to-white p-4 md:p-5 dark:border-blue-300/35 dark:from-blue-400/12 dark:via-slate-900/85 dark:to-slate-900/80">
          <span className="absolute inset-y-0 left-0 w-1.5 bg-emerald-500/90 dark:bg-emerald-300/90" />
          <div className="pl-3">
            <p className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-blue-800 uppercase dark:text-blue-200">
              <Lightbulb className="h-3.5 w-3.5" />
              {language === "de" ? "Heutiger Key Takeaway" : "Today's key takeaway"}
            </p>
            {takeawayLines ? (
              <ul className="mt-4 list-none space-y-3">
                {takeawayLines.map((line, index) => (
                  <li
                    key={`takeaway-${index}`}
                    className="flex gap-3 text-sm leading-snug text-slate-800 dark:text-slate-100 md:text-[15px]"
                  >
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-800 dark:bg-blue-400/20 dark:text-blue-100">
                      {index + 1}
                    </span>
                    <span className="min-w-0">{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 max-w-4xl text-sm leading-relaxed text-slate-800 dark:text-slate-100">
                {fallbackTakeawayText}
              </p>
            )}
          </div>
        </article>
        <h1 className="max-w-5xl text-5xl leading-tight text-slate-900 md:text-7xl dark:text-white [font-family:var(--font-heading)]">
          AETHER
        </h1>
        <p className="max-w-3xl text-xl text-slate-700 dark:text-slate-200 md:text-2xl">
          {language === "de"
            ? "Klarheit für Deutschlands Energiewende"
            : "Clarity for Germany's energy transition"}
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {language === "de"
            ? "Tägliches High-Signal-Briefing für Storage-Teams, die Nachfragestress, Erneuerbaren-Anteil und Deployment-Dynamik der BESS-Flotte verfolgen."
            : "Daily high-signal briefing for storage teams tracking demand stress, renewable penetration, and BESS deployment momentum."}
        </p>
        <p className="text-xs tracking-[0.16em] text-slate-500 uppercase dark:text-slate-400">
          {language === "de" ? "Live-Metriken" : "Live metrics"}
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <LiveMetricTile
            title={language === "de" ? "Erzeugung" : "Generation"}
            value={
              market
                ? formatAdaptivePower(market.realtimeSystem.domesticGenerationMw)
                : language === "de"
                  ? "voruebergehend nicht verfuegbar"
                  : "temporarily unavailable"
            }
            detailLine={
              language === "de"
                ? `Öko ${renewableGenerationDisplay} · Konv. ${conventionalGenerationDisplay}`
                : `Renew. ${renewableGenerationDisplay} · Conv. ${conventionalGenerationDisplay}`
            }
            isLoading={isLiveDataLoading}
          />
          <LiveMetricTile
            title={language === "de" ? "Last" : "Demand"}
            value={
              market
                ? formatAdaptivePower(market.realtimeSystem.loadMw)
                : language === "de"
                  ? "voruebergehend nicht verfuegbar"
                  : "temporarily unavailable"
            }
            isLoading={isLiveDataLoading}
          />
          <LiveMetricTile
            title={language === "de" ? "Netto-Position" : "Net position"}
            value={
              netPositionMw !== null
                ? `${netPositionMw >= 0 ? (language === "de" ? "Überschuss" : "Surplus") : language === "de" ? "Defizit" : "Deficit"} ${formatAdaptivePower(Math.abs(netPositionMw))}`
                : language === "de"
                  ? "voruebergehend nicht verfuegbar"
                  : "temporarily unavailable"
            }
            detailLine={`${language === "de" ? "BESS" : "BESS"} · ${fleetModeLabel}`}
            isLoading={isLiveDataLoading}
          />
        </div>
        <article className="mt-10 rounded-2xl border border-slate-300/45 bg-white/75 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
          <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {language === "de" ? "Flottenkontext & Karte" : "Fleet context & map"}
          </p>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
            {language === "de"
              ? "Installierte GW/GWh über Energy-Charts; Nutzungs-Split über MaStR. Darunter deutschlandweite Utility- und Small-Scale-Standorte."
              : "Installed GW/GWh from Energy-Charts; size split from MaStR. Below that, nationwide utility-scale and small-scale pins."}
          </p>
          <p className="mt-3 text-[11px] font-semibold tracking-[0.1em] text-slate-500 uppercase dark:text-slate-400">
            {language === "de" ? "BESS-Flottenüberblick" : "BESS Fleet Overview"}
          </p>
          <div className="mt-3 grid gap-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Installierte Leistung gesamt" : "Installed Power Total"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.power.totalGw, "GW")}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Utility-Scale (&gt;10 MW)" : "Utility-scale (&gt;10 MW)"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.power.utilityScaleGw, "GW")}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Small-Scale (&lt;10 MW)" : "Small-scale (&lt;10 MW)"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.power.smallScaleGw, "GW")}
                </p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Installierte Energie gesamt" : "Installed Energy Total"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.energy.totalGwh, "GWh")}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Utility-Scale (&gt;10 MW)" : "Utility-scale (&gt;10 MW)"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.energy.utilityScaleGwh, "GWh")}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Small-Scale (&lt;10 MW)" : "Small-scale (&lt;10 MW)"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.energy.smallScaleGwh, "GWh")}
                </p>
              </div>
            </div>
          </div>
          <hr className="my-8 border-slate-200/90 dark:border-slate-600/35" />
          <div className="flex flex-wrap items-center gap-2 text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            <span>{language === "de" ? "BESS-Deployment-Karte" : "BESS Deployment Map"}</span>
            <span className="inline-flex items-center rounded-full border border-blue-300/60 bg-blue-50/90 px-2 py-0.5 text-[10px] tracking-[0.1em] text-blue-700 dark:border-blue-300/35 dark:bg-blue-400/10 dark:text-blue-200">
              {language === "de" ? "Utility-Scale-Pins" : "Utility-scale pins"}
            </span>
            <span className="inline-flex items-center rounded-full border border-cyan-300/60 bg-cyan-50/90 px-2 py-0.5 text-[10px] tracking-[0.1em] text-cyan-700 dark:border-cyan-300/35 dark:bg-cyan-400/10 dark:text-cyan-200">
              {language === "de" ? "Small-Scale-Dichte" : "Small-scale density"}
            </span>
          </div>
          <div className="mt-4">
            <MegapackMap compact />
          </div>
        </article>
      </section>

      <GermanyDayEnergyFlow
        flow={market?.dayEnergyFlow ?? null}
        fleetCapacityGwh={market?.bess.installedCapacityGwh}
        fleetPowerGw={market?.bess.installedPowerGw}
        language={language}
        isLoading={isLiveDataLoading}
      />

      <div className="mx-auto w-full max-w-[68rem]">
        <BessDispatchSimulator />
      </div>

      <section
        id="market-snapshot"
        className="scroll-mt-8 space-y-5 border-t border-slate-200/90 pt-10 dark:border-slate-600/35 dark:pt-12"
      >
        <div className="max-w-3xl">
          <h2 className="text-lg text-slate-800 dark:text-slate-100 md:text-xl [font-family:var(--font-heading)]">
            {language === "de" ? "Market Snapshot" : "Market snapshot"}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {language === "de"
              ? "Vier Kennzahlen aus dem gleichen Abruf wie oben — kompakt fuer Kontext vor dem Assessments-Block."
              : "Four indicators from the same pull as above—compact context ahead of assessment."}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:gap-4">
          <QuickStatPill
            label={language === "de" ? "Netto am Knoten" : "Structural net"}
            value={
              netPositionMw !== null
                ? `${netPositionMw >= 0 ? (language === "de" ? "Ueberschuss" : "Surplus") : language === "de" ? "Defizit" : "Deficit"} ${formatAdaptivePower(Math.abs(netPositionMw))}`
                : unavailableShort
            }
            isLoading={isLiveDataLoading}
          />
          <QuickStatPill
            label={language === "de" ? "Erneuerbarquote (Live)" : "Renewable share (live)"}
            value={renewableShareDisplay}
            isLoading={isLiveDataLoading}
          />
          <QuickStatPill
            label={language === "de" ? "Effektive Abendluecke (SoC-adj.)" : "Effective evening gap (SoC-adj.)"}
            value={
              effectiveGapGw !== null
                ? `~${formatGw(effectiveGapGw)}`
                : unavailableShort
            }
            isLoading={isLiveDataLoading}
          />
          <QuickStatPill
            label={language === "de" ? "Nicht aufgenommener Restueberschuss" : "Uncaptured structural surplus"}
            value={fleetUncapturedSurplusDisplay}
            isLoading={isLiveDataLoading}
          />
        </div>
      </section>

      <section
        className="mx-auto w-full max-w-4xl border-t border-slate-200/90 pt-14 dark:border-slate-600/35 dark:pt-16"
        id="ai-assessment"
      >
        {showAiAssessmentSection ? (
          <BessAssessmentCenter
            variant="minimal"
            compact
            initialData={assessment}
            pendingInitialData={isAssessmentPending}
            skipInitialFetch
          />
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-11 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
          </div>
        )}
      </section>

      <section id="news" className="space-y-8 border-t border-slate-200/90 pt-14 dark:border-slate-600/35 dark:pt-16">
        <NewsPreviewSection limit={4} showHeaderLink />
      </section>

      <button
        type="button"
        onClick={openAiChat}
        className="group fixed right-6 bottom-6 z-[1000] w-[min(340px,calc(100vw-3rem))] rounded-3xl border border-primary/35 bg-[#fbfaf8]/95 px-5 py-4 text-left text-slate-900 shadow-[0_18px_42px_rgba(15,118,110,0.16)] backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-[0_22px_48px_rgba(15,118,110,0.24)] dark:border-emerald-200/30 dark:bg-slate-900/95 dark:text-slate-100 dark:hover:border-emerald-200/60"
        aria-label={language === "de" ? "Frage AETHER alles" : "Ask AETHER anything"}
      >
        <span className="inline-flex items-center gap-2 text-[11px] tracking-[0.14em] text-primary uppercase dark:text-emerald-200">
          <MessageCircle className="h-4 w-4" />
          {language === "de" ? "AETHER Chat" : "AETHER Chat"}
        </span>
        <span className="mt-1 block text-sm font-semibold md:text-base">
          {language === "de" ? "Sprechen Sie mit AETHER." : "Talk with AETHER."}
        </span>
        <span className="mt-1 block text-xs text-slate-600 dark:text-slate-300">
          {language === "de"
            ? "Trends, Risiken und nächste Schritte auf einen Blick."
            : "Trends, risks, and next steps in one conversation."}
        </span>
      </button>

    </div>
  );
}

function LiveMetricTile({
  title,
  value,
  detailLine,
  isLoading = false,
}: {
  title: string;
  value: string;
  detailLine?: string;
  isLoading?: boolean;
}) {
  return (
    <article className="rounded-xl border border-slate-300/50 bg-white/85 px-4 py-3 dark:border-slate-500/40 dark:bg-slate-900/60">
      <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
        {title}
      </p>
      {isLoading ? (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-8 w-[min(100%,180px)]" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ) : (
        <>
          <p className="mt-1.5 text-xl font-bold tabular-nums text-slate-900 md:text-2xl dark:text-white [font-family:var(--font-sans)]">
            {value}
          </p>
          {detailLine ? (
            <p className="mt-1 text-[11px] leading-snug text-slate-600 dark:text-slate-400">{detailLine}</p>
          ) : null}
        </>
      )}
    </article>
  );
}

function QuickStatPill({
  label,
  value,
  isLoading = false,
}: {
  label: string;
  value: string;
  isLoading?: boolean;
}) {
  return (
    <div className="min-w-[min(100%,11rem)] flex-1 rounded-xl border border-slate-200/85 bg-white/95 px-4 py-3 shadow-sm dark:border-slate-600/40 dark:bg-slate-900/55">
      <p className="text-[10px] font-medium tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">{label}</p>
      {isLoading ? (
        <div className="mt-2">
          <Skeleton className="h-6 w-28" />
        </div>
      ) : (
        <p className="mt-1 text-base font-bold tabular-nums text-slate-900 dark:text-white md:text-lg [font-family:var(--font-sans)]">
          {value}
        </p>
      )}
    </div>
  );
}

