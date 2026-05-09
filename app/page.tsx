"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Lightbulb } from "lucide-react";
import dynamic from "next/dynamic";
import { z } from "zod";

import NewsPreviewSection from "@/components/NewsPreviewSection";
import { useLanguage } from "@/components/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { createLogger } from "@/lib/debug";
import { computeNetSurplusFleetAbsorption } from "@/lib/netSurplusFleetAbsorption";
import { computePracticalDailyCycleCapacityMwh } from "@/lib/optimalBessCapacity";
import { estimateEveningSoc, type SocBand } from "@/lib/socEstimator";

const log = createLogger("market-snapshot");

const MegapackMap = dynamic(() => import("@/components/MegapackMap"), {
  ssr: false,
});
const GermanyDayEnergyFlow = dynamic(() => import("@/components/GermanyDayEnergyFlow"), {
  ssr: false,
});

const recommendationFlowSchema = z.object({
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
});

type FourWeekRecommendation = {
  p95PracticalCapacityMwh: number;
  coveredDays: number;
};

type KeyNumbersSummary = {
  practicalCapacityMwh: number;
  grossSurplusMwh: number;
  theoreticallyStorableMwh: number;
  missedSurplusMwh: number;
  dateLabel: string;
};

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
    batteryStorageMw: z.number().nullable().optional(),
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
const MWH_COMPACT_FORMATTER = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
const LIVE_UPDATE_LABEL: Record<"en" | "de", string> = {
  en: "Updated live",
  de: "Live aktualisiert",
};
const DATA_FETCH_RETRIES = 2;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
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

function formatInstalledValue(value: number, unit: "GW" | "GWh"): string {
  return `${NUMBER_FORMATTER.format(value)} ${unit}`;
}

