jest.mock("@/lib/netztransparenzApi", () => ({
  getDesignatedCurtailmentMwByTimestampForBerlinRange: jest.fn(),
  hasNetztransparenzCurtailmentConfig: jest.fn(),
}));

import {
  __GERMANY_REVENUE_MODEL_TESTING__,
  getGermanyMarketRevenueReference,
  getRedispatchReferenceForBerlinDateKey,
  getSmardSpotPriceMapForTimestamps,
} from "@/lib/germanyRevenueModel";
import {
  getDesignatedCurtailmentMwByTimestampForBerlinRange,
  hasNetztransparenzCurtailmentConfig,
} from "@/lib/netztransparenzApi";

const mockedCurtailment = jest.mocked(getDesignatedCurtailmentMwByTimestampForBerlinRange);
const mockedHasCurtailmentConfig = jest.mocked(hasNetztransparenzCurtailmentConfig);

const jsonResponse = (payload: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }) as Response;

describe("germanyRevenueModel", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    __GERMANY_REVENUE_MODEL_TESTING__.clearCaches();
    mockedCurtailment.mockReset();
    mockedHasCurtailmentConfig.mockReset();
    mockedHasCurtailmentConfig.mockReturnValue(true);
    Object.defineProperty(global, "fetch", {
      writable: true,
      value: jest.fn(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("maps exact quarter-hour timestamps to live SMARD spot prices", async () => {
    const olderAnchor = Date.parse("2026-05-05T00:00:00.000Z");
    const recentAnchor = Date.parse("2026-05-12T00:00:00.000Z");
    const fetchMock = global.fetch as jest.Mock;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("index_quarterhour")) {
        return jsonResponse({ timestamps: [olderAnchor, recentAnchor] });
      }
      if (url.includes(String(olderAnchor))) {
        return jsonResponse({
          series: [
            [Date.parse("2026-05-11T10:00:00.000Z"), 5],
            [Date.parse("2026-05-11T18:00:00.000Z"), 180],
          ],
        });
      }
      if (url.includes(String(recentAnchor))) {
        return jsonResponse({
          series: [
            [Date.parse("2026-05-12T10:00:00.000Z"), 10],
            [Date.parse("2026-05-12T18:00:00.000Z"), 200],
          ],
        });
      }
      throw new Error(`Unexpected SMARD url: ${url}`);
    });

    const points = await __GERMANY_REVENUE_MODEL_TESTING__.getRecentSmardPoints();

    const result = await getSmardSpotPriceMapForTimestamps([
      "2026-05-12T10:00:00.000Z",
      "2026-05-12T18:00:00.000Z",
      "2026-05-12T19:00:00.000Z",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(points.map((point) => point.timestampIso)).toEqual([
      "2026-05-11T10:00:00.000Z",
      "2026-05-11T18:00:00.000Z",
      "2026-05-12T10:00:00.000Z",
      "2026-05-12T18:00:00.000Z",
    ]);
    expect(result.get("2026-05-12T10:00:00.000Z")).toBe(10);
    expect(result.get("2026-05-12T18:00:00.000Z")).toBe(200);
    expect(result.has("2026-05-12T19:00:00.000Z")).toBe(false);
  });

  it("builds a live market reference and context from recent prices and curtailment", async () => {
    const olderAnchor = Date.parse("2026-05-05T00:00:00.000Z");
    const recentAnchor = Date.parse("2026-05-12T00:00:00.000Z");
    const fetchMock = global.fetch as jest.Mock;

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("index_quarterhour")) {
        return jsonResponse({ timestamps: [olderAnchor, recentAnchor] });
      }
      if (url.includes(String(olderAnchor))) {
        return jsonResponse({
          series: [
            [Date.parse("2026-05-11T10:00:00.000Z"), -20],
            [Date.parse("2026-05-11T18:00:00.000Z"), 180],
          ],
        });
      }
      if (url.includes(String(recentAnchor))) {
        return jsonResponse({
          series: [
            [Date.parse("2026-05-12T10:00:00.000Z"), 10],
            [Date.parse("2026-05-12T18:00:00.000Z"), 200],
          ],
        });
      }
      throw new Error(`Unexpected SMARD url: ${url}`);
    });

    mockedCurtailment.mockResolvedValue(
      new Map<string, number>([
        ["2026-05-11T10:00:00.000Z", 400],
        ["2026-05-12T10:00:00.000Z", 200],
      ])
    );

    const points = await __GERMANY_REVENUE_MODEL_TESTING__.getRecentSmardPoints();
    const { marketReference, marketContext } = await getGermanyMarketRevenueReference();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(points).toHaveLength(4);
    expect(marketReference.spotPriceStatus).toBe("live");
    expect(marketReference.sampledDays).toBe(2);
    expect(marketReference.derivedSpotSpreadEurPerMwh).toBeCloseTo(220, 6);
    expect(marketReference.averageDailyCurtailmentOpportunityMwh).toBeCloseTo(150 / 7, 6);
    expect(marketContext?.averageLowPriceEurPerMwh).toBeCloseTo(-20, 6);
    expect(marketContext?.averageHighPriceEurPerMwh).toBeCloseTo(200, 6);
    expect(marketContext?.negativePriceSharePct).toBeCloseTo(25, 6);
    expect(marketContext?.eveningPeakPremiumEurPerMwh).toBeCloseTo(195, 6);
  });

  it("selects the published redispatch reference period for the Berlin date", () => {
    const reference = getRedispatchReferenceForBerlinDateKey("2026-05-12");
    expect(reference.validFrom).toBe("2025-10-01");
    expect(reference.validTo).toBe("2026-09-30");
    expect(reference.positiveCostEurPerMwh).toBeCloseTo(149.37, 6);
    expect(reference.negativeCostEurPerMwh).toBeCloseTo(-40.15, 6);
  });
});
