/**
 * Pure rule-based estimator for the BESS fleet's evening State of Charge (SoC).
 *
 * The bands follow the product spec for the "Daily Energy Balance & Battery Outlook"
 * section. They intentionally bias toward conservative midpoints so downstream
 * "Effective Evening Gap" math does not over-promise discharge headroom when the
 * upstream renewable signal is noisy.
 *
 * Bands:
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
