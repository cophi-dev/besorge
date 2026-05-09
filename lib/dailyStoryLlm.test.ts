import {
  __DAILY_STORY_TESTING__,
  dailyStorySchema,
  generateDailyStory,
} from "@/lib/dailyStoryLlm";
import type { MorningBriefingContext } from "@/lib/morningBriefingContext";

const baseContext: MorningBriefingContext = {
  dateBerlin: "2026-05-09",
  retrievedAtIso: "2026-05-09T12:00:00.000Z",
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

const goodStory = {
  headline: "Evening ramp dragged the system into deficit while midday solar covered the day's middle hours.",
  narrative:
    "Generation trailed load by 47.1 GWh today. Solar carried the 11:00–14:00 window with a comfortable surplus, but the 18:00–21:00 evening ramp pulled the system into a deep residual deficit that the German fleet only partially covered.",
  counterfactual:
    "A right-sized 18.4 GWh / 9.2 GW BESS would have flattened ~31% of the grid imbalance, capturing ~47% of the surplus and serving ~22% of the deficit.",
  dataAsOfNote: "Based on the first 85% of today's quarter-hours.",
};

describe("dailyStoryLlm.dailyStorySchema", () => {
  it("accepts a well-formed payload", () => {
    expect(dailyStorySchema.parse(goodStory)).toEqual(goodStory);
  });

  it("rejects an empty headline", () => {
    expect(() =>
      dailyStorySchema.parse({ ...goodStory, headline: "" })
    ).toThrow();
  });

  it("rejects an oversized counterfactual", () => {
    expect(() =>
      dailyStorySchema.parse({
        ...goodStory,
        counterfactual: "x".repeat(401),
      })
    ).toThrow();
  });

  it("treats dataAsOfNote as optional", () => {
    const { dataAsOfNote: _drop, ...withoutNote } = goodStory;
    void _drop;
    expect(dailyStorySchema.parse(withoutNote)).toMatchObject({
      headline: goodStory.headline,
    });
  });
});

describe("dailyStoryLlm.stripJsonFence", () => {
  const { stripJsonFence } = __DAILY_STORY_TESTING__;

  it("strips a ```json fence", () => {
    expect(stripJsonFence("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("strips a bare ``` fence", () => {
    expect(stripJsonFence("```\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("returns plain JSON unchanged", () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("dailyStoryLlm.buildUserPayload", () => {
  const { buildUserPayload } = __DAILY_STORY_TESTING__;

  it("includes the language and the briefing context", () => {
    const payload = buildUserPayload(baseContext, "de");
    expect(payload.language).toBe("de");
    expect(payload.briefing).toBe(baseContext);
    expect(payload.instructions.some((i) => i.includes("Deutsch"))).toBe(true);
  });

  it("requests counterfactual sourcing of simulated.* fields", () => {
    const payload = buildUserPayload(baseContext, "en");
    const counterfactualHint = payload.instructions.find(
      (i) => i.startsWith("counterfactual:")
    );
    expect(counterfactualHint).toBeDefined();
    expect(counterfactualHint).toMatch(/practicalCapacityGwh/);
    expect(counterfactualHint).toMatch(/gridImpactReductionPct/);
  });
});

describe("dailyStoryLlm.generateDailyStory", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.AI_PROVIDER = "xai";
    process.env.AI_MODEL = "grok-test";
    process.env.XAI_API_KEY = "test-key";
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_BASE_URL;
    delete process.env.DAILY_STORY_AI_MODEL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetAllMocks();
  });

  it("calls the configured xAI endpoint and returns a parsed story", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(goodStory),
            },
          },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateDailyStory(baseContext, "en");

    expect(result).toEqual(goodStory);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("grok-test");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
  });

  it("strips ```json fences before validation", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: ["```json\n", JSON.stringify(goodStory), "\n```"].join(""),
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const result = await generateDailyStory(baseContext, "en");
    expect(result).toEqual(goodStory);
  });

  it("throws when the model returns invalid JSON", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "this is not json" } }],
      }),
    }) as unknown as typeof fetch;

    await expect(generateDailyStory(baseContext, "en")).rejects.toThrow(
      /non-JSON/
    );
  });

  it("throws when the model returns a JSON shape that fails the schema", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ headline: "ok" }),
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await expect(generateDailyStory(baseContext, "en")).rejects.toThrow(
      /invalid JSON shape/
    );
  });

  it("propagates HTTP errors", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    }) as unknown as typeof fetch;

    await expect(generateDailyStory(baseContext, "en")).rejects.toThrow(
      /xAI chat failed: 500/
    );
  });

  it("requires XAI_API_KEY when AI_PROVIDER=xai", async () => {
    delete process.env.XAI_API_KEY;
    global.fetch = jest.fn() as unknown as typeof fetch;
    await expect(generateDailyStory(baseContext, "en")).rejects.toThrow(
      /XAI_API_KEY/
    );
  });

  it("respects DAILY_STORY_AI_MODEL override", async () => {
    process.env.DAILY_STORY_AI_MODEL = "grok-cheap";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(goodStory) } }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await generateDailyStory(baseContext, "en");
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.model).toBe("grok-cheap");
  });

  it("rejects unsupported providers", async () => {
    process.env.AI_PROVIDER = "anthropic";
    global.fetch = jest.fn() as unknown as typeof fetch;
    await expect(generateDailyStory(baseContext, "en")).rejects.toThrow(
      /Unsupported AI_PROVIDER/
    );
  });
});
