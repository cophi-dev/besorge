import { simulatePracticalDispatchAtCapacity } from "@/lib/optimalBessCapacity";

const QUARTER_HOUR_H = 0.25;

export type NetSurplusSlotInput = {
  totalGenerationMw: number;
  loadMw: number;
  timestampIso?: string;
  curtailmentMw?: number | null;
};

export type NetSurplusFleetAbsorptionResult = {
  /** Σ max(0, gen − load) × ¼ h (MWh) over the slot series. */
  grossSurplusEnergyMwh: number;
  /** Σ curtailed renewable energy that could charge storage, MWh. */
  curtailedEnergyMwh: number;
  /** Structural surplus plus curtailed energy, MWh. */
  grossChargeOpportunityEnergyMwh: number;
  /** Energy that could enter an empty fleet under power + energy caps (MWh). */
  absorbedEnergyMwh: number;
  /** Charge opportunity not absorbed because the fleet hits power and/or SOC ceilings. */
  missedSurplusEnergyMwh: number;
  endSocMwh: number;
  /** inferred SoC (% of nameplate fleet energy) after each quarter-hour (same length as `slots`). */
  inferredFleetSocPctSeries: number[];
};

/**
 * Same greedy rules as chart “practical” dispatch over the fleet nameplate caps: charge on surplus
 * slots up to SOC and power caps, discharge on deficit slots — so SOC can recover before later surplus.
 *
 * Gross surplus sums only positive surplus MWh per slot; `absorbedEnergyMwh` sums actual charge energy
 * (MWh) from the dispatch walk (better KPI than {@link computeNetSurplusFleetAbsorption}, which is charge-only).
 */
export function computeCyclingFleetSurplusAbsorption(
  slots: NetSurplusSlotInput[],
  fleetEnergyCapacityMwh: number,
  fleetPowerMw: number,
  options?: { initialSocMwh?: number; resetDailyByBerlin?: boolean }
): NetSurplusFleetAbsorptionResult {
  const cap = fleetEnergyCapacityMwh;
  const dispatchSeries = simulatePracticalDispatchAtCapacity(slots, cap, {
    initialSocMwh: options?.initialSocMwh ?? 0,
    resetDailyByBerlin: options?.resetDailyByBerlin ?? false,
    maxPowerMw: fleetPowerMw,
  });

  let grossSurplusEnergyMwh = 0;
  let curtailedEnergyMwh = 0;
  let absorbedEnergyMwh = 0;

  for (let i = 0; i < slots.length; i++) {
    const netMw = slots[i].totalGenerationMw - slots[i].loadMw;
    grossSurplusEnergyMwh += Math.max(0, netMw) * QUARTER_HOUR_H;
    curtailedEnergyMwh += Math.max(0, slots[i].curtailmentMw ?? 0) * QUARTER_HOUR_H;
    absorbedEnergyMwh += (dispatchSeries[i]?.chargeMw ?? 0) * QUARTER_HOUR_H;
  }

  const last = dispatchSeries[dispatchSeries.length - 1];
  const endSocMwh =
    cap > 0 && last !== undefined ? (Math.min(100, Math.max(0, last.socPct)) / 100) * cap : 0;

  const inferredFleetSocPctSeries = dispatchSeries.map((d) =>
    Number.isFinite(d.socPct) ? Math.min(100, Math.max(0, d.socPct)) : 0
  );

  return {
    grossSurplusEnergyMwh,
    curtailedEnergyMwh,
    grossChargeOpportunityEnergyMwh: grossSurplusEnergyMwh + curtailedEnergyMwh,
    absorbedEnergyMwh,
    missedSurplusEnergyMwh: Math.max(0, grossSurplusEnergyMwh + curtailedEnergyMwh - absorbedEnergyMwh),
    endSocMwh,
    inferredFleetSocPctSeries,
  };
}

/**
 * Walk quarter-hour slots in order: each slot offers `max(0, gen − load) × ¼ h` MWh of charging energy.
 * SOC never decreases on deficits (charge-only). Prefer {@link computeCyclingFleetSurplusAbsorption} for KPIs
 * aligned with modeled fleet cycling.
 *
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
  let curtailedEnergyMwh = 0;
  let absorbedEnergyMwh = 0;
  const inferredFleetSocPctSeries: number[] = [];

  for (const s of slots) {
    const netMw = s.totalGenerationMw - s.loadMw;
    const slotSurplusMwh = Math.max(0, netMw) * QUARTER_HOUR_H;
    const slotCurtailedMwh = Math.max(0, s.curtailmentMw ?? 0) * QUARTER_HOUR_H;
    const slotChargeOpportunityMwh = slotSurplusMwh + slotCurtailedMwh;
    grossSurplusEnergyMwh += slotSurplusMwh;
    curtailedEnergyMwh += slotCurtailedMwh;

    let chargeMwh = 0;
    if (slotChargeOpportunityMwh > 0 && energyCapMwh !== null) {
      const headroomMwh = energyCapMwh - socMwh;
      chargeMwh = Math.min(
        slotChargeOpportunityMwh,
        powerCapMwhPerSlot,
        Math.max(0, headroomMwh)
      );
      socMwh += chargeMwh;
    }
    absorbedEnergyMwh += chargeMwh;

    const pct =
      energyCapMwh !== null && energyCapMwh > 0 ? (socMwh / energyCapMwh) * 100 : 0;
    inferredFleetSocPctSeries.push(pct);
  }

  return {
    grossSurplusEnergyMwh,
    curtailedEnergyMwh,
    grossChargeOpportunityEnergyMwh: grossSurplusEnergyMwh + curtailedEnergyMwh,
    absorbedEnergyMwh,
    missedSurplusEnergyMwh: grossSurplusEnergyMwh + curtailedEnergyMwh - absorbedEnergyMwh,
    endSocMwh: socMwh,
    inferredFleetSocPctSeries,
  };
}
