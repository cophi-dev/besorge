/**
 * Pure rule-based estimator for the BESS fleet's State of Charge (SoC).
 *
 * `estimateEveningSoc` implements the product-spec **evening** SoC bands (renewable share
 * + recent solar-rich days) for downstream “effective evening gap” math.
 *
 * `estimateFleetSocAtMoment` is a separate **snapshot-time** heuristic: it scales that
 * evening anchor through an intraday curve (Europe/Berlin clock), nudges with observed
 * battery grid MW, and lifts the estimate when **today’s quarter-hours** were mostly in
 * structural surplus (generation > load). It is indicative only, not telemetry.
 *
 * Evening bands:
 *  - High:     renewable share > 70% AND >= 2 solar-rich days in last 3 -> 75-85% (mid 80)
 *  - Moderate: renewable share in [50, 70]                              -> 55-70% (mid 62)
 *  - Low:      renewable share < 50%                                    -> 40-55% (mid 47)
 *  - Unknown:  null inputs                                              -> 50-65% (mid 58, "moderate")
 */

export type SocBandLabel = "low" | "moderate" | "high" | "unknown";

export type SocBand = {
  lowPct: number;
  highPct: number;
  midpointPct: number;
  label: SocBandLabel;
};

export type SocEstimateInput = {
  renewableShareOfLoadPct: number | null | undefined;
  solarRichDays: number | null | undefined;
};

const BAND_HIGH: SocBand = { lowPct: 75, highPct: 85, midpointPct: 80, label: "high" };
const BAND_MODERATE: SocBand = { lowPct: 55, highPct: 70, midpointPct: 62, label: "moderate" };
const BAND_LOW: SocBand = { lowPct: 40, highPct: 55, midpointPct: 47, label: "low" };
const BAND_UNKNOWN: SocBand = { lowPct: 50, highPct: 65, midpointPct: 58, label: "unknown" };

export const estimateEveningSoc = ({
  renewableShareOfLoadPct,
  solarRichDays,
}: SocEstimateInput): SocBand => {
  if (renewableShareOfLoadPct === null || renewableShareOfLoadPct === undefined) {
    return BAND_UNKNOWN;
  }
  if (renewableShareOfLoadPct > 70 && (solarRichDays ?? 0) >= 2) {
    return BAND_HIGH;
  }
  if (renewableShareOfLoadPct >= 50) {
    return BAND_MODERATE;
  }
  return BAND_LOW;
};

/** Key times (Berlin wall clock, hour) → multiplier applied to the evening-band midpoint. */
const INTRADAY_SOC_MULTIPLIER_KEYS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.52],
  [5, 0.56],
  [10, 0.76],
  [14, 0.9],
  [17, 0.97],
  [18, 0.99],
  [19, 1.0],
  [21, 0.86],
  [23, 0.72],
  [24, 0.52],
];

function berlinDecimalHour(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return 12;
  }
  return hour + minute / 60;
}

function intradaySocMultiplier(berlinHour: number): number {
  const h = ((berlinHour % 24) + 24) % 24;
  for (let i = 0; i < INTRADAY_SOC_MULTIPLIER_KEYS.length - 1; i += 1) {
    const [h0, m0] = INTRADAY_SOC_MULTIPLIER_KEYS[i];
    const [h1, m1] = INTRADAY_SOC_MULTIPLIER_KEYS[i + 1];
    if (h >= h0 && h <= h1) {
      const span = h1 - h0;
      const t = span === 0 ? 0 : (h - h0) / span;
      return m0 + t * (m1 - m0);
    }
  }
  return INTRADAY_SOC_MULTIPLIER_KEYS[INTRADAY_SOC_MULTIPLIER_KEYS.length - 1][1];
}

export type DispatchSlotSurplusInput = {
  totalGenerationMw: number;
  loadMw: number;
};

/** Share of slots where domestic generation exceeds load (structural surplus quarters). */
export function computeSlotSurplusFraction(
  slots: readonly DispatchSlotSurplusInput[] | null | undefined
): number | null {
  if (!slots?.length) {
    return null;
  }
  let surplusSlots = 0;
  for (const s of slots) {
    if (s.totalGenerationMw > s.loadMw) {
      surplusSlots += 1;
    }
  }
  return surplusSlots / slots.length;
}

