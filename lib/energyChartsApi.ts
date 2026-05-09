import { z } from "zod";

import { getBerlinDateKeyFromUnixSeconds as getBerlinDateKey } from "@/lib/berlinCalendar";
import { computeEconomics, defaultEconomicsAssumptions } from "@/lib/bessEconomics";
import { createLogger } from "@/lib/debug";
import { computeCoverageAtCapacityMwh, computeLogicalBessRecommendation } from "@/lib/optimalBessCapacity";
import type {
  GermanyEnergyFlowBerlinRange,
  GermanyEnergyFlowPeriod,
} from "@/lib/germanyEnergyFlowPeriod";
import {
  expectedQuarterHoursInFlowRange,
  resolveGermanyEnergyFlowBerlinRange,
  totalPowerFetchStartDateForRange,
} from "@/lib/germanyEnergyFlowPeriod";

const log = createLogger("energy-charts");

const ENERGY_CHARTS_BASE_URL = "https://api.energy-charts.info";
const ENERGY_CHARTS_STALE_TTL_MS = 1000 * 60 * 60 * 24;
const ENERGY_CHARTS_REVALIDATE_SECONDS = 60;
const DEFAULT_RETRY_ATTEMPTS = 2;
/** Energy-Charts occasionally returns 404 under load; treat like other transient upstream errors. */
const RETRYABLE_STATUS_CODES = new Set([404, 429, 500, 502, 503, 504]);
const responseCache = new Map<string, { fetchedAtMs: number; payload: unknown }>();

/** Clears the in-memory Energy-Charts success cache (tests only; see `energyChartsApi.test.ts`). */
export function clearEnergyChartsResponseCache(): void {
  responseCache.clear();
}

/** Energy-Charts returns 404 for `total_power?country=de` without explicit calendar `start`/`end`. */
const GERMANY_TOTAL_POWER_LOOKBACK_DAYS = 45;

const formatCalendarDateBerlin = (date: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const getGermanyTotalPowerPathForCalendarRange = (startStr: string, endStr: string): string =>
  `/total_power?country=de&start=${startStr}&end=${endStr}`;

const getGermanyTotalPowerPath = (): string => {
  const end = new Date();
  const startMs = end.getTime() - GERMANY_TOTAL_POWER_LOOKBACK_DAYS * 86_400_000;
  const startStr = formatCalendarDateBerlin(new Date(startMs));
  const endStr = formatCalendarDateBerlin(end);
  return getGermanyTotalPowerPathForCalendarRange(startStr, endStr);
};

const seriesSchema = z.object({
  name: z.string(),
  data: z.array(z.number().nullable()),
});

const totalPowerResponseSchema = z.object({
  unix_seconds: z.array(z.number()),
  production_types: z.array(seriesSchema),
});

const installedPowerResponseSchema = z.object({
  time: z.array(z.string()),
  production_types: z.array(seriesSchema),
  last_update: z.number().optional(),
});

const renewableShareForecastResponseSchema = z.object({
  unix_seconds: z.array(z.number()),
  ren_share: z.array(z.number().nullable()),
  substitute: z.boolean(),
  deprecated: z.boolean(),
});
type TotalPowerResponse = z.infer<typeof totalPowerResponseSchema>;
type InstalledPowerResponse = z.infer<typeof installedPowerResponseSchema>;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const fetchJson = async <T>(
  path: string,
  schema: z.ZodSchema<T>,
  options?: {
    retries?: number;
    allowStaleOnFailure?: boolean;
    staleTtlMs?: number;
    noStore?: boolean;
  }
): Promise<T> => {
  const url = `${ENERGY_CHARTS_BASE_URL}${path}`;
  const retries = options?.retries ?? DEFAULT_RETRY_ATTEMPTS;
  const allowStaleOnFailure = options?.allowStaleOnFailure ?? false;
  const staleTtlMs = options?.staleTtlMs ?? ENERGY_CHARTS_STALE_TTL_MS;
  const noStore = options?.noStore ?? false;

  let lastFailureMessage = "Unknown fetch failure";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        ...(noStore
          ? { cache: "no-store" as const }
          : {
              // Keep upstream snapshots fresh enough for the 15-min cadence.
              next: { revalidate: ENERGY_CHARTS_REVALIDATE_SECONDS },
            }),
      });

      if (!response.ok) {
        const responseBody = await response.text();
        log("request failed %o", {
          request: { url, method: "GET" },
          response: {
            status: response.status,
            statusText: response.statusText,
            body: responseBody.slice(0, 500),
          },
          retry: { attempt, retries },
        });
        lastFailureMessage = `Energy-Charts request failed with status ${response.status}`;
        const canRetry = RETRYABLE_STATUS_CODES.has(response.status) && attempt < retries;
        if (canRetry) {
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw new Error(lastFailureMessage);
      }

      const payload = await response.json();
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        log("schema parse failed %o", {
          request: { url, method: "GET" },
          errors: parsed.error.flatten(),
          retry: { attempt, retries },
        });
        lastFailureMessage = "Energy-Charts returned an unexpected response shape";
        throw new Error(lastFailureMessage);
      }

      responseCache.set(url, {
        fetchedAtMs: Date.now(),
        payload: parsed.data,
      });

      return parsed.data;
    } catch (error) {
      const retryableError = error instanceof Error ? error : new Error("Unknown fetch failure");
      lastFailureMessage = retryableError.message;
      if (attempt < retries) {
        await sleep(200 * 2 ** attempt);
        continue;
      }
      break;
    }
  }

  if (allowStaleOnFailure) {
    const cached = responseCache.get(url);
    if (cached && Date.now() - cached.fetchedAtMs <= staleTtlMs) {
      const parsedCached = schema.safeParse(cached.payload);
      if (parsedCached.success) {
        log("serving stale response after upstream failure %o", {
          request: { url, method: "GET" },
          staleAgeMs: Date.now() - cached.fetchedAtMs,
          staleTtlMs,
          reason: lastFailureMessage,
        });
        return parsedCached.data;
      }
    }
  }

  throw new Error(lastFailureMessage);
};

const findSeriesOrThrow = (
  series: { name: string; data: Array<number | null> }[],
  name: string
) => {
  const match = series.find((entry) => entry.name === name);
  if (!match) {
    throw new Error(`Series "${name}" not found`);
  }
  return match;
};

const getLatestNonNullPoint = <TLabel extends string | number>(
  labels: TLabel[],
  values: Array<number | null>
) => {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null) {
      return { label: labels[index], value, index };
    }
  }
  throw new Error("No non-null data points available");
};

/** Series excluded from domestic generation sum (meta, demand, or cross-border). */
const EXCLUDED_FROM_DOMESTIC_GENERATION = new Set([
  "Load (incl. self-consumption)",
  "Residual load",
  "Renewable share of load",
  "Renewable share of generation",
  "Cross border electricity trading",
  "Hydro pumped storage consumption",
]);

