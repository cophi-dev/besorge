import { z } from "zod";

import {
  addBerlinCalendarDays,
  countBerlinCalendarDaysInclusive,
  formatBerlinDateKeyFromUtcDate,
} from "@/lib/berlinCalendar";
import {
  marketRevenueReferenceSchema,
  type MarketRevenueReference,
} from "@/lib/bessEconomics";
import { createLogger } from "@/lib/debug";
import {
  getDesignatedCurtailmentMwByTimestampForBerlinRange,
  hasNetztransparenzCurtailmentConfig,
} from "@/lib/netztransparenzApi";

const log = createLogger("germany-revenue-model");

const SMARD_BASE_URL = "https://www.smard.de/app";
const SMARD_MARKET_PRICE_FILTER = "4169";
const SMARD_REGION = "DE";
const SMARD_RESOLUTION = "quarterhour";
const RECENT_SPOT_SERIES_COUNT = 2;
const RECENT_LOOKBACK_DAYS = 7;
const SMARD_CACHE_TTL_MS = 15 * 60 * 1000;
const QUARTER_HOUR_MWH_FACTOR = 0.25;

const smardIndexSchema = z.object({
  timestamps: z.array(z.number()),
});

const smardSeriesSchema = z.object({
  meta_data: z.unknown().optional(),
  series: z.array(z.tuple([z.number(), z.number().nullable()])),
});

export const revenueMarketContextSchema = z.object({
  sampledSlots: z.number().int().nonnegative(),
  sampleStartIso: z.string(),
  sampleEndIso: z.string(),
  averageLowPriceEurPerMwh: z.number(),
  averageHighPriceEurPerMwh: z.number(),
  averageMiddayPriceEurPerMwh: z.number(),
  averageEveningPriceEurPerMwh: z.number(),
  eveningPeakPremiumEurPerMwh: z.number(),
  negativePriceSharePct: z.number().min(0).max(100),
});

export type RevenueMarketContext = z.infer<typeof revenueMarketContextSchema>;

type SmardPoint = {
  timestampMs: number;
  timestampIso: string;
  berlinDateKey: string;
  hourBerlin: number;
  priceEurPerMwh: number;
};

type RedispatchReference = {
  validFrom: string;
  validTo: string;
  positiveCostEurPerMwh: number;
  negativeCostEurPerMwh: number;
};

const REDISPATCH_REFERENCES: RedispatchReference[] = [
  {
    validFrom: "2021-10-01",
    validTo: "2022-09-30",
    positiveCostEurPerMwh: 88.1,
    negativeCostEurPerMwh: -20.23,
  },
  {
    validFrom: "2022-10-01",
    validTo: "2023-09-30",
    positiveCostEurPerMwh: 216.99,
    negativeCostEurPerMwh: -128.5,
  },
  {
    validFrom: "2023-10-01",
    validTo: "2024-09-30",
    positiveCostEurPerMwh: 222.0,
    negativeCostEurPerMwh: -142.23,
  },
  {
    validFrom: "2024-10-01",
    validTo: "2025-09-30",
    positiveCostEurPerMwh: 181.1,
    negativeCostEurPerMwh: -130.4,
  },
  {
    validFrom: "2025-10-01",
    validTo: "2026-09-30",
    positiveCostEurPerMwh: 149.37,
    negativeCostEurPerMwh: -40.15,
  },
];

let smardIndexCache: { fetchedAtMs: number; timestamps: number[] } | null = null;
const smardSeriesCache = new Map<number, { fetchedAtMs: number; points: SmardPoint[] }>();

const berlinHourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  hour12: false,
});

const average = (values: number[]): number =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const averageExtremes = (values: number[], side: "low" | "high"): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sliceSize = Math.max(1, Math.floor(sorted.length * 0.2));
  const slice =
    side === "low" ? sorted.slice(0, sliceSize) : sorted.slice(sorted.length - sliceSize);
  return average(slice);
};

const buildSmardIndexUrl = () =>
  `${SMARD_BASE_URL}/chart_data/${SMARD_MARKET_PRICE_FILTER}/${SMARD_REGION}/index_${SMARD_RESOLUTION}.json`;

const buildSmardSeriesUrl = (anchorTimestampMs: number) =>
  `${SMARD_BASE_URL}/chart_data/${SMARD_MARKET_PRICE_FILTER}/${SMARD_REGION}/${SMARD_MARKET_PRICE_FILTER}_${SMARD_REGION}_${SMARD_RESOLUTION}_${anchorTimestampMs}.json`;

