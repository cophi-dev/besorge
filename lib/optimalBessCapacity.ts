const QUARTER_HOUR_H = 0.25;

export type OptimalCapacitySlotInput = {
  timestampIso?: string;
  totalGenerationMw: number;
  loadMw: number;
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

const resolvePowerCapMwhPerSlot = (maxPowerMw?: number | null): number =>
  maxPowerMw !== null && maxPowerMw !== undefined && Number.isFinite(maxPowerMw) && maxPowerMw > 0
    ? maxPowerMw * QUARTER_HOUR_H
    : Number.POSITIVE_INFINITY;

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
    const netMw = s.totalGenerationMw - s.loadMw;
    const netMwh = netMw * QUARTER_HOUR_H;
    if (netMwh >= 0) {
      socMwh += netMwh;
    } else {
      const dischargeMwh = Math.min(socMwh, -netMwh);
      servedDeficitEnergyMwh += dischargeMwh;
      socMwh = Math.max(0, socMwh + netMwh);
    }
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
      if (netMw > 0 && netMw > requiredChargePowerMw) {
        requiredChargePowerMw = netMw;
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
  options?: { resetDailyByBerlin?: boolean; maxPowerMw?: number | null }
): {
  totalSurplusEnergyMwh: number;
  absorbedSurplusEnergyMwh: number;
  totalDeficitEnergyMwh: number;
  servedDeficitEnergyMwh: number;
  absorbedSurplusShare: number;
  servedDeficitShare: number;
} {
  const cap = Math.max(0, capacityMwh);
  const powerCapMwhPerSlot = resolvePowerCapMwhPerSlot(options?.maxPowerMw);
  let socMwh = 0;
  let activeDay: string | null = null;
  let totalSurplusEnergyMwh = 0;
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
    const netMwh = (s.totalGenerationMw - s.loadMw) * QUARTER_HOUR_H;
    if (netMwh >= 0) {
      totalSurplusEnergyMwh += netMwh;
      const charge = Math.min(cap - socMwh, netMwh, powerCapMwhPerSlot);
      socMwh += Math.max(0, charge);
      absorbedSurplusEnergyMwh += Math.max(0, charge);
    } else {
      const deficit = -netMwh;
      totalDeficitEnergyMwh += deficit;
      const discharge = Math.min(socMwh, deficit, powerCapMwhPerSlot);
      socMwh -= discharge;
      servedDeficitEnergyMwh += discharge;
    }
  }

  return {
    totalSurplusEnergyMwh,
    absorbedSurplusEnergyMwh,
    totalDeficitEnergyMwh,
    servedDeficitEnergyMwh,
    absorbedSurplusShare:
      totalSurplusEnergyMwh > 0 ? absorbedSurplusEnergyMwh / totalSurplusEnergyMwh : 0,
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
    const netMwh = (s.totalGenerationMw - s.loadMw) * QUARTER_HOUR_H;
    if (netMwh >= 0) {
      const chargeMwh = Math.min(netMwh, powerCapMwhPerSlot);
      socMwh = Math.min(cap, socMwh + chargeMwh);
    } else {
      const dischargeMwh = Math.min(-netMwh, powerCapMwhPerSlot);
      socMwh = Math.max(0, socMwh - dischargeMwh);
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

    const netMwh = (s.totalGenerationMw - s.loadMw) * QUARTER_HOUR_H;
    if (netMwh >= 0) {
      const charge = Math.min(Math.max(0, cap - socMwh), netMwh, powerCapMwhPerSlot);
      socMwh += charge;
      adjusted.push((netMwh - charge) / QUARTER_HOUR_H);
    } else {
      const deficit = -netMwh;
      const discharge = Math.min(socMwh, deficit, powerCapMwhPerSlot);
      socMwh -= discharge;
      adjusted.push((-deficit + discharge) / QUARTER_HOUR_H);
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

    const netMwh = (s.totalGenerationMw - s.loadMw) * QUARTER_HOUR_H;
    let chargeMwh = 0;
    let dischargeMwh = 0;

    if (netMwh >= 0) {
      chargeMwh = Math.min(Math.max(0, cap - socMwh), netMwh, powerCapMwhPerSlot);
      socMwh += chargeMwh;
    } else {
      const deficitMwh = -netMwh;
      dischargeMwh = Math.min(socMwh, deficitMwh, powerCapMwhPerSlot);
      socMwh -= dischargeMwh;
    }

    series.push({
      chargeMw: chargeMwh / QUARTER_HOUR_H,
      dischargeMw: dischargeMwh / QUARTER_HOUR_H,
      socPct: cap > 0 ? (socMwh / cap) * 100 : 0,
    });
  }

  return series;
}