function formatEnergyFromMwh(mwh: number): string {
  const gwh = mwh / 1_000;
  if (Math.abs(gwh) >= 1) {
    return `${MWH_COMPACT_FORMATTER.format(gwh)} GWh`;
  }
  return `${MWH_COMPACT_FORMATTER.format(mwh)} MWh`;
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
  const [liveLoadProgress, setLiveLoadProgress] = useState(10);
  const [isLiveDataLoading, setIsLiveDataLoading] = useState(true);
  const [fourWeekRecommendation, setFourWeekRecommendation] = useState<FourWeekRecommendation | null>(null);
  const [keyNumbersSummary, setKeyNumbersSummary] = useState<KeyNumbersSummary | null>(null);

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
      setLiveLoadProgress(10);
      setFourWeekRecommendation(null);
      setKeyNumbersSummary(null);

      try {
        const [marketResult, thisMonthRaw, lastMonthRaw, yesterdayRaw] = await Promise.all([
          fetchJsonWithRetry<unknown>("/api/market/de", "no-store"),
          fetchJsonWithRetry<unknown>("/api/market/de/energy-flow?period=this_month", "no-store").catch(
            () => null
          ),
          fetchJsonWithRetry<unknown>("/api/market/de/energy-flow?period=last_month", "no-store").catch(
            () => null
          ),
          fetchJsonWithRetry<unknown>("/api/market/de/energy-flow?period=yesterday", "no-store").catch(
            () => null
          ),
        ]);

        const parsed = marketSnapshotSchema.safeParse(marketResult);
        if (parsed.success) {
          setMarket(parsed.data);
          const todaySlots = parsed.data.dayEnergyFlow?.slots ?? [];
          const yesterdayParsed = recommendationFlowSchema.safeParse(yesterdayRaw);
          const yesterdaySlots = yesterdayParsed.success ? yesterdayParsed.data.slots : [];
          const candidates: Array<{ slots: typeof todaySlots; dateLabel: string }> = [
            { slots: todaySlots, dateLabel: parsed.data.dayEnergyFlow?.dateBerlin ?? "today" },
            { slots: yesterdaySlots, dateLabel: "yesterday" },
          ];
          for (const candidate of candidates) {
            if (candidate.slots.length < 4) {
              continue;
            }
            const practical = computePracticalDailyCycleCapacityMwh(candidate.slots);
            const absorption = computeNetSurplusFleetAbsorption(
              candidate.slots,
              parsed.data.bess.installedCapacityGwh * 1_000,
              parsed.data.bess.installedPowerGw * 1_000
            );
            const hasSignal =
              practical !== null &&
              (practical.practicalCapacityMwh > 0 ||
                absorption.grossSurplusEnergyMwh > 0 ||
                absorption.absorbedEnergyMwh > 0 ||
                absorption.missedSurplusEnergyMwh > 0);
            if (practical && hasSignal) {
              setKeyNumbersSummary({
                practicalCapacityMwh: practical.practicalCapacityMwh,
                grossSurplusMwh: absorption.grossSurplusEnergyMwh,
                theoreticallyStorableMwh: absorption.absorbedEnergyMwh,
                missedSurplusMwh: absorption.missedSurplusEnergyMwh,
                dateLabel: candidate.dateLabel,
              });
              break;
            }
          }
        } else {
          log("market snapshot failed schema validation %o", {
            request: { url: "/api/market/de" },
            errors: parsed.error.flatten(),
          });
        }

        const monthPayloads = [thisMonthRaw, lastMonthRaw]
          .map((entry) => recommendationFlowSchema.safeParse(entry))
          .filter((entry) => entry.success)
          .map((entry) => entry.data);
        const mergedSlots = monthPayloads
          .flatMap((entry) => entry.slots)
          .sort((a, b) => new Date(a.timestampIso).getTime() - new Date(b.timestampIso).getTime());
        if (mergedSlots.length > 0) {
          const latestTs = new Date(mergedSlots[mergedSlots.length - 1].timestampIso).getTime();
          const minTs = latestTs - 28 * DAY_MILLISECONDS;
          const lastFourWeeksSlots = mergedSlots.filter((slot) => {
            const ts = new Date(slot.timestampIso).getTime();
            return Number.isFinite(ts) && ts >= minTs;
          });
          const recommendation = computePracticalDailyCycleCapacityMwh(lastFourWeeksSlots);
          if (recommendation) {
            const uniqueDays = new Set(
              lastFourWeeksSlots.map((slot) => slot.timestampIso.slice(0, 10))
            ).size;
            setFourWeekRecommendation({
              p95PracticalCapacityMwh: recommendation.practicalCapacityMwh,
              coveredDays: uniqueDays,
            });
          }
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

  const unavailableShort = language === "de" ? "k. A." : "n/a";

  const fallbackTakeawayText =
    language === "de"
      ? "In Kürze siehst du die Kernbotschaft aus Live-Lage, Tagesprofil und Handlungsempfehlung."
      : "The core message from live position, daily profile, and recommendation will appear shortly.";

  /** Keep MW / GWh numbers out of the takeaway when they already appear in Live Metrics or the daily profile. */
  const takeawayLines =
    effectiveGapGw !== null && socAvailable && netPositionMw !== null
      ? language === "de"
        ? [
            netPositionMw >= 0
              ? "Der Markt startet heute mit strukturellem Überschuss und klar nutzbaren Ladefenstern."
              : "Der Markt startet heute mit strukturellem Defizit und engem Flexibilitätsfenster.",
            "Das Daily Profile zeigt, wann Überschüsse real in nutzbare Speicherarbeit übergehen und wo Energie liegen bleibt.",
            "Nutze die Empfehlung unten als pragmatische Zielgröße für BESS-Kapazität auf Basis der letzten vier Wochen.",
          ]
        : [
            netPositionMw >= 0
              ? "The market opens with structural surplus and clear charging windows."
              : "The market opens with structural deficit and a tighter flexibility window.",
            "The daily profile shows when surplus turns into usable storage work and where energy is still missed.",
            "Use the recommendation below as a practical BESS capacity target based on the last four weeks.",
          ]
      : null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-5 pb-20 pt-12 md:gap-14 md:px-8 lg:px-12">
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
      <p className="text-xs tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{liveUpdateLabel}</p>

      <section className="space-y-2">
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
          {language === "de" ? "Live Snapshot" : "Live snapshot"}
        </p>
        <div className="grid gap-2.5 sm:grid-cols-3">
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
            title={language === "de" ? "Netto + BESS" : "Net position + BESS"}
            value={
              netPositionMw !== null
                ? `${netPositionMw >= 0 ? (language === "de" ? "Überschuss" : "Surplus") : language === "de" ? "Defizit" : "Deficit"} ${formatAdaptivePower(Math.abs(netPositionMw))}`
                : language === "de"
                  ? "voruebergehend nicht verfuegbar"
                  : "temporarily unavailable"
            }
            detailLine={`${language === "de" ? "Status" : "Status"} · ${fleetModeLabel}`}
            isLoading={isLiveDataLoading}
          />
        </div>
      </section>

      <section
        id="overview"
        className="space-y-6 border-t border-slate-200/90 pt-8 md:space-y-8 dark:border-slate-600/35"
      >
        <div className="max-w-3xl space-y-1.5">
          <h2 className="text-xl text-slate-900 dark:text-slate-100 md:text-2xl [font-family:var(--font-heading)]">
            {language === "de" ? "ENERGY-CHARTS DAILY PROFILE" : "ENERGY-CHARTS DAILY PROFILE"}
          </h2>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {language === "de"
              ? "Klarer Fokus auf Tagesprofil, praktische Speichergröße und verpasste Überschüsse."
              : "Clear focus on daily profile, practical storage size, and missed surplus."}
          </p>
        </div>
        <GermanyDayEnergyFlow
          fleetCapacityGwh={market?.bess.installedCapacityGwh}
          fleetPowerGw={market?.bess.installedPowerGw}
          language={language}
        />
      </section>

      <section className="space-y-4 border-t border-slate-200/90 pt-8 dark:border-slate-600/35">
        <p className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-blue-800 uppercase dark:text-blue-200">
          <Lightbulb className="h-3.5 w-3.5" />
          {language === "de" ? "Key Takeaway" : "Key takeaway"}
        </p>
        {takeawayLines ? (
          <div className="rounded-2xl border border-blue-200/75 bg-blue-50/80 p-5 dark:border-blue-300/35 dark:bg-blue-400/10">
            <div className="space-y-2.5 text-sm leading-relaxed text-slate-800 md:text-base dark:text-slate-100">
              {takeawayLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-slate-300/50 bg-white/80 p-4 text-sm text-slate-700 dark:border-slate-500/40 dark:bg-slate-900/50 dark:text-slate-200">
            {fallbackTakeawayText}
          </p>
        )}
      </section>

      <section className="border-t border-slate-200/90 pt-8 dark:border-slate-600/35">
        <details className="group rounded-2xl border border-slate-300/45 bg-white/75 p-4 dark:border-slate-500/35 dark:bg-slate-900/55">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-2 py-2 text-left">
            <div>
              <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
                {language === "de" ? "Fleet Context + Map" : "Fleet context + map"}
              </p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                {language === "de"
                  ? "Sekundärer Kontext zu installierter Flotte und Standorten."
                  : "Secondary context for installed fleet and deployment footprint."}
              </p>
            </div>
            <ChevronDown className="h-5 w-5 shrink-0 text-slate-500 transition group-open:rotate-180 dark:text-slate-300" />
          </summary>
          <div className="mt-3 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <QuickStatPill
                label={language === "de" ? "Installierte Leistung (DE)" : "Installed power (DE)"}
                value={formatInstalledValue(BESS_OVERVIEW.power.totalGw, "GW")}
                isLoading={false}
              />
              <QuickStatPill
                label={language === "de" ? "Installierte Energie (DE)" : "Installed energy (DE)"}
                value={formatInstalledValue(BESS_OVERVIEW.energy.totalGwh, "GWh")}
                isLoading={false}
              />
            </div>
            <MegapackMap compact />
          </div>
        </details>
      </section>

      <section id="market-snapshot" className="scroll-mt-8 space-y-4 border-t border-slate-200/90 pt-10 dark:border-slate-600/35">
        <div className="max-w-3xl">
          <h2 className="text-lg text-slate-800 dark:text-slate-100 md:text-xl [font-family:var(--font-heading)]">
            {language === "de" ? "Key Numbers & Recommendation" : "Key Numbers & Recommendation"}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {language === "de"
              ? "Kernaussagen aus Tagesprofil plus empfohlene BESS-Kapazität aus den letzten vier Wochen."
              : "Core day-profile numbers plus a recommended BESS capacity from the last four weeks."}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <QuickStatPill
            label={language === "de" ? "P95 Practical Capacity" : "P95 Practical Capacity"}
            value={keyNumbersSummary ? formatEnergyFromMwh(keyNumbersSummary.practicalCapacityMwh) : unavailableShort}
            isLoading={isLiveDataLoading}
          />
          <QuickStatPill
            label={language === "de" ? "Gross Surplus" : "Gross Surplus"}
            value={keyNumbersSummary ? formatEnergyFromMwh(keyNumbersSummary.grossSurplusMwh) : unavailableShort}
            isLoading={isLiveDataLoading}
          />
        </div>
        {keyNumbersSummary ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {language === "de"
              ? `Key Numbers basieren auf: ${keyNumbersSummary.dateLabel}.`
              : `Key numbers are based on: ${keyNumbersSummary.dateLabel}.`}
          </p>
        ) : null}
        <article className="rounded-2xl border border-emerald-300/45 bg-emerald-50/60 p-5 dark:border-emerald-300/30 dark:bg-emerald-500/10">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-emerald-800 uppercase dark:text-emerald-200">
            {language === "de"
              ? "Recommended BESS Capacity based on last 4 weeks"
              : "Recommended BESS Capacity based on last 4 weeks"}
          </p>
          <p className="mt-2 text-2xl font-extrabold text-emerald-900 dark:text-emerald-100">
            {fourWeekRecommendation
              ? `${formatEnergyFromMwh(fourWeekRecommendation.p95PracticalCapacityMwh)} (P95)`
              : unavailableShort}
          </p>
          <p className="mt-2 text-xs text-emerald-900/85 dark:text-emerald-100/85">
            {fourWeekRecommendation
              ? language === "de"
                ? `Berechnet aus ${fourWeekRecommendation.coveredDays.toString()} beobachteten Berlin-Tagen in den jüngsten 4 Wochen.`
                : `Computed from ${fourWeekRecommendation.coveredDays.toString()} observed Berlin days across the latest 4 weeks.`
              : language === "de"
                ? "Empfehlung wird geladen, sobald genügend veröffentlichte Viertelstunden vorliegen."
                : "Recommendation appears once enough published quarter-hours are available."}
          </p>
        </article>
      </section>

      <section className="border-t border-slate-200/90 pt-8 dark:border-slate-600/35">
        <NewsPreviewSection limit={5} compact showHeaderLink={false} />
      </section>

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

