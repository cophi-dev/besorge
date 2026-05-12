import {
  getGermanyEnergyFlowForBerlinRange,
  getGermanyMarketSnapshot,
} from "@/lib/energyChartsApi";
import { loadHomeBriefingInitialData } from "@/lib/homeBriefingData";

jest.mock("@/lib/energyChartsApi", () => ({
  getGermanyEnergyFlowForBerlinRange: jest.fn(),
  getGermanyMarketSnapshot: jest.fn(),
}));

const mockedGetGermanyEnergyFlowForBerlinRange =
  getGermanyEnergyFlowForBerlinRange as jest.MockedFunction<
    typeof getGermanyEnergyFlowForBerlinRange
  >;
const mockedGetGermanyMarketSnapshot =
  getGermanyMarketSnapshot as jest.MockedFunction<typeof getGermanyMarketSnapshot>;

describe("loadHomeBriefingInitialData", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it("falls back to yesterday when today's first slots are unavailable", async () => {
    const market = {
      retrievedAtIso: "2026-05-12T22:10:00.000Z",
    } as Awaited<ReturnType<typeof getGermanyMarketSnapshot>>;
    const yesterdayFlow = {
      dateBerlin: "2026-05-12",
      samplePoints: 96,
      pointFractionOfDay: 1,
      source: "energy-charts.total_power",
      slots: [],
      period: "today",
      rangeStartBerlin: "2026-05-12",
      rangeEndBerlin: "2026-05-12",
    } as Awaited<ReturnType<typeof getGermanyEnergyFlowForBerlinRange>>;
    const now = new Date("2026-05-12T22:10:00.000Z");

    mockedGetGermanyMarketSnapshot.mockResolvedValue(market);
    mockedGetGermanyEnergyFlowForBerlinRange
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(yesterdayFlow);

    const result = await loadHomeBriefingInitialData(now);

    expect(result).toEqual({
      defaultBerlinDateKey: "2026-05-12",
      market,
      initialEnergyFlow: yesterdayFlow,
    });
    expect(mockedGetGermanyEnergyFlowForBerlinRange).toHaveBeenCalledTimes(2);
    expect(mockedGetGermanyEnergyFlowForBerlinRange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        startKey: "2026-05-13",
        endKey: "2026-05-13",
        capSlotsAtNow: true,
      }),
      now
    );
    expect(mockedGetGermanyEnergyFlowForBerlinRange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        startKey: "2026-05-12",
        endKey: "2026-05-12",
        capSlotsAtNow: false,
      }),
      now
    );
  });

  it("keeps today when today's slots are already available", async () => {
    const market = {
      retrievedAtIso: "2026-05-12T22:30:00.000Z",
    } as Awaited<ReturnType<typeof getGermanyMarketSnapshot>>;
    const todayFlow = {
      dateBerlin: "2026-05-13",
      samplePoints: 4,
      pointFractionOfDay: 1,
      source: "energy-charts.total_power",
      slots: [],
      period: "today",
      rangeStartBerlin: "2026-05-13",
      rangeEndBerlin: "2026-05-13",
    } as Awaited<ReturnType<typeof getGermanyEnergyFlowForBerlinRange>>;
    const now = new Date("2026-05-12T22:30:00.000Z");

    mockedGetGermanyMarketSnapshot.mockResolvedValue(market);
    mockedGetGermanyEnergyFlowForBerlinRange.mockResolvedValueOnce(todayFlow);

    const result = await loadHomeBriefingInitialData(now);

    expect(result).toEqual({
      defaultBerlinDateKey: "2026-05-13",
      market,
      initialEnergyFlow: todayFlow,
    });
    expect(mockedGetGermanyEnergyFlowForBerlinRange).toHaveBeenCalledTimes(1);
  });
});
