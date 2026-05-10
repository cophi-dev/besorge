import { addBerlinCalendarDays, formatBerlinDateKeyFromUtcDate } from "@/lib/berlinCalendar";
import {
  getGermanyEnergyFlowForBerlinRange,
  getGermanyMarketSnapshot,
  type GermanyDispatchSlot,
  type GermanyDispatchSlotsResponse,
} from "@/lib/energyChartsApi";
import {
  resolveGermanyEnergyFlowBerlinRangeForDate,
  resolveGermanyEnergyFlowBerlinRangeForMonth,
  resolveGermanyEnergyFlowBerlinRangeForWeek,
  type GermanyEnergyFlowBerlinRange,
} from "@/lib/germanyEnergyFlowPeriod";
import {
  computeCoverageAtCapacityMwh,
  computeLogicalBessRecommendation,
  computePracticalDailyCycleCapacityMwh,
  computeStitchedPracticalInitialSocMwh,
  simulateAdjustedNetMwAtCapacity,
} from "@/lib/optimalBessCapacity";

const QUARTER_HOUR_H = 0.25;

/** Berlin hours inclusive: 10–16 structural net energy (core daylight band). */
export const BRIEF_DAY_CORE_HOUR_START = 10;
export const BRIEF_DAY_CORE_HOUR_END = 16;

/** Berlin hours inclusive: 17–21 (evening ramp band). */
export const BRIEF_EVENING_RAMP_HOUR_START = 17;
export const BRIEF_EVENING_RAMP_HOUR_END = 21;

export type BriefingDayShapeWindowsGwh = {
  dayCoreGwh: number;
  eveningRampGwh: number;
  overnightBaseGwh: number;
};

export type BriefingDayShape = {
  structuralNetGwhByWindow: BriefingDayShapeWindowsGwh;
  /**
   * Secondary KPI: Σ(renewable generation − load) × ¼h over slots where
   * `renewableGenerationMw` is available; scaled to GWh. Null when no slot
   * includes renewable MW.
   */
  renewableNetStructuralBalanceGwh: number | null;
  /** Fraction of sampled slots where renewable MW was present. */
  renewableSlotFractionOfSampled: number;
  peakSurplusHourBerlin: number | null;
  peakDeficitHourBerlin: number | null;
};

export type MorningBriefingContext = {
  dateBerlin: string;
  retrievedAtIso: string;
  /** 0–1 Energy-Charts slot coverage for that Berlin day. */
  pointFractionOfDay: number;
  samplePoints: number;
  /** Sum of (gen − load) over slots, GWh. */
  netStructuralBalanceGwh: number;
  /** Intra-day structure from the same quarter-hour samples (Berlin-hour bands). */
  dayShape: BriefingDayShape;
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
  /** True when slots span more than one Berlin calendar day (week/month chart). */
  isMultiDayWindow: boolean;
  rangeStartBerlin: string;
  rangeEndBerlin: string;
};

function structuralNetWindowForHour(hourBerlin: number): keyof BriefingDayShapeWindowsGwh {
  if (hourBerlin >= BRIEF_DAY_CORE_HOUR_START && hourBerlin <= BRIEF_DAY_CORE_HOUR_END) {
    return "dayCoreGwh";
  }
  if (hourBerlin >= BRIEF_EVENING_RAMP_HOUR_START && hourBerlin <= BRIEF_EVENING_RAMP_HOUR_END) {
    return "eveningRampGwh";
  }
  return "overnightBaseGwh";
}

/**
 * Deterministic day-shape summaries for briefing / LLM (same slots as aggregate net balance).
 */
