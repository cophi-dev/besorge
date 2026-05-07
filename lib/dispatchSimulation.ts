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

export type DispatchStrategy = "arbitrage_evening_priority";

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
};

export type DispatchAction = "charge" | "discharge" | "idle";

export type DispatchScheduleEntry = {
  timestampIso: string;
  hourBerlin: number;
  residualLoadMw: number;
  /** Synthesized DE day-ahead-style price proxy in €/MWh. */
  priceProxyEurPerMwh: number;
  action: DispatchAction;
  /** Signed grid-side power in MW: positive = discharge to grid, negative = charge from grid. */
  powerMw: number;
  /** State of charge in MWh at the END of this slot. */
  socMwh: number;
  socPct: number;
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
  /** Discharge - charge price spread captured (€/MWh). */
  averageSpreadEurPerMwh: number;
  /** Round-trip energy loss as a percentage of grid input. */
  roundTripLossPct: number;
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

  const desiredDischargeSlots = Math.ceil(inputs.capacityMwh / energyPerSlotMwh);
  const cappedDischargeSlots = Math.min(desiredDischargeSlots, enrichedSlots.length);

  const dischargeRanked = [...enrichedSlots].sort(
    (a, b) => b.dischargeScore - a.dischargeScore
  );
  const dischargeSet = new Set<number>(
    dischargeRanked.slice(0, cappedDischargeSlots).map((s) => s.index)
  );

  const earliestDischargeIndex =
    dischargeSet.size === 0
      ? enrichedSlots.length
      : Math.min(...Array.from(dischargeSet));

  // Charge from grid is larger than what is stored, so we may want a few extra slots
  // to fully fill the battery once charge-side losses are applied.
  const desiredChargeSlots = Math.ceil(
    inputs.capacityMwh / sqrtEta / energyPerSlotMwh
  );

  const chargeCandidates = enrichedSlots
    .filter(
      (slot) => slot.index < earliestDischargeIndex && !dischargeSet.has(slot.index)
    )
    .sort((a, b) => a.priceProxyEurPerMwh - b.priceProxyEurPerMwh);
  const cappedChargeSlots = Math.min(desiredChargeSlots, chargeCandidates.length);
  const chargeSet = new Set<number>(
    chargeCandidates.slice(0, cappedChargeSlots).map((s) => s.index)
  );

  let socMwh = 0;
  let energyChargedFromGridMwh = 0;
  let energyDischargedToGridMwh = 0;
  let chargeCostEur = 0;
  let dischargeRevenueEur = 0;
  let dischargedFromBatteryMwh = 0;
  let eveningDeliveredMwh = 0;
  let actualChargeSlots = 0;
  let actualDischargeSlots = 0;

  const schedule: DispatchScheduleEntry[] = enrichedSlots.map((slot) => {
    let action: DispatchAction = "idle";
    let signedPowerMw = 0;

    if (chargeSet.has(slot.index) && socMwh < inputs.capacityMwh) {
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
        actualChargeSlots += 1;
      }
    } else if (dischargeSet.has(slot.index) && socMwh > 1e-6) {
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
        actualDischargeSlots += 1;
      }
    }

    return {
      timestampIso: slot.timestampIso,
      hourBerlin: slot.hourBerlin,
      residualLoadMw: slot.residualLoadMw,
      priceProxyEurPerMwh: slot.priceProxyEurPerMwh,
      action,
      powerMw: signedPowerMw,
      socMwh,
      socPct: (socMwh / inputs.capacityMwh) * 100,
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
      averageSpreadEurPerMwh: avgDischargePriceEurPerMwh - avgChargePriceEurPerMwh,
      roundTripLossPct,
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
