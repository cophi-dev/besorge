const QUARTER_HOUR_H = 0.25;

export type OptimalCapacitySlotInput = {
  timestampIso?: string;
  totalGenerationMw: number;
  loadMw: number;
  /**
   * Additional curtailed renewable power that could charge storage in this slot
   * without changing the published structural net (`generation - load`) trace.
   */
  curtailmentMw?: number | null;
};

export type PracticalDispatchSlot = {
  chargeMw: number;
  dischargeMw: number;
  socPct: number;
};

export type DailyBessSizingProfile = {
  dateBerlin: string;
  requiredEnergyMwh: number;
  requiredChargePowerMw: number;
  requiredDischargePowerMw: number;
  requiredPowerMw: number;
};

export type LogicalBessRecommendationTier = {
  label: "aggressive" | "balanced" | "conservative";
  percentile: number;
  recommendedEnergyMwh: number;
  recommendedPowerMw: number;
};

export type LogicalBessRecommendation = {
  observedDays: number;
  tiers: LogicalBessRecommendationTier[];
  continuousWindowRequiredEnergyMwh: number;
  dailyEnergyP95Mwh: number;
  dailyPowerP95Mw: number;
};

type PowerConstrainedSimulationOptions = {
  resetDailyByBerlin?: boolean;
  initialSocMwh?: number;
  maxPowerMw?: number | null;
};

export type CoverageAtCapacityOptions = {
  resetDailyByBerlin?: boolean;
  maxPowerMw?: number | null;
  /**
   * Packed level at the start of the first Berlin day in `slots`, before any dispatch in that walk.
   * When `resetDailyByBerlin` is true, each subsequent calendar day still starts from 0 (same as chart dispatch).
   */
  initialSocMwh?: number;
};

const resolvePowerCapMwhPerSlot = (maxPowerMw?: number | null): number =>
  maxPowerMw !== null && maxPowerMw !== undefined && Number.isFinite(maxPowerMw) && maxPowerMw > 0
    ? maxPowerMw * QUARTER_HOUR_H
    : Number.POSITIVE_INFINITY;

const structuralNetMwhForSlot = (slot: OptimalCapacitySlotInput): number =>
  (slot.totalGenerationMw - slot.loadMw) * QUARTER_HOUR_H;

const curtailedChargeOpportunityMwhForSlot = (slot: OptimalCapacitySlotInput): number => {
  const curtailedMw = slot.curtailmentMw;
  return curtailedMw !== null && curtailedMw !== undefined && Number.isFinite(curtailedMw) && curtailedMw > 0
    ? curtailedMw * QUARTER_HOUR_H
    : 0;
};

/** Charging power not covered by structural surplus or curtailed headroom — only this moves the border proxy. */
export function borderCoupledBatteryChargeMw(slot: OptimalCapacitySlotInput, chargeMw: number): number {
  if (!Number.isFinite(chargeMw) || chargeMw <= 0) {
    return 0;
  }
  const surplusMw =
    Number.isFinite(slot.totalGenerationMw) && Number.isFinite(slot.loadMw)
      ? Math.max(0, slot.totalGenerationMw - slot.loadMw)
      : 0;
  const curtailMw =
    slot.curtailmentMw !== null &&
    slot.curtailmentMw !== undefined &&
    Number.isFinite(slot.curtailmentMw) &&
    slot.curtailmentMw > 0
      ? slot.curtailmentMw
      : 0;
  const domesticSlackMw = surplusMw + curtailMw;
  return Math.max(0, chargeMw - domesticSlackMw);
}

/**
 * "Optimal" energy capacity for a perfect surplus-following BESS over the given slot series:
 * - Start empty (SoC = 0).
 * - Charge on structural surplus (gen − load > 0).
 * - Discharge on structural deficit (gen − load < 0), but SoC cannot go below 0.
 * - Perfect efficiency, unlimited power, no forecasting.
 *
 * Result is the maximum SoC reached (MWh), i.e. the smallest energy capacity that could
 * follow all deficits that are "funded" by earlier surpluses in this window.
 */
