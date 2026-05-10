import { POST } from "@/app/api/briefing/flow-share/route";
import { generateFlowShareCaption } from "@/lib/flowShareCaptionLlm";
import { flowSharePayloadSchema } from "@/lib/flowSharePayload";

jest.mock("@/lib/flowShareCaptionLlm", () => {
  const actual = jest.requireActual("@/lib/flowShareCaptionLlm");
  return {
    ...actual,
    generateFlowShareCaption: jest.fn(),
  };
});

const llmMock = generateFlowShareCaption as jest.MockedFunction<typeof generateFlowShareCaption>;

const basePayload = {
  language: "en" as const,
  dateBerlin: "2026-05-09",
  selectorMode: "day" as const,
  windowLabel: "2026-05-09",
  dataCoveragePct: 100,
  sampleQuarterHours: 96,
  presentationMode: "observed" as const,
  netBalanceGwhWindow: -2.3,
  chartHeading: "Observed surplus, deficit",
  grossSurplusGwh: 40,
  baselineSelfConsumptionPct: 82,
};

describe("/api/briefing/flow-share", () => {
  beforeEach(() => {
    llmMock.mockReset();
  });

  it("accepts fixture payload schema", () => {
    expect(flowSharePayloadSchema.safeParse(basePayload).success).toBe(true);
  });

  it("Request.json round-trips fixture", async () => {
    const r = new Request("http://localhost/api/briefing/flow-share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
    });
    await expect(r.json()).resolves.toMatchObject({ language: "en", dateBerlin: "2026-05-09" });
  });

  it("returns LLM caption on success", async () => {
    llmMock.mockResolvedValueOnce({ postText: "Germany net −2 GWh structural window test text here." });

    const res = await POST(
      new Request("http://localhost/api/briefing/flow-share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basePayload),
      })
    );
    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toMatchObject({
      source: "llm",
      postText: "Germany net −2 GWh structural window test text here.",
    });
  });

  it("falls back to deterministic caption when LLM throws", async () => {
    llmMock.mockRejectedValueOnce(new Error("rate limit"));

    const res = await POST(
      new Request("http://localhost/api/briefing/flow-share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basePayload),
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { source: string; postText: string };
    expect(json.source).toBe("fallback_numeric");
    expect(typeof json.postText).toBe("string");
    expect(json.postText.length).toBeGreaterThanOrEqual(12);
    expect(json.postText.length).toBeLessThanOrEqual(260);
  });

  it("rejects invalid payload", async () => {
    const res = await POST(
      new Request("http://localhost/api/briefing/flow-share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
  });
});
