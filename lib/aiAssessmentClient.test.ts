import { getBessAssessmentFromAi } from "@/lib/aiAssessmentClient";

const originalEnv = process.env;

const context = {
  snapshot: {
    retrievedAtIso: "2026-05-06T09:00:00.000Z",
    energyUsage: {
      latestValueMw: 55_000,
      trailing24hAverageMw: 50_000,
    },
    bess: {
      installedCapacityGwh: 17.2,
      installedPowerGw: 11.1,
    },
    realtimeSystem: {
      loadMw: 55_000,
      domesticGenerationMw: 53_000,
      batteryStorageMw: 600,
    },
  },
  historical: {
    trailing24hAverageMw: 50_000,
    trailing7dAverageMw: 49_100,
    trailing30dAverageMw: 48_700,
    trailing7dPeakMw: 68_000,
    trailing30dPeakMw: 72_000,
  },
  marketSignals: {
    loadDelta7dVs30dMw: 400,
    peakDelta7dVs30dMw: -600,
    residualVolatility7dPct: 22,
    residualVolatility30dPct: 18,
    residualRampP95MwPer15m: 2400,
    eveningStressPeriods7d: 64,
    oversupplyPeriods7d: 12,
  },
  forecast: {
    available: true,
    note: "Forecast integrated",
    source: "energy-charts.ren_share_forecast",
    horizonHours: 48,
    renewableSharePctP50Next24h: 53,
    renewableSharePctMinNext24h: 41,
    renewableSharePctMaxNext24h: 68,
    renewableSharePctP50Next48h: 51,
    renewableSharePctMinNext48h: 39,
    renewableSharePctMaxNext48h: 69,
    renewableSharePctP50Day2: 49,
  },
  renewablePatterns: {
    recentWindowDays: 3,
    recentSolarShareOfLoadPctAvg: 28,
    recentWindShareOfLoadPctAvg: 21,
    recentMiddaySolarMwAvg: 18000,
    recentEveningResidualMwAvg: 22000,
    recentOversupplyPeriods: 14,
    recentSolarRichDays: 2,
    inferredBatteryReadiness: "high",
    note: "recent pattern and forecast suggest solid charge readiness",
  },
  dataQuality: {
    missingSignals: [],
    note: "all good",
  },
};

describe("getBessAssessmentFromAi", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AI_PROVIDER: "xai",
      AI_MODEL: "grok-3-mini",
      XAI_API_KEY: "test-key",
      AI_BASE_URL: "https://api.x.ai/v1",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetAllMocks();
  });

  it("parses valid model JSON output", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "beneficial_now",
                score: 74,
                confidence: 68,
                timeHorizon: "now",
                shortTermSignal: "Residual load remains elevated during evening windows.",
                structuralSignal: "High renewable penetration should sustain flexibility demand.",
                scoreBreakdown: {
                  volatility: 78,
                  adequacy: 71,
                  policyAndRegulation: 61,
                  marketPressure: 66,
                },
                confidenceDrivers: ["Residual volatility is persistently high."],
                confidenceLimitations: ["No forward price curve integrated."],
                keyDrivers: ["Rising residual load"],
                risks: ["Short observation window"],
                recommendedNextActions: ["Run sensitivity analysis"],
                horizonOutlook: {
                  now: {
                    recommendation: "Proceed with selective pipeline acceleration.",
                    rationale: "Immediate flexibility deficit remains visible.",
                  },
                  next12m: {
                    recommendation: "Prioritize grid-constrained nodes.",
                    rationale: "Near-term competition likely increases on generic nodes.",
                  },
                  next36m: {
                    recommendation: "Maintain optionality on expansion phases.",
                    rationale: "Policy and market design uncertainty remains material.",
                  },
                },
                dataGapsImpact: "Missing forward curves lowers long-horizon confidence.",
                analystSummary:
                  "SpeicherPilot currently reads this window as beneficial now. Recent solar strength and supportive next-day renewables suggest good recharge optionality after evening discharge.",
                fullAnalysisSummary:
                  "Recent renewable conditions point to a constructive near-term setup for BESS. Multiple solar-rich sessions likely improved fleet charge readiness, and the 24-48h forecast keeps recharge risk contained. This supports selective discharge into evening residual peaks with disciplined trigger thresholds.",
                asOf: "2026-05-06T10:00:00.000Z",
              }),
            },
          },
        ],
      }),
    });
    global.fetch = mockFetch as typeof fetch;

    const result = await getBessAssessmentFromAi(context);
    expect(result.verdict).toBe("beneficial_now");
    expect(result.score).toBe(74);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws when provider is unsupported", async () => {
    process.env.AI_PROVIDER = "other";
    await expect(getBessAssessmentFromAi(context)).rejects.toThrow('Unsupported AI_PROVIDER "other"');
  });
});
