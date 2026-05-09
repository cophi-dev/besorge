"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import dynamic from "next/dynamic";
import { z } from "zod";

import { LiveSnapshotHeader } from "@/components/LiveSnapshotHeader";
import NewsPreviewSection from "@/components/NewsPreviewSection";
import { useLanguage } from "@/components/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { createLogger } from "@/lib/debug";
import type { ChartFleetSocSnapshot } from "@/lib/chartFleetSocSnapshot";
import { estimateFleetSocAtMoment, computeSlotSurplusFraction } from "@/lib/socEstimator";

const log = createLogger("market-snapshot");

const MegapackMap = dynamic(() => import("@/components/MegapackMap"), {
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
const DATA_FETCH_RETRIES = 2;
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
  const [liveLoadProgress, setLiveLoadProgress] = useState(10);
  const [isLiveDataLoading, setIsLiveDataLoading] = useState(true);
  const [chartFleetSoc, setChartFleetSoc] = useState<ChartFleetSocSnapshot | null>(null);

  const handleChartFleetSoc = useCallback((snapshot: ChartFleetSocSnapshot | null) => {
    setChartFleetSoc(snapshot);
  }, []);

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

      try {
        const marketResult = await fetchJsonWithRetry<unknown>("/api/market/de", "no-store");

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
  const netPositionMw = market ? market.realtimeSystem.domesticGenerationMw - market.realtimeSystem.loadMw : null;
  const inferredFleetMode = inferFleetMode({
    netPositionMw,
    residualLoadMw: market?.realtimeSystem.residualLoadMw ?? null,
  });
  const generationGw = market !== null ? market.realtimeSystem.domesticGenerationMw / 1000 : null;
  const demandGw = market !== null ? market.realtimeSystem.loadMw / 1000 : null;
  const netPositionGw = netPositionMw !== null ? netPositionMw / 1000 : null;
  const renewableSharePct =
    market &&
    renewableGenerationValue !== null &&
    market.realtimeSystem.domesticGenerationMw > 0
      ? (renewableGenerationValue / market.realtimeSystem.domesticGenerationMw) * 100
      : null;
  const fleetSocMoment =
    market !== null
      ? estimateFleetSocAtMoment({
          renewableShareOfLoadPct: market.realtimeSystem.renewableShareOfLoadPct ?? null,
          solarRichDays: market.recentRenewablePatterns?.solarRichDays ?? null,
          at: new Date(market.realtimeSystem.timestampIso),
          batteryStorageMw: market.realtimeSystem.batteryStorageMw ?? null,
          installedFleetPowerMw: market.bess.installedPowerGw * 1000,
          slotSurplusFraction: computeSlotSurplusFraction(market.dayEnergyFlow?.slots ?? null),
          currentNetPositionMw: netPositionMw,
        })
      : null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-5 pb-24 pt-12 md:gap-16 md:px-8 lg:px-12">
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
      <LiveSnapshotHeader
        language={language}
        isLoading={isLiveDataLoading}
        generationGw={generationGw}
        renewableSharePct={renewableSharePct}
        demandGw={demandGw}
        netPositionGw={netPositionGw}
        fleetMode={inferredFleetMode}
        chartFleetSoc={chartFleetSoc}
        fleetSocMoment={fleetSocMoment}
        updatedAtIso={market?.realtimeSystem.timestampIso ?? null}
      />

      <section
        id="overview"
        className="border-t border-slate-200/90 pt-12 md:pt-14 dark:border-slate-600/35"
      >
        <GermanyDayEnergyFlow
          fleetCapacityGwh={market?.bess.installedCapacityGwh}
          fleetPowerGw={market?.bess.installedPowerGw}
          language={language}
          onChartFleetSocSnapshot={handleChartFleetSoc}
        />
      </section>

      <section className="border-t border-slate-200/90 pt-12 md:pt-14 dark:border-slate-600/35">
        <details className="group rounded-2xl border border-slate-300/45 bg-white/75 p-4 dark:border-slate-500/35 dark:bg-slate-900/55">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-2 py-2 text-left">
            <div>
              <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
                {language === "de" ? "Flotte · Karte" : "Fleet · map"}
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

      <section className="border-t border-slate-200/90 pt-12 dark:border-slate-600/35">
        <NewsPreviewSection limit={5} compact showHeaderLink={false} />
      </section>

    </div>
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

