import { z } from "zod";

import { germanyEnergyFlowPeriodSchema } from "@/lib/germanyEnergyFlowPeriod";

export const germanyDispatchSlotSchema = z.object({
  timestampIso: z.string(),
  hourBerlin: z.number(),
  residualLoadMw: z.number(),
  loadMw: z.number(),
  totalGenerationMw: z.number(),
  renewableGenerationMw: z.number().nullable(),
  crossBorderElectricityTradingMw: z.number().nullable().optional().default(null),
  curtailmentMw: z.number().nullable().optional().default(null),
});

export const germanyEnergyFlowApiSchema = z.object({
  dateBerlin: z.string(),
  samplePoints: z.number(),
  pointFractionOfDay: z.number(),
  source: z.literal("energy-charts.total_power"),
  slots: z.array(germanyDispatchSlotSchema),
  curtailmentStatus: z
    .enum(["loaded", "unavailable_not_configured", "unavailable_upstream"])
    .optional()
    .default("unavailable_upstream"),
  period: germanyEnergyFlowPeriodSchema.optional(),
  rangeStartBerlin: z.string().optional(),
  rangeEndBerlin: z.string().optional(),
});

export const bessRecommendationTierSchema = z.object({
  label: z.enum(["aggressive", "balanced", "conservative"]),
  percentile: z.number(),
  recommendedEnergyMwh: z.number(),
  recommendedPowerMw: z.number(),
});

export const bessRecommendationApiSchema = z.object({
  lookbackDays: z.number(),
  rangeStartBerlin: z.string(),
  rangeEndBerlin: z.string(),
  observedDays: z.number(),
  dailyEnergyP95Mwh: z.number(),
  dailyPowerP95Mw: z.number(),
  continuousWindowRequiredEnergyMwh: z.number(),
  tiers: z.array(bessRecommendationTierSchema),
  impactAtBalancedTier: z
    .object({
      absorbedSurplusShare: z.number(),
      servedDeficitShare: z.number(),
      totalSurplusEnergyMwh: z.number(),
      totalDeficitEnergyMwh: z.number(),
    })
    .nullable(),
  indicativeEconomicsAtBalancedTier: z
    .object({
      capexEur: z.number(),
      annualRevenueEur: z.number(),
      annualOperatingCostsEur: z.number(),
      annualNetCashflowEur: z.number(),
      paybackYears: z.number(),
    })
    .nullable(),
});

export const revenueMarketContextSchema = z.object({
  sampledSlots: z.number().int().nonnegative(),
  sampleStartIso: z.string(),
  sampleEndIso: z.string(),
  averageLowPriceEurPerMwh: z.number(),
  averageHighPriceEurPerMwh: z.number(),
  averageMiddayPriceEurPerMwh: z.number(),
  averageEveningPriceEurPerMwh: z.number(),
  eveningPeakPremiumEurPerMwh: z.number(),
  negativePriceSharePct: z.number().min(0).max(100),
});

export const revenueMarketReferenceSchema = z.object({
  derivedSpotSpreadEurPerMwh: z.number().nonnegative(),
  averageDailyCurtailmentOpportunityMwh: z.number().nonnegative(),
  positiveRedispatchCostEurPerMwh: z.number().nonnegative(),
  negativeRedispatchCostEurPerMwh: z.number(),
  sampledDays: z.number().int().nonnegative(),
  spotPriceStatus: z.enum(["live", "fallback_unavailable"]),
  curtailmentStatus: z.enum(["loaded", "unavailable_not_configured", "unavailable_upstream"]),
  priceSourceLabel: z.string().min(1),
  redispatchSourceLabel: z.string().min(1),
});

export const revenueModelApiSchema = z.object({
  marketReference: revenueMarketReferenceSchema,
  marketContext: revenueMarketContextSchema.nullable(),
});

export type BessRecommendation = z.infer<typeof bessRecommendationApiSchema>;
export type RevenueModelPayload = z.infer<typeof revenueModelApiSchema>;