const valueAtIndexWithFallback = (
  data: Array<number | null>,
  primaryIndex: number,
  maxStepsBack = 12
): number | null => {
  for (let step = 0; step <= maxStepsBack && primaryIndex - step >= 0; step += 1) {
    const value = data[primaryIndex - step];
    if (value !== null && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
};

const pickLatestAvailableValue = (
  data: Array<number | null>,
  primaryIndex: number
): number | null =>
  valueAtIndexWithFallback(data, primaryIndex, 96) ??
  valueAtIndexWithFallback(data, data.length - 1, data.length);

const sumDomesticGenerationMw = (
  productionTypes: { name: string; data: Array<number | null> }[],
  loadIndex: number
): number => {
  let sum = 0;
  for (const series of productionTypes) {
    if (EXCLUDED_FROM_DOMESTIC_GENERATION.has(series.name)) {
      continue;
    }
    if (isResidualLoadProductionSeriesName(series.name)) {
      continue;
    }
    const value = valueAtIndexWithFallback(series.data, loadIndex, 0);
    if (value !== null) {
      sum += value;
    }
  }
  return sum;
};

/** Domestic generation stacked in `total_power`, excluding battery (prevents double-count vs battery charge signal). */
const sumDomesticGenerationExcludingBatteryMw = (
  productionTypes: { name: string; data: Array<number | null> }[],
  dataIndex: number
): number => {
  let sum = 0;
  for (const series of productionTypes) {
    if (EXCLUDED_FROM_DOMESTIC_GENERATION.has(series.name)) {
      continue;
    }
    if (isResidualLoadProductionSeriesName(series.name)) {
      continue;
    }
    if (/battery/i.test(series.name)) {
      continue;
    }
    const value = valueAtIndexWithFallback(series.data, dataIndex, 0);
    if (value !== null) {
      sum += value;
    }
  }
  return sum;
};

const findBatteryStorageSeries = (
  productionTypes: { name: string; data: Array<number | null> }[]
): { name: string; data: Array<number | null> } | undefined =>
  productionTypes.find((series) => {
    if (EXCLUDED_FROM_DOMESTIC_GENERATION.has(series.name)) {
      return false;
    }
    return /battery/i.test(series.name);
  });

const RENEWABLE_GENERATION_SERIES_REGEX =
  /(wind|solar|biomass|geothermal|hydro run-of-river|hydro water reservoir)/i;

/** Matches Energy-Charts residual rows even if capitalization/suffix wording drifts slightly. */
const RESIDUAL_LOAD_SERIES_REGEX = /^residual\s*load\b/i;

const findResidualLoadSeries = (
  productionTypes: ProductionSeries[]
): ProductionSeries | undefined =>
  productionTypes.find((entry) => RESIDUAL_LOAD_SERIES_REGEX.test(entry.name.trim()));

const isResidualLoadProductionSeriesName = (name: string): boolean =>
  RESIDUAL_LOAD_SERIES_REGEX.test(name.trim());

const isRenewableGenerationSeries = (name: string): boolean =>
  !EXCLUDED_FROM_DOMESTIC_GENERATION.has(name) &&
  !/battery/i.test(name) &&
  RENEWABLE_GENERATION_SERIES_REGEX.test(name);

const isConventionalGenerationSeries = (name: string): boolean =>
  !EXCLUDED_FROM_DOMESTIC_GENERATION.has(name) &&
  !/battery/i.test(name) &&
  !RENEWABLE_GENERATION_SERIES_REGEX.test(name);

const sumSeriesAtIndex = (
  productionTypes: { name: string; data: Array<number | null> }[],
  predicate: (name: string) => boolean,
  index: number
): number | null => {
  let sum: number | null = null;
  for (const series of productionTypes) {
    if (!predicate(series.name)) {
      continue;
    }
    const value = series.data[index];
    if (value !== null && Number.isFinite(value)) {
      sum = (sum ?? 0) + value;
    }
  }
  return sum;
};

const deriveRenewableShareOfLoadSeries = (
  productionTypes: { name: string; data: Array<number | null> }[],
  loadSeries: { name: string; data: Array<number | null> }
): Array<number | null> => {
  const renewableGenerationSeries = productionTypes.filter((series) =>
    isRenewableGenerationSeries(series.name)
  );

  if (renewableGenerationSeries.length === 0) {
    return loadSeries.data.map(() => null);
  }

  return loadSeries.data.map((loadMw, index) => {
    if (loadMw === null || loadMw <= 0) {
      return null;
    }

    let renewableGenerationMw = 0;
    for (const series of renewableGenerationSeries) {
      const value = series.data[index];
      if (value !== null && Number.isFinite(value)) {
        renewableGenerationMw += value;
      }
    }

    return (renewableGenerationMw / loadMw) * 100;
  });
};

const mergeRenewableShareSeries = (
  preferredSeries: Array<number | null>,
  fallbackSeries: Array<number | null>
) =>
  preferredSeries.map((value, index) => {
    if (value !== null && Number.isFinite(value)) {
      return value;
    }
    const fallback = fallbackSeries[index];
    return fallback !== null && Number.isFinite(fallback) ? fallback : null;
  });

export type EveningWindowSnapshot = {
  /** Berlin local date the window samples belong to (YYYY-MM-DD). */
  dateBerlin: string;
  /** Number of 15-min samples included in the 17:00-21:00 average. */
  samplePoints: number;
  /** Average residual load (Demand - Renewable) across 17-21h, in MW. */
  avgResidualLoadMw: number;
  /** Average conventional generation across 17-21h, in MW (null when no conventional series). */
  avgConventionalGenerationMw: number | null;
  /** Average renewable generation across 17-21h, in MW (null when no renewable series). */
  avgRenewableGenerationMw: number | null;
};

export type DailyEnergySnapshot = {
  /** Berlin local date the integration covers (YYYY-MM-DD). */
  dateBerlin: string;
  /** Number of 15-min samples integrated for this Berlin day so far. */
  samplePoints: number;
  /** Coverage of the full 24h day (0..1). 96 quarter-hour samples = 1.0. */
  pointFractionOfDay: number;
  /** Total renewable generation integrated as MW * 0.25h / 1000, in GWh. */
  renewableGenerationGwh: number;
  /** Total domestic generation (renewable + conventional) integrated in GWh. */
  totalGenerationGwh: number;
  /** Total domestic demand integrated as MW * 0.25h / 1000, in GWh. */
  demandGwh: number;
  /** renewableGenerationGwh - demandGwh; positive = surplus, negative = deficit. */
  netBalanceGwh: number;
  /** totalGenerationGwh - demandGwh; positive = surplus, negative = deficit. */
  totalNetBalanceGwh: number;
};

/**
 * Observed structural surplus vs battery charging from Energy-Charts quarter-hour data.
 * Battery series: negative MW is treated as charging from the grid (consumption).
 */
export type FleetStructuralSurplusSnapshot = {
  dateBerlin: string;
  samplePoints: number;
  pointFractionOfDay: number;
  /** Σ max(0, non-battery domestic generation − load) × ¼ h (MWh). */
  totalStructuralSurplusMwh: number;
  /** Portion of that surplus met by observed battery charging (MWh), slot-wise min(surplus, charge). */
  observedBatteryAbsorptionInSurplusMwh: number;
  /** Remaining structural surplus not matched by observed charging in the same slot (MWh). */
  uncapturedStructuralSurplusMwh: number;
};

export type GermanyDispatchSlot = {
  /** ISO-8601 timestamp at the start of the quarter-hour (UTC). */
  timestampIso: string;
  /** Berlin local hour at the start of the slot (0..23). */
  hourBerlin: number;
  /** Real Energy-Charts residual load in MW for this slot. */
  residualLoadMw: number;
  /** Total load in MW for this slot. */
  loadMw: number;
  /** Total domestic generation in MW for this slot. */
  totalGenerationMw: number;
  /** Renewable generation in MW for this slot, null when unavailable. */
  renewableGenerationMw: number | null;
};

export type GermanyDispatchSlotsResponse = {
  /** Berlin local date the slots cover. */
  dateBerlin: string;
  /** Number of quarter-hour samples returned (max 96). */
  samplePoints: number;
  /** Coverage of the full 24h day (0..1). */
  pointFractionOfDay: number;
  /** Source label (always "energy-charts.total_power" for now). */
  source: "energy-charts.total_power";
  /** Quarter-hour slots in chronological order. */
  slots: GermanyDispatchSlot[];
  /** Present when the series was built for a named multi-day or day-partial window. */
  period?: GermanyEnergyFlowPeriod;
  rangeStartBerlin?: string;
  rangeEndBerlin?: string;
};

export type GermanyBessRecommendationResponse = {
  lookbackDays: number;
  rangeStartBerlin: string;
  rangeEndBerlin: string;
  observedDays: number;
  dailyEnergyP95Mwh: number;
  dailyPowerP95Mw: number;
  continuousWindowRequiredEnergyMwh: number;
  tiers: Array<{
    label: "aggressive" | "balanced" | "conservative";
    percentile: number;
    recommendedEnergyMwh: number;
    recommendedPowerMw: number;
  }>;
  impactAtBalancedTier: {
    absorbedSurplusShare: number;
    servedDeficitShare: number;
    totalSurplusEnergyMwh: number;
    totalDeficitEnergyMwh: number;
  } | null;
  indicativeEconomicsAtBalancedTier: {
    capexEur: number;
    annualRevenueEur: number;
    annualOperatingCostsEur: number;
    annualNetCashflowEur: number;
    paybackYears: number;
  } | null;
};

export type RecentRenewablePatternsSnapshot = {
  /** Lookback window in days (default 3). */
  windowDays: number;
  /** Days within the window where average midday solar share >= 25% of load. */
  solarRichDays: number | null;
  /** Heuristic readiness of the BESS fleet to discharge in the evening. */
  inferredBatteryReadiness: "high" | "moderate" | "low" | "unknown";
};

export type GermanyMarketSnapshot = {
  retrievedAtIso: string;
  energyUsage: {
    unit: "MW";
    latestValueMw: number;
    latestTimestampIso: string;
    trailing24hAverageMw: number;
  };
  bess: {
    capacityUnit: "GWh";
    installedCapacityGwh: number;
    capacityYear: string;
    powerUnit: "GW";
    installedPowerGw: number;
    powerYear: string;
  };
  realtimeSystem: {
    unit: "MW";
    timestampIso: string;
    loadMw: number;
    domesticGenerationMw: number;
    batteryStorageMw: number | null;
    residualLoadMw?: number;
    renewableShareOfLoadPct?: number;
  };
  eveningWindow: EveningWindowSnapshot | null;
  dailyEnergy: DailyEnergySnapshot | null;
  /** Null when no battery storage series is present in `total_power`. */
  fleetStructuralSurplus: FleetStructuralSurplusSnapshot | null;
  /**
   * Latest observed Berlin day of quarter-hour load / generation / residual (same derivation as dispatch API).
   * Null when no day has enough usable slots.
   */
  dayEnergyFlow: GermanyDispatchSlotsResponse | null;
  recentRenewablePatterns: RecentRenewablePatternsSnapshot;
};

export type GermanyAssessmentContext = {
  snapshot: GermanyMarketSnapshot;
  historical: {
    trailing24hAverageMw: number;
    trailing7dAverageMw: number;
    trailing30dAverageMw: number;
    trailing7dPeakMw: number;
    trailing30dPeakMw: number;
  };
  marketSignals: {
    loadDelta7dVs30dMw: number;
    peakDelta7dVs30dMw: number;
    residualVolatility7dPct: number | null;
    residualVolatility30dPct: number | null;
    residualRampP95MwPer15m: number | null;
    eveningStressPeriods7d: number | null;
    oversupplyPeriods7d: number | null;
  };
  forecast: {
    available: boolean;
    note: string;
    source: "energy-charts.ren_share_forecast";
    horizonHours: number | null;
    renewableSharePctP50Next24h: number | null;
    renewableSharePctMinNext24h: number | null;
    renewableSharePctMaxNext24h: number | null;
    renewableSharePctP50Next48h: number | null;
    renewableSharePctMinNext48h: number | null;
    renewableSharePctMaxNext48h: number | null;
    renewableSharePctP50Day2: number | null;
  };
  renewablePatterns: {
    recentWindowDays: number;
    recentSolarShareOfLoadPctAvg: number | null;
    recentWindShareOfLoadPctAvg: number | null;
    recentMiddaySolarMwAvg: number | null;
    recentEveningResidualMwAvg: number | null;
    recentOversupplyPeriods: number | null;
    recentSolarRichDays: number | null;
    inferredBatteryReadiness: "high" | "moderate" | "low" | "unknown";
    note: string;
  };
  dataQuality: {
    missingSignals: string[];
    note: string;
  };
};

const averageLast = (values: number[], length: number) => {
  if (values.length === 0) {
    return 0;
  }
  const slice = values.slice(-Math.min(length, values.length));
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
};

const peakLast = (values: number[], length: number) => {
  if (values.length === 0) {
    return 0;
  }
  const slice = values.slice(-Math.min(length, values.length));
  return Math.max(...slice);
};

const stdDev = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  return Math.sqrt(variance);
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
};

const berlinHourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  hour12: false,
});

