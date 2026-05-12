import { getBessAssessmentFromAi } from "@/lib/aiAssessmentClient";
import { getGermanyAssessmentContext } from "@/lib/energyChartsApi";

jest.mock("next/server", () => ({
  NextResponse: {
    json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return {
        status: init?.status ?? 200,
        headers: init?.headers ?? {},
        json: async () => data,
      };
    },
  },
}));

jest.mock("@/lib/energyChartsApi", () => ({
  getGermanyAssessmentContext: jest.fn(),
}));

jest.mock("@/lib/aiAssessmentClient", () => ({
  getBessAssessmentFromAi: jest.fn(),
}));

const mockedContext = getGermanyAssessmentContext as jest.MockedFunction<
  typeof getGermanyAssessmentContext
>;
const mockedAi = getBessAssessmentFromAi as jest.MockedFunction<typeof getBessAssessmentFromAi>;
let GET: typeof import("@/app/api/assessment/de/route").GET;

describe("GET /api/assessment/de", () => {
  beforeAll(async () => {
    ({ GET } = await import("@/app/api/assessment/de/route"));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it("returns assessment payload on success", async () => {
    mockedContext.mockResolvedValue({
      snapshot: {
        retrievedAtIso: "2026-05-06T09:00:00.000Z",
        energyUsage: { unit: "MW", latestValueMw: 1, latestTimestampIso: "x", trailing24hAverageMw: 1 },
        bess: {
          capacityUnit: "GWh",
          installedCapacityGwh: 1,
          capacityYear: "2025",
          powerUnit: "GW",
          installedPowerGw: 1,
          powerYear: "2025",
        },
        realtimeSystem: {
          unit: "MW",
          timestampIso: "x",
          loadMw: 1,
          domesticGenerationMw: 1,
          batteryStorageMw: 1,
        },
        eveningWindow: null,
        dailyEnergy: null,
        fleetStructuralSurplus: null,
        dayEnergyFlow: null,
        recentRenewablePatterns: {
          windowDays: 3,
          solarRichDays: null,
          inferredBatteryReadiness: "unknown",
        },
      },
      historical: {
        trailing24hAverageMw: 1,
        trailing7dAverageMw: 1,
        trailing30dAverageMw: 1,
        trailing7dPeakMw: 1,
        trailing30dPeakMw: 1,
      },
      marketSignals: {
        loadDelta7dVs30dMw: 1,
        peakDelta7dVs30dMw: 1,
        residualVolatility7dPct: 10,
        residualVolatility30dPct: 12,
        residualRampP95MwPer15m: 100,
        eveningStressPeriods7d: 5,
        oversupplyPeriods7d: 2,
      },
      forecast: {
        available: true,
        note: "Forecast integrated",
        source: "energy-charts.ren_share_forecast",
        horizonHours: 48,
        renewableSharePctP50Next24h: 53,
        renewableSharePctMinNext24h: 41,
        renewableSharePctMaxNext24h: 68,
        renewableSharePctP50Next48h: 52,
        renewableSharePctMinNext48h: 40,
        renewableSharePctMaxNext48h: 70,
        renewableSharePctP50Day2: 50,
      },
      renewablePatterns: {
        recentWindowDays: 3,
        recentSolarShareOfLoadPctAvg: 27,
        recentWindShareOfLoadPctAvg: 20,
        recentMiddaySolarMwAvg: 17000,
        recentEveningResidualMwAvg: 21000,
        recentOversupplyPeriods: 10,
        recentSolarRichDays: 2,
        inferredBatteryReadiness: "high",
        note: "recent pattern and forecast support readiness",
      },
      dataQuality: { missingSignals: [], note: "ok" },
    });
    mockedAi.mockResolvedValue({
      verdict: "beneficial_now",
      score: 80,
      confidence: 72,
      timeHorizon: "now",
      shortTermSignal: "Immediate tightness remains visible.",
      structuralSignal: "Renewable growth supports storage demand.",
      scoreBreakdown: {
        volatility: 75,
        adequacy: 70,
        policyAndRegulation: 60,
        marketPressure: 68,
      },
      confidenceDrivers: ["Observed residual load volatility"],
      confidenceLimitations: ["No integrated market forward curves"],
      keyDrivers: ["x"],
      risks: ["y"],
      recommendedNextActions: ["z"],
      horizonOutlook: {
        now: { recommendation: "Proceed selectively", rationale: "Near-term spread potential present" },
        next12m: { recommendation: "Target constrained nodes", rationale: "Competition likely rises" },
        next36m: { recommendation: "Stage investments", rationale: "Regulatory design still evolving" },
      },
      dataGapsImpact: "Forward data gaps reduce certainty.",
      analystSummary:
        "BESSForge currently reads this window as beneficial now. Recent renewable momentum and a supportive day-ahead profile imply better recharge optionality after evening discharge.",
      fullAnalysisSummary:
        "The last few days show a constructive renewable backdrop for short-term BESS dispatch. With batteries likely entering evening windows in healthier charge positions and forward renewable share still elevated, residual peaks can be monetized with lower next-day recharge risk. The setup supports selective, risk-controlled execution rather than broad acceleration.",
      asOf: "2026-05-06T10:00:00.000Z",
    });

    const response = await GET();
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.verdict).toBe("beneficial_now");
    expect(response.headers["Cache-Control"]).toBe("public, s-maxage=60, stale-while-revalidate=120");
  });

  it("returns 502 when assessment fails", async () => {
    mockedContext.mockRejectedValue(new Error("boom"));
    const response = await GET();
    expect(response.status).toBe(502);
  });
});
