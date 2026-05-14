import { z } from "zod";

/**
 * Indicative pre-sales economics only — not investment advice, not a guarantee
 * of performance. Intended for BESS sales-engineering interview / demo workflows.
 */

export const packTypeSchema = z.enum(["megapack-2-xl", "megapack-2", "custom"]);
export type PackType = z.infer<typeof packTypeSchema>;

export const projectMegapackConfigSchema = z.object({
  packType: packTypeSchema,
  label: z.string().min(1),
  count: z.number().int().nonnegative(),
  totalPowerMw: z.number().nonnegative(),
  totalEnergyMwh: z.number().nonnegative(),
  footprintM2: z.number().nonnegative(),
  weightTons: z.number().nonnegative(),
  roundTripEfficiency: z.number().min(0).max(100),
});

export type ProjectMegapackConfig = z.infer<typeof projectMegapackConfigSchema>;

export const gridRegulatoryScenarioSchema = z.enum([
  "baseline",
  "moderate_grid_stress",
  "elevated_regulatory_risk",
]);

export type GridRegulatoryScenario = z.infer<typeof gridRegulatoryScenarioSchema>;

export const marketRevenueReferenceSchema = z.object({
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

export type MarketRevenueReference = z.infer<typeof marketRevenueReferenceSchema>;

export const economicsAssumptionsSchema = z.object({
  /** Full energy-throughput equivalents per day relative to nameplate MWh (not MW×MWh). */
  fullCycleEquivalentsPerDay: z.number().min(0.1).max(4),
  /** Blended captured spread / value, EUR per MWh discharged (illustrative). */
  averagePriceSpreadEurPerMwh: z.number().nonnegative(),
  projectLifetimeYears: z.number().int().min(1).max(40),
  /** Annual electricity price / revenue uplift applied to nominal revenue, percent. */
  electricityPriceInflationPercent: z.number().min(0).max(20),
  /** Illustrative installed cost proxy, EUR per MWh nameplate. */
  capexEurPerMwh: z.number().positive(),
  /** Annual OPEX as fraction of CAPEX (O&M, insurance, etc.). */
  annualOpexRateOfCapex: z.number().min(0).max(0.5),
  /** DE-market-style scenario: scales illustrative revenue / OPEX — not legal or tariff data. */
  gridRegulatoryScenario: gridRegulatoryScenarioSchema,
});

export type EconomicsAssumptions = z.infer<typeof economicsAssumptionsSchema>;

export const defaultEconomicsAssumptions: EconomicsAssumptions = {
  fullCycleEquivalentsPerDay: 1,
  averagePriceSpreadEurPerMwh: 85,
  projectLifetimeYears: 20,
  electricityPriceInflationPercent: 2,
  capexEurPerMwh: 220_000,
  annualOpexRateOfCapex: 0.015,
  gridRegulatoryScenario: "baseline",
};

export function parseEconomicsAssumptions(
  input: Partial<EconomicsAssumptions>
): EconomicsAssumptions {
  return economicsAssumptionsSchema.parse({
    ...defaultEconomicsAssumptions,
    ...input,
  });
}

const scenarioFactors: Record<
  GridRegulatoryScenario,
  { revenueMultiplier: number; opexMultiplier: number; label: string }
> = {
  baseline: {
    revenueMultiplier: 1,
    opexMultiplier: 1,
    label: "Baseline (no extra grid/regulatory stress)",
  },
  moderate_grid_stress: {
    revenueMultiplier: 0.97,
    opexMultiplier: 1.06,
    label: "Moderate — illustrative grid charge / policy creep",
  },
  elevated_regulatory_risk: {
    revenueMultiplier: 0.93,
    opexMultiplier: 1.12,
    label: "Elevated — illustrative regulatory / tariff downside",
  },
};

export function regulatoryScenarioDescription(
  scenario: GridRegulatoryScenario
): string {
  return scenarioFactors[scenario].label;
}

export type EconomicsResult = {
  annualDischargedMwh: number;
  annualArbitrageRevenue: number;
  annualPeakShavingRevenue: number;
  annualGridServicesRevenue: number;
  annualAvoidedRedispatchRevenue: number;
  annualRevenueNominal: number;
  annualRevenue: number;
  capex: number;
  annualOperatingCosts: number;
  annualNetCashflow: number;
  yearlyRevenues: { year: number; revenue: number }[];
  totalRevenueOverLifetime: number;
  paybackYears: number;
  grossIrr: number;
  lcoeEurPerMwh: number;
  effectiveAveragePriceSpreadEurPerMwh: number;
  revenueModel: "manual_blended" | "live_market_reference";
  /** Human-readable lines for proposals / UI footnotes. */
  assumptionFootnotes: string[];
};

const REVENUE_SPLIT = {
  arbitrage: 0.6,
  peakShaving: 0.25,
  gridServices: 0.15,
} as const;

/**
 * Energy-limited throughput model:
 * annual discharged ≈ nameplate MWh × full-cycle equivalents/day × 365 × round-trip efficiency.
 * RTE is applied once as a simple proxy for AC energy delivered vs nameplate DC cycling.
 */
export function computeEconomics(
  physical: Pick<
    ProjectMegapackConfig,
    "totalPowerMw" | "totalEnergyMwh" | "roundTripEfficiency"
  >,
  assumptions: EconomicsAssumptions,
  marketReference?: MarketRevenueReference | null
): EconomicsResult {
  const rte = physical.roundTripEfficiency / 100;
  const annualDischargedMwh =
    physical.totalEnergyMwh *
    assumptions.fullCycleEquivalentsPerDay *
    365 *
    rte;

  const { revenueMultiplier, opexMultiplier } = scenarioFactors[assumptions.gridRegulatoryScenario];
  const useLiveMarketReference =
    marketReference !== null &&
    marketReference !== undefined &&
    marketReference.sampledDays > 0 &&
    marketReference.derivedSpotSpreadEurPerMwh > 0;

  const effectiveAveragePriceSpreadEurPerMwh = useLiveMarketReference
    ? marketReference.derivedSpotSpreadEurPerMwh
    : assumptions.averagePriceSpreadEurPerMwh;

  const annualArbitrageRevenue = useLiveMarketReference
    ? annualDischargedMwh * effectiveAveragePriceSpreadEurPerMwh
    : annualDischargedMwh *
      assumptions.averagePriceSpreadEurPerMwh *
      REVENUE_SPLIT.arbitrage;

  const annualPeakShavingRevenue = useLiveMarketReference
    ? 0
    : annualDischargedMwh *
      assumptions.averagePriceSpreadEurPerMwh *
      REVENUE_SPLIT.peakShaving;

  const annualGridServicesRevenue = useLiveMarketReference
    ? 0
    : annualDischargedMwh *
      assumptions.averagePriceSpreadEurPerMwh *
      REVENUE_SPLIT.gridServices;

  const dailyBatteryThroughputMwh =
    physical.totalEnergyMwh * assumptions.fullCycleEquivalentsPerDay * rte;
  const annualAvoidedRedispatchRevenue =
    useLiveMarketReference && marketReference !== null && marketReference !== undefined
      ? Math.min(
          dailyBatteryThroughputMwh,
          marketReference.averageDailyCurtailmentOpportunityMwh
        ) *
        365 *
        marketReference.positiveRedispatchCostEurPerMwh
      : 0;

  const annualRevenueNominal =
    annualArbitrageRevenue +
    annualPeakShavingRevenue +
    annualGridServicesRevenue +
    annualAvoidedRedispatchRevenue;
  const annualRevenue = annualRevenueNominal * revenueMultiplier;

  const capex = physical.totalEnergyMwh * assumptions.capexEurPerMwh;
  const annualOperatingCosts = capex * assumptions.annualOpexRateOfCapex * opexMultiplier;
  const annualNetCashflow = annualRevenue - annualOperatingCosts;

  const inflation = assumptions.electricityPriceInflationPercent / 100;
  const yearlyRevenues = Array.from({ length: assumptions.projectLifetimeYears }, (_, idx) => {
    const year = idx + 1;
    const inflationMultiplier = (1 + inflation) ** idx;
    return {
      year,
      revenue: annualRevenue * inflationMultiplier,
    };
  });

  const totalRevenueOverLifetime = yearlyRevenues.reduce((sum, entry) => sum + entry.revenue, 0);

  const paybackYears =
    annualNetCashflow > 0 ? capex / annualNetCashflow : Number.POSITIVE_INFINITY;

  const grossIrr =
    capex > 0 && totalRevenueOverLifetime > 0
      ? ((totalRevenueOverLifetime / capex) ** (1 / assumptions.projectLifetimeYears) - 1) * 100
      : 0;

  const lifetimeEnergy = annualDischargedMwh * assumptions.projectLifetimeYears;
  const lcoeEurPerMwh =
    lifetimeEnergy > 0
      ? (capex + annualOperatingCosts * assumptions.projectLifetimeYears) / lifetimeEnergy
      : 0;

  const assumptionFootnotes = [
    "Indicative pre-sales model — not investment advice.",
    "Throughput: nameplate MWh × full-cycle equivalents/day × 365 × RTE (simplified).",
    `Regulatory scenario: ${regulatoryScenarioDescription(assumptions.gridRegulatoryScenario)}.`,
  ];

  if (useLiveMarketReference && marketReference !== null && marketReference !== undefined) {
    assumptionFootnotes.push(
      `Live market reference: spot spread ${marketReference.derivedSpotSpreadEurPerMwh.toFixed(1)} EUR/MWh from ${marketReference.sampledDays} recent day(s) via ${marketReference.priceSourceLabel}.`,
      `Avoided redispatch uses average daily curtailment opportunity (${marketReference.averageDailyCurtailmentOpportunityMwh.toFixed(1)} MWh/day) and positive redispatch cost ${marketReference.positiveRedispatchCostEurPerMwh.toFixed(2)} EUR/MWh from ${marketReference.redispatchSourceLabel}.`
    );
    if (marketReference.curtailmentStatus !== "loaded") {
      assumptionFootnotes.push(
        "Curtailment feed unavailable in this run, so avoided redispatch is set conservatively to zero."
      );
    }
  } else {
    assumptionFootnotes.push(
      `Revenue split (illustrative): arbitrage ${REVENUE_SPLIT.arbitrage * 100}%, peak shave ${REVENUE_SPLIT.peakShaving * 100}%, grid ${REVENUE_SPLIT.gridServices * 100}%.`
    );
  }

  return {
    annualDischargedMwh,
    annualArbitrageRevenue: annualArbitrageRevenue * revenueMultiplier,
    annualPeakShavingRevenue: annualPeakShavingRevenue * revenueMultiplier,
    annualGridServicesRevenue: annualGridServicesRevenue * revenueMultiplier,
    annualAvoidedRedispatchRevenue: annualAvoidedRedispatchRevenue * revenueMultiplier,
    annualRevenueNominal,
    annualRevenue,
    capex,
    annualOperatingCosts,
    annualNetCashflow,
    yearlyRevenues,
    totalRevenueOverLifetime,
    paybackYears: Number.isFinite(paybackYears) ? paybackYears : 0,
    grossIrr,
    lcoeEurPerMwh,
    effectiveAveragePriceSpreadEurPerMwh,
    revenueModel: useLiveMarketReference ? "live_market_reference" : "manual_blended",
    assumptionFootnotes,
  };
}

export function aggregateProjectConfigurations(
  configs: ProjectMegapackConfig[]
): ProjectMegapackConfig | null {
  if (configs.length === 0) {
    return null;
  }

  if (configs.length === 1) {
    return projectMegapackConfigSchema.parse(configs[0]);
  }

  const totalPowerMw = configs.reduce((sum, config) => sum + config.totalPowerMw, 0);
  const totalEnergyMwh = configs.reduce((sum, config) => sum + config.totalEnergyMwh, 0);
  const footprintM2 = configs.reduce((sum, config) => sum + config.footprintM2, 0);
  const weightTons = configs.reduce((sum, config) => sum + config.weightTons, 0);
  const count = configs.reduce((sum, config) => sum + config.count, 0);
  const weightedRte =
    totalEnergyMwh > 0
      ? configs.reduce(
          (sum, config) => sum + config.totalEnergyMwh * config.roundTripEfficiency,
          0
        ) / totalEnergyMwh
      : configs[0]!.roundTripEfficiency;

  return projectMegapackConfigSchema.parse({
    packType: "custom",
    label: `Aggregated stack (${configs.length} blocks)`,
    count,
    totalPowerMw,
    totalEnergyMwh,
    footprintM2,
    weightTons,
    roundTripEfficiency: weightedRte,
  });
}
