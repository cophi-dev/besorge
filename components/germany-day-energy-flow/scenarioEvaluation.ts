import type { GermanyDispatchSlotsResponse } from "@/lib/energyChartsApi";
import {
  borderCoupledBatteryChargeMw,
  computeCoverageAtCapacityMwh,
  simulateAdjustedNetMwAtCapacity,
  simulatePracticalDispatchAtCapacity,
} from "@/lib/optimalBessCapacity";

import { QUARTER_HOUR_H } from "./constants";
import type { RevenueModelPayload } from "./schemas";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function computeOpportunityValuePerMwh(
  marketReference: RevenueModelPayload["marketReference"] | null,
  totalChargeOpportunityEnergyMwh: number,
  totalCurtailmentEnergyMwh: number
): number | null {
  const spreadEurPerMwh =
    marketReference !== null && marketReference.derivedSpotSpreadEurPerMwh > 0
      ? marketReference.derivedSpotSpreadEurPerMwh
      : null;
  const redispatchEurPerMwh =
    marketReference !== null && marketReference.positiveRedispatchCostEurPerMwh > 0
      ? marketReference.positiveRedispatchCostEurPerMwh
      : null;
  const curtailedShareOfOpportunity =
    totalChargeOpportunityEnergyMwh > 1e-9
      ? totalCurtailmentEnergyMwh / totalChargeOpportunityEnergyMwh
      : 0;
  const opportunityValuePerMwh =
    (spreadEurPerMwh ?? 0) + (redispatchEurPerMwh ?? 0) * curtailedShareOfOpportunity;
  return opportunityValuePerMwh > 0 ? opportunityValuePerMwh : null;
}

function computeGridReliefScore(input: {
  curtailedAvoidedShare: number | null;
  dampingPct: number | null;
  peakReductionShare: number | null;
  importReductionShare: number | null;
}): number | null {
  const parts = [
    input.curtailedAvoidedShare !== null ? { value: clamp01(input.curtailedAvoidedShare), weight: 0.32 } : null,
    input.dampingPct !== null ? { value: clamp01(input.dampingPct / 100), weight: 0.33 } : null,
    input.peakReductionShare !== null ? { value: clamp01(input.peakReductionShare), weight: 0.2 } : null,
    input.importReductionShare !== null ? { value: clamp01(input.importReductionShare), weight: 0.15 } : null,
  ].filter((part): part is { value: number; weight: number } => part !== null);

  if (parts.length === 0) {
    return null;
  }

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const weighted = parts.reduce((sum, part) => sum + part.value * part.weight, 0);
  return Math.round((weighted / totalWeight) * 100);
}

export type ScenarioImpactSnapshot = {
  coverage: ReturnType<typeof computeCoverageAtCapacityMwh>;
  absorbedCurtailmentEnergyMwh: number;
  remainingCurtailmentEnergyMwh: number;
  peakReductionMw: number;
  gridImpactReductionPct: number | null;
  observedImportEnergyMwh: number | null;
  simulatedImportEnergyMwh: number | null;
  importReductionEnergyMwh: number | null;
  bessRevenueTodayEur: number | null;
  avoidedRedispatchCostsEur: number | null;
  avoidedCurtailmentValueEur: number | null;
  chargeOpportunityValueEur: number | null;
  totalValueCreatedEur: number | null;
  missedOpportunityEur: number | null;
  curtailedRecoveredToLoadEnergyMwh: number;
  gridReliefScore: number | null;
};