export function computeBriefingDayShape(slots: GermanyDispatchSlot[]): BriefingDayShape {
  const structuralNetGwhByWindow: BriefingDayShapeWindowsGwh = {
    dayCoreGwh: 0,
    eveningRampGwh: 0,
    overnightBaseGwh: 0,
  };
  let renewableMwhAccum = 0;
  let slotsWithRenewable = 0;
  const hourlyStructuralGwh = new Map<number, number>();

  for (const s of slots) {
    const structMwh = (s.totalGenerationMw - s.loadMw) * QUARTER_HOUR_H;
    structuralNetGwhByWindow[structuralNetWindowForHour(s.hourBerlin)] += structMwh / 1000;

    if (s.renewableGenerationMw !== null && Number.isFinite(s.renewableGenerationMw)) {
      renewableMwhAccum += (s.renewableGenerationMw - s.loadMw) * QUARTER_HOUR_H;
      slotsWithRenewable += 1;
    }

    const h = s.hourBerlin;
    hourlyStructuralGwh.set(h, (hourlyStructuralGwh.get(h) ?? 0) + structMwh / 1000);
  }

  const n = slots.length;
  const renewableSlotFractionOfSampled = n > 0 ? slotsWithRenewable / n : 0;
  const renewableNetStructuralBalanceGwh =
    slotsWithRenewable > 0 ? renewableMwhAccum / 1000 : null;

  let maxGwh = -Infinity;
  let maxHour: number | null = null;
  let minGwh = Infinity;
  let minHour: number | null = null;

  for (const [hour, gwh] of hourlyStructuralGwh) {
    if (gwh > maxGwh) {
      maxGwh = gwh;
      maxHour = hour;
    }
    if (gwh < minGwh) {
      minGwh = gwh;
      minHour = hour;
    }
  }

  let peakSurplusHourBerlin: number | null = null;
  let peakDeficitHourBerlin: number | null = null;
  if (maxHour !== null && maxGwh > 0) {
    peakSurplusHourBerlin = maxHour;
  }
  if (minHour !== null && minGwh < 0) {
    peakDeficitHourBerlin = minHour;
  }

  return {
    structuralNetGwhByWindow,
    renewableNetStructuralBalanceGwh,
    renewableSlotFractionOfSampled,
    peakSurplusHourBerlin,
    peakDeficitHourBerlin,
  };
}

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
  maxPowerMw: number | null,
  initialSocMwh: number
): number | null {
  if (slots.length === 0 || capacityMwh <= 0) {
    return null;
  }
  const adjusted = simulateAdjustedNetMwAtCapacity(slots, capacityMwh, {
    resetDailyByBerlin: true,
    initialSocMwh,
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
 * Build briefing context for an arbitrary Berlin calendar range (single day
 * or stitched week/month window). Prior two calendar days before `range.startKey`
 * seed stitched practical SoC the same way as single-day mode.
 */
export async function buildMorningBriefingContextForBerlinRange(
  range: GermanyEnergyFlowBerlinRange,
  now: Date = new Date()
): Promise<MorningBriefingContext | null> {
  const startKey = range.startKey;
  const prevKey = addBerlinCalendarDays(startKey, -1);
  const beforePrevKey = addBerlinCalendarDays(startKey, -2);

  const [flow, prevFlow, beforePrevFlow, market] = await Promise.all([
    getGermanyEnergyFlowForBerlinRange(range, now),
    getGermanyEnergyFlowForBerlinRange(resolveGermanyEnergyFlowBerlinRangeForDate(prevKey, now), now),
    getGermanyEnergyFlowForBerlinRange(resolveGermanyEnergyFlowBerlinRangeForDate(beforePrevKey, now), now),
    getGermanyMarketSnapshot(),
  ]);

  if (flow === null || flow.slots.length === 0) {
    return null;
  }

  const rangeStart = flow.rangeStartBerlin ?? range.startKey;
  const rangeEnd = flow.rangeEndBerlin ?? range.endKey;
  const isMultiDayWindow = rangeStart !== rangeEnd;

  const netStructuralBalanceGwh = sumStructuralNetGwh(flow.slots);
  const dayShape = computeBriefingDayShape(flow.slots);
  const practical = computePracticalDailyCycleCapacityMwh(flow.slots);
  const rec = computeLogicalBessRecommendation(flow.slots);
  const balanced = rec.tiers.find((t) => t.label === "balanced");
  const capMwh = practical?.practicalCapacityMwh ?? 0;
  const pw = balanced?.recommendedPowerMw ?? null;
  const maxPower = pw !== null && pw > 0 && Number.isFinite(pw) ? pw : null;
  const initialSocMwh =
    capMwh > 0
      ? Math.min(
          capMwh,
          Math.max(
            0,
            computeStitchedPracticalInitialSocMwh({
              dayBeforePreviousSlots: beforePrevFlow?.slots ?? [],
              previousDaySlots: prevFlow?.slots ?? [],
              capacityMwh: capMwh,
              maxPowerMw: maxPower,
            })
          )
        )
      : 0;

  const coverage =
    capMwh > 0
      ? computeCoverageAtCapacityMwh(flow.slots, capMwh, {
          resetDailyByBerlin: true,
          maxPowerMw: maxPower,
          initialSocMwh,
        })
      : null;

  const gridPct = gridImpactReductionPct(flow.slots, capMwh, maxPower, initialSocMwh);

  const rawNote = [
    `window=${flow.dateBerlin}`,
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
    dayShape,
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
    isMultiDayWindow,
    rangeStartBerlin: rangeStart,
    rangeEndBerlin: rangeEnd,
  };
}

/**
 * Build a compact, LLM-ready snapshot for `dateKey` (Berlin calendar),
 * including observed series + modeled optimal-BESS simulation for that day.
 */
export async function buildMorningBriefingContext(dateBerlin: string): Promise<MorningBriefingContext | null> {
  const now = new Date();
  return buildMorningBriefingContextForBerlinRange(
    resolveGermanyEnergyFlowBerlinRangeForDate(dateBerlin, now),
    now
  );
}

export function yesterdayBerlinDateKey(now: Date = new Date()): string {
  const today = formatBerlinDateKeyFromUtcDate(now);
  return addBerlinCalendarDays(today, -1);
}