export function computeOptimalSurplusDeficitCapacityMwh(
  slots: OptimalCapacitySlotInput[]
): {
  optimalCapacityMwh: number;
  maxSocMwh: number;
  endSocMwh: number;
  /** Energy actually discharged into deficit slots given the no-negative-SOC constraint. */
  servedDeficitEnergyMwh: number;
} {
  let socMwh = 0;
  let maxSocMwh = 0;
  let servedDeficitEnergyMwh = 0;

  for (const s of slots) {
    const netMwh = structuralNetMwhForSlot(s);
    const curtailedMwh = curtailedChargeOpportunityMwhForSlot(s);
    if (netMwh < 0) {
      const dischargeMwh = Math.min(socMwh, -netMwh);
      servedDeficitEnergyMwh += dischargeMwh;
      socMwh = Math.max(0, socMwh - dischargeMwh);
    }
    socMwh += Math.max(0, netMwh) + curtailedMwh;
    if (socMwh > maxSocMwh) {
      maxSocMwh = socMwh;
    }
  }

  return {
    optimalCapacityMwh: maxSocMwh,
    maxSocMwh,
    endSocMwh: socMwh,
    servedDeficitEnergyMwh,
  };
}

const berlinDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
};

/**
 * Practical daily-cycle requirement:
 * - Same perfect surplus/deficit walk, but SoC resets to 0 at each Berlin midnight.
 * - Returns P95 of daily required energy as practical sizing anchor.
 */
export function computePracticalDailyCycleCapacityMwh(
  slots: OptimalCapacitySlotInput[]
): {
  practicalCapacityMwh: number;
  p95DailyRequiredMwh: number;
  maxDailyRequiredMwh: number;
  observedDays: number;
} {
  const perDay = new Map<string, OptimalCapacitySlotInput[]>();
  for (const s of slots) {
    const key = s.timestampIso
      ? berlinDateFormatter.format(new Date(s.timestampIso))
      : "unknown-day";
    const arr = perDay.get(key);
    if (arr) {
      arr.push(s);
    } else {
      perDay.set(key, [s]);
    }
  }
  const dailyRequired = [...perDay.values()].map(
    (daySlots) => computeOptimalSurplusDeficitCapacityMwh(daySlots).optimalCapacityMwh
  );
  const p95DailyRequiredMwh = percentile(dailyRequired, 0.95);
  const maxDailyRequiredMwh = dailyRequired.length > 0 ? Math.max(...dailyRequired) : 0;
  return {
    practicalCapacityMwh: p95DailyRequiredMwh,
    p95DailyRequiredMwh,
    maxDailyRequiredMwh,
    observedDays: dailyRequired.length,
  };
}

export function computeDailyBessSizingProfiles(
  slots: OptimalCapacitySlotInput[]
): DailyBessSizingProfile[] {
  const perDay = new Map<string, OptimalCapacitySlotInput[]>();
  for (const s of slots) {
    const key = s.timestampIso
      ? berlinDateFormatter.format(new Date(s.timestampIso))
      : "unknown-day";
    const arr = perDay.get(key);
    if (arr) {
      arr.push(s);
    } else {
      perDay.set(key, [s]);
    }
  }

  const profiles: DailyBessSizingProfile[] = [];
  for (const [dateBerlin, daySlots] of perDay.entries()) {
    const requiredEnergyMwh = computeOptimalSurplusDeficitCapacityMwh(daySlots).optimalCapacityMwh;
    let requiredChargePowerMw = 0;
    let requiredDischargePowerMw = 0;
    for (const s of daySlots) {
      const netMw = s.totalGenerationMw - s.loadMw;
      const availableChargeMw =
        Math.max(0, netMw) +
        (s.curtailmentMw !== null &&
        s.curtailmentMw !== undefined &&
        Number.isFinite(s.curtailmentMw) &&
        s.curtailmentMw > 0
          ? s.curtailmentMw
          : 0);
      if (availableChargeMw > requiredChargePowerMw) {
        requiredChargePowerMw = availableChargeMw;
      }
      if (netMw < 0) {
        const deficitMw = -netMw;
        if (deficitMw > requiredDischargePowerMw) {
          requiredDischargePowerMw = deficitMw;
        }
      }
    }
    profiles.push({
      dateBerlin,
      requiredEnergyMwh,
      requiredChargePowerMw,
      requiredDischargePowerMw,
      requiredPowerMw: Math.max(requiredChargePowerMw, requiredDischargePowerMw),
    });
  }
  return profiles;
}

