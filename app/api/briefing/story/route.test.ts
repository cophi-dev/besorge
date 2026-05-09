/**
 * Integration test for the daily-story API route.
 *
 * `Request`/`Response` polyfills are registered in `jest.setup.ts` so
 * `next/server` imports cleanly under jsdom. Mocks both
 * `morningBriefingContext` and `dailyStoryLlm` so we exercise the real
 * route orchestration: schema validation, LLM happy path, and the
 * deterministic numeric fallback that protects the home page from any
 * LLM outage. `next/cache` is already passthrough-mocked in
 * `jest.setup.ts`.
 */

import { GET } from "@/app/api/briefing/story/route";
import type { MorningBriefingContext } from "@/lib/morningBriefingContext";

jest.mock("@/lib/morningBriefingContext", () => ({
  buildMorningBriefingContext: jest.fn(),
  yesterdayBerlinDateKey: () => "2026-05-08",
}));

jest.mock("@/lib/dailyStoryLlm", () => {
  const actual = jest.requireActual("@/lib/dailyStoryLlm");
  return {
    ...actual,
    generateDailyStory: jest.fn(),
  };
});

import { buildMorningBriefingContext } from "@/lib/morningBriefingContext";
import { generateDailyStory } from "@/lib/dailyStoryLlm";

const buildCtxMock = buildMorningBriefingContext as jest.MockedFunction<
  typeof buildMorningBriefingContext
>;
const llmMock = generateDailyStory as jest.MockedFunction<typeof generateDailyStory>;

const baseContext: MorningBriefingContext = {
  dateBerlin: "2026-05-09",
  retrievedAtIso: "2026-05-09T18:00:00.000Z",
  pointFractionOfDay: 0.85,
  samplePoints: 82,
  netStructuralBalanceGwh: -47.1,
  fleet: { powerGw: 18.3, capacityGwh: 27.9 },
  simulated: {
    practicalCapacityGwh: 18.4,
    balancedPowerMw: 9200,
    gridImpactReductionPct: 31.2,
    absorbedSurplusShare: 0.47,
    servedDeficitShare: 0.22,
  },
  rawNote: "stub",
};

const llmStory = {
  headline: "Evening ramp pulled the system into deficit while solar carried lunch.",
  narrative:
    "Generation trailed load by 47.1 GWh today. Solar carried the 11:00–14:00 window with a comfortable surplus, but the 18:00–21:00 evening ramp pulled the system into a deep residual deficit.",
  counterfactual:
    "A right-sized 18.4 GWh / 9.2 GW BESS would have flattened ~31% of the grid imbalance, capturing ~47% of the surplus and serving ~22% of the deficit.",
  dataAsOfNote: "Based on the first 85% of today's quarter-hours.",
};

const callRoute = async (qs: string) =>
  GET(new Request(`http://localhost/api/briefing/story?${qs}`));

describe("/api/briefing/story", () => {
  beforeEach(() => {
    buildCtxMock.mockReset();
    llmMock.mockReset();
  });

  it("returns LLM source when both context and LLM succeed", async () => {
    buildCtxMock.mockResolvedValueOnce(baseContext);
    llmMock.mockResolvedValueOnce(llmStory);

    const response = await callRoute("date=2026-05-09&language=en");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.source).toBe("llm");
    expect(json.dateBerlin).toBe("2026-05-09");
    expect(json.story).toEqual(llmStory);
    expect(response.headers.get("Cache-Control")).toMatch(/s-maxage=900/);
  });

  it("falls back to deterministic numeric story when LLM fails", async () => {
    buildCtxMock.mockResolvedValueOnce(baseContext);
    llmMock.mockRejectedValueOnce(new Error("xAI 500"));

    const response = await callRoute("date=2026-05-09&language=en");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.source).toBe("fallback_numeric");
    expect(json.story.headline).toMatch(/Structural balance/i);
    expect(json.story.counterfactual).toMatch(/18\.4 GWh/);
    expect(json.story.counterfactual).toMatch(/9\.2 GW/);
    expect(json.story.dataAsOfNote).toMatch(/85%/);
  });

  it("handles capMwh=0 in the fallback without inventing numbers", async () => {
    buildCtxMock.mockResolvedValueOnce({
      ...baseContext,
      simulated: {
        practicalCapacityGwh: 0,
        balancedPowerMw: 0,
        gridImpactReductionPct: null,
        absorbedSurplusShare: null,
        servedDeficitShare: null,
      },
    });
    llmMock.mockRejectedValueOnce(new Error("xAI 500"));

    const response = await callRoute("date=2026-05-09&language=en");
    const json = await response.json();
    expect(json.source).toBe("fallback_numeric");
    expect(json.story.counterfactual).toMatch(/no meaningfully sized daily storage/i);
  });

  it("emits localized fallback strings for DE", async () => {
    buildCtxMock.mockResolvedValueOnce(baseContext);
    llmMock.mockRejectedValueOnce(new Error("xAI 500"));

    const response = await callRoute("date=2026-05-09&language=de");
    const json = await response.json();
    expect(json.story.headline).toMatch(/Strukturelle Bilanz/);
    expect(json.story.counterfactual).toMatch(/optimal dimensionierter/);
    expect(json.story.dataAsOfNote).toMatch(/Stand:/);
  });

  it("returns 502 when even the context cannot be built", async () => {
    buildCtxMock.mockResolvedValueOnce(null);

    const response = await callRoute("date=2026-05-09&language=en");
    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.message).toMatch(/Unable to build daily story/i);
    expect(llmMock).not.toHaveBeenCalled();
  });

  it("rejects malformed query params with 400", async () => {
    const response = await callRoute("date=NOPE&language=en");
    expect(response.status).toBe(400);
    expect(buildCtxMock).not.toHaveBeenCalled();
  });

  it("defaults to yesterday when date is missing", async () => {
    buildCtxMock.mockResolvedValueOnce({ ...baseContext, dateBerlin: "2026-05-08" });
    llmMock.mockResolvedValueOnce(llmStory);

    const response = await callRoute("language=en");
    expect(response.status).toBe(200);
    expect(buildCtxMock).toHaveBeenCalledWith("2026-05-08");
  });
});
