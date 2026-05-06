import { z } from "zod";

import { createLogger } from "@/lib/debug";

const log = createLogger("energy-charts");

const ENERGY_CHARTS_BASE_URL = "https://api.energy-charts.info";
const ENERGY_CHARTS_STALE_TTL_MS = 1000 * 60 * 60 * 24;
const DEFAULT_RETRY_ATTEMPTS = 2;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const responseCache = new Map<string, { fetchedAtMs: number; payload: unknown }>();

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
  }
): Promise<T> => {
  const url = `${ENERGY_CHARTS_BASE_URL}${path}`;
  const retries = options?.retries ?? DEFAULT_RETRY_ATTEMPTS;
  const allowStaleOnFailure = options?.allowStaleOnFailure ?? false;
  const staleTtlMs = options?.staleTtlMs ?? ENERGY_CHARTS_STALE_TTL_MS;

  let lastFailureMessage = "Unknown fetch failure";

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        next: { revalidate: 60 * 30 },
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

const sumDomesticGenerationMw = (
  productionTypes: { name: string; data: Array<number | null> }[],
  loadIndex: number
): number => {
  let sum = 0;
  for (const series of productionTypes) {
    if (EXCLUDED_FROM_DOMESTIC_GENERATION.has(series.name)) {
      continue;
    }
    const value = valueAtIndexWithFallback(series.data, loadIndex, 0);
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

const deriveRenewableShareOfLoadSeries = (
  productionTypes: { name: string; data: Array<number | null> }[],
  loadSeries: { name: string; data: Array<number | null> }
): Array<number | null> => {
  const renewableGenerationSeries = productionTypes.filter(
    (series) =>
      !EXCLUDED_FROM_DOMESTIC_GENERATION.has(series.name) &&
      !/battery/i.test(series.name) &&
      RENEWABLE_GENERATION_SERIES_REGEX.test(series.name)
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

const summarizeRenewableShareForecast = (
  payload: z.infer<typeof renewableShareForecastResponseSchema>,
  snapshotTimestampIso: string
): GermanyAssessmentContext["forecast"] => {
  const nowSeconds = Math.floor(new Date(snapshotTimestampIso).getTime() / 1000);
  const horizonSeconds = 24 * 60 * 60;

  const next24hValues = payload.unix_seconds
    .map((timestamp, index) => ({ timestamp, value: payload.ren_share[index] }))
    .filter(
      (point): point is { timestamp: number; value: number } =>
        point.timestamp > nowSeconds &&
        point.timestamp <= nowSeconds + horizonSeconds &&
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
    };
  }

  return {
    available: true,
    note: "Renewable-share forecast integrated from Energy-Charts for the next 24h window.",
    source: "energy-charts.ren_share_forecast",
    horizonHours: 24,
    renewableSharePctP50Next24h: percentile(next24hValues, 0.5),
    renewableSharePctMinNext24h: Math.min(...next24hValues),
    renewableSharePctMaxNext24h: Math.max(...next24hValues),
  };
};

export const getGermanyMarketSnapshot = async (): Promise<GermanyMarketSnapshot> => {
  const [totalPower, installedPower] = await Promise.all([
    fetchJson("/total_power?country=de", totalPowerResponseSchema),
    fetchJson("/installed_power?country=de", installedPowerResponseSchema, {
      allowStaleOnFailure: true,
    }),
  ]);

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

  const residualSeries = totalPower.production_types.find((entry) => entry.name === "Residual load");
  const residualValue =
    residualSeries === undefined ? null : valueAtIndexWithFallback(residualSeries.data, loadIndex);

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
  const renewableShareValue =
    mergedRenewableShareSeries.length === 0
      ? null
      : valueAtIndexWithFallback(mergedRenewableShareSeries, loadIndex);

  const realtimeSystem: GermanyMarketSnapshot["realtimeSystem"] = {
    unit: "MW",
    timestampIso: new Date(loadPoint.label * 1000).toISOString(),
    loadMw: loadPoint.value,
    domesticGenerationMw,
    batteryStorageMw,
    ...(residualValue !== null ? { residualLoadMw: residualValue } : {}),
    ...(renewableShareValue !== null ? { renewableShareOfLoadPct: renewableShareValue } : {}),
  };

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
  };
};

export const getGermanyAssessmentContext = async (): Promise<GermanyAssessmentContext> => {
  const [snapshot, totalPower] = await Promise.all([
    getGermanyMarketSnapshot(),
    fetchJson("/total_power?country=de", totalPowerResponseSchema),
  ]);

  const loadSeries = findSeriesOrThrow(
    totalPower.production_types,
    "Load (incl. self-consumption)"
  );
  const nonNullLoad = loadSeries.data.filter((value): value is number => value !== null);
  const residualSeries = totalPower.production_types.find((entry) => entry.name === "Residual load");
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
      : residualSeries.data.slice(-trailing7dPoints).reduce((count, value, index) => {
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
          .reduce((count, value) => (value !== null && value < 0 ? count + 1 : count), 0);
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
    };
  }

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
    dataQuality: {
      missingSignals,
      note:
        missingSignals.length > 0
          ? "Some structural indicators are missing and may reduce confidence."
          : "All structural indicators for this MVP context are available.",
    },
  };
};
