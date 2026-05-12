/**
 * Deterministic, dependency-free BESS dispatch simulator.
 *
 * Operates on real Energy-Charts quarter-hour slots for a single Berlin day
 * and produces a per-slot schedule plus aggregate KPIs.
 *
 * Strategy `arbitrage_evening_priority`:
 *  1. Synthesize a price proxy from residual load (cheap when residual is low,
 *     expensive when residual is high). The proxy is normalized to a typical
 *     DE day-ahead band so KPI numbers are interpretable as €/MWh estimates.
 *  2. Score each slot for discharge desirability with an evening (17–20 Berlin)
 *     bonus so the algorithm visibly prioritizes the evening flexibility gap.
 *  3. Pick the top-N highest-scoring slots as discharge candidates, then pick
 *     the lowest-priced N+ slots BEFORE the earliest discharge slot as charge
 *     candidates (preserves causality for a single-day cycle).
 *  4. Walk slots chronologically, tracking SoC. Apply round-trip efficiency as
 *     symmetric charge/discharge losses (sqrt(η) on each side).
 *
 * The simulation is intentionally a heuristic, not an LP solver, but every
 * output is grounded in real, dated 15-minute Energy-Charts data.
 */

const QUARTER_HOUR_HOURS = 0.25;
const EVENING_HOURS_BERLIN = new Set([17, 18, 19, 20]);

/** Synthetic price band so KPIs read as plausible €/MWh values. */
const PRICE_PROXY_FLOOR_EUR_PER_MWH = 30;
const PRICE_PROXY_CEILING_EUR_PER_MWH = 250;

/**
 * Evening discharge bias as a fraction of the observed price-proxy range.
 * 0.20 means evening slots get a +20% of-range bonus on the discharge score.
 */
const EVENING_DISCHARGE_BONUS_FRACTION = 0.2;

export type DispatchStrategy = "auto_policy_v1";

export type DispatchSimulationInput = {
  powerMw: number;
  capacityMwh: number;
  rteEfficiencyPct: number;
  strategy: DispatchStrategy;
};

export type DispatchSlotInput = {
  /** ISO-8601 timestamp at the start of the 15-min slot. */
  timestampIso: string;
  /** Berlin local hour (0..23) — caller is responsible for tz mapping. */
  hourBerlin: number;
  /** Real Energy-Charts residual load in MW for this slot. */
  residualLoadMw: number;
  /** Total load in MW for this slot. */
  loadMw?: number;
  /** Total domestic generation in MW for this slot. */
  totalGenerationMw?: number;
  /** Renewable generation in MW for this slot (`null` when absent in the feed — same as Energy-Charts Germany slots). */
  renewableGenerationMw?: number | null;
  /** Signed observed cross-border trading in MW: positive = imports, negative = exports. */
  crossBorderElectricityTradingMw?: number | null;
};

export type DispatchAction = "charge" | "discharge" | "idle";

export type DispatchScheduleEntry = {
  timestampIso: string;
  hourBerlin: number;
  residualLoadMw: number;
  loadMw: number | null;
  totalGenerationMw: number | null;
  renewableGenerationMw: number | null;
  crossBorderElectricityTradingMw: number | null;
  simulatedCrossBorderElectricityTradingMw: number | null;
  /** Synthesized DE day-ahead-style price proxy in €/MWh. */
  priceProxyEurPerMwh: number;
  action: DispatchAction;
  /** Signed grid-side power in MW: positive = discharge to grid, negative = charge from grid. */
  powerMw: number;
  /** State of charge in MWh at the END of this slot. */
  socMwh: number;
  socPct: number;
  /** Remaining room to charge at END of slot (MWh). */
  chargeHeadroomMwh: number;
  /** Remaining room to discharge at END of slot (MWh). */
  dischargeHeadroomMwh: number;
  /** Human-readable auto-policy reason for this slot decision. */
  decisionReason: string;
  /**
   * Best-case SoC (%) reachable by this slot if charging only from residual
   * surplus (residualLoadMw < 0), constrained by power, capacity, and RTE.
   */
  maxReachableSocPct: number;
};