function surplusFractionBoostPct(fraction: number | null): number {
  if (fraction === null || !Number.isFinite(fraction)) {
    return 0;
  }
  /** Past ~45% surplus quarters, fleet work should materially lift stored energy vs a dry day. */
  return Math.min(12, Math.max(0, (fraction - 0.45) * 38));
}

function currentNetPositionBoostPct(netPositionMw: number | null | undefined): number {
  if (netPositionMw === null || netPositionMw === undefined || !Number.isFinite(netPositionMw)) {
    return 0;
  }
  if (netPositionMw > 1_200) {
    return 3.5;
  }
  if (netPositionMw > 400) {
    return 1.5;
  }
  if (netPositionMw < -1_200) {
    return -3.5;
  }
  if (netPositionMw < -400) {
    return -1.5;
  }
  return 0;
}

function batteryActivityNudgePct(
  batteryStorageMw: number | null | undefined,
  installedFleetPowerMw: number | null | undefined
): number {
  if (
    batteryStorageMw === null ||
    batteryStorageMw === undefined ||
    installedFleetPowerMw === null ||
    installedFleetPowerMw === undefined ||
    !Number.isFinite(installedFleetPowerMw) ||
    installedFleetPowerMw <= 0
  ) {
    return 0;
  }
  /** Negative grid battery MW is treated as fleet charging (see product notes). */
  const normalized = -batteryStorageMw / installedFleetPowerMw;
  return Math.max(-7, Math.min(7, normalized * 6));
}

export type FleetSocMomentEstimate = {
  midpointPct: number;
  lowPct: number;
  highPct: number;
  /** Human label for the snapshot instant in Europe/Berlin (matches KPI clock). */
  snapshotBerlinLabel: string;
};

/**
 * Indicative **fleet SoC at the snapshot instant** (Europe/Berlin clock of `at`).
 *
 * This is not measured telemetry. It scales the same renewable-based **evening** band
 * (`estimateEveningSoc`) through an intraday shape, then layers battery MW, **today’s
 * surplus quarter-hour share**, and the **current net MW** position as small transparent
 * adjustments so a long surplus day does not read like a flat morning SoC at dusk.
 */
export function estimateFleetSocAtMoment(params: {
  renewableShareOfLoadPct: number | null | undefined;
  solarRichDays: number | null | undefined;
  at: Date;
  batteryStorageMw?: number | null;
  installedFleetPowerMw?: number | null;
  /** Fraction of today's dispatch slots with generation > load; from `dayEnergyFlow.slots`. */
  slotSurplusFraction?: number | null;
  /** Live generation − load at the snapshot (MW). */
  currentNetPositionMw?: number | null;
}): FleetSocMomentEstimate {
  const {
    renewableShareOfLoadPct,
    solarRichDays,
    at,
    batteryStorageMw,
    installedFleetPowerMw,
    slotSurplusFraction,
    currentNetPositionMw,
  } = params;
  const evening = estimateEveningSoc({ renewableShareOfLoadPct, solarRichDays });
  const E = evening.midpointPct;
  const h = berlinDecimalHour(at);
  const mult = intradaySocMultiplier(h);
  const nudge = batteryActivityNudgePct(batteryStorageMw, installedFleetPowerMw ?? null);
  let surplusBoost = surplusFractionBoostPct(slotSurplusFraction ?? null);
  if (currentNetPositionMw !== null && currentNetPositionMw !== undefined && currentNetPositionMw < -600) {
    surplusBoost *= 0.55;
  }
  const netBoost = currentNetPositionBoostPct(currentNetPositionMw);
  const raw = E * mult + nudge + surplusBoost + netBoost;
  const midpointPct = Math.min(96, Math.max(10, raw));
  const halfWidth = Math.max(
    5,
    (evening.highPct - evening.lowPct) / 3,
    surplusBoost > 0 ? 3 + surplusBoost * 0.35 : 0
  );
  const lowPct = Math.max(5, midpointPct - halfWidth);
  const highPct = Math.min(98, midpointPct + halfWidth);
  const snapshotBerlinLabel = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(at)
    .replace(", ", " ");

  return { midpointPct, lowPct, highPct, snapshotBerlinLabel };
}
