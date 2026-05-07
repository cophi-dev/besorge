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
});

type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const PERCENT_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
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

function formatSignedGwh(valueGwh: number, language: "en" | "de"): string {
  const abs = Math.abs(valueGwh);
  const sign = valueGwh >= 0 ? "+" : "−";
  const tag = valueGwh >= 0 ? (language === "de" ? "Überschuss" : "surplus") : language === "de" ? "Defizit" : "deficit";
  return `${sign}${NUMBER_FORMATTER.format(abs)} GWh ${tag}`;
}

function formatSignedValue(value: number, unit: string): string {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${NUMBER_FORMATTER.format(Math.abs(value))} ${unit}`;
}

function formatInstalledValue(value: number, unit: "GW" | "GWh"): string {
  return `${NUMBER_FORMATTER.format(value)} ${unit}`;
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

      const marketPromise = fetchJsonWithRetry<unknown>("/api/market/de");
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
  const volatilityScore = assessment ? Math.round(assessment.scoreBreakdown.volatility) : null;
  const rampScore = assessment ? Math.round(assessment.scoreBreakdown.adequacy) : null;
  const opportunityScore = assessment ? Math.round(assessment.score) : null;

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
  const eveningGapIsProxy = market?.eveningWindow == null;
  const eveningGapValueDisplay =
    eveningFlexibilityGapGw !== null
      ? formatGw(eveningFlexibilityGapGw)
      : language === "de"
        ? "voruebergehend nicht verfuegbar"
        : "temporarily unavailable";

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
  const effectiveGapDisplay = effectiveGapGw !== null ? formatGw(effectiveGapGw) : null;
  const effectiveGapValueDisplay =
    effectiveGapDisplay ?? (language === "de" ? "voruebergehend nicht verfuegbar" : "temporarily unavailable");

  const dailyEnergy = market?.dailyEnergy ?? null;
  const dailyEnergyAvailable = dailyEnergy !== null;
  const dailyTotalBalanceValue = dailyEnergyAvailable
    ? formatSignedGwh(dailyEnergy.totalNetBalanceGwh, language)
    : language === "de"
      ? "voruebergehend nicht verfuegbar"
      : "temporarily unavailable";

  const renewableSharePct = market?.realtimeSystem.renewableShareOfLoadPct ?? null;
  const unavailableShort = language === "de" ? "k. A." : "n/a";
  const quickStatsFleetSoc = socAvailable
    ? `~${PERCENT_FORMATTER.format(socBand.midpointPct)}%`
    : unavailableShort;
  const renewableShareDisplay =
    renewableSharePct !== null ? `${PERCENT_FORMATTER.format(renewableSharePct)}%` : unavailableShort;

  const takeawayText =
    dailyEnergy && effectiveGapGw !== null && socAvailable
      ? language === "de"
        ? `Heute liegt die Tagesbilanz bei ${formatSignedValue(dailyEnergy.totalNetBalanceGwh, "GWh")} (Netto-Systembilanz). Der geschätzte Fleet-SoC zum Abend liegt bei rund ${PERCENT_FORMATTER.format(socBand.midpointPct)}%, daher bleibt nach Flottenentladung eine effektive Evening Gap von etwa ${formatGw(effectiveGapGw)}. Für Dispatch heißt das: Chancen selektiv nutzen, aber Zyklen nur bei klaren Spreads fahren.`
        : `Today, the net daily system balance is ${formatSignedValue(dailyEnergy.totalNetBalanceGwh, "GWh")}. Estimated fleet SoC into the evening is around ${PERCENT_FORMATTER.format(socBand.midpointPct)}%, leaving an effective evening gap near ${formatGw(effectiveGapGw)} after expected fleet discharge. Dispatch takeaway: capture opportunities selectively and avoid cycling unless spreads are clear.`
      : language === "de"
        ? "Live-Daten werden geladen. Sobald Tagesbilanz, Fleet-SoC und Evening Gap vollständig vorliegen, wird hier ein klarer, datenbasierter Takeaway angezeigt."
        : "Live data is loading. Once daily balance, fleet SoC, and evening gap are available, this section will show a clear data-based takeaway.";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-16 px-8 pb-24 pt-16 md:gap-20 lg:px-12">
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
              Heutiger Key Takeaway
            </p>
            <p className="mt-2 max-w-4xl text-sm leading-relaxed text-slate-800 dark:text-slate-100">
              {takeawayText}
            </p>
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
        <div className="mt-10 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <KpiCard
              title={language === "de" ? "Gesamterzeugung" : "Total generation"}
              value={market ? formatAdaptivePower(market.realtimeSystem.domesticGenerationMw) : language === "de" ? "voruebergehend nicht verfuegbar" : "temporarily unavailable"}
              meaning={language === "de" ? "Aktuelle inländische Stromerzeugung." : "Current domestic electricity generation."}
              isLoading={isLiveDataLoading}
              detailRows={[
                { label: language === "de" ? "Erneuerbar" : "Renewable", value: renewableGenerationDisplay },
                { label: language === "de" ? "Konventionell" : "Conventional", value: conventionalGenerationDisplay },
              ]}
            />
            <KpiCard
              title={language === "de" ? "Aktuelle Last" : "Current demand"}
              value={market ? formatAdaptivePower(market.realtimeSystem.loadMw) : language === "de" ? "voruebergehend nicht verfuegbar" : "temporarily unavailable"}
              meaning={language === "de" ? "Live-Leistungsbedarf im Netz." : "Live power needed in the grid."}
              isLoading={isLiveDataLoading}
            />
          </div>
          <div className="flex justify-center">
            <KpiCard
              className="w-full md:max-w-md"
              title={language === "de" ? "Netto-Position" : "Net position"}
              value={
                netPositionMw !== null
                  ? `${netPositionMw >= 0 ? (language === "de" ? "Überschuss" : "Surplus") : language === "de" ? "Defizit" : "Deficit"} ${formatAdaptivePower(Math.abs(netPositionMw))}`
                  : language === "de"
                    ? "voruebergehend nicht verfuegbar"
                    : "temporarily unavailable"
              }
              meaning={language === "de" ? "Saldo aus inländischer Erzeugung und aktueller Last." : "Domestic generation balance vs current demand."}
              isLoading={isLiveDataLoading}
            />
          </div>
        </div>
        <article className="rounded-2xl border border-slate-300/45 bg-white/75 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
          <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {language === "de" ? "BESS-Flottenüberblick" : "BESS Fleet Overview"}
          </p>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
            {language === "de"
              ? "Summen basieren auf Energy-Charts; die Größensegmentierung auf Betriebsanlagen aus dem MaStR."
              : "Totals use Energy-Charts; size split uses MaStR operational registry units."}
          </p>
          <div className="mt-4 grid gap-4">
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
        </article>
        <article className="rounded-2xl border border-slate-300/45 bg-white/75 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
          <div className="flex flex-wrap items-center gap-2 text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            <span>{language === "de" ? "BESS-Deployment-Karte" : "BESS Deployment Map"}</span>
            <span className="inline-flex items-center rounded-full border border-blue-300/60 bg-blue-50/90 px-2 py-0.5 text-[10px] tracking-[0.1em] text-blue-700 dark:border-blue-300/35 dark:bg-blue-400/10 dark:text-blue-200">
              {language === "de" ? "Utility-Scale-Pins" : "Utility-scale pins"}
            </span>
            <span className="inline-flex items-center rounded-full border border-cyan-300/60 bg-cyan-50/90 px-2 py-0.5 text-[10px] tracking-[0.1em] text-cyan-700 dark:border-cyan-300/35 dark:bg-cyan-400/10 dark:text-cyan-200">
              {language === "de" ? "Small-Scale-Dichte" : "Small-scale density"}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {language === "de"
              ? "Utility-Scale- und Small-Scale-BESS-Standorte in Deutschland (MaStR-Daten)."
              : "Utility-scale and small-scale BESS locations across Germany (MaStR data)."}
          </p>
          <div className="mt-4">
            <MegapackMap compact />
          </div>
        </article>
      </section>

      <BessDispatchSimulator />

      <section
        id="market-signals"
        className="scroll-mt-8 space-y-5 border-t border-slate-200/90 pt-14 dark:border-slate-600/35 dark:pt-16"
      >
        <h2 className="text-2xl text-slate-800 dark:text-slate-100 md:text-3xl [font-family:var(--font-heading)]">
          {language === "de" ? "Strategische Signale" : "Strategic Signal Review"}
        </h2>
        <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
          {language === "de"
            ? "Kompakte Marktindikatoren — Kontext für Ihre Dispatch-Entscheidungen."
            : "Compact market indicators — context for dispatch decisions."}
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <CompactSignalStat
            label={language === "de" ? "Evening Gap" : "Evening gap"}
            value={eveningGapValueDisplay}
            footnote={
              eveningGapIsProxy && market
                ? language === "de"
                  ? "Snapshot-Proxy"
                  : "Snapshot proxy"
                : undefined
            }
            isLoading={isLiveDataLoading}
          />
          <CompactSignalStat
            label={language === "de" ? "Volatilität" : "Volatility"}
            value={volatilityScore !== null ? `${volatilityScore}/100` : unavailableShort}
            isLoading={isLiveDataLoading}
          />
          <CompactSignalStat
            label={language === "de" ? "Rampen" : "Ramps"}
            value={rampScore !== null ? `${rampScore}/100` : unavailableShort}
            isLoading={isLiveDataLoading}
          />
          <CompactSignalStat
            label={language === "de" ? "Opportunity" : "Opportunity"}
            value={opportunityScore !== null ? `${opportunityScore}/100` : unavailableShort}
            footnote={
              assessment
                ? language === "de"
                  ? assessment.verdict === "beneficial_now"
                    ? "Fazit: vorteilhaft"
                    : assessment.verdict === "not_beneficial_now"
                      ? "Fazit: nicht vorteilhaft"
                      : "Fazit: unklar"
                  : assessment.verdict === "beneficial_now"
                    ? "Verdict: beneficial"
                    : assessment.verdict === "not_beneficial_now"
                      ? "Verdict: not beneficial"
                      : "Verdict: uncertain"
                : undefined
            }
            isLoading={isLiveDataLoading}
          />
        </div>
      </section>

      <section
        id="quick-stats"
        className="scroll-mt-8 space-y-4 border-t border-slate-200/90 pt-12 dark:border-slate-600/35 dark:pt-14"
      >
        <p className="text-xs tracking-[0.16em] text-slate-500 uppercase dark:text-slate-400">
          {language === "de" ? "Markt-Quick-Stats" : "Market quick stats"}
        </p>
        <div className="flex flex-wrap gap-3">
          <QuickStatPill
            label={language === "de" ? "Tagesbilanz (Netto)" : "Daily net balance"}
            value={dailyTotalBalanceValue}
            isLoading={isLiveDataLoading || !dailyEnergyAvailable}
          />
          <QuickStatPill
            label={language === "de" ? "Fleet-SoC (Abend)" : "Fleet SoC (eve.)"}
            value={quickStatsFleetSoc}
            isLoading={isLiveDataLoading || !socAvailable}
          />
          <QuickStatPill
            label={language === "de" ? "Effektive Abendlücke" : "Effective evening gap"}
            value={effectiveGapValueDisplay}
            isLoading={isLiveDataLoading || effectiveGapDisplay === null}
          />
          <QuickStatPill
            label={language === "de" ? "Erneuerbar-Anteil" : "Renewable share"}
            value={renewableShareDisplay}
            isLoading={isLiveDataLoading}
          />
          <QuickStatPill
            label={language === "de" ? "Abend-Flexlücke (brutto)" : "Evening gap (gross)"}
            value={eveningGapValueDisplay}
            isLoading={isLiveDataLoading}
          />
        </div>
        {dailyEnergy ? (
          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            {language === "de" ? "Datum (Berlin):" : "Date (Berlin):"} {dailyEnergy.dateBerlin}
          </p>
        ) : null}
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

function KpiCard({
  title,
  value,
  meaning,
  sublabel,
  className,
  detailRows,
  isLoading = false,
}: {
  title: string;
  value: string;
  meaning: string;
  sublabel?: string;
  className?: string;
  detailRows?: Array<{ label: string; value: string }>;
  isLoading?: boolean;
}) {
  return (
    <article className={`relative rounded-2xl border border-slate-300/55 bg-white/80 p-5 dark:border-slate-500/40 dark:bg-slate-900/65 ${className ?? ""}`}>
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      {isLoading ? (
        <CardLoadingSkeleton compact />
      ) : (
        <>
          <p className="mt-2 text-3xl font-black text-slate-900 dark:text-white md:text-4xl [font-family:var(--font-sans)]">
            {value}
          </p>
          {detailRows?.length ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700 dark:text-slate-200">
          {detailRows.map((detail) => (
            <p key={detail.label} className="inline-flex items-center gap-1.5">
              <span className="text-slate-500 dark:text-slate-300">{detail.label}:</span>
              <span className="font-semibold text-slate-900 dark:text-white">{detail.value}</span>
            </p>
          ))}
        </div>
          ) : null}
          {sublabel ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-300">{sublabel}</p> : null}
          <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{meaning}</p>
        </>
      )}
    </article>
  );
}

function CompactSignalStat({
  label,
  value,
  footnote,
  isLoading = false,
}: {
  label: string;
  value: string;
  footnote?: string;
  isLoading?: boolean;
}) {
  return (
    <article className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-3.5 shadow-sm dark:border-slate-600/40 dark:bg-slate-900/45">
      <p className="text-[10px] font-medium tracking-[0.12em] text-slate-500 uppercase dark:text-slate-400">{label}</p>
      {isLoading ? (
        <div className="mt-2">
          <Skeleton className="h-7 w-20" />
        </div>
      ) : (
        <>
          <p className="mt-1.5 text-xl font-bold tabular-nums tracking-tight text-slate-900 dark:text-white md:text-2xl [font-family:var(--font-sans)]">
            {value}
          </p>
          {footnote ? <p className="mt-1 text-[10px] leading-tight text-slate-500 dark:text-slate-400">{footnote}</p> : null}
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

function CardLoadingSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`${compact ? "mt-3 space-y-2" : "mt-3 space-y-3"}`}>
      <Skeleton className={`${compact ? "h-8 w-2/3" : "h-10 w-3/4"}`} />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      {!compact ? <Skeleton className="h-3 w-4/5" /> : null}
    </div>
  );
}