export function computeLogicalBessRecommendation(
  slots: OptimalCapacitySlotInput[]
): LogicalBessRecommendation {
  const profiles = computeDailyBessSizingProfiles(slots);
  const dailyEnergy = profiles.map((entry) => entry.requiredEnergyMwh);
  const dailyPower = profiles.map((entry) => entry.requiredPowerMw);
  const percentileValue = (
    label: LogicalBessRecommendationTier["label"] | "p95"
  ): number => {
    switch (label) {
      case "aggressive":
        return 0.8;
      case "balanced":
        return 0.9;
      case "conservative":
        return 0.95;
      case "p95":
        return 0.95;
      default:
        return 0.9;
    }
  };
  const tiers: LogicalBessRecommendationTier[] = (
    ["aggressive", "balanced", "conservative"] as const
  ).map((label) => {
    const p = percentileValue(label);
    return {
      label,
      percentile: p,
      recommendedEnergyMwh: percentile(dailyEnergy, p),
      recommendedPowerMw: percentile(dailyPower, p),
    };
  });

  return {
    observedDays: profiles.length,
    tiers,
    continuousWindowRequiredEnergyMwh: computeOptimalSurplusDeficitCapacityMwh(slots).optimalCapacityMwh,
    dailyEnergyP95Mwh: percentile(dailyEnergy, percentileValue("p95")),
    dailyPowerP95Mw: percentile(dailyPower, percentileValue("p95")),
  };
}

export function computeCoverageAtCapacityMwh(
  slots: OptimalCapacitySlotInput[],
  capacityMwh: number,
  options?: CoverageAtCapacityOptions
): {
  totalSurplusEnergyMwh: number;
  totalCurtailmentEnergyMwh: number;
  totalChargeOpportunityEnergyMwh: number;
  absorbedSurplusEnergyMwh: number;
  totalDeficitEnergyMwh: number;
  servedDeficitEnergyMwh: number;
  absorbedSurplusShare: number;
  servedDeficitShare: number;
} {
  const cap = Math.max(0, capacityMwh);
  const powerCapMwhPerSlot = resolvePowerCapMwhPerSlot(options?.maxPowerMw);
  let socMwh = Math.min(cap, Math.max(0, options?.initialSocMwh ?? 0));
  let activeDay: string | null = null;
  let totalSurplusEnergyMwh = 0;
  let totalCurtailmentEnergyMwh = 0;
  let totalChargeOpportunityEnergyMwh = 0;
  let absorbedSurplusEnergyMwh = 0;
  let totalDeficitEnergyMwh = 0;
  let servedDeficitEnergyMwh = 0;

  for (const s of slots) {
    if (options?.resetDailyByBerlin && s.timestampIso) {
      const day = berlinDateFormatter.format(new Date(s.timestampIso));
      if (activeDay === null) {
        activeDay = day;
      } else if (day !== activeDay) {
        socMwh = 0;
        activeDay = day;
      }
    }
    const netMwh = structuralNetMwhForSlot(s);
    const curtailedMwh = curtailedChargeOpportunityMwhForSlot(s);
    const structuralSurplusMwh = Math.max(0, netMwh);
    const totalChargeOpportunityMwh = structuralSurplusMwh + curtailedMwh;
    totalSurplusEnergyMwh += structuralSurplusMwh;
    totalCurtailmentEnergyMwh += curtailedMwh;
    totalChargeOpportunityEnergyMwh += totalChargeOpportunityMwh;
    if (netMwh < 0) {
      const deficit = -netMwh;
      totalDeficitEnergyMwh += deficit;
      const discharge = Math.min(socMwh, deficit, powerCapMwhPerSlot);
      socMwh -= discharge;
      servedDeficitEnergyMwh += discharge;
    }
    if (totalChargeOpportunityMwh > 0) {
      const charge = Math.min(cap - socMwh, totalChargeOpportunityMwh, powerCapMwhPerSlot);
      socMwh += Math.max(0, charge);
      absorbedSurplusEnergyMwh += Math.max(0, charge);
    }
  }

  return {
    totalSurplusEnergyMwh,
    totalCurtailmentEnergyMwh,
    totalChargeOpportunityEnergyMwh,
    absorbedSurplusEnergyMwh,
    totalDeficitEnergyMwh,
    servedDeficitEnergyMwh,
    absorbedSurplusShare:
      totalChargeOpportunityEnergyMwh > 0
        ? absorbedSurplusEnergyMwh / totalChargeOpportunityEnergyMwh
        : 0,
    servedDeficitShare:
      totalDeficitEnergyMwh > 0 ? servedDeficitEnergyMwh / totalDeficitEnergyMwh : 0,
  };
}

