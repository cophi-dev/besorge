import { __FLOW_SHARE_CAPTION_TESTING__, flowShareCaptionSchema } from "@/lib/flowShareCaptionLlm";
import type { FlowSharePayload } from "@/lib/flowSharePayload";

describe("buildFlowShareFallback", () => {
  const base: FlowSharePayload = {
    language: "en",
    dateBerlin: "2026-05-09",
    selectorMode: "day",
    windowLabel: "2026-05-09",
    dataCoveragePct: 99,
    sampleQuarterHours: 95,
    presentationMode: "observed",
    netBalanceGwhWindow: -12.34,
    chartHeading: "Observed surplus, deficit & estimated fleet SoC",
    grossSurplusGwh: 88.8,
    baselineSelfConsumptionPct: 71.2,
  };

  it("produces bounded length text", () => {
    const txt = __FLOW_SHARE_CAPTION_TESTING__.buildFlowShareFallback(base);
    const ok = flowShareCaptionSchema.safeParse({ postText: txt });
    expect(ok.success).toBe(true);
  });

  it("includes damping line for simulated mode", () => {
    const simulated: FlowSharePayload = {
      ...base,
      presentationMode: "simulated",
      optimalBessEnergyGwh: 18.5,
      optimalBessPowerGw: 9.2,
      imbalanceDampingPct: 41.3,
      absorbedSurplusPct: 0.88,
      servedDeficitPct: 0.31,
      grossSurplusGwh: undefined,
      baselineSelfConsumptionPct: undefined,
    };
    const txt = __FLOW_SHARE_CAPTION_TESTING__.buildFlowShareFallback(simulated);
    expect(txt).toMatch(/41|damping|Σ|Σ\|slot\|/i);
    const ok = flowShareCaptionSchema.safeParse({ postText: txt });
    expect(ok.success).toBe(true);
  });
});
