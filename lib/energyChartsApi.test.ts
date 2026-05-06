import { getGermanyAssessmentContext, getGermanyMarketSnapshot } from "@/lib/energyChartsApi";

const buildConstantSeries = (length: number, value: number): Array<number | null> =>
  Array.from({ length }, () => value);

const buildTotalPowerPayload = ({
  loadValue,
  residualValue,
  includeRenewableShareSeries,
  includeRenewableGenerationSeries,
  points,
}: {
  loadValue: number;
  residualValue: number;
  includeRenewableShareSeries: boolean;
  includeRenewableGenerationSeries: boolean;
  points: number;
}) => {
  const loadSeries = buildConstantSeries(points, loadValue);
  const residualSeries = buildConstantSeries(points, residualValue);

  return {
    unix_seconds: Array.from({ length: points }, (_, index) => 1_700_000_000 + index * 900),
    production_types: [
      { name: "Load (incl. self-consumption)", data: loadSeries },
      { name: "Residual load", data: residualSeries },
      ...(includeRenewableShareSeries
        ? [{ name: "Renewable share of load", data: buildConstantSeries(points, 55) }]
        : []),
      ...(includeRenewableGenerationSeries
        ? [
            { name: "Wind onshore", data: buildConstantSeries(points, 300) },
            { name: "Solar", data: buildConstantSeries(points, 300) },
          ]
        : []),
      { name: "Coal", data: buildConstantSeries(points, 300) },
    ],
  };
};

const installedPowerPayload = {
  time: ["2024", "2025"],
  production_types: [
    { name: "Battery storage (capacity)", data: [14.2, 17.2] },
    { name: "Battery storage (power)", data: [8.1, 11.1] },
  ],
};

const forecastPayload = {
  unix_seconds: Array.from({ length: 120 }, (_, index) => 1_700_629_100 + (index + 1) * 900),
  ren_share: Array.from({ length: 120 }, (_, index) => 40 + (index % 20)),
  substitute: false,
  deprecated: false,
};

const makeJsonResponse = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Error",
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

describe("getGermanyAssessmentContext", () => {
  afterEach(() => {
    jest.resetAllMocks();
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("backfills renewable share history from renewable generation series", async () => {
    const totalPower = buildTotalPowerPayload({
      loadValue: 1_000,
      residualValue: 200,
      includeRenewableShareSeries: false,
      includeRenewableGenerationSeries: true,
      points: 700,
    });

    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/installed_power?country=de")) {
        return makeJsonResponse(installedPowerPayload);
      }
      if (url.includes("/total_power?country=de")) {
        return makeJsonResponse(totalPower);
      }
      if (url.includes("/ren_share_forecast?country=de")) {
        return makeJsonResponse(forecastPayload);
      }
      return makeJsonResponse({ message: "not found" }, 404);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const context = await getGermanyAssessmentContext();

    expect(fetchMock).toHaveBeenCalled();
    expect(context.snapshot.realtimeSystem.renewableShareOfLoadPct).toBeCloseTo(60, 3);
    expect(context.dataQuality.missingSignals).not.toContain("Limited renewable share history for trailing 7d");
    expect(context.forecast.available).toBe(true);
    expect(context.forecast.horizonHours).toBe(24);
    expect(context.forecast.renewableSharePctP50Next24h).not.toBeNull();
  });

  it("keeps renewable-share gap when neither direct nor derived series are available", async () => {
    const totalPower = buildTotalPowerPayload({
      loadValue: 1_000,
      residualValue: 200,
      includeRenewableShareSeries: false,
      includeRenewableGenerationSeries: false,
      points: 700,
    });

    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/installed_power?country=de")) {
        return makeJsonResponse(installedPowerPayload);
      }
      if (url.includes("/total_power?country=de")) {
        return makeJsonResponse(totalPower);
      }
      if (url.includes("/ren_share_forecast?country=de")) {
        return makeJsonResponse({ message: "downstream unavailable" }, 503);
      }
      return makeJsonResponse({ message: "not found" }, 404);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const context = await getGermanyAssessmentContext();

    expect(context.snapshot.realtimeSystem.renewableShareOfLoadPct).toBeUndefined();
    expect(context.dataQuality.missingSignals).toContain("Limited renewable share history for trailing 7d");
    expect(context.forecast.available).toBe(false);
    expect(context.forecast.renewableSharePctP50Next24h).toBeNull();
  });
});

describe("getGermanyMarketSnapshot resilience", () => {
  afterEach(() => {
    jest.resetAllMocks();
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("serves stale installed-power data when upstream is rate-limited", async () => {
    const totalPower = buildTotalPowerPayload({
      loadValue: 1_000,
      residualValue: 200,
      includeRenewableShareSeries: true,
      includeRenewableGenerationSeries: true,
      points: 120,
    });

    let installedPowerCalls = 0;
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/installed_power?country=de")) {
        installedPowerCalls += 1;
        if (installedPowerCalls === 1) {
          return makeJsonResponse(installedPowerPayload);
        }
        return makeJsonResponse({ message: "rate limited" }, 429);
      }
      if (url.includes("/total_power?country=de")) {
        return makeJsonResponse(totalPower);
      }
      return makeJsonResponse({ message: "not found" }, 404);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const firstSnapshot = await getGermanyMarketSnapshot();
    const secondSnapshot = await getGermanyMarketSnapshot();

    expect(firstSnapshot.bess.installedCapacityGwh).toBe(17.2);
    expect(firstSnapshot.bess.installedPowerGw).toBe(11.1);
    expect(secondSnapshot.bess.installedCapacityGwh).toBe(17.2);
    expect(secondSnapshot.bess.installedPowerGw).toBe(11.1);
    expect(installedPowerCalls).toBeGreaterThan(1);
  });
});