const getBerlinHour = (timestampSeconds: number): number =>
  Number.parseInt(berlinHourFormatter.format(new Date(timestampSeconds * 1000)), 10);

const summarizeRenewableShareForecast = (
  payload: z.infer<typeof renewableShareForecastResponseSchema>,
  snapshotTimestampIso: string
): GermanyAssessmentContext["forecast"] => {
  const nowSeconds = Math.floor(new Date(snapshotTimestampIso).getTime() / 1000);
  const horizon24Seconds = 24 * 60 * 60;
  const horizon48Seconds = 48 * 60 * 60;

  const next24hValues = payload.unix_seconds
    .map((timestamp, index) => ({ timestamp, value: payload.ren_share[index] }))
    .filter(
      (point): point is { timestamp: number; value: number } =>
        point.timestamp > nowSeconds &&
        point.timestamp <= nowSeconds + horizon24Seconds &&
        point.value !== null &&
        Number.isFinite(point.value)
    )
    .map((point) => point.value);
  const next48hValues = payload.unix_seconds
    .map((timestamp, index) => ({ timestamp, value: payload.ren_share[index] }))
    .filter(
      (point): point is { timestamp: number; value: number } =>
        point.timestamp > nowSeconds &&
        point.timestamp <= nowSeconds + horizon48Seconds &&
        point.value !== null &&
        Number.isFinite(point.value)
    )
    .map((point) => point.value);
  const day2Values = payload.unix_seconds
    .map((timestamp, index) => ({ timestamp, value: payload.ren_share[index] }))
    .filter(
      (point): point is { timestamp: number; value: number } =>
        point.timestamp > nowSeconds + horizon24Seconds &&
        point.timestamp <= nowSeconds + horizon48Seconds &&
        point.value !== null &&
        Number.isFinite(point.value)
    )
    .map((point) => point.value);

  if (next24hValues.length === 0) {
    return {
      available: false,
      note: "Renewable-share forecast endpoint returned no usable values for the next 24h.",
      source: "energy-charts.ren_share_forecast",
      horizonHours: null,
      renewableSharePctP50Next24h: null,
      renewableSharePctMinNext24h: null,
      renewableSharePctMaxNext24h: null,
      renewableSharePctP50Next48h: null,
      renewableSharePctMinNext48h: null,
      renewableSharePctMaxNext48h: null,
      renewableSharePctP50Day2: null,
    };
  }

  return {
    available: true,
    note: "Renewable-share forecast integrated from Energy-Charts for the next 24-48h windows.",
    source: "energy-charts.ren_share_forecast",
    horizonHours: next48hValues.length > 0 ? 48 : 24,
    renewableSharePctP50Next24h: percentile(next24hValues, 0.5),
    renewableSharePctMinNext24h: Math.min(...next24hValues),
    renewableSharePctMaxNext24h: Math.max(...next24hValues),
    renewableSharePctP50Next48h: next48hValues.length > 0 ? percentile(next48hValues, 0.5) : null,
    renewableSharePctMinNext48h: next48hValues.length > 0 ? Math.min(...next48hValues) : null,
    renewableSharePctMaxNext48h: next48hValues.length > 0 ? Math.max(...next48hValues) : null,
    renewableSharePctP50Day2: day2Values.length > 0 ? percentile(day2Values, 0.5) : null,
  };
};

