/**
 * BESS dispatch heuristic tied to real 15-minute Energy-Charts–style series
 * (Daily Energy Balance / total power snapshot).
 *
 * Strategy `arbitrage_gap`: price-shaped arbitrage from residual load, explicit
 * evening-window (17:00–21:00 Berlin) bias, oversupply charging, and a
 * volatility term for discharge scoring.
 */

const QUARTER_HOUR_H = 0.25;
const SOC_MIN_FRAC = 0.1;
const SOC_MAX_FRAC = 0.9;
const PRICE_FLOOR_EUR_MWH = 30;
const PRICE_CEILING_EUR_MWH = 250;
const EVENING_DISCHARGE_BONUS_FRAC = 0.18;
const VOLATILITY_SCORE_WEIGHT = 0.12;
const RESIDUAL_OVERSUPPLY_MW = -500;
const MUST_RUN_BASELOAD_FACTOR = 0.7;
const RENEWABLE_HIGH_FLOOR_PCT = 55;

/** Berlin evening flexibility window: 17:00 <= t < 21:00 (hours 17–20). */
const isEveningBerlin = (hour: number): boolean => hour >= 17 && hour < 21;

const isFinitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const percentileSorted = (sorted: number[], p: number): number => {
  if (sorted.length === 0) {
    return RENEWABLE_HIGH_FLOOR_PCT;
  }
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx] ?? RENEWABLE_HIGH_FLOOR_PCT;
};

const buildPriceProxy = (residuals: number[]) => {
  const minR = Math.min(...residuals);
  const maxR = Math.max(...residuals);
  const range = maxR - minR;
  if (range <= 0) {
    const mid = (PRICE_FLOOR_EUR_MWH + PRICE_CEILING_EUR_MWH) / 2;
    return {
      map: (): number => mid,
      minPrice: mid,
      maxPrice: mid,
      range: 0,
    };
  }
  const span = PRICE_CEILING_EUR_MWH - PRICE_FLOOR_EUR_MWH;
  return {
    map: (r: number) => PRICE_FLOOR_EUR_MWH + ((r - minR) / range) * span,
    minPrice: PRICE_FLOOR_EUR_MWH,
    maxPrice: PRICE_CEILING_EUR_MWH,
    range: span,
  };
};

const rollingStd = (values: number[], index: number, window: number): number => {
  const start = Math.max(0, index - window + 1);
  const slice = values.slice(start, index + 1);
  if (slice.length < 2) {
    return 0;
  }
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / (slice.length - 1);
  return Math.sqrt(variance);
};

export type BessDispatchStrategy = "arbitrage_gap";

export type BessDispatchDayInput = {
  dateBerlin: string;
  timestampsIso: string[];
  hourBerlin: number[];
  /** Demand (load) in MW — "Load (incl. self-consumption)". */
  loadMw: Array<number | null>;
  /** Domestic total generation in MW (renewable + conventional, excluding meta series). */
  totalGenerationMw: Array<number | null>;
  /** Residual load in MW (Energy-Charts definition: load − renewables, high = tight system). */
  residualLoadMw: Array<number | null>;
  /** Renewable share of load in % — series or derived. */
  renewableShareOfLoadPct: Array<number | null>;
  /**
   * Evening flexibility gap in MW (e.g. page.tsx: avg residual 17–21 × MUST_RUN_BASELOAD_FACTOR).
   * If omitted, it is estimated from the mean residual in 17–21 on this day.
   */
  eveningFlexibilityGapMw?: number | null;
  /** Snapshot renewable share % — nudges the renewable “high” threshold upward when provided. */
  renewableShareCurrentPct?: number | null;
};

export type SimulateBessDispatchParams = {
  powerMW: number;
  energyMWh: number;
  /** Round-trip efficiency η in (0, 1], e.g. 0.92. */
  efficiency: number;
  strategy: BessDispatchStrategy;
  day: BessDispatchDayInput;
};

export type BessDispatchQuarter = {
  index: number;
  timestampIso: string;
  hourBerlin: number;
  loadMw: number | null;
  totalGenerationMw: number | null;
  netPositionMw: number | null;
  residualLoadMw: number;
  renewableShareOfLoadPct: number | null;
  priceProxyEurPerMwh: number;
  /** Signed AC power — positive = discharge to grid, negative = charge from grid. */
  powerMw: number;
  socMwh: number;
  socPct: number;
};