export function evaluateBessScenario(params: {
  slots: GermanyDispatchSlotsResponse["slots"];
  capacityMwh: number;
  maxPowerMw: number | null;
  initialSocMwh: number;
  resetDailyByBerlin: boolean;
  marketReference: RevenueModelPayload["marketReference"] | null;
}): ScenarioImpactSnapshot {
  const { slots, capacityMwh, maxPowerMw, initialSocMwh, resetDailyByBerlin, marketReference } = params;

  const coverage = computeCoverageAtCapacityMwh(slots, capacityMwh, {
    maxPowerMw,
    initialSocMwh,
    resetDailyByBerlin,
  });

  const dispatchSeries =
    capacityMwh > 0
      ? simulatePracticalDispatchAtCapacity(slots, capacityMwh, {
          maxPowerMw,
          initialSocMwh,
          resetDailyByBerlin,
        })
      : [];
  const adjustedNetSeries =
    capacityMwh > 0
      ? simulateAdjustedNetMwAtCapacity(slots, capacityMwh, {
          maxPowerMw,
          initialSocMwh,
          resetDailyByBerlin,
        })
      : [];

  let absorbedCurtailmentEnergyMwh = 0;
  let peakAbsNetMw = 0;
  let peakAbsAdjustedNetMw = 0;
  let baselineAbsMwh = 0;
  let adjustedAbsMwh = 0;
  let hasObservedCrossBorder = false;
  let observedImportEnergyMwh = 0;
  let simulatedImportEnergyMwh = 0;

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]!;
    const structuralSurplusMwh = Math.max(0, slot.totalGenerationMw - slot.loadMw) * QUARTER_HOUR_H;
    const curtailedMwh = Math.max(0, slot.curtailmentMw ?? 0) * QUARTER_HOUR_H;
    const chargeMwh = (dispatchSeries[i]?.chargeMw ?? 0) * QUARTER_HOUR_H;
    const totalChargeOpportunityMwh = structuralSurplusMwh + curtailedMwh;
    if (chargeMwh > 0 && totalChargeOpportunityMwh > 0 && curtailedMwh > 0) {
      absorbedCurtailmentEnergyMwh += Math.min(
        curtailedMwh,
        chargeMwh * (curtailedMwh / totalChargeOpportunityMwh)
      );
    }

    const netMw = slot.totalGenerationMw - slot.loadMw;
    baselineAbsMwh += Math.abs(netMw) * QUARTER_HOUR_H;
    adjustedAbsMwh += Math.abs(adjustedNetSeries[i] ?? netMw) * QUARTER_HOUR_H;
    peakAbsNetMw = Math.max(peakAbsNetMw, Math.abs(netMw));
    peakAbsAdjustedNetMw = Math.max(
      peakAbsAdjustedNetMw,
      Math.abs(adjustedNetSeries[i] ?? netMw)
    );

    if (slot.crossBorderElectricityTradingMw !== null && slot.crossBorderElectricityTradingMw !== undefined) {
      hasObservedCrossBorder = true;
      const observedCrossBorderMw = slot.crossBorderElectricityTradingMw;
      const practicalChargeMw = dispatchSeries[i]?.chargeMw ?? 0;
      const practicalDischargeMw = dispatchSeries[i]?.dischargeMw ?? 0;
      const borderCoupledChargeMw = borderCoupledBatteryChargeMw(slot, practicalChargeMw);
      observedImportEnergyMwh += Math.max(0, observedCrossBorderMw) * QUARTER_HOUR_H;
      simulatedImportEnergyMwh +=
        Math.max(0, observedCrossBorderMw + borderCoupledChargeMw - practicalDischargeMw) *
        QUARTER_HOUR_H;
    }
  }

  const remainingCurtailmentEnergyMwh = Math.max(0, coverage.totalCurtailmentEnergyMwh - absorbedCurtailmentEnergyMwh);
  const peakReductionMw = Math.max(0, peakAbsNetMw - peakAbsAdjustedNetMw);
  const gridImpactReductionPct =
    baselineAbsMwh > 0
      ? Math.min(100, Math.max(0, (1 - adjustedAbsMwh / baselineAbsMwh) * 100))
      : null;
  const importReductionEnergyMwh = hasObservedCrossBorder
    ? Math.max(0, observedImportEnergyMwh - simulatedImportEnergyMwh)
    : null;

  const spreadEurPerMwh =
    marketReference !== null && marketReference.derivedSpotSpreadEurPerMwh > 0
      ? marketReference.derivedSpotSpreadEurPerMwh
      : null;
  const redispatchEurPerMwh =
    marketReference !== null && marketReference.positiveRedispatchCostEurPerMwh > 0
      ? marketReference.positiveRedispatchCostEurPerMwh
      : null;

  const curtailedRecoveredToLoadEnergyMwh = Math.min(
    absorbedCurtailmentEnergyMwh,
    coverage.servedDeficitEnergyMwh
  );
  const bessRevenueTodayEur =
    spreadEurPerMwh !== null
      ? Math.max(0, coverage.servedDeficitEnergyMwh - curtailedRecoveredToLoadEnergyMwh) * spreadEurPerMwh
      : null;
  const avoidedCurtailmentValueEur =
    spreadEurPerMwh !== null ? curtailedRecoveredToLoadEnergyMwh * spreadEurPerMwh : null;
  const avoidedRedispatchCostsEur =
    redispatchEurPerMwh !== null ? absorbedCurtailmentEnergyMwh * redispatchEurPerMwh : null;

  const opportunityValuePerMwh = computeOpportunityValuePerMwh(
    marketReference,
    coverage.totalChargeOpportunityEnergyMwh,
    coverage.totalCurtailmentEnergyMwh
  );
  const chargeOpportunityValueEur =
    opportunityValuePerMwh !== null
      ? coverage.absorbedSurplusEnergyMwh * opportunityValuePerMwh
      : null;
  const missedOpportunityEur =
    opportunityValuePerMwh !== null
      ? Math.max(0, coverage.totalChargeOpportunityEnergyMwh - coverage.absorbedSurplusEnergyMwh) *
        opportunityValuePerMwh
      : null;
  const totalValueCreatedEur =
    bessRevenueTodayEur !== null &&
    avoidedCurtailmentValueEur !== null &&
    avoidedRedispatchCostsEur !== null
      ? bessRevenueTodayEur + avoidedCurtailmentValueEur + avoidedRedispatchCostsEur
      : null;

  const gridReliefScore = computeGridReliefScore({
    curtailedAvoidedShare:
      coverage.totalCurtailmentEnergyMwh > 1e-9
        ? absorbedCurtailmentEnergyMwh / coverage.totalCurtailmentEnergyMwh
        : null,
    dampingPct: coverage.totalChargeOpportunityEnergyMwh > 0 ? gridImpactReductionPct : null,
    peakReductionShare: peakAbsNetMw > 0 ? peakReductionMw / peakAbsNetMw : null,
    importReductionShare:
      hasObservedCrossBorder && observedImportEnergyMwh > 1e-9 && importReductionEnergyMwh !== null
        ? importReductionEnergyMwh / observedImportEnergyMwh
        : null,
  });

  return {
    coverage,
    absorbedCurtailmentEnergyMwh,
    remainingCurtailmentEnergyMwh,
    peakReductionMw,
    gridImpactReductionPct,
    observedImportEnergyMwh: hasObservedCrossBorder ? observedImportEnergyMwh : null,
    simulatedImportEnergyMwh: hasObservedCrossBorder ? simulatedImportEnergyMwh : null,
    importReductionEnergyMwh,
    bessRevenueTodayEur,
    avoidedRedispatchCostsEur,
    avoidedCurtailmentValueEur,
    chargeOpportunityValueEur,
    totalValueCreatedEur,
    missedOpportunityEur,
    curtailedRecoveredToLoadEnergyMwh,
    gridReliefScore,
  };
}