const summarizeRecentRenewablePatterns = (params: {
  unixSeconds: number[];
  loadValues: Array<number | null>;
  residualValues: Array<number | null> | null;
  solarValues: Array<number | null>;
  windValues: Array<number | null>;
  forecast: GermanyAssessmentContext["forecast"];
}): GermanyAssessmentContext["renewablePatterns"] => {
  const { unixSeconds, loadValues, residualValues, solarValues, windValues, forecast } = params;
  const recentWindowDays = 3;
  const latestTimestamp = unixSeconds[unixSeconds.length - 1];
  const minTimestamp = latestTimestamp - recentWindowDays * 24 * 60 * 60;
  const dailyMiddaySolarShare = new Map<string, number[]>();
  const recentSolarShareValues: number[] = [];
  const recentWindShareValues: number[] = [];
  const recentMiddaySolarMwValues: number[] = [];
  const recentEveningResidualMwValues: number[] = [];
  let recentOversupplyPeriods = 0;

  for (let index = 0; index < unixSeconds.length; index += 1) {
    const timestamp = unixSeconds[index];
    if (timestamp < minTimestamp) {
      continue;
    }
    const load = loadValues[index];
    if (load === null || load <= 0) {
      continue;
    }
    const solar = solarValues[index];
    const wind = windValues[index];
    const residual = residualValues?.[index] ?? null;
    const hourBerlin = getBerlinHour(timestamp);
    const dayKey = getBerlinDateKey(timestamp);

    if (solar !== null && Number.isFinite(solar)) {
      const solarShare = (solar / load) * 100;
      recentSolarShareValues.push(solarShare);
      if (hourBerlin >= 10 && hourBerlin <= 15) {
        recentMiddaySolarMwValues.push(solar);
        const existing = dailyMiddaySolarShare.get(dayKey) ?? [];
        existing.push(solarShare);
        dailyMiddaySolarShare.set(dayKey, existing);
      }
    }

    if (wind !== null && Number.isFinite(wind)) {
      recentWindShareValues.push((wind / load) * 100);
    }

    if (residual !== null && Number.isFinite(residual)) {
      if (hourBerlin >= 17 && hourBerlin <= 22) {
        recentEveningResidualMwValues.push(residual);
      }
      if (residual < 0) {
        recentOversupplyPeriods += 1;
      }
    }
  }

  const recentSolarRichDays = [...dailyMiddaySolarShare.values()].reduce((count, values) => {
    const middayAvg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return middayAvg >= 25 ? count + 1 : count;
  }, 0);
  const renewableTailwind =
    forecast.renewableSharePctP50Day2 ?? forecast.renewableSharePctP50Next24h ?? null;

  const inferredBatteryReadiness: GermanyAssessmentContext["renewablePatterns"]["inferredBatteryReadiness"] =
    recentSolarShareValues.length === 0
      ? "unknown"
      : recentSolarRichDays >= 2 && renewableTailwind !== null && renewableTailwind >= 48
        ? "high"
        : recentSolarRichDays >= 1 || (renewableTailwind !== null && renewableTailwind >= 42)
          ? "moderate"
          : "low";

  return {
    recentWindowDays,
    recentSolarShareOfLoadPctAvg:
      recentSolarShareValues.length > 0 ? averageLast(recentSolarShareValues, recentSolarShareValues.length) : null,
    recentWindShareOfLoadPctAvg:
      recentWindShareValues.length > 0 ? averageLast(recentWindShareValues, recentWindShareValues.length) : null,
    recentMiddaySolarMwAvg:
      recentMiddaySolarMwValues.length > 0 ? averageLast(recentMiddaySolarMwValues, recentMiddaySolarMwValues.length) : null,
    recentEveningResidualMwAvg:
      recentEveningResidualMwValues.length > 0
        ? averageLast(recentEveningResidualMwValues, recentEveningResidualMwValues.length)
        : null,
    recentOversupplyPeriods: residualValues === null ? null : recentOversupplyPeriods,
    recentSolarRichDays: recentSolarShareValues.length > 0 ? recentSolarRichDays : null,
    inferredBatteryReadiness,
    note:
      "Recent 3-day renewable behavior combines with the 24-48h renewable-share forecast to infer likely fleet charge readiness.",
  };
};

const EVENING_WINDOW_HOURS_BERLIN = [17, 18, 19, 20] as const;
const POINTS_PER_DAY_15MIN = 96;
const QUARTER_HOUR_TO_GWH = 0.25 / 1000;
const SOLAR_RICH_MIDDAY_SHARE_THRESHOLD_PCT = 25;
const RECENT_RENEWABLE_PATTERN_WINDOW_DAYS = 3;

type ProductionSeries = { name: string; data: Array<number | null> };

const groupIndicesByBerlinDate = (unixSeconds: number[]): Map<string, number[]> => {
  const map = new Map<string, number[]>();
  for (let index = 0; index < unixSeconds.length; index += 1) {
    const dayKey = getBerlinDateKey(unixSeconds[index]);
    const existing = map.get(dayKey);
    if (existing) {
      existing.push(index);
    } else {
      map.set(dayKey, [index]);
    }
  }
  return map;
};

const computeEveningWindowSnapshot = (params: {
  unixSeconds: number[];
  loadSeries: ProductionSeries;
  productionTypes: ProductionSeries[];
  residualSeries: ProductionSeries | undefined;
}): EveningWindowSnapshot | null => {
  const { unixSeconds, loadSeries, productionTypes, residualSeries } = params;
  if (unixSeconds.length === 0) {
    return null;
  }
  const indicesByDate = groupIndicesByBerlinDate(unixSeconds);
  const dateKeys = [...indicesByDate.keys()].sort();
  for (let i = dateKeys.length - 1; i >= 0; i -= 1) {
    const dateKey = dateKeys[i];
    const candidateIndices = (indicesByDate.get(dateKey) ?? []).filter((index) => {
      const hour = getBerlinHour(unixSeconds[index]);
      return EVENING_WINDOW_HOURS_BERLIN.includes(hour as 17 | 18 | 19 | 20);
    });
    if (candidateIndices.length < 4) {
      continue;
    }
    const residualValues: number[] = [];
    const conventionalValues: number[] = [];
    const renewableValues: number[] = [];
    for (const index of candidateIndices) {
      const renewableMw = sumSeriesAtIndex(productionTypes, isRenewableGenerationSeries, index);
      const conventionalMw = sumSeriesAtIndex(productionTypes, isConventionalGenerationSeries, index);
      const loadMw = loadSeries.data[index];
      let residualMw: number | null = null;
      if (residualSeries) {
        const direct = residualSeries.data[index];
        if (direct !== null && Number.isFinite(direct)) {
          residualMw = direct;
        }
      }
      if (residualMw === null && loadMw !== null && Number.isFinite(loadMw) && renewableMw !== null) {
        residualMw = loadMw - renewableMw;
      }
      if (residualMw !== null && Number.isFinite(residualMw)) {
        residualValues.push(residualMw);
      }
      if (conventionalMw !== null) {
        conventionalValues.push(conventionalMw);
      }
      if (renewableMw !== null) {
        renewableValues.push(renewableMw);
      }
    }
    if (residualValues.length < 4) {
      continue;
    }
    const avg = (values: number[]) =>
      values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
    return {
      dateBerlin: dateKey,
      samplePoints: residualValues.length,
      avgResidualLoadMw: avg(residualValues) ?? 0,
      avgConventionalGenerationMw: avg(conventionalValues),
      avgRenewableGenerationMw: avg(renewableValues),
    };
  }
  return null;
};