export type DispatchResult = {
  params: Pick<SimulateBessDispatchParams, "powerMW" | "energyMWh" | "efficiency" | "strategy">;
  meta: {
    dateBerlin: string;
    quarterHours: number;
    pointFractionOfDay: number;
    priceProxyMinEurPerMwh: number;
    priceProxyMaxEurPerMwh: number;
  };
  /** End-of-slot state of charge (nameplate MWh), length = quarterHours. */
  socMwh: number[];
  /** End-of-slot SoC in % of nameplate (0–100). */
  socPct: number[];
  /** Per quarter-hour dispatch (+=discharge), length = quarterHours. */
  powerDispatchMw: number[];
  quarters: BessDispatchQuarter[];
  economics: {
    grossRevenueEur: number;
    arbitrageRevenueComponentEur: number;
    eveningGapRevenueComponentEur: number;
    energyChargedFromGridMwh: number;
    energyDischargedToGridMwh: number;
    avgChargePriceEurPerMwh: number;
    avgDischargePriceEurPerMwh: number;
    averageSpreadEurPerMwh: number;
  };
  evening: {
    /** Reference gap used for coverage KPI (MW). */
    flexibilityGapMw: number;
    /** Average discharge power during 17–21 over the full 4 h window (MW). */
    averageDischargeMwInWindow: number;
    /** min(averageDischargeMW, flexibilityGapMw) — reported “covered” MW. */
    gapCoveredMw: number;
    netPositionEveningAvgMw: number;
  };
  /** Full cycles ≈ dischargedFromBattery / nameplate. */
  fullCyclesToday: number;
  operational: {
    socMinFrac: number;
    socMaxFrac: number;
    cRateCap: number;
  };
};

