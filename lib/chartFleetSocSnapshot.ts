/** Last point of the fleet SoC line shown on the Energy-Charts daily profile (for header alignment). */
export type ChartFleetSocSnapshot = {
  socPct: number;
  mode: "fleet" | "practical";
  lastSlotTimestampIso: string;
  /** BESS activity implied by the same series as the chart (last quarter-hour step). */
  fleetMode: "charging" | "discharging" | "idle";
};

export type ChartRowTailForFleetMode = {
  estimatedFleetSocPct: number;
  simulatedPracticalSocPct: number;
  netBalanceMw: number;
  practicalChargeMw: number;
  practicalDischargeMw: number;
};

/**
 * Infer charge / discharge / idle from the **same data** the profile chart uses for its
 * last quarter-hour (fleet-capacity SoC step, or practical sim SoC / dispatch MW).
 */
export function inferFleetModeFromChartTail(params: {
  showSimulatedNet: boolean;
  last: ChartRowTailForFleetMode;
  previous: ChartRowTailForFleetMode | null;
}): "charging" | "discharging" | "idle" {
  const { showSimulatedNet, last, previous } = params;

  if (showSimulatedNet) {
    if (previous !== null) {
      const dSoc = last.simulatedPracticalSocPct - previous.simulatedPracticalSocPct;
      if (dSoc >= 0.35) {
        return "charging";
      }
      if (dSoc <= -0.35) {
        return "discharging";
      }
    }
    const ch = last.practicalChargeMw;
    const dis = last.practicalDischargeMw;
    if (ch >= 25 && ch > dis * 1.05) {
      return "charging";
    }
    if (dis >= 25 && dis > ch * 1.05) {
      return "discharging";
    }
    return "idle";
  }

  if (previous !== null) {
    const dSoc = last.estimatedFleetSocPct - previous.estimatedFleetSocPct;
    if (dSoc >= 0.35) {
      return "charging";
    }
    if (dSoc <= -0.35) {
      return "discharging";
    }
  }
  const net = last.netBalanceMw;
  if (net > 1_200) {
    return "charging";
  }
  if (net < -1_200) {
    return "discharging";
  }
  return "idle";
}