export type DispatchResults = {
  /** MWh drawn from the grid across the day. */
  energyChargedFromGridMwh: number;
  /** MWh delivered to the grid across the day (post-RTE). */
  energyDischargedToGridMwh: number;
  /** Average price proxy weighted by charge MWh. */
  avgChargePriceEurPerMwh: number;
  /** Average price proxy weighted by discharge MWh. */
  avgDischargePriceEurPerMwh: number;
  /** Discharge revenue minus charge cost, in €. */
  grossRevenueEur: number;
  /** Equivalent full cycles based on energy delivered to the grid. */
  cycles: number;
  /** MWh delivered during 17–20 Berlin (inclusive). */
  eveningDeliveredMwh: number;
  /** Share of total delivered MWh that landed in the evening window. */
  eveningCoveragePct: number;
  /** Observed cross-border imports from Energy-Charts (positive trading only), integrated over the day. */
  observedImportEnergyMwh: number;
  /** Observed cross-border exports from Energy-Charts (negative trading only), integrated over the day. */
  observedExportEnergyMwh: number;
  /** Counterfactual imports after applying the modeled BESS dispatch one-for-one to observed border flow. */
  simulatedImportEnergyMwh: number;
  /** Counterfactual exports after applying the modeled BESS dispatch one-for-one to observed border flow. */
  simulatedExportEnergyMwh: number;
  /** Simulated minus observed imports; negative means the modeled BESS reduces imports. */
  importDeltaEnergyMwh: number;
  /** Simulated minus observed exports; negative means the modeled BESS reduces exports. */
  exportDeltaEnergyMwh: number;
  /** Discharge - charge price spread captured (€/MWh). */
  averageSpreadEurPerMwh: number;
  /** Round-trip energy loss as a percentage of grid input. */
  roundTripLossPct: number;
  /** Max reachable SoC at the start of the evening window (17:00 Berlin). */
  maxReachableSocByEveningPct: number;
  /** Maximum reachable SoC at any time in the observed day. */
  maxReachableSocPeakPct: number;
  /**
   * Surplus energy that was available in-slot but not stored due to BESS
   * charging constraints (power and/or remaining capacity), in MWh.
   */
  uncapturedSurplusMwh: number;
};

export type DispatchSimulationOutput = {
  inputs: DispatchSimulationInput;
  schedule: DispatchScheduleEntry[];
  results: DispatchResults;
  diagnostics: {
    samplePoints: number;
    chargeSlots: number;
    dischargeSlots: number;
    /** Available residual-load price-proxy band, useful for UI labelling. */
    priceProxyMinEurPerMwh: number;
    priceProxyMaxEurPerMwh: number;
  };
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[index] ?? 0;
};

const buildPriceProxyMapper = (residuals: number[]) => {
  const minR = Math.min(...residuals);
  const maxR = Math.max(...residuals);
  const range = maxR - minR;
  if (range <= 0) {
    const mid = (PRICE_PROXY_FLOOR_EUR_PER_MWH + PRICE_PROXY_CEILING_EUR_PER_MWH) / 2;
    return {
      mapper: () => mid,
      minPrice: mid,
      maxPrice: mid,
    };
  }
  const span = PRICE_PROXY_CEILING_EUR_PER_MWH - PRICE_PROXY_FLOOR_EUR_PER_MWH;
  const mapper = (residual: number) =>
    PRICE_PROXY_FLOOR_EUR_PER_MWH + ((residual - minR) / range) * span;
  return {
    mapper,
    minPrice: PRICE_PROXY_FLOOR_EUR_PER_MWH,
    maxPrice: PRICE_PROXY_CEILING_EUR_PER_MWH,
  };
};

