import { z } from "zod";

import { createLogger } from "@/lib/debug";

const log = createLogger("energy-charts");

const ENERGY_CHARTS_BASE_URL = "https://api.energy-charts.info";

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

const fetchJson = async <T>(
  path: string,
  schema: z.ZodSchema<T>
): Promise<T> => {
  const url = `${ENERGY_CHARTS_BASE_URL}${path}`;
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
    });
    throw new Error(`Energy-Charts request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    log("schema parse failed %o", {
      request: { url, method: "GET" },
      errors: parsed.error.flatten(),
    });
    throw new Error("Energy-Charts returned an unexpected response shape");
  }

  return parsed.data;
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
      return { label: labels[index], value };
    }
  }
  throw new Error("No non-null data points available");
};

type GermanyMarketSnapshot = {
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
};

export const getGermanyMarketSnapshot = async (): Promise<GermanyMarketSnapshot> => {
  const [totalPower, installedPower] = await Promise.all([
    fetchJson("/total_power?country=de", totalPowerResponseSchema),
    fetchJson("/installed_power?country=de", installedPowerResponseSchema),
  ]);

  const loadSeries = findSeriesOrThrow(
    totalPower.production_types,
    "Load (incl. self-consumption)"
  );
  const loadPoint = getLatestNonNullPoint(totalPower.unix_seconds, loadSeries.data);
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
  };
};
