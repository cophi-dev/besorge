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

const berlinDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const getBerlinHour = (timestampSeconds: number): number =>
  Number.parseInt(berlinHourFormatter.format(new Date(timestampSeconds * 1000)), 10);

const getBerlinDateKey = (timestampSeconds: number): string =>
  berlinDateFormatter.format(new Date(timestampSeconds * 1000));

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

export const getGermanyMarketSnapshot = async (): Promise<GermanyMarketSnapshot> => {
  const [totalPower, installedPower] = await Promise.all([
    fetchJson("/total_power?country=de", totalPowerResponseSchema, {
      allowStaleOnFailure: true,
    }),
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
    fetchJson("/total_power?country=de", totalPowerResponseSchema, {
      allowStaleOnFailure: true,
    }),
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