const computeDailyEnergySnapshot = (params: {
  unixSeconds: number[];
  loadSeries: ProductionSeries;
  productionTypes: ProductionSeries[];
}): DailyEnergySnapshot | null => {
  const { unixSeconds, loadSeries, productionTypes } = params;
  if (unixSeconds.length === 0) {
    return null;
  }
  const indicesByDate = groupIndicesByBerlinDate(unixSeconds);
  const dateKeys = [...indicesByDate.keys()].sort();
  for (let i = dateKeys.length - 1; i >= 0; i -= 1) {
    const dateKey = dateKeys[i];
    const indices = indicesByDate.get(dateKey) ?? [];
    let renewableGwh = 0;
    let totalGenerationGwh = 0;
    let demandGwh = 0;
    let countedPoints = 0;
    for (const index of indices) {
      const loadMw = loadSeries.data[index];
      const renewableMw = sumSeriesAtIndex(productionTypes, isRenewableGenerationSeries, index);
      const conventionalMw = sumSeriesAtIndex(productionTypes, isConventionalGenerationSeries, index);
      if (loadMw === null || !Number.isFinite(loadMw)) {
        continue;
      }
      countedPoints += 1;
      demandGwh += loadMw * QUARTER_HOUR_TO_GWH;
      if (renewableMw !== null) {
        renewableGwh += renewableMw * QUARTER_HOUR_TO_GWH;
      }
      const totalGenerationMw = (renewableMw ?? 0) + (conventionalMw ?? 0);
      totalGenerationGwh += totalGenerationMw * QUARTER_HOUR_TO_GWH;
    }
    if (countedPoints === 0) {
      continue;
    }
    return {
      dateBerlin: dateKey,
      samplePoints: countedPoints,
      pointFractionOfDay: Math.min(1, countedPoints / POINTS_PER_DAY_15MIN),
      renewableGenerationGwh: renewableGwh,
      totalGenerationGwh,
      demandGwh,
      netBalanceGwh: renewableGwh - demandGwh,
      totalNetBalanceGwh: totalGenerationGwh - demandGwh,
    };
  }
  return null;
};

const computeFleetStructuralSurplusSnapshot = (params: {
  unixSeconds: number[];
  loadSeries: ProductionSeries;
  productionTypes: ProductionSeries[];
}): FleetStructuralSurplusSnapshot | null => {
  const { unixSeconds, loadSeries, productionTypes } = params;
  if (unixSeconds.length === 0) {
    return null;
  }
  const batterySeries = findBatteryStorageSeries(productionTypes);
  if (batterySeries === undefined) {
    return null;
  }
  const quarterHourMwhPerMw = QUARTER_HOUR_TO_GWH * 1000;
  const indicesByDate = groupIndicesByBerlinDate(unixSeconds);
  const dateKeys = [...indicesByDate.keys()].sort();
  for (let i = dateKeys.length - 1; i >= 0; i -= 1) {
    const dateKey = dateKeys[i];
    const indices = indicesByDate.get(dateKey) ?? [];
    let countedPoints = 0;
    let totalStructuralSurplusMwh = 0;
    let observedBatteryAbsorptionInSurplusMwh = 0;
    let uncapturedStructuralSurplusMwh = 0;
    for (const index of indices) {
      const loadMw = loadSeries.data[index];
      if (loadMw === null || !Number.isFinite(loadMw)) {
        continue;
      }
      countedPoints += 1;
      const genLessBatteryMw = sumDomesticGenerationExcludingBatteryMw(productionTypes, index);
      const surplusMw = Math.max(0, genLessBatteryMw - loadMw);
      const surplusMwh = surplusMw * quarterHourMwhPerMw;
      totalStructuralSurplusMwh += surplusMwh;
      const batteryMw = batterySeries.data[index];
      const chargeMw =
        batteryMw !== null && Number.isFinite(batteryMw) && batteryMw < 0 ? -batteryMw : 0;
      const chargerMwh = chargeMw * quarterHourMwhPerMw;
      if (surplusMwh > 1e-12) {
        const absorbed = Math.min(surplusMwh, chargerMwh);
        observedBatteryAbsorptionInSurplusMwh += absorbed;
        uncapturedStructuralSurplusMwh += surplusMwh - absorbed;
      }
    }
    if (countedPoints === 0) {
      continue;
    }
    return {
      dateBerlin: dateKey,
      samplePoints: countedPoints,
      pointFractionOfDay: Math.min(1, countedPoints / POINTS_PER_DAY_15MIN),
      totalStructuralSurplusMwh,
      observedBatteryAbsorptionInSurplusMwh,
      uncapturedStructuralSurplusMwh,
    };
  }
  return null;
};

const computeRecentSolarStreak = (params: {
  unixSeconds: number[];
  loadSeries: ProductionSeries;
  productionTypes: ProductionSeries[];
  windowDays?: number;
}): { solarRichDays: number | null; observedDays: number } => {
  const windowDays = params.windowDays ?? RECENT_RENEWABLE_PATTERN_WINDOW_DAYS;
  if (params.unixSeconds.length === 0) {
    return { solarRichDays: null, observedDays: 0 };
  }
  const latestTs = params.unixSeconds[params.unixSeconds.length - 1];
  const minTs = latestTs - windowDays * 24 * 60 * 60;
  const dailyMiddaySolarShare = new Map<string, number[]>();
  for (let index = 0; index < params.unixSeconds.length; index += 1) {
    const ts = params.unixSeconds[index];
    if (ts < minTs) {
      continue;
    }
    const hour = getBerlinHour(ts);
    if (hour < 10 || hour > 15) {
      continue;
    }
    const load = params.loadSeries.data[index];
    if (load === null || !Number.isFinite(load) || load <= 0) {
      continue;
    }
    const solar = sumSeriesAtIndex(
      params.productionTypes,
      (name) => /solar/i.test(name) && !EXCLUDED_FROM_DOMESTIC_GENERATION.has(name),
      index
    );
    if (solar === null) {
      continue;
    }
    const dayKey = getBerlinDateKey(ts);
    const existing = dailyMiddaySolarShare.get(dayKey) ?? [];
    existing.push((solar / load) * 100);
    dailyMiddaySolarShare.set(dayKey, existing);
  }
  if (dailyMiddaySolarShare.size === 0) {
    return { solarRichDays: null, observedDays: 0 };
  }
  let solarRichDays = 0;
  for (const values of dailyMiddaySolarShare.values()) {
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    if (avg >= SOLAR_RICH_MIDDAY_SHARE_THRESHOLD_PCT) {
      solarRichDays += 1;
    }
  }
  return { solarRichDays, observedDays: dailyMiddaySolarShare.size };
};

const inferBatteryReadiness = (
  solarRichDays: number | null,
  renewableShareForecastP50: number | null
): RecentRenewablePatternsSnapshot["inferredBatteryReadiness"] => {
  if (solarRichDays === null) {
    return "unknown";
  }
  if (solarRichDays >= 2 && renewableShareForecastP50 !== null && renewableShareForecastP50 >= 48) {
    return "high";
  }
  if (solarRichDays >= 1 || (renewableShareForecastP50 !== null && renewableShareForecastP50 >= 42)) {
    return "moderate";
  }
  return "low";
};

const computeRecentRenewablePatternsSnapshot = (params: {
  unixSeconds: number[];
  loadSeries: ProductionSeries;
  productionTypes: ProductionSeries[];
  renewableShareForecastP50?: number | null;
}): RecentRenewablePatternsSnapshot => {
  const { solarRichDays } = computeRecentSolarStreak({
    unixSeconds: params.unixSeconds,
    loadSeries: params.loadSeries,
    productionTypes: params.productionTypes,
    windowDays: RECENT_RENEWABLE_PATTERN_WINDOW_DAYS,
  });
  return {
    windowDays: RECENT_RENEWABLE_PATTERN_WINDOW_DAYS,
    solarRichDays,
    inferredBatteryReadiness: inferBatteryReadiness(
      solarRichDays,
      params.renewableShareForecastP50 ?? null
    ),
  };
};

const MIN_DISPATCH_SLOTS = 4;
/** Backfill stale / null ECMWF residual points using recent published values (¼ h grain). */
const RESIDUAL_LOAD_BACKFILL_STEPS = 96;

type TotalPowerSlotBuildContext = {
  loadSeries: ProductionSeries;
  residualSeries: ProductionSeries | undefined;
  mergedRenewableShareSeries: Array<number | null>;
};