export function simulateSocPctAtCapacityMwh(
  slots: OptimalCapacitySlotInput[],
  capacityMwh: number,
  options?: PowerConstrainedSimulationOptions
): number[] {
  const cap = Math.max(0, capacityMwh);
  const powerCapMwhPerSlot = resolvePowerCapMwhPerSlot(options?.maxPowerMw);
  if (cap <= 0) {
    return slots.map(() => 0);
  }
  let socMwh = Math.min(cap, Math.max(0, options?.initialSocMwh ?? 0));
  let activeDay: string | null = null;
  const series: number[] = [];
  for (const s of slots) {
    if (options?.resetDailyByBerlin && s.timestampIso) {
      const day = berlinDateFormatter.format(new Date(s.timestampIso));
      if (activeDay === null) {
        activeDay = day;
      } else if (day !== activeDay) {
        socMwh = 0;
        activeDay = day;
      }
    }
    const netMwh = structuralNetMwhForSlot(s);
    const curtailedMwh = curtailedChargeOpportunityMwhForSlot(s);
    if (netMwh < 0) {
      const dischargeMwh = Math.min(-netMwh, powerCapMwhPerSlot);
      socMwh = Math.max(0, socMwh - dischargeMwh);
    }
    if (Math.max(0, netMwh) + curtailedMwh > 0) {
      const chargeMwh = Math.min(Math.max(0, netMwh) + curtailedMwh, powerCapMwhPerSlot);
      socMwh = Math.min(cap, socMwh + chargeMwh);
    }
    series.push((socMwh / cap) * 100);
  }
  return series;
}

export function simulateAdjustedNetMwAtCapacity(
  slots: OptimalCapacitySlotInput[],
  capacityMwh: number,
  options?: PowerConstrainedSimulationOptions
): number[] {
  const cap = Math.max(0, capacityMwh);
  const powerCapMwhPerSlot = resolvePowerCapMwhPerSlot(options?.maxPowerMw);
  let socMwh = Math.min(cap, Math.max(0, options?.initialSocMwh ?? 0));
  let activeDay: string | null = null;
  const adjusted: number[] = [];

  for (const s of slots) {
    if (options?.resetDailyByBerlin && s.timestampIso) {
      const day = berlinDateFormatter.format(new Date(s.timestampIso));
      if (activeDay === null) {
        activeDay = day;
      } else if (day !== activeDay) {
        socMwh = 0;
        activeDay = day;
      }
    }

    const netMwh = structuralNetMwhForSlot(s);
    const curtailedMwh = curtailedChargeOpportunityMwhForSlot(s);
    if (netMwh < 0) {
      const deficit = -netMwh;
      const discharge = Math.min(socMwh, deficit, powerCapMwhPerSlot);
      socMwh -= discharge;
      adjusted.push((-deficit + discharge) / QUARTER_HOUR_H);
      if (curtailedMwh > 0) {
        const curtailedCharge = Math.min(Math.max(0, cap - socMwh), curtailedMwh, powerCapMwhPerSlot);
        socMwh += curtailedCharge;
      }
    } else {
      const structuralCharge = Math.min(Math.max(0, cap - socMwh), netMwh, powerCapMwhPerSlot);
      socMwh += structuralCharge;
      const remainingHeadroom = Math.max(0, cap - socMwh);
      const remainingPower = Math.max(0, powerCapMwhPerSlot - structuralCharge);
      if (curtailedMwh > 0 && remainingHeadroom > 0 && remainingPower > 0) {
        socMwh += Math.min(remainingHeadroom, curtailedMwh, remainingPower);
      }
      adjusted.push((netMwh - structuralCharge) / QUARTER_HOUR_H);
    }
  }
  return adjusted;
}