export const simulateBessDispatch = (params: SimulateBessDispatchParams): DispatchResult => {
  if (params.strategy !== "arbitrage_gap") {
    throw new Error(`Unsupported strategy: ${String(params.strategy)}`);
  }
  if (!isFinitePositive(params.powerMW)) {
    throw new Error("powerMW must be a finite positive number");
  }
  if (!isFinitePositive(params.energyMWh)) {
    throw new Error("energyMWh must be a finite positive number");
  }
  if (!isFiniteNumber(params.efficiency) || params.efficiency <= 0 || params.efficiency > 1) {
    throw new Error("efficiency must be in (0, 1]");
  }

  const { day } = params;
  const n = day.timestampsIso.length;
  if (
    n === 0 ||
    day.hourBerlin.length !== n ||
    day.loadMw.length !== n ||
    day.totalGenerationMw.length !== n ||
    day.residualLoadMw.length !== n ||
    day.renewableShareOfLoadPct.length !== n
  ) {
    throw new Error("day series must be non-empty and all arrays aligned");
  }
  if (n < 4) {
    throw new Error("need at least four quarter-hours to simulate");
  }

  const capacityMwh = params.energyMWh;
  const minSocMwh = SOC_MIN_FRAC * capacityMwh;
  const maxSocMwh = SOC_MAX_FRAC * capacityMwh;
  const startSocMwh = 0.5 * capacityMwh;

  const eta = params.efficiency;
  const sqrtEta = Math.sqrt(eta);
  const dt = QUARTER_HOUR_H;
  const gridSlotMwh = params.powerMW * dt;

  type Row = {
    index: number;
    timestampIso: string;
    hourBerlin: number;
    loadMw: number | null;
    totalGenerationMw: number | null;
    residualLoadMw: number;
    renewableShareOfLoadPct: number | null;
    netPositionMw: number | null;
    priceProxyEurPerMwh: number;
    dischargeScore: number;
    chargeOk: boolean;
    isEvening: boolean;
  };

  const usableResiduals: number[] = [];
  const renewValues: number[] = [];
  const eveningResiduals: number[] = [];

  const rows: Row[] = [];

  for (let i = 0; i < n; i += 1) {
    const res = day.residualLoadMw[i];
    if (res === null || !Number.isFinite(res)) {
      continue;
    }
    usableResiduals.push(res);
    const ren = day.renewableShareOfLoadPct[i];
    if (ren !== null && Number.isFinite(ren)) {
      renewValues.push(ren);
    }
    const hour = day.hourBerlin[i] ?? 0;
    if (isEveningBerlin(hour)) {
      eveningResiduals.push(res);
    }
    const load = day.loadMw[i];
    const gen = day.totalGenerationMw[i];
    let net: number | null = null;
    if (
      load !== null &&
      Number.isFinite(load) &&
      gen !== null &&
      Number.isFinite(gen)
    ) {
      net = gen - load;
    }
    rows.push({
      index: rows.length,
      timestampIso: day.timestampsIso[i] ?? "",
      hourBerlin: day.hourBerlin[i] ?? 0,
      loadMw: load !== null && Number.isFinite(load) ? load : null,
      totalGenerationMw: gen !== null && Number.isFinite(gen) ? gen : null,
      residualLoadMw: res,
      renewableShareOfLoadPct: ren !== null && Number.isFinite(ren) ? ren : null,
      netPositionMw: net,
      priceProxyEurPerMwh: 0,
      dischargeScore: 0,
      chargeOk: false,
      isEvening: isEveningBerlin(hour),
    });
  }

  if (rows.length < 4) {
    throw new Error("not enough slots with valid residual load");
  }

  const residualsAligned = rows.map((r) => r.residualLoadMw);
  const { map: priceMap, minPrice, maxPrice, range: priceRange } = buildPriceProxy(residualsAligned);

  const renewSorted = [...renewValues].sort((a, b) => a - b);
  let renewHigh = percentileSorted(renewSorted, 0.7);
  renewHigh = Math.max(RENEWABLE_HIGH_FLOOR_PCT, renewHigh);
  if (
    day.renewableShareCurrentPct !== null &&
    day.renewableShareCurrentPct !== undefined &&
    Number.isFinite(day.renewableShareCurrentPct)
  ) {
    renewHigh = Math.max(renewHigh, day.renewableShareCurrentPct - 2);
  }

  const stdWindow = 4;
  const rollingStds = residualsAligned.map((_, idx) =>
    rollingStd(residualsAligned, idx, stdWindow)
  );
  const maxStd = Math.max(...rollingStds, 1);

  let netEveningSum = 0;
  let netEveningCount = 0;
  for (const row of rows) {
    if (row.isEvening && row.netPositionMw !== null) {
      netEveningSum += row.netPositionMw;
      netEveningCount += 1;
    }
  }
  const netEveningAvgMw =
    netEveningCount > 0 ? netEveningSum / netEveningCount : residualsAligned.reduce((s, v) => s + v, 0) / residualsAligned.length;

  const eveningBonus = priceRange * EVENING_DISCHARGE_BONUS_FRAC;

  for (const row of rows) {
    const price = priceMap(row.residualLoadMw);
    const volNorm = rollingStds[row.index] / maxStd;
    const score =
      price +
      (row.isEvening ? eveningBonus : 0) +
      VOLATILITY_SCORE_WEIGHT * volNorm * priceRange;
    const ren = row.renewableShareOfLoadPct;
    const chargeOk =
      row.residualLoadMw < RESIDUAL_OVERSUPPLY_MW ||
      (ren !== null && ren >= renewHigh);
    rows[row.index] = {
      ...row,
      priceProxyEurPerMwh: price,
      dischargeScore: score,
      chargeOk,
    };
  }

  const dischargeBatteryTarget = Math.max(0, startSocMwh - minSocMwh);
  const chargeStoredTarget = Math.max(0, maxSocMwh - startSocMwh);

  const batteryPerDischargeSlot = gridSlotMwh / sqrtEta;
  const storedPerChargeSlot = gridSlotMwh * sqrtEta;

  const nDischarge = Math.min(
    rows.length,
    Math.ceil(dischargeBatteryTarget / batteryPerDischargeSlot)
  );
  const nCharge = Math.min(
    rows.length,
    Math.ceil(chargeStoredTarget / storedPerChargeSlot)
  );

  const dischargeRanked = [...rows].sort((a, b) => b.dischargeScore - a.dischargeScore);
  const dischargeSet = new Set(dischargeRanked.slice(0, nDischarge).map((r) => r.index));

  const earliestDischarge =
    dischargeSet.size === 0 ? rows.length : Math.min(...Array.from(dischargeSet));

  const chargeCandidates = rows
    .filter((slot) => slot.chargeOk && !dischargeSet.has(slot.index) && slot.index < earliestDischarge)
    .sort((a, b) => a.priceProxyEurPerMwh - b.priceProxyEurPerMwh);

  const chargeSet = new Set(chargeCandidates.slice(0, nCharge).map((c) => c.index));

  let socMwh = startSocMwh;
  let energyChargedFromGridMwh = 0;
  let energyDischargedToGridMwh = 0;
  let chargeCostEur = 0;
  let dischargeRevenueEur = 0;
  let eveningDischargeRevenueEur = 0;
  let dischargedFromBatteryMwh = 0;
  let eveningDischargedToGridMwh = 0;

  const socSeriesMwh: number[] = [];
  const socSeriesPct: number[] = [];
  const powerSeries: number[] = [];
  const quarters: BessDispatchQuarter[] = [];

  for (const row of rows) {
    let signedPowerMw = 0;

    if (chargeSet.has(row.index) && socMwh < maxSocMwh - 1e-9) {
      const headroom = maxSocMwh - socMwh;
      const storedThisSlot = Math.min(storedPerChargeSlot, headroom);
      if (storedThisSlot > 1e-6) {
        const gridDraw = storedThisSlot / sqrtEta;
        signedPowerMw = -gridDraw / dt;
        socMwh += storedThisSlot;
        energyChargedFromGridMwh += gridDraw;
        chargeCostEur += gridDraw * row.priceProxyEurPerMwh;
      }
    } else if (dischargeSet.has(row.index) && socMwh > minSocMwh + 1e-9) {
      const headroom = socMwh - minSocMwh;
      const fromBattery = Math.min(batteryPerDischargeSlot, headroom);
      if (fromBattery > 1e-6) {
        const toGrid = fromBattery * sqrtEta;
        signedPowerMw = toGrid / dt;
        socMwh -= fromBattery;
        dischargedFromBatteryMwh += fromBattery;
        energyDischargedToGridMwh += toGrid;
        dischargeRevenueEur += toGrid * row.priceProxyEurPerMwh;
        if (row.isEvening) {
          eveningDischargeRevenueEur += toGrid * row.priceProxyEurPerMwh;
          eveningDischargedToGridMwh += toGrid;
        }
      }
    }

    const socPct = (socMwh / capacityMwh) * 100;
    socSeriesMwh.push(socMwh);
    socSeriesPct.push(socPct);
    powerSeries.push(signedPowerMw);
    quarters.push({
      index: row.index,
      timestampIso: row.timestampIso,
      hourBerlin: row.hourBerlin,
      loadMw: row.loadMw,
      totalGenerationMw: row.totalGenerationMw,
      netPositionMw: row.netPositionMw,
      residualLoadMw: row.residualLoadMw,
      renewableShareOfLoadPct: row.renewableShareOfLoadPct,
      priceProxyEurPerMwh: row.priceProxyEurPerMwh,
      powerMw: signedPowerMw,
      socMwh,
      socPct,
    });
  }

  const grossRevenueEur = dischargeRevenueEur - chargeCostEur;
  const eveningChargeShare =
    energyDischargedToGridMwh > 0
      ? eveningDischargedToGridMwh / energyDischargedToGridMwh
      : 0;
  const eveningCostAllocationEur = chargeCostEur * eveningChargeShare;
  const eveningGapRevenueComponentEur = eveningDischargeRevenueEur - eveningCostAllocationEur;
  const arbitrageRevenueComponentEur = grossRevenueEur - eveningGapRevenueComponentEur;

  const avgChargePriceEurPerMwh =
    energyChargedFromGridMwh > 0 ? chargeCostEur / energyChargedFromGridMwh : 0;
  const avgDischargePriceEurPerMwh =
    energyDischargedToGridMwh > 0 ? dischargeRevenueEur / energyDischargedToGridMwh : 0;

  const eveningMeanResidual =
    eveningResiduals.length > 0
      ? eveningResiduals.reduce((s, v) => s + v, 0) / eveningResiduals.length
      : residualsAligned.reduce((s, v) => s + v, 0) / residualsAligned.length;

  const flexibilityGapMw =
    day.eveningFlexibilityGapMw !== null &&
    day.eveningFlexibilityGapMw !== undefined &&
    Number.isFinite(day.eveningFlexibilityGapMw)
      ? day.eveningFlexibilityGapMw
      : eveningMeanResidual * MUST_RUN_BASELOAD_FACTOR;

  const eveningHours = 4;
  const averageDischargeMwInWindow = eveningDischargedToGridMwh / eveningHours;
  const gapCoveredMw = Math.min(
    averageDischargeMwInWindow,
    Math.max(0, flexibilityGapMw)
  );

  return {
    params: {
      powerMW: params.powerMW,
      energyMWh: params.energyMWh,
      efficiency: params.efficiency,
      strategy: params.strategy,
    },
    meta: {
      dateBerlin: day.dateBerlin,
      quarterHours: rows.length,
      pointFractionOfDay: Math.min(1, rows.length / 96),
      priceProxyMinEurPerMwh: minPrice,
      priceProxyMaxEurPerMwh: maxPrice,
    },
    socMwh: socSeriesMwh,
    socPct: socSeriesPct,
    powerDispatchMw: powerSeries,
    quarters,
    economics: {
      grossRevenueEur,
      arbitrageRevenueComponentEur,
      eveningGapRevenueComponentEur,
      energyChargedFromGridMwh,
      energyDischargedToGridMwh,
      avgChargePriceEurPerMwh,
      avgDischargePriceEurPerMwh,
      averageSpreadEurPerMwh: avgDischargePriceEurPerMwh - avgChargePriceEurPerMwh,
    },
    evening: {
      flexibilityGapMw,
      averageDischargeMwInWindow,
      gapCoveredMw,
      netPositionEveningAvgMw: netEveningAvgMw,
    },
    fullCyclesToday: dischargedFromBatteryMwh / capacityMwh,
    operational: {
      socMinFrac: SOC_MIN_FRAC,
      socMaxFrac: SOC_MAX_FRAC,
      cRateCap: 1,
    },
  };
};