const buildTotalPowerSlotContext = (totalPower: TotalPowerResponse): TotalPowerSlotBuildContext => {
  const loadSeries = findSeriesOrThrow(
    totalPower.production_types,
    "Load (incl. self-consumption)"
  );
  const residualSeries = findResidualLoadSeries(totalPower.production_types);
  const renewableShareSeriesDirect = totalPower.production_types.find(
    (entry) => entry.name === "Renewable share of load"
  );
  const derivedRenewableShareSeries = deriveRenewableShareOfLoadSeries(
    totalPower.production_types,
    loadSeries
  );
  const mergedRenewableShareSeries =
    renewableShareSeriesDirect === undefined
      ? derivedRenewableShareSeries
      : mergeRenewableShareSeries(renewableShareSeriesDirect.data, derivedRenewableShareSeries);
  return { loadSeries, residualSeries, mergedRenewableShareSeries };
};

const buildGermanyDispatchSlotsForIndices = (
  totalPower: TotalPowerResponse,
  indices: readonly number[],
  ctx: TotalPowerSlotBuildContext
): GermanyDispatchSlot[] => {
  const { loadSeries, residualSeries, mergedRenewableShareSeries } = ctx;
  const slots: GermanyDispatchSlot[] = [];
  for (const index of indices) {
    const ts = totalPower.unix_seconds[index];
    const loadMw = loadSeries.data[index];
    if (loadMw === null || !Number.isFinite(loadMw)) {
      continue;
    }

    const renewableMw = sumSeriesAtIndex(
      totalPower.production_types,
      isRenewableGenerationSeries,
      index
    );
    const sharePct = valueAtIndexWithFallback(mergedRenewableShareSeries, index, 96);
    const renewableMwFromShare =
      sharePct !== null && Number.isFinite(sharePct) && loadMw > 0 ? (sharePct / 100) * loadMw : null;

    let residualMw: number | null = null;
    if (residualSeries) {
      const direct = residualSeries.data[index];
      if (direct !== null && Number.isFinite(direct)) {
        residualMw = direct;
      }
    }
    if (residualMw === null && renewableMw !== null && Number.isFinite(renewableMw)) {
      residualMw = loadMw - renewableMw;
    }
    if (
      residualMw === null &&
      renewableMwFromShare !== null &&
      Number.isFinite(renewableMwFromShare)
    ) {
      residualMw = loadMw - renewableMwFromShare;
    }
    if (residualMw === null && residualSeries) {
      const backfilled = valueAtIndexWithFallback(
        residualSeries.data,
        index,
        RESIDUAL_LOAD_BACKFILL_STEPS
      );
      if (backfilled !== null && Number.isFinite(backfilled)) {
        residualMw = backfilled;
      }
    }

    const renewableGenerationMwForSlot =
      renewableMw ?? (renewableMwFromShare !== null ? renewableMwFromShare : null);

    if (residualMw === null || !Number.isFinite(residualMw)) {
      continue;
    }

    slots.push({
      timestampIso: new Date(ts * 1000).toISOString(),
      hourBerlin: getBerlinHour(ts),
      residualLoadMw: residualMw,
      loadMw,
      totalGenerationMw: sumDomesticGenerationMw(totalPower.production_types, index),
      renewableGenerationMw: renewableGenerationMwForSlot,
    });
  }
  return slots;
};

const extractGermanyDispatchSlotsFromTotalPower = (
  totalPower: TotalPowerResponse
): GermanyDispatchSlotsResponse | null => {
  const ctx = buildTotalPowerSlotContext(totalPower);
  const indicesByDate = groupIndicesByBerlinDate(totalPower.unix_seconds);
  const dateKeys = [...indicesByDate.keys()].sort();

  for (let i = dateKeys.length - 1; i >= 0; i -= 1) {
    const dateKey = dateKeys[i];
    const indices = indicesByDate.get(dateKey) ?? [];
    const slots = buildGermanyDispatchSlotsForIndices(totalPower, indices, ctx);

    if (slots.length >= MIN_DISPATCH_SLOTS) {
      return {
        dateBerlin: dateKey,
        samplePoints: slots.length,
        pointFractionOfDay: Math.min(1, slots.length / POINTS_PER_DAY_15MIN),
        source: "energy-charts.total_power",
        slots,
      };
    }
  }

  return null;
};

const extractGermanyDispatchSlotsForBerlinCalendarRange = (
  totalPower: TotalPowerResponse,
  params: {
    startKey: string;
    endKey: string;
    capSlotsAtNow: boolean;
    nowMs: number;
    expectedQuarterHours: number;
    period: GermanyEnergyFlowPeriod;
  }
): GermanyDispatchSlotsResponse | null => {
  const ctx = buildTotalPowerSlotContext(totalPower);
  const nowSec = Math.floor(params.nowMs / 1000);
  const indices: number[] = [];
  for (let index = 0; index < totalPower.unix_seconds.length; index += 1) {
    const ts = totalPower.unix_seconds[index];
    const key = getBerlinDateKey(ts);
    if (key < params.startKey || key > params.endKey) {
      continue;
    }
    if (params.capSlotsAtNow && key === params.endKey && ts > nowSec) {
      continue;
    }
    indices.push(index);
  }
  if (indices.length === 0) {
    return null;
  }
  const slots = buildGermanyDispatchSlotsForIndices(totalPower, indices, ctx);
  if (slots.length < MIN_DISPATCH_SLOTS) {
    return null;
  }
  const denom = Math.max(1, params.expectedQuarterHours);
  const dateLabel =
    params.startKey === params.endKey ? params.startKey : `${params.startKey}–${params.endKey}`;
  return {
    dateBerlin: dateLabel,
    samplePoints: slots.length,
    pointFractionOfDay: Math.min(1, slots.length / denom),
    source: "energy-charts.total_power",
    slots,
    period: params.period,
    rangeStartBerlin: params.startKey,
    rangeEndBerlin: params.endKey,
  };
};

