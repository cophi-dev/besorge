import { addBerlinCalendarDays, formatBerlinDateKeyFromUtcDate } from "@/lib/berlinCalendar";
import {
  getGermanyEnergyFlowForBerlinRange,
  getGermanyMarketSnapshot,
  type GermanyDispatchSlotsResponse,
} from "@/lib/energyChartsApi";
import { resolveGermanyEnergyFlowBerlinRangeForDate } from "@/lib/germanyEnergyFlowPeriod";
import {
  computeCoverageAtCapacityMwh,
  computeLogicalBessRecommendation,
  computePracticalDailyCycleCapacityMwh,
  simulateAdjustedNetMwAtCapacity,
} from "@/lib/optimalBessCapacity";

const QUARTER_HOUR_H = 0.25;

export type MorningBriefingContext = {
  dateBerlin: string;
  retrievedAtIso: string;
  /** 0–1 Energy-Charts slot coverage for that Berlin day. */
  pointFractionOfDay: number;
  samplePoints: number;
  /** Sum of (gen − load) over slots, GWh. */
  netStructuralBalanceGwh: number;
  /** Installed fleet from market snapshot. */
  fleet: { powerGw: number; capacityGwh: number };
  simulated: {
    practicalCapacityGwh: number;
    balancedPowerMw: number;
    gridImpactReductionPct: number | null;
    absorbedSurplusShare: number | null;
    servedDeficitShare: number | null;
  };
  rawNote: string;
};

function sumStructuralNetGwh(slots: GermanyDispatchSlotsResponse["slots"]): number {
  let mwh = 0;
  for (const s of slots) {
    mwh += (s.totalGenerationMw - s.loadMw) * QUARTER_HOUR_H;
  }
  return mwh / 1000;
}

function gridImpactReductionPct(
  slots: GermanyDispatchSlotsResponse["slots"],
  capacityMwh: number,
  maxPowerMw: number | null
): number | null {
  if (slots.length === 0 || capacityMwh <= 0) {
    return null;
  }
  const adjusted = simulateAdjustedNetMwAtCapacity(slots, capacityMwh, {
    resetDailyByBerlin: true,
    initialSocMwh: 0,
    maxPowerMw,
  });
  let baselineAbs = 0;
  let adjustedAbs = 0;
  for (let i = 0; i < slots.length; i += 1) {
    const net = slots[i].totalGenerationMw - slots[i].loadMw;
    baselineAbs += Math.abs(net * QUARTER_HOUR_H);
    adjustedAbs += Math.abs((adjusted[i] ?? net) * QUARTER_HOUR_H);
  }
  if (baselineAbs <= 0) {
    return null;
  }
  const reduction = Math.max(0, 1 - adjustedAbs / baselineAbs);
  return Math.min(100, Math.max(0, reduction * 100));
}

/**
 * Build a compact, LLM-ready snapshot for `dateKey` (Berlin calendar),
 * including observed series + modeled optimal-BESS simulation for that day.
 */
export async function buildMorningBriefingContext(dateBerlin: string): Promise<MorningBriefingContext | null> {
  const now = new Date();
  const range = resolveGermanyEnergyFlowBerlinRangeForDate(dateBerlin, now);
  const [flow, market] = await Promise.all([
    getGermanyEnergyFlowForBerlinRange(range, now),
    getGermanyMarketSnapshot(),
  ]);

  if (flow === null || flow.slots.length === 0) {
    return null;
  }

  const netStructuralBalanceGwh = sumStructuralNetGwh(flow.slots);
  const practical = computePracticalDailyCycleCapacityMwh(flow.slots);
  const rec = computeLogicalBessRecommendation(flow.slots);
  const balanced = rec.tiers.find((t) => t.label === "balanced");
  const capMwh = practical?.practicalCapacityMwh ?? 0;
  const pw = balanced?.recommendedPowerMw ?? null;
  const coverage =
    capMwh > 0
      ? computeCoverageAtCapacityMwh(flow.slots, capMwh, {
          resetDailyByBerlin: true,
          maxPowerMw: pw && pw > 0 ? pw : null,
        })
      : null;

  const gridPct = gridImpactReductionPct(flow.slots, capMwh, pw && pw > 0 ? pw : null);

  const rawNote = [
    `date=${flow.dateBerlin}`,
    `coverage=${(flow.pointFractionOfDay * 100).toFixed(1)}%`,
    `net=${netStructuralBalanceGwh.toFixed(2)} GWh`,
    `p95_practical≈${(capMwh / 1000).toFixed(2)} GWh`,
    gridPct !== null ? `grid_impact~${gridPct.toFixed(0)}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    dateBerlin: flow.dateBerlin,
    retrievedAtIso: market.retrievedAtIso,
    pointFractionOfDay: flow.pointFractionOfDay,
    samplePoints: flow.samplePoints,
    netStructuralBalanceGwh,
    fleet: {
      powerGw: market.bess.installedPowerGw,
      capacityGwh: market.bess.installedCapacityGwh,
    },
    simulated: {
      practicalCapacityGwh: capMwh / 1000,
      balancedPowerMw: pw ?? 0,
      gridImpactReductionPct: gridPct,
      absorbedSurplusShare: coverage?.absorbedSurplusShare ?? null,
      servedDeficitShare: coverage?.servedDeficitShare ?? null,
    },
    rawNote,
  };
}

export function yesterdayBerlinDateKey(now: Date = new Date()): string {
  const today = formatBerlinDateKeyFromUtcDate(now);
  return addBerlinCalendarDays(today, -1);
}