export function simulatePracticalDispatchAtCapacity(
  slots: OptimalCapacitySlotInput[],
  capacityMwh: number,
  options?: PowerConstrainedSimulationOptions
): PracticalDispatchSlot[] {
  const cap = Math.max(0, capacityMwh);
  const powerCapMwhPerSlot = resolvePowerCapMwhPerSlot(options?.maxPowerMw);
  let socMwh = Math.min(cap, Math.max(0, options?.initialSocMwh ?? 0));
  let activeDay: string | null = null;
  const series: PracticalDispatchSlot[] = [];

  for (const s of slots) {
    if (options?.resetDailyByBerlin && s.timestampIso) {
      const day = berlinDateFormatter.format(new Date(s.timestampIso));
      if (activeDay === null) {
        activeDay = day;
      } else if (day !== activeDay) {
        socMwh = 0;
        activeDay = day;
      }
    }

    const netMwh = structuralNetMwhForSlot(s);
    const curtailedMwh = curtailedChargeOpportunityMwhForSlot(s);
    let chargeMwh = 0;
    let dischargeMwh = 0;

    if (netMwh < 0) {
      const deficitMwh = -netMwh;
      dischargeMwh = Math.min(socMwh, deficitMwh, powerCapMwhPerSlot);
      socMwh -= dischargeMwh;
    }
    const totalChargeOpportunityMwh = Math.max(0, netMwh) + curtailedMwh;
    if (totalChargeOpportunityMwh > 0) {
      chargeMwh = Math.min(Math.max(0, cap - socMwh), totalChargeOpportunityMwh, powerCapMwhPerSlot);
      socMwh += chargeMwh;
    }

    series.push({
      chargeMw: chargeMwh / QUARTER_HOUR_H,
      dischargeMw: dischargeMwh / QUARTER_HOUR_H,
      socPct: cap > 0 ? (socMwh / cap) * 100 : 0,
    });
  }

  return series;
}

/**
 * End-of-series practical SoC (MWh) if `dayBeforePreviousSlots` runs from empty at 00:00,
 * then `previousDaySlots` continues from that end state — same stitching as the Germany chart (day mode).
 */
export function computeStitchedPracticalInitialSocMwh(params: {
  dayBeforePreviousSlots: OptimalCapacitySlotInput[];
  previousDaySlots: OptimalCapacitySlotInput[];
  capacityMwh: number;
  maxPowerMw: number | null | undefined;
}): number {
  const { dayBeforePreviousSlots, previousDaySlots, capacityMwh, maxPowerMw } = params;
  const cap = Math.max(0, capacityMwh);
  if (cap <= 0) {
    return 0;
  }
  const pwr = maxPowerMw ?? null;
  let startYesterdayMwh = 0;
  if (dayBeforePreviousSlots.length > 0) {
    const stitch = simulatePracticalDispatchAtCapacity(dayBeforePreviousSlots, cap, {
      resetDailyByBerlin: true,
      initialSocMwh: 0,
      maxPowerMw: pwr,
    });
    const lastStitch = stitch[stitch.length - 1];
    if (lastStitch !== undefined) {
      startYesterdayMwh =
        (Math.min(100, Math.max(0, lastStitch.socPct)) / 100) * cap;
    }
  }
  if (previousDaySlots.length === 0) {
    return 0;
  }
  const prevSeries = simulatePracticalDispatchAtCapacity(previousDaySlots, cap, {
    resetDailyByBerlin: true,
    initialSocMwh: startYesterdayMwh,
    maxPowerMw: pwr,
  });
  const prevEndSocPct = prevSeries[prevSeries.length - 1]?.socPct ?? 0;
  return (Math.min(100, Math.max(0, prevEndSocPct)) / 100) * cap;
}