const buildGermanyMarketSnapshot = ({
  totalPower,
  installedPower,
}: {
  totalPower: TotalPowerResponse;
  installedPower: InstalledPowerResponse;
}): GermanyMarketSnapshot => {
  const loadSeries = findSeriesOrThrow(
    totalPower.production_types,
    "Load (incl. self-consumption)"
  );
  const loadPoint = getLatestNonNullPoint(totalPower.unix_seconds, loadSeries.data);
  const loadIndex = loadPoint.index;
  const trailingLoadValues = loadSeries.data.filter((value): value is number => value !== null).slice(-96);
  const trailing24hAverageMw =
    trailingLoadValues.reduce((sum, value) => sum + value, 0) / trailingLoadValues.length;

  const batteryCapacitySeries = findSeriesOrThrow(
    installedPower.production_types,
    "Battery storage (capacity)"
  );
  const batteryPowerSeries = findSeriesOrThrow(
    installedPower.production_types,
    "Battery storage (power)"
  );

  const capacityPoint = getLatestNonNullPoint(installedPower.time, batteryCapacitySeries.data);
  const powerPoint = getLatestNonNullPoint(installedPower.time, batteryPowerSeries.data);

  const domesticGenerationMw = sumDomesticGenerationMw(totalPower.production_types, loadIndex);
  const batteryGridSeries = findBatteryStorageSeries(totalPower.production_types);
  const batteryStorageMw =
    batteryGridSeries === undefined
      ? null
      : valueAtIndexWithFallback(batteryGridSeries.data, loadIndex);

  const residualSeries = findResidualLoadSeries(totalPower.production_types);
  const residualValue =
    residualSeries === undefined
      ? loadPoint.value - domesticGenerationMw
      : pickLatestAvailableValue(residualSeries.data, loadIndex) ?? (loadPoint.value - domesticGenerationMw);

  const renewableShareSeries = totalPower.production_types.find(
    (entry) => entry.name === "Renewable share of load"
  );
  const derivedRenewableShareSeries = deriveRenewableShareOfLoadSeries(
    totalPower.production_types,
    loadSeries
  );
  const mergedRenewableShareSeries =
    renewableShareSeries === undefined
      ? derivedRenewableShareSeries
      : mergeRenewableShareSeries(renewableShareSeries.data, derivedRenewableShareSeries);
  const renewableShareFromResidual =
    residualValue !== null && loadPoint.value > 0
      ? ((loadPoint.value - residualValue) / loadPoint.value) * 100
      : null;
  const renewableShareFromSeries =
    mergedRenewableShareSeries.length === 0
      ? null
      : pickLatestAvailableValue(mergedRenewableShareSeries, loadIndex);
  const renewableShareValue = renewableShareFromResidual ?? renewableShareFromSeries;

  const realtimeSystem: GermanyMarketSnapshot["realtimeSystem"] = {
    unit: "MW",
    timestampIso: new Date(loadPoint.label * 1000).toISOString(),
    loadMw: loadPoint.value,
    domesticGenerationMw,
    batteryStorageMw,
    ...(residualValue !== null ? { residualLoadMw: residualValue } : {}),
    ...(renewableShareValue !== null ? { renewableShareOfLoadPct: renewableShareValue } : {}),
  };

  const eveningWindow = computeEveningWindowSnapshot({
    unixSeconds: totalPower.unix_seconds,
    loadSeries,
    productionTypes: totalPower.production_types,
    residualSeries,
  });
  const dailyEnergy = computeDailyEnergySnapshot({
    unixSeconds: totalPower.unix_seconds,
    loadSeries,
    productionTypes: totalPower.production_types,
  });
  const fleetStructuralSurplus = computeFleetStructuralSurplusSnapshot({
    unixSeconds: totalPower.unix_seconds,
    loadSeries,
    productionTypes: totalPower.production_types,
  });
  const recentRenewablePatterns = computeRecentRenewablePatternsSnapshot({
    unixSeconds: totalPower.unix_seconds,
    loadSeries,
    productionTypes: totalPower.production_types,
  });
  const dayEnergyFlow = extractGermanyDispatchSlotsFromTotalPower(totalPower);

  return {
    retrievedAtIso: new Date().toISOString(),
    energyUsage: {
      unit: "MW",
      latestValueMw: loadPoint.value,
      latestTimestampIso: new Date(loadPoint.label * 1000).toISOString(),
      trailing24hAverageMw: Number.isFinite(trailing24hAverageMw) ? trailing24hAverageMw : loadPoint.value,
    },
    bess: {
      capacityUnit: "GWh",
      installedCapacityGwh: capacityPoint.value,
      capacityYear: capacityPoint.label,
      powerUnit: "GW",
      installedPowerGw: powerPoint.value,
      powerYear: powerPoint.label,
    },
    realtimeSystem,
    eveningWindow,
    dailyEnergy,
    fleetStructuralSurplus,
    dayEnergyFlow,
    recentRenewablePatterns,
  };
};

export const getGermanyMarketSnapshot = async (): Promise<GermanyMarketSnapshot> => {
  const [totalPower, installedPower] = await Promise.all([
    fetchJson(getGermanyTotalPowerPath(), totalPowerResponseSchema, {
      allowStaleOnFailure: true,
      noStore: true,
    }),
    fetchJson("/installed_power?country=de", installedPowerResponseSchema, {
      allowStaleOnFailure: true,
    }),
  ]);

  return buildGermanyMarketSnapshot({ totalPower, installedPower });
};

/** Factual quarter-hour series from Energy-Charts for a named Berlin window (no interpolation). */
export const getGermanyEnergyFlowForPeriod = async (
  period: GermanyEnergyFlowPeriod
): Promise<GermanyDispatchSlotsResponse | null> => {
  const now = new Date();
  const range = resolveGermanyEnergyFlowBerlinRange(period, now);
  return getGermanyEnergyFlowForBerlinRange(range, now);
};

export const getGermanyEnergyFlowForBerlinRange = async (
  range: GermanyEnergyFlowBerlinRange,
  now: Date = new Date()
): Promise<GermanyDispatchSlotsResponse | null> => {
  const fetchStart = totalPowerFetchStartDateForRange(range);
  const fetchEnd = formatCalendarDateBerlin(now);
  const path = getGermanyTotalPowerPathForCalendarRange(fetchStart, fetchEnd);
  const totalPower = await fetchJson(path, totalPowerResponseSchema, {
    allowStaleOnFailure: true,
  });
  const expected = expectedQuarterHoursInFlowRange(range, now);
  return extractGermanyDispatchSlotsForBerlinCalendarRange(totalPower, {
    startKey: range.startKey,
    endKey: range.endKey,
    capSlotsAtNow: range.capSlotsAtNow,
    nowMs: now.getTime(),
    expectedQuarterHours: expected,
    period: range.period,
  });
};

const TRAILING_BESS_RECOMMENDATION_LOOKBACK_DAYS = 365;

export const getGermanyBessRecommendationTrailingWindow = async (
  lookbackDays: number = TRAILING_BESS_RECOMMENDATION_LOOKBACK_DAYS,
  now: Date = new Date()
): Promise<GermanyBessRecommendationResponse> => {
  const endKey = formatCalendarDateBerlin(now);
  const startDate = new Date(now.getTime() - lookbackDays * 86_400_000);
  const startKey = formatCalendarDateBerlin(startDate);
  const totalPower = await fetchJson(
    getGermanyTotalPowerPathForCalendarRange(startKey, endKey),
    totalPowerResponseSchema,
    { allowStaleOnFailure: true }
  );

  const loadSeries = findSeriesOrThrow(
    totalPower.production_types,
    "Load (incl. self-consumption)"
  );
  const slots = totalPower.unix_seconds
    .map((ts, index) => {
      const dayKey = getBerlinDateKey(ts);
      if (dayKey < startKey || dayKey > endKey) {
        return null;
      }
      const loadMw = loadSeries.data[index];
      if (loadMw === null || !Number.isFinite(loadMw)) {
        return null;
      }
      return {
        timestampIso: new Date(ts * 1000).toISOString(),
        loadMw,
        totalGenerationMw: sumDomesticGenerationMw(totalPower.production_types, index),
      };
    })
    .filter((entry): entry is { timestampIso: string; loadMw: number; totalGenerationMw: number } => entry !== null);

  const recommendation = computeLogicalBessRecommendation(slots);
  const balancedTier = recommendation.tiers.find((entry) => entry.label === "balanced") ?? null;
  const impactAtBalancedTier =
    balancedTier === null
      ? null
      : computeCoverageAtCapacityMwh(slots, balancedTier.recommendedEnergyMwh, {
          resetDailyByBerlin: true,
          maxPowerMw: balancedTier.recommendedPowerMw,
        });
  const indicativeEconomicsAtBalancedTier =
    balancedTier === null
      ? null
      : computeEconomics(
          {
            totalPowerMw: balancedTier.recommendedPowerMw,
            totalEnergyMwh: balancedTier.recommendedEnergyMwh,
            roundTripEfficiency: 90,
          },
          defaultEconomicsAssumptions
        );
  return {
    lookbackDays,
    rangeStartBerlin: startKey,
    rangeEndBerlin: endKey,
    observedDays: recommendation.observedDays,
    dailyEnergyP95Mwh: recommendation.dailyEnergyP95Mwh,
    dailyPowerP95Mw: recommendation.dailyPowerP95Mw,
    continuousWindowRequiredEnergyMwh: recommendation.continuousWindowRequiredEnergyMwh,
    tiers: recommendation.tiers,
    impactAtBalancedTier:
      impactAtBalancedTier === null
        ? null
        : {
            absorbedSurplusShare: impactAtBalancedTier.absorbedSurplusShare,
            servedDeficitShare: impactAtBalancedTier.servedDeficitShare,
            totalSurplusEnergyMwh: impactAtBalancedTier.totalSurplusEnergyMwh,
            totalDeficitEnergyMwh: impactAtBalancedTier.totalDeficitEnergyMwh,
          },
    indicativeEconomicsAtBalancedTier:
      indicativeEconomicsAtBalancedTier === null
        ? null
        : {
            capexEur: indicativeEconomicsAtBalancedTier.capex,
            annualRevenueEur: indicativeEconomicsAtBalancedTier.annualRevenue,
            annualOperatingCostsEur: indicativeEconomicsAtBalancedTier.annualOperatingCosts,
            annualNetCashflowEur: indicativeEconomicsAtBalancedTier.annualNetCashflow,
            paybackYears: indicativeEconomicsAtBalancedTier.paybackYears,
          },
  };
};

