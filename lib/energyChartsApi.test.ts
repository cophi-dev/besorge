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

describe("getGermanyMarketSnapshot evening + daily aggregates", () => {
  afterEach(() => {
    jest.resetAllMocks();
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("populates eveningWindow, dailyEnergy, and recentRenewablePatterns from quarter-hour series", async () => {
    /**
     * Anchor at 2024-06-15 00:00 Berlin (= 2024-06-14 22:00 UTC, CEST = UTC+2).
     * 96 quarter-hour points then span exactly one Berlin day, with hours
     * 17-20 falling on indices 68-83 (4 hours x 4 points = 16 samples).
     */
    const anchorUnixSeconds = 1_718_402_400;
    const points = 96;
    const loadMw = 50_000;
    const solarMw = 18_000;
    const windMw = 8_000;
    const coalMw = 12_000;
    const residualMw = loadMw - solarMw - windMw;

    const totalPower = {
      unix_seconds: Array.from({ length: points }, (_, i) => anchorUnixSeconds + i * 900),
      production_types: [
        { name: "Load (incl. self-consumption)", data: buildConstantSeries(points, loadMw) },
        { name: "Residual load", data: buildConstantSeries(points, residualMw) },
        { name: "Solar", data: buildConstantSeries(points, solarMw) },
        { name: "Wind onshore", data: buildConstantSeries(points, windMw) },
        { name: "Fossil hard coal", data: buildConstantSeries(points, coalMw) },
      ],
    };

    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/installed_power?country=de")) {
        return makeJsonResponse(installedPowerPayload);
      }
      if (url.includes("/total_power?country=de")) {
        return makeJsonResponse(totalPower);
      }
      return makeJsonResponse({ message: "not found" }, 404);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await getGermanyMarketSnapshot();

    expect(snapshot.eveningWindow).not.toBeNull();
    expect(snapshot.eveningWindow?.dateBerlin).toBe("2024-06-15");
    expect(snapshot.eveningWindow?.samplePoints).toBe(16);
    expect(snapshot.eveningWindow?.avgResidualLoadMw).toBeCloseTo(residualMw, 3);
    expect(snapshot.eveningWindow?.avgRenewableGenerationMw).toBeCloseTo(solarMw + windMw, 3);
    expect(snapshot.eveningWindow?.avgConventionalGenerationMw).toBeCloseTo(coalMw, 3);

    expect(snapshot.dailyEnergy).not.toBeNull();
    expect(snapshot.dailyEnergy?.dateBerlin).toBe("2024-06-15");
    expect(snapshot.dailyEnergy?.samplePoints).toBe(96);
    expect(snapshot.dailyEnergy?.pointFractionOfDay).toBe(1);
    /** 50_000 MW * 96 quarters * 0.25h / 1000 = 1_200 GWh */
    expect(snapshot.dailyEnergy?.demandGwh).toBeCloseTo(1_200, 3);
    /** (18_000 + 8_000) MW * 24h / 1000 = 624 GWh */
    expect(snapshot.dailyEnergy?.renewableGenerationGwh).toBeCloseTo(624, 3);
    /** (18_000 + 8_000 + 12_000) MW * 24h / 1000 = 912 GWh */
    expect(snapshot.dailyEnergy?.totalGenerationGwh).toBeCloseTo(912, 3);
    expect(snapshot.dailyEnergy?.netBalanceGwh).toBeCloseTo(624 - 1_200, 3);
    expect(snapshot.dailyEnergy?.totalNetBalanceGwh).toBeCloseTo(912 - 1_200, 3);

    expect(snapshot.recentRenewablePatterns.windowDays).toBe(3);
    /** Solar share at midday = 18_000 / 50_000 = 36% which clears the 25% threshold for 1 observed day. */
    expect(snapshot.recentRenewablePatterns.solarRichDays).toBe(1);
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
