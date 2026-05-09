const QUARTER_HOUR_H = 0.25;

export type NetSurplusSlotInput = {
  totalGenerationMw: number;
  loadMw: number;
};

export type NetSurplusFleetAbsorptionResult = {
  /** Σ max(0, gen − load) × ¼ h (MWh) over the slot series. */
  grossSurplusEnergyMwh: number;
  /** Energy that could enter an empty fleet under power + energy caps (MWh). */
  absorbedEnergyMwh: number;
  /** Gross minus absorbed — surplus energy that hits power or SOC ceiling (MWh). */
  missedSurplusEnergyMwh: number;
  endSocMwh: number;
  /** inferred SoC (% of nameplate fleet energy) after each quarter-hour (same length as `slots`). */
  inferredFleetSocPctSeries: number[];
};

/**
 * Walk quarter-hour slots in order: each slot offers `max(0, gen − load) × ¼ h` MWh of charging energy.
 * Absorption is limited per slot by fleet AC power (GW → MW × ¼ h) and remaining empty energy capacity (GWh → MWh).
 */
export function computeNetSurplusFleetAbsorption(
  slots: NetSurplusSlotInput[],
  fleetEnergyCapacityMwh: number | null,
  fleetPowerMw: number | null,
  options?: { initialSocMwh?: number }
): NetSurplusFleetAbsorptionResult {
  const powerCapMwhPerSlot =
    fleetPowerMw !== null && Number.isFinite(fleetPowerMw) && fleetPowerMw > 0
      ? fleetPowerMw * QUARTER_HOUR_H
      : Number.POSITIVE_INFINITY;

  const energyCapMwh =
    fleetEnergyCapacityMwh !== null &&
    Number.isFinite(fleetEnergyCapacityMwh) &&
    fleetEnergyCapacityMwh > 0
      ? fleetEnergyCapacityMwh
      : null;

  let socMwh =
    energyCapMwh !== null
      ? Math.min(energyCapMwh, Math.max(0, options?.initialSocMwh ?? 0))
      : 0;
  let grossSurplusEnergyMwh = 0;
  let absorbedEnergyMwh = 0;
  const inferredFleetSocPctSeries: number[] = [];

  for (const s of slots) {
    const netMw = s.totalGenerationMw - s.loadMw;
    const slotSurplusMwh = Math.max(0, netMw) * QUARTER_HOUR_H;
    grossSurplusEnergyMwh += slotSurplusMwh;

    let chargeMwh = 0;
    if (slotSurplusMwh > 0 && energyCapMwh !== null) {
      const headroomMwh = energyCapMwh - socMwh;
      chargeMwh = Math.min(slotSurplusMwh, powerCapMwhPerSlot, Math.max(0, headroomMwh));
      socMwh += chargeMwh;
    }
    absorbedEnergyMwh += chargeMwh;

    const pct =
      energyCapMwh !== null && energyCapMwh > 0 ? (socMwh / energyCapMwh) * 100 : 0;
    inferredFleetSocPctSeries.push(pct);
  }

  return {
    grossSurplusEnergyMwh,
    absorbedEnergyMwh,
    missedSurplusEnergyMwh: grossSurplusEnergyMwh - absorbedEnergyMwh,
    endSocMwh: socMwh,
    inferredFleetSocPctSeries,
  };
}