async function fetchSmardIndex(): Promise<number[]> {
  if (smardIndexCache && Date.now() - smardIndexCache.fetchedAtMs < SMARD_CACHE_TTL_MS) {
    return smardIndexCache.timestamps;
  }

  const response = await fetch(buildSmardIndexUrl(), {
    headers: { Accept: "application/json" },
    next: { revalidate: 900 },
  });

  if (!response.ok) {
    throw new Error(`SMARD index request failed with status ${response.status}`);
  }

  const parsed = smardIndexSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("SMARD index response had an unexpected shape");
  }

  smardIndexCache = {
    fetchedAtMs: Date.now(),
    timestamps: parsed.data.timestamps,
  };
  return parsed.data.timestamps;
}

async function fetchSmardSeries(anchorTimestampMs: number): Promise<SmardPoint[]> {
  const cached = smardSeriesCache.get(anchorTimestampMs);
  if (cached && Date.now() - cached.fetchedAtMs < SMARD_CACHE_TTL_MS) {
    return cached.points;
  }

  const response = await fetch(buildSmardSeriesUrl(anchorTimestampMs), {
    headers: { Accept: "application/json" },
    next: { revalidate: 900 },
  });

  if (!response.ok) {
    throw new Error(`SMARD series request failed with status ${response.status}`);
  }

  const parsed = smardSeriesSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("SMARD series response had an unexpected shape");
  }

  const points = parsed.data.series
    .filter((entry): entry is [number, number] => entry[1] !== null && Number.isFinite(entry[1]))
    .map(([timestampMs, priceEurPerMwh]) => {
      const timestampIso = new Date(timestampMs).toISOString();
      return {
        timestampMs,
        timestampIso,
        berlinDateKey: formatBerlinDateKeyFromUtcDate(new Date(timestampMs)),
        hourBerlin: Number(berlinHourFormatter.format(new Date(timestampMs))),
        priceEurPerMwh,
      };
    });

  smardSeriesCache.set(anchorTimestampMs, { fetchedAtMs: Date.now(), points });
  return points;
}