/**
 * Fetch today's (Berlin) quarter-hour residual load slots from Energy-Charts.
 *
 * Returns a compact dispatch-shaped DTO (residual + load + renewables) instead
 * of the full `total_power` payload. Falls back to the most recent fully-
 * observed Berlin day if the current day has no usable samples yet (e.g. very
 * early morning).
 */
export const getGermanyTodaysDispatchSlots =
  async (): Promise<GermanyDispatchSlotsResponse> => {
    const totalPower = await fetchJson(
      getGermanyTotalPowerPath(),
      totalPowerResponseSchema,
      { allowStaleOnFailure: true }
    );
    const flow = extractGermanyDispatchSlotsFromTotalPower(totalPower);
    if (!flow) {
      throw new Error(
        "No usable quarter-hour residual-load slots available from Energy-Charts."
      );
    }
    return flow;
  };

export const getGermanyAssessmentContext = async (): Promise<GermanyAssessmentContext> => {
  const [totalPower, installedPower] = await Promise.all([
    fetchJson(getGermanyTotalPowerPath(), totalPowerResponseSchema, {
      allowStaleOnFailure: true,
    }),
    fetchJson("/installed_power?country=de", installedPowerResponseSchema, {
      allowStaleOnFailure: true,
    }),
  ]);
  const snapshot = buildGermanyMarketSnapshot({ totalPower, installedPower });

  const loadSeries = findSeriesOrThrow(
    totalPower.production_types,
    "Load (incl. self-consumption)"
  );
  const nonNullLoad = loadSeries.data.filter((value): value is number => value !== null);
  const residualSeries = findResidualLoadSeries(totalPower.production_types);
  const nonNullResidual =
    residualSeries === undefined
      ? []
      : residualSeries.data.filter((value): value is number => value !== null);
  const renewableShareSeries = totalPower.production_types.find(
    (entry) => entry.name === "Renewable share of load"
  );
  const derivedRenewableShareSeries = deriveRenewableShareOfLoadSeries(
    totalPower.production_types,
    loadSeries
  );
  const renewableShareValues =
    renewableShareSeries === undefined
      ? derivedRenewableShareSeries
      : mergeRenewableShareSeries(renewableShareSeries.data, derivedRenewableShareSeries);
  const nonNullRenewableShare = renewableShareValues.filter((value): value is number => value !== null);
  const solarSeries = totalPower.production_types.filter((entry) => /solar/i.test(entry.name));
  const windSeries = totalPower.production_types.filter((entry) => /wind/i.test(entry.name));
  const solarValues = totalPower.unix_seconds.map((_, index) =>
    solarSeries.reduce<number | null>((sum, series) => {
      const value = series.data[index];
      if (value === null || !Number.isFinite(value)) {
        return sum;
      }
      return (sum ?? 0) + value;
    }, null)
  );
  const windValues = totalPower.unix_seconds.map((_, index) =>
    windSeries.reduce<number | null>((sum, series) => {
      const value = series.data[index];
      if (value === null || !Number.isFinite(value)) {
        return sum;
      }
      return (sum ?? 0) + value;
    }, null)
  );

  const pointsPerDay = 96;
  const trailing7dPoints = pointsPerDay * 7;
  const trailing30dPoints = pointsPerDay * 30;
  const residual7d = nonNullResidual.slice(-trailing7dPoints);
  const residual30d = nonNullResidual.slice(-trailing30dPoints);
  const residualRamps = residual30d
    .slice(1)
    .map((value, index) => Math.abs(value - residual30d[index]));
  const eveningStressPeriods7d =
    residualSeries === undefined || renewableShareValues.length === 0
      ? null
      : residualSeries.data.slice(-trailing7dPoints).reduce<number>((count, value, index) => {
          const renewable = renewableShareValues.slice(-trailing7dPoints)[index];
          if (value === null || renewable === null) {
            return count;
          }
          return value > 0 && renewable < 45 ? count + 1 : count;
        }, 0);
  const oversupplyPeriods7d =
    residualSeries === undefined
      ? null
      : residualSeries.data
          .slice(-trailing7dPoints)
          .reduce<number>((count, value) => (value !== null && value < 0 ? count + 1 : count), 0);
  const missingSignals: string[] = [];
  if (residualSeries === undefined) {
    missingSignals.push("Residual load series unavailable");
  }
  if (nonNullRenewableShare.length < trailing7dPoints) {
    missingSignals.push("Limited renewable share history for trailing 7d");
  }

  let forecast: GermanyAssessmentContext["forecast"];
  try {
    const renewableShareForecast = await fetchJson(
      "/ren_share_forecast?country=de",
      renewableShareForecastResponseSchema
    );
    forecast = summarizeRenewableShareForecast(
      renewableShareForecast,
      snapshot.energyUsage.latestTimestampIso
    );
  } catch (error) {
    log("renewable-share forecast unavailable %o", { error });
    forecast = {
      available: false,
      note: "Renewable-share forecast endpoint unavailable in this run.",
      source: "energy-charts.ren_share_forecast",
      horizonHours: null,
      renewableSharePctP50Next24h: null,
      renewableSharePctMinNext24h: null,
      renewableSharePctMaxNext24h: null,
      renewableSharePctP50Next48h: null,
      renewableSharePctMinNext48h: null,
      renewableSharePctMaxNext48h: null,
      renewableSharePctP50Day2: null,
    };
  }
  const renewablePatterns = summarizeRecentRenewablePatterns({
    unixSeconds: totalPower.unix_seconds,
    loadValues: loadSeries.data,
    residualValues: residualSeries?.data ?? null,
    solarValues,
    windValues,
    forecast,
  });

  return {
    snapshot,
    historical: {
      trailing24hAverageMw: averageLast(nonNullLoad, pointsPerDay),
      trailing7dAverageMw: averageLast(nonNullLoad, trailing7dPoints),
      trailing30dAverageMw: averageLast(nonNullLoad, trailing30dPoints),
      trailing7dPeakMw: peakLast(nonNullLoad, trailing7dPoints),
      trailing30dPeakMw: peakLast(nonNullLoad, trailing30dPoints),
    },
    marketSignals: {
      loadDelta7dVs30dMw: averageLast(nonNullLoad, trailing7dPoints) - averageLast(nonNullLoad, trailing30dPoints),
      peakDelta7dVs30dMw: peakLast(nonNullLoad, trailing7dPoints) - peakLast(nonNullLoad, trailing30dPoints),
      residualVolatility7dPct:
        residual7d.length > 0
          ? (stdDev(residual7d) / Math.max(1, Math.abs(averageLast(residual7d, residual7d.length)))) * 100
          : null,
      residualVolatility30dPct:
        residual30d.length > 0
          ? (stdDev(residual30d) / Math.max(1, Math.abs(averageLast(residual30d, residual30d.length)))) * 100
          : null,
      residualRampP95MwPer15m: residualRamps.length > 0 ? percentile(residualRamps, 0.95) : null,
      eveningStressPeriods7d,
      oversupplyPeriods7d,
    },
    forecast,
    renewablePatterns,
    dataQuality: {
      missingSignals,
      note:
        missingSignals.length > 0
          ? "Some structural indicators are missing and may reduce confidence."
          : "All structural indicators for this MVP context are available.",
    },
  };
};
