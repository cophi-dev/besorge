import {
  computeEconomics,
  defaultEconomicsAssumptions,
  type MarketRevenueReference,
} from "@/lib/bessEconomics";

describe("computeEconomics", () => {
  const physical = {
    totalPowerMw: 500,
    totalEnergyMwh: 2_000,
    roundTripEfficiency: 92,
  };

  it("uses live market reference values when a recent spot spread is available", () => {
    const marketReference: MarketRevenueReference = {
      derivedSpotSpreadEurPerMwh: 100,
      averageDailyCurtailmentOpportunityMwh: 1_500,
      positiveRedispatchCostEurPerMwh: 149.37,
      negativeRedispatchCostEurPerMwh: -40.15,
      sampledDays: 7,
      spotPriceStatus: "live",
      curtailmentStatus: "loaded",
      priceSourceLabel: "SMARD quarter-hour market price (DE/LU)",
      redispatchSourceLabel: "Netztransparenz calculated redispatch prices (2025-10-01 to 2026-09-30)",
    };

    const result = computeEconomics(
      physical,
      {
        ...defaultEconomicsAssumptions,
        gridRegulatoryScenario: "baseline",
      },
      marketReference
    );

    const annualDischargedMwh = 2_000 * 365 * 0.92;
    const expectedRedispatch =
      Math.min(2_000 * 0.92, 1_500) * 365 * marketReference.positiveRedispatchCostEurPerMwh;

    expect(result.revenueModel).toBe("live_market_reference");
    expect(result.annualDischargedMwh).toBeCloseTo(annualDischargedMwh, 6);
    expect(result.annualArbitrageRevenue).toBeCloseTo(annualDischargedMwh * 100, 6);
    expect(result.annualPeakShavingRevenue).toBe(0);
    expect(result.annualGridServicesRevenue).toBe(0);
    expect(result.annualAvoidedRedispatchRevenue).toBeCloseTo(expectedRedispatch, 6);
    expect(result.annualRevenue).toBeCloseTo(
      result.annualArbitrageRevenue + result.annualAvoidedRedispatchRevenue,
      6
    );
  });

  it("falls back to the legacy blended model when live market data is unavailable", () => {
    const unavailableReference: MarketRevenueReference = {
      derivedSpotSpreadEurPerMwh: 0,
      averageDailyCurtailmentOpportunityMwh: 0,
      positiveRedispatchCostEurPerMwh: 149.37,
      negativeRedispatchCostEurPerMwh: -40.15,
      sampledDays: 0,
      spotPriceStatus: "fallback_unavailable",
      curtailmentStatus: "unavailable_upstream",
      priceSourceLabel: "SMARD unavailable",
      redispatchSourceLabel: "Netztransparenz calculated redispatch prices (2025-10-01 to 2026-09-30)",
    };

    const result = computeEconomics(physical, defaultEconomicsAssumptions, unavailableReference);
    const annualDischargedMwh =
      physical.totalEnergyMwh *
      defaultEconomicsAssumptions.fullCycleEquivalentsPerDay *
      365 *
      (physical.roundTripEfficiency / 100);
    const baseRevenue =
      annualDischargedMwh * defaultEconomicsAssumptions.averagePriceSpreadEurPerMwh;

    expect(result.revenueModel).toBe("manual_blended");
    expect(result.annualArbitrageRevenue).toBeCloseTo(baseRevenue * 0.6, 6);
    expect(result.annualPeakShavingRevenue).toBeCloseTo(baseRevenue * 0.25, 6);
    expect(result.annualGridServicesRevenue).toBeCloseTo(baseRevenue * 0.15, 6);
    expect(result.annualAvoidedRedispatchRevenue).toBe(0);
  });
});