async function getRecentSmardPoints(): Promise<SmardPoint[]> {
  const anchors = await fetchSmardIndex();
  const recentAnchors = anchors.slice(-RECENT_SPOT_SERIES_COUNT);
  const batches = await Promise.all(recentAnchors.map((anchor) => fetchSmardSeries(anchor)));
  const deduped = new Map<number, SmardPoint>();
  for (const batch of batches) {
    for (const point of batch) {
      deduped.set(point.timestampMs, point);
    }
  }
  return [...deduped.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

function computeMarketContext(points: SmardPoint[]): RevenueMarketContext | null {
  if (points.length === 0) {
    return null;
  }

  const prices = points.map((point) => point.priceEurPerMwh);
  const middayPrices = points
    .filter((point) => point.hourBerlin >= 10 && point.hourBerlin <= 15)
    .map((point) => point.priceEurPerMwh);
  const eveningPrices = points
    .filter((point) => point.hourBerlin >= 17 && point.hourBerlin <= 20)
    .map((point) => point.priceEurPerMwh);

  const sampleStartIso = points[0]?.timestampIso ?? new Date().toISOString();
  const sampleEndIso = points[points.length - 1]?.timestampIso ?? sampleStartIso;
  const averageLowPriceEurPerMwh = averageExtremes(prices, "low");
  const averageHighPriceEurPerMwh = averageExtremes(prices, "high");
  const averageMiddayPriceEurPerMwh = average(middayPrices);
  const averageEveningPriceEurPerMwh = average(eveningPrices);
  const negativePriceSharePct =
    prices.length > 0
      ? (prices.filter((value) => value < 0).length / prices.length) * 100
      : 0;

  return {
    sampledSlots: points.length,
    sampleStartIso,
    sampleEndIso,
    averageLowPriceEurPerMwh,
    averageHighPriceEurPerMwh,
    averageMiddayPriceEurPerMwh,
    averageEveningPriceEurPerMwh,
    eveningPeakPremiumEurPerMwh: averageEveningPriceEurPerMwh - averageMiddayPriceEurPerMwh,
    negativePriceSharePct,
  };
}

async function getAverageDailyCurtailmentOpportunityMwh(params: {
  startKey: string;
  endKey: string;
}): Promise<{
  averageDailyCurtailmentOpportunityMwh: number;
  curtailmentStatus: MarketRevenueReference["curtailmentStatus"];
}> {
  const { startKey, endKey } = params;
  const curtailmentByTimestamp = await getDesignatedCurtailmentMwByTimestampForBerlinRange({
    startKey,
    endKey,
    period: `lookback_${startKey}_${endKey}`,
  }).catch((error) => {
    log("curtailment load failed for revenue model %o", {
      range: { startKey, endKey },
      error,
    });
    return null;
  });

  const curtailmentStatus =
    curtailmentByTimestamp !== null
      ? ("loaded" as const)
      : hasNetztransparenzCurtailmentConfig()
        ? ("unavailable_upstream" as const)
        : ("unavailable_not_configured" as const);

  if (curtailmentByTimestamp === null) {
    return {
      averageDailyCurtailmentOpportunityMwh: 0,
      curtailmentStatus,
    };
  }

  const totalCurtailmentMwh = [...curtailmentByTimestamp.values()].reduce(
    (sum, mw) => sum + Math.max(0, mw) * QUARTER_HOUR_MWH_FACTOR,
    0
  );
  const days = countBerlinCalendarDaysInclusive(startKey, endKey);

  return {
    averageDailyCurtailmentOpportunityMwh: days > 0 ? totalCurtailmentMwh / days : 0,
    curtailmentStatus,
  };
}

export function getRedispatchReferenceForBerlinDateKey(dateKey: string): RedispatchReference {
  const match = REDISPATCH_REFERENCES.find(
    (entry) => dateKey >= entry.validFrom && dateKey <= entry.validTo
  );
  if (match) {
    return match;
  }
  return dateKey < REDISPATCH_REFERENCES[0]!.validFrom
    ? REDISPATCH_REFERENCES[0]!
    : REDISPATCH_REFERENCES[REDISPATCH_REFERENCES.length - 1]!;
}

export async function getSmardSpotPriceMapForTimestamps(
  timestampsIso: string[]
): Promise<Map<string, number>> {
  if (timestampsIso.length === 0) {
    return new Map();
  }

  try {
    const targetEpochs = new Set(
      timestampsIso
        .map((value) => Date.parse(value))
        .filter((value) => Number.isFinite(value))
    );
    const points = await getRecentSmardPoints();
    const matched = points.filter((point) => targetEpochs.has(point.timestampMs));
    return new Map(matched.map((point) => [point.timestampIso, point.priceEurPerMwh]));
  } catch (error) {
    log("spot price lookup failed %o", {
      timestampsRequested: timestampsIso.length,
      error,
    });
    return new Map();
  }
}

export async function getGermanyMarketRevenueReference(): Promise<{
  marketReference: MarketRevenueReference;
  marketContext: RevenueMarketContext | null;
}> {
  const now = new Date();
  const endKey = formatBerlinDateKeyFromUtcDate(now);
  const startKey = addBerlinCalendarDays(endKey, -(RECENT_LOOKBACK_DAYS - 1));
  const redispatchReference = getRedispatchReferenceForBerlinDateKey(endKey);

  try {
    const [points, curtailment] = await Promise.all([
      getRecentSmardPoints(),
      getAverageDailyCurtailmentOpportunityMwh({ startKey, endKey }),
    ]);

    const filteredPoints = points.filter((point) => point.berlinDateKey >= startKey);
    const marketContext = computeMarketContext(filteredPoints);
    const sampledDays = new Set(filteredPoints.map((point) => point.berlinDateKey)).size;

    const marketReference = marketRevenueReferenceSchema.parse({
      derivedSpotSpreadEurPerMwh:
        marketContext === null
          ? 0
          : Math.max(
              0,
              marketContext.averageHighPriceEurPerMwh - marketContext.averageLowPriceEurPerMwh
            ),
      averageDailyCurtailmentOpportunityMwh: curtailment.averageDailyCurtailmentOpportunityMwh,
      positiveRedispatchCostEurPerMwh: redispatchReference.positiveCostEurPerMwh,
      negativeRedispatchCostEurPerMwh: redispatchReference.negativeCostEurPerMwh,
      sampledDays,
      spotPriceStatus: marketContext === null ? "fallback_unavailable" : "live",
      curtailmentStatus: curtailment.curtailmentStatus,
      priceSourceLabel: "SMARD quarter-hour market price (DE/LU)",
      redispatchSourceLabel: `Netztransparenz calculated redispatch prices (${redispatchReference.validFrom} to ${redispatchReference.validTo})`,
    });

    return { marketReference, marketContext };
  } catch (error) {
    log("market revenue reference fallback engaged %o", {
      range: { startKey, endKey },
      error,
    });

    return {
      marketReference: marketRevenueReferenceSchema.parse({
        derivedSpotSpreadEurPerMwh: 0,
        averageDailyCurtailmentOpportunityMwh: 0,
        positiveRedispatchCostEurPerMwh: redispatchReference.positiveCostEurPerMwh,
        negativeRedispatchCostEurPerMwh: redispatchReference.negativeCostEurPerMwh,
        sampledDays: 0,
        spotPriceStatus: "fallback_unavailable",
        curtailmentStatus: hasNetztransparenzCurtailmentConfig()
          ? "unavailable_upstream"
          : "unavailable_not_configured",
        priceSourceLabel: "SMARD quarter-hour market price (unavailable)",
        redispatchSourceLabel: `Netztransparenz calculated redispatch prices (${redispatchReference.validFrom} to ${redispatchReference.validTo})`,
      }),
      marketContext: null,
    };
  }
}

export const __GERMANY_REVENUE_MODEL_TESTING__ = {
  clearCaches(): void {
    smardIndexCache = null;
    smardSeriesCache.clear();
  },
  getRecentSmardPoints,
};
