import { z } from "zod";

/**
 * Snapshot of Energy-Charts flow metrics serialized from the dashboard for
 * social-caption generation. Matches the KPI strip + chart the user sees
 * for the selected window (day/week/month × observed/simulated).
 */
export const flowSharePayloadSchema = z.object({
  language: z.enum(["en", "de"]),
  /** Primary Energy-Charts day key for metadata (Berlin calendar). */
  dateBerlin: z.string(),
  selectorMode: z.enum(["day", "week", "month"]),
  windowLabel: z.string(),
  /** 0–100 data coverage estimate for plotted quarter-hours */
  dataCoveragePct: z.number(),
  sampleQuarterHours: z.number(),
  presentationMode: z.enum(["observed", "simulated"]),
  /** Σ(gen − load)×¼h across plotted slots → GWh (signed). */
  netBalanceGwhWindow: z.number(),
  chartHeading: z.string(),
  grossSurplusGwh: z.number().optional(),
  missedSurplusGwh: z.number().optional(),
  missedSurplusPctOfGross: z.number().optional(),
  baselineSelfConsumptionPct: z.number().optional(),
  absorbedStructuralSurplusGwh: z.number().optional(),
  /** Fraction 0–1 of gross surplus energy absorbed into modeled BESS. */
  absorbedSurplusPct: z.number().optional(),
  servedDeficitGwh: z.number().optional(),
  /** Fraction 0–1 of gross deficit energy covered from modeled BESS. */
  servedDeficitPct: z.number().optional(),
  imbalanceDampingPct: z.number().optional(),
  /** 0–100 self-consumption share with modeled optimal BESS, if simulated. */
  selfConsumptionWithBessPct: z.number().optional(),
  optimalBessEnergyGwh: z.number().optional(),
  optimalBessPowerGw: z.number().optional(),
});

export type FlowSharePayload = z.infer<typeof flowSharePayloadSchema>;

export type FlowShareCaptionSource = "llm" | "fallback_numeric";

export type FlowShareCaptionApiResponse = {
  source: FlowShareCaptionSource;
  postText: string;
};