export const simulateDispatch = (
  slots: DispatchSlotInput[],
  inputs: DispatchSimulationInput
): DispatchSimulationOutput => {
  if (slots.length === 0) {
    throw new Error("dispatch simulation requires at least one slot");
  }
  if (!isFiniteNumber(inputs.powerMw) || inputs.powerMw <= 0) {
    throw new Error("powerMw must be a positive number");
  }
  if (!isFiniteNumber(inputs.capacityMwh) || inputs.capacityMwh <= 0) {
    throw new Error("capacityMwh must be a positive number");
  }
  if (
    !isFiniteNumber(inputs.rteEfficiencyPct) ||
    inputs.rteEfficiencyPct <= 0 ||
    inputs.rteEfficiencyPct > 100
  ) {
    throw new Error("rteEfficiencyPct must be in (0, 100]");
  }

  const eta = inputs.rteEfficiencyPct / 100;
  const sqrtEta = Math.sqrt(eta);
  const dt = QUARTER_HOUR_HOURS;
  const energyPerSlotMwh = inputs.powerMw * dt;

  const sortedSlots = [...slots].sort((a, b) =>
    a.timestampIso.localeCompare(b.timestampIso)
  );
  const residuals = sortedSlots.map((s) => s.residualLoadMw);
  const { mapper: priceProxy, minPrice, maxPrice } = buildPriceProxyMapper(residuals);
  const priceRange = Math.max(0, maxPrice - minPrice);
  const eveningBonus = priceRange * EVENING_DISCHARGE_BONUS_FRACTION;
  const priceP35 = quantile(enrichedPrices(residuals, priceProxy), 0.35);
  const priceP75 = quantile(enrichedPrices(residuals, priceProxy), 0.75);
  const eveningResidualThreshold = quantile(residuals, 0.7);

  const enrichedSlots = sortedSlots.map((slot, index) => {
    const price = priceProxy(slot.residualLoadMw);
    const isEvening = EVENING_HOURS_BERLIN.has(slot.hourBerlin);
    return {
      ...slot,
      index,
      priceProxyEurPerMwh: price,
      dischargeScore: price + (isEvening ? eveningBonus : 0),
      isEvening,
    };
  });

  let socMwh = 0;
  let energyChargedFromGridMwh = 0;
  let energyDischargedToGridMwh = 0;
  let chargeCostEur = 0;
  let dischargeRevenueEur = 0;
  let dischargedFromBatteryMwh = 0;
  let eveningDeliveredMwh = 0;
  let uncapturedSurplusMwh = 0;
  let observedImportEnergyMwh = 0;
  let observedExportEnergyMwh = 0;
  let simulatedImportEnergyMwh = 0;
  let simulatedExportEnergyMwh = 0;
  let actualChargeSlots = 0;
  let actualDischargeSlots = 0;
  let envelopeSocMwh = 0;
  let maxReachableSocByEveningPct = 0;
  let maxReachableSocPeakPct = 0;

  const schedule: DispatchScheduleEntry[] = enrichedSlots.map((slot) => {
    let action: DispatchAction = "idle";
    let decisionReason = "hold_reserve";
    let signedPowerMw = 0;

    const hasTotalBalanceForAction =
      isFiniteNumber(slot.totalGenerationMw) && isFiniteNumber(slot.loadMw);
    const availableSurplusMw = hasTotalBalanceForAction
      ? Math.max(0, (slot.totalGenerationMw ?? 0) - (slot.loadMw ?? 0))
      : slot.residualLoadMw < 0
        ? Math.abs(slot.residualLoadMw)
        : 0;
    const futureSlotsBeforeEvening = enrichedSlots.filter(
      (s) => s.index >= slot.index && s.hourBerlin < 17
    );
    const futureSurplusBeforeEveningMwh = futureSlotsBeforeEvening.reduce((sum, s) => {
      const hasBalance = isFiniteNumber(s.totalGenerationMw) && isFiniteNumber(s.loadMw);
      const futureSurplusMw = hasBalance
        ? Math.max(0, (s.totalGenerationMw ?? 0) - (s.loadMw ?? 0))
        : s.residualLoadMw < 0
          ? Math.abs(s.residualLoadMw)
          : 0;
      return sum + Math.min(inputs.powerMw, futureSurplusMw) * dt * sqrtEta;
    }, 0);
    const eveningRiskHigh = slot.residualLoadMw >= eveningResidualThreshold || slot.isEvening;
    const targetSocForEveningMwh = inputs.capacityMwh * (eveningRiskHigh ? 0.65 : 0.4);
    const needsPrecharge = socMwh < targetSocForEveningMwh && futureSurplusBeforeEveningMwh < (targetSocForEveningMwh - socMwh);

    if (availableSurplusMw > 0 && socMwh < inputs.capacityMwh) {
      const availableSurplusMwh = availableSurplusMw * dt;
      const gridChargeCapMwh = Math.min(energyPerSlotMwh, availableSurplusMwh);
      const desiredStoredMwh = gridChargeCapMwh * sqrtEta;
      const headroomMwh = inputs.capacityMwh - socMwh;
      const actualStoredMwh = Math.min(desiredStoredMwh, headroomMwh);
      if (actualStoredMwh > 1e-6) {
        const actualGridDrawMwh = actualStoredMwh / sqrtEta;
        const actualPowerMw = actualGridDrawMwh / dt;
        signedPowerMw = -actualPowerMw;
        socMwh += actualStoredMwh;
        energyChargedFromGridMwh += actualGridDrawMwh;
        chargeCostEur += actualGridDrawMwh * slot.priceProxyEurPerMwh;
        action = "charge";
        decisionReason = "surplus_capture";
        actualChargeSlots += 1;
        uncapturedSurplusMwh += Math.max(0, availableSurplusMwh - actualGridDrawMwh);
      }
    } else if (availableSurplusMw > 0) {
      uncapturedSurplusMwh += availableSurplusMw * dt;
    } else if (
      !slot.isEvening &&
      needsPrecharge &&
      slot.priceProxyEurPerMwh <= priceP35 &&
      socMwh < inputs.capacityMwh
    ) {
      const desiredStoredMwh = energyPerSlotMwh * sqrtEta;
      const headroomMwh = inputs.capacityMwh - socMwh;
      const actualStoredMwh = Math.min(desiredStoredMwh, headroomMwh);
      if (actualStoredMwh > 1e-6) {
        const actualGridDrawMwh = actualStoredMwh / sqrtEta;
        const actualPowerMw = actualGridDrawMwh / dt;
        signedPowerMw = -actualPowerMw;
        socMwh += actualStoredMwh;
        energyChargedFromGridMwh += actualGridDrawMwh;
        chargeCostEur += actualGridDrawMwh * slot.priceProxyEurPerMwh;
        action = "charge";
        decisionReason = "precharge_evening_risk";
        actualChargeSlots += 1;
      }
    } else if (
      socMwh > 1e-6 &&
      (slot.isEvening || slot.priceProxyEurPerMwh + (slot.isEvening ? eveningBonus : 0) >= priceP75)
    ) {
      const desiredFromBatteryMwh = energyPerSlotMwh / sqrtEta;
      const actualFromBatteryMwh = Math.min(desiredFromBatteryMwh, socMwh);
      if (actualFromBatteryMwh > 1e-6) {
        const actualToGridMwh = actualFromBatteryMwh * sqrtEta;
        const actualPowerMw = actualToGridMwh / dt;
        signedPowerMw = actualPowerMw;
        socMwh -= actualFromBatteryMwh;
        dischargedFromBatteryMwh += actualFromBatteryMwh;
        energyDischargedToGridMwh += actualToGridMwh;
        dischargeRevenueEur += actualToGridMwh * slot.priceProxyEurPerMwh;
        if (slot.isEvening) {
          eveningDeliveredMwh += actualToGridMwh;
        }
        action = "discharge";
        decisionReason = slot.isEvening ? "evening_support" : "high_price_discharge";
        actualDischargeSlots += 1;
      }
    }

    // Envelope: prioritize real domestic surplus (generation - load). If not
    // available, fall back to residual<0 (renewable oversupply proxy).
    const hasTotalBalanceForEnvelope =
      isFiniteNumber(slot.totalGenerationMw) && isFiniteNumber(slot.loadMw);
    const availableSurplusMwForEnvelope = hasTotalBalanceForEnvelope
      ? Math.max(0, (slot.totalGenerationMw ?? 0) - (slot.loadMw ?? 0))
      : slot.residualLoadMw < 0
        ? Math.abs(slot.residualLoadMw)
        : 0;
    if (availableSurplusMwForEnvelope > 0 && envelopeSocMwh < inputs.capacityMwh) {
      const surplusMwh = availableSurplusMwForEnvelope * dt;
      const gridDrawableMwh = Math.min(energyPerSlotMwh, surplusMwh);
      const storedFromSurplusMwh = gridDrawableMwh * sqrtEta;
      const headroomMwh = inputs.capacityMwh - envelopeSocMwh;
      envelopeSocMwh += Math.min(storedFromSurplusMwh, headroomMwh);
    }
    const maxReachableSocPct = (envelopeSocMwh / inputs.capacityMwh) * 100;
    maxReachableSocPeakPct = Math.max(maxReachableSocPeakPct, maxReachableSocPct);
    if (slot.hourBerlin === 17) {
      maxReachableSocByEveningPct = Math.max(
        maxReachableSocByEveningPct,
        maxReachableSocPct
      );
    }

    const observedCrossBorderMw =
      isFiniteNumber(slot.crossBorderElectricityTradingMw)
        ? slot.crossBorderElectricityTradingMw
        : null;
    const simulatedCrossBorderMw =
      observedCrossBorderMw === null ? null : observedCrossBorderMw - signedPowerMw;
    if (observedCrossBorderMw !== null) {
      observedImportEnergyMwh += Math.max(0, observedCrossBorderMw) * dt;
      observedExportEnergyMwh += Math.max(0, -observedCrossBorderMw) * dt;
    }
    if (simulatedCrossBorderMw !== null) {
      simulatedImportEnergyMwh += Math.max(0, simulatedCrossBorderMw) * dt;
      simulatedExportEnergyMwh += Math.max(0, -simulatedCrossBorderMw) * dt;
    }

    return {
      timestampIso: slot.timestampIso,
      hourBerlin: slot.hourBerlin,
      residualLoadMw: slot.residualLoadMw,
      loadMw: isFiniteNumber(slot.loadMw) ? slot.loadMw : null,
      totalGenerationMw: isFiniteNumber(slot.totalGenerationMw)
        ? slot.totalGenerationMw
        : null,
      renewableGenerationMw: isFiniteNumber(slot.renewableGenerationMw)
        ? slot.renewableGenerationMw
        : null,
      crossBorderElectricityTradingMw: observedCrossBorderMw,
      simulatedCrossBorderElectricityTradingMw: simulatedCrossBorderMw,
      priceProxyEurPerMwh: slot.priceProxyEurPerMwh,
      action,
      powerMw: signedPowerMw,
      socMwh,
      socPct: (socMwh / inputs.capacityMwh) * 100,
      chargeHeadroomMwh: Math.max(0, inputs.capacityMwh - socMwh),
      dischargeHeadroomMwh: Math.max(0, socMwh),
      decisionReason,
      maxReachableSocPct,
    };
  });

  const avgChargePriceEurPerMwh =
    energyChargedFromGridMwh > 0 ? chargeCostEur / energyChargedFromGridMwh : 0;
  const avgDischargePriceEurPerMwh =
    energyDischargedToGridMwh > 0 ? dischargeRevenueEur / energyDischargedToGridMwh : 0;
  const grossRevenueEur = dischargeRevenueEur - chargeCostEur;
  const cycles = dischargedFromBatteryMwh / inputs.capacityMwh;
  const eveningCoveragePct =
    energyDischargedToGridMwh > 0
      ? (eveningDeliveredMwh / energyDischargedToGridMwh) * 100
      : 0;
  const roundTripLossPct =
    energyChargedFromGridMwh > 0
      ? ((energyChargedFromGridMwh - energyDischargedToGridMwh) / energyChargedFromGridMwh) *
        100
      : 0;
  if (maxReachableSocByEveningPct <= 0) {
    const eveningPoint = schedule.find((entry) => entry.hourBerlin >= 17);
    maxReachableSocByEveningPct = eveningPoint?.maxReachableSocPct ?? maxReachableSocPeakPct;
  }

  return {
    inputs,
    schedule,
    results: {
      energyChargedFromGridMwh,
      energyDischargedToGridMwh,
      avgChargePriceEurPerMwh,
      avgDischargePriceEurPerMwh,
      grossRevenueEur,
      cycles,
      eveningDeliveredMwh,
      eveningCoveragePct,
      observedImportEnergyMwh,
      observedExportEnergyMwh,
      simulatedImportEnergyMwh,
      simulatedExportEnergyMwh,
      importDeltaEnergyMwh: simulatedImportEnergyMwh - observedImportEnergyMwh,
      exportDeltaEnergyMwh: simulatedExportEnergyMwh - observedExportEnergyMwh,
      averageSpreadEurPerMwh: avgDischargePriceEurPerMwh - avgChargePriceEurPerMwh,
      roundTripLossPct,
      maxReachableSocByEveningPct,
      maxReachableSocPeakPct,
      uncapturedSurplusMwh,
    },
    diagnostics: {
      samplePoints: slots.length,
      chargeSlots: actualChargeSlots,
      dischargeSlots: actualDischargeSlots,
      priceProxyMinEurPerMwh: minPrice,
      priceProxyMaxEurPerMwh: maxPrice,
    },
  };
};

export const __INTERNAL__ = {
  PRICE_PROXY_FLOOR_EUR_PER_MWH,
  PRICE_PROXY_CEILING_EUR_PER_MWH,
  EVENING_DISCHARGE_BONUS_FRACTION,
  EVENING_HOURS_BERLIN,
};

function enrichedPrices(residuals: number[], mapper: (residual: number) => number): number[] {
  return residuals.map((value) => mapper(value));
}
