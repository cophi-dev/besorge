"use client";

import dynamic from "next/dynamic";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { z } from "zod";

import { MethodologySection } from "@/components/briefing/MethodologySection";
import { BriefingSectionNav } from "@/components/home/BriefingSectionNav";
import { LiveSnapshotHeader } from "@/components/LiveSnapshotHeader";
import { useLanguage } from "@/components/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { createLogger } from "@/lib/debug";
import type { HomeBriefingInitialData } from "@/lib/homeBriefingData";
import type { ChartFleetSocSnapshot } from "@/lib/chartFleetSocSnapshot";
import type { BriefingStoryWindow } from "@/lib/briefingStoryWindow";
import {
  applyBriefingStoryWindowToSearchParams,
  parseBriefingStoryWindowFromSearchParams,
  serializeBriefingStoryWindow,
} from "@/lib/briefingStoryWindow";
import { formatBerlinDateKeyFromUtcDate } from "@/lib/berlinCalendar";
import { estimateFleetSocAtMoment, computeSlotSurplusFraction } from "@/lib/socEstimator";

const log = createLogger("home-briefing");

const MegapackMap = dynamic(() => import("@/components/MegapackMap"), {
  ssr: false,
  loading: () => <Skeleton className="h-[460px] w-full rounded-xl" />,
});
const GermanyDayEnergyFlow = dynamic(() => import("@/components/GermanyDayEnergyFlow"), {
  ssr: false,
  loading: () => (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card/30 p-4">
      <Skeleton className="h-8 w-2/3 max-w-md" />
      <Skeleton className="h-[min(460px,72vw)] min-h-[280px] w-full rounded-xl" />
    </div>
  ),
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
          crossBorderElectricityTradingMw: z.number().nullable().optional(),
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

function parseMarketFromInitial(raw: HomeBriefingInitialData["market"]): MarketSnapshot | null {
  if (raw === null) {
    return null;
  }
  const parsed = marketSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    log("initial market failed schema validation %o", parsed.error.flatten());
    return null;
  }
  return parsed.data;
}

type HomeBriefingClientProps = {
  initial: HomeBriefingInitialData;
};

/**
 * Owns daily-story state that can diverge from the URL when the chart selector
 * changes before the URL sync effect runs. Remounting (via `key` on the parent)
 * clears the override so a new shared link wins without a sync effect.
 */
function GermanyFlowStoryBridge({
  urlAnchoredStoryWindow,
  storyRefreshNonce,
  children,
}: {
  urlAnchoredStoryWindow: BriefingStoryWindow;
  storyRefreshNonce: number;
  children: (args: {
    briefingStoryWindow: BriefingStoryWindow;
    briefingStoryRefreshNonce: number;
    onBriefingStoryWindowChange: (window: BriefingStoryWindow) => void;
  }) => ReactNode;
}) {
  const defaultStoryWindow = urlAnchoredStoryWindow;
  const defaultSerialized = useMemo(
    () => serializeBriefingStoryWindow(defaultStoryWindow),
    [defaultStoryWindow]
  );
  const [chartStoryOverride, setChartStoryOverride] = useState<BriefingStoryWindow | null>(null);
  const storyWindow = chartStoryOverride ?? defaultStoryWindow;
  const onBriefingStoryWindowChange = useCallback(
    (nextWindow: BriefingStoryWindow) => {
      setChartStoryOverride((prev) => {
        const nextSerialized = serializeBriefingStoryWindow(nextWindow);
        const nextOverride = nextSerialized === defaultSerialized ? null : nextWindow;
        const prevSerialized = prev === null ? null : serializeBriefingStoryWindow(prev);
        if (prevSerialized === nextSerialized) {
          return prev;
        }
        return nextOverride;
      });
    },
    [defaultSerialized]
  );
  return <>{children({ briefingStoryWindow: storyWindow, briefingStoryRefreshNonce: storyRefreshNonce, onBriefingStoryWindowChange })}</>;
}

export function HomeBriefingClient({ initial }: HomeBriefingClientProps) {
  const { language } = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const simQuery = searchParams.get("sim");
  const initialSimulatedNet = simQuery === "1" || simQuery === "true";

  const [market, setMarket] = useState<MarketSnapshot | null>(() => parseMarketFromInitial(initial.market));
  const [liveLoadProgress, setLiveLoadProgress] = useState(10);
  const [isLiveDataLoading, setIsLiveDataLoading] = useState(() => initial.market === null);
  const [chartFleetSoc, setChartFleetSoc] = useState<ChartFleetSocSnapshot | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  /** Bumped on every user-initiated Refresh so the LLM story re-rolls. */
  const [storyRefreshNonce, setStoryRefreshNonce] = useState(0);

  const handleChartFleetSoc = useCallback((snapshot: ChartFleetSocSnapshot | null) => {
    setChartFleetSoc(snapshot);
  }, []);

  const loadMarketData = useCallback(async () => {
    const fetchJsonWithRetry = async <T,>(url: string, cache: RequestCache = "default"): Promise<T> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= DATA_FETCH_RETRIES; attempt += 1) {
        try {
          const response = await fetch(url, { cache });
          if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
          }
          return (await response.json()) as T;
        } catch (error) {
          lastError = error;
          if (attempt >= DATA_FETCH_RETRIES) {
            break;
          }
          await sleep(250 * 2 ** attempt);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Unknown request failure");
    };

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
      /* cards show fallbacks */
    }

    setLiveLoadProgress(100);
    window.setTimeout(() => {
      setIsLiveDataLoading(false);
    }, 180);
  }, []);

  useEffect(() => {
    if (initial.market !== null) {
      return undefined;
    }
    const progressIntervalId = window.setInterval(() => {
      setLiveLoadProgress((current) => Math.min(92, current + (current < 55 ? 8 : 4)));
    }, 350);
    queueMicrotask(() => {
      void loadMarketData();
    });
    return () => window.clearInterval(progressIntervalId);
  }, [initial.market, loadMarketData]);

  const handleRefresh = useCallback(() => {
    void loadMarketData();
    setStoryRefreshNonce((n) => n + 1);
    router.refresh();
  }, [loadMarketData, router]);

  const handleShare = useCallback(async () => {
    setShareBusy(true);
    const params = new URLSearchParams(searchParams.toString());
    const url = `${typeof window !== "undefined" ? window.location.origin : ""}${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      log("clipboard write failed for url %s", url);
    } finally {
      window.setTimeout(() => setShareBusy(false), 400);
    }
  }, [pathname, searchParams]);

  const defaultBerlinDateKey =
    initial.defaultBerlinDateKey ?? formatBerlinDateKeyFromUtcDate(new Date());

  const urlAnchoredStoryWindow = useMemo((): BriefingStoryWindow => {
    return (
      parseBriefingStoryWindowFromSearchParams(searchParams) ?? {
        type: "day",
        date: defaultBerlinDateKey,
      }
    );
  }, [searchParams, defaultBerlinDateKey]);

  const handleStoryWindowUrlChange = useCallback(
    (window: BriefingStoryWindow) => {
      const next = new URLSearchParams(searchParams.toString());
      applyBriefingStoryWindowToSearchParams(window, next);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const handleSimulatedModeChange = useCallback(
    (simulated: boolean) => {
      const next = new URLSearchParams(searchParams.toString());
      if (simulated) {
        next.set("sim", "1");
      } else {
        next.delete("sim");
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

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

  const seedStoryWindow = urlAnchoredStoryWindow;

  return (
    <div
      id="speicherpilot-briefing-root"
      className="scroll-mt-20 md:scroll-mt-24 mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 pb-16 pt-5 md:gap-8 md:px-8 md:pb-20 lg:px-12"
    >
      {isLiveDataLoading && initial.market === null ? (
        <div className="pointer-events-none fixed top-[calc(3.5rem+env(safe-area-inset-top,0px))] left-1/2 z-[1200] w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-border/80 bg-card/95 p-3 shadow-lg backdrop-blur-md sm:top-[calc(4rem+env(safe-area-inset-top,0px))] lg:top-[calc(68px+env(safe-area-inset-top,0px))]">
          <p className="text-xs text-muted-foreground">
            {language === "de"
              ? "Energy-Charts & Snapshot werden geladen…"
              : "Loading Energy-Charts snapshot…"}
          </p>
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-emerald-500 transition-[width] duration-300 ease-out"
              style={{ width: `${Math.max(5, Math.min(100, liveLoadProgress))}%` }}
            />
          </div>
        </div>
      ) : null}

      <BriefingSectionNav language={language} />

      <section id="briefing-live">
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
      </section>

      <section id="overview" className="border-t border-border/50 pt-8 md:pt-10">
        <GermanyFlowStoryBridge
          key={serializeBriefingStoryWindow(urlAnchoredStoryWindow)}
          urlAnchoredStoryWindow={urlAnchoredStoryWindow}
          storyRefreshNonce={storyRefreshNonce}
        >
          {({ briefingStoryWindow, briefingStoryRefreshNonce, onBriefingStoryWindowChange }) => (
            <GermanyDayEnergyFlow
              fleetCapacityGwh={market?.bess.installedCapacityGwh}
              fleetPowerGw={market?.bess.installedPowerGw}
              language={language}
              isRefreshing={isLiveDataLoading}
              lastUpdatedIso={
                market?.realtimeSystem.timestampIso ?? initial.market?.realtimeSystem.timestampIso ?? null
              }
              onRefresh={handleRefresh}
              onShare={handleShare}
              shareBusy={shareBusy}
              onChartFleetSocSnapshot={handleChartFleetSoc}
              initialEnergyFlow={initial.initialEnergyFlow}
              initialBerlinDateKey={initial.defaultBerlinDateKey}
              seedStoryWindow={seedStoryWindow}
              onStoryWindowUrlChange={handleStoryWindowUrlChange}
              onBriefingStoryWindowChange={onBriefingStoryWindowChange}
              briefingStoryWindow={briefingStoryWindow}
              briefingStoryRefreshNonce={briefingStoryRefreshNonce}
              initialSimulatedNet={initialSimulatedNet}
              onSimulatedModeChange={handleSimulatedModeChange}
            />
          )}
        </GermanyFlowStoryBridge>
      </section>

      <section id="methodology">
        <MethodologySection language={language} />
      </section>

      <section id="fleet-map" className="border-t border-border/50 pt-8 md:pt-10">
        <details
          open
          className="group rounded-xl border border-border/60 bg-card/40 p-3 backdrop-blur-sm dark:bg-card/25"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-2 py-2 text-left">
            <div>
              <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
                {language === "de" ? "Flotte · Karte" : "Fleet · map"}
              </p>
            </div>
            <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition group-open:rotate-180" />
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
    <div className="min-w-[min(100%,11rem)] flex-1 rounded-xl border border-border/70 bg-card/80 px-4 py-3 shadow-sm">
      <p className="text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">{label}</p>
      {isLoading ? (
        <div className="mt-2">
          <Skeleton className="h-6 w-28" />
        </div>
      ) : (
        <p className="mt-1 text-base font-bold tabular-nums text-foreground md:text-lg [font-family:var(--font-sans)]">
          {value}
        </p>
      )}
    </div>
  );
}
