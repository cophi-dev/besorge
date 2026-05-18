/**
 * Presentation helpers for indicative BESS economics on the Germany day profile.
 * Separates modeled proxy value from expected real revenue and flags unrealistic capacity scaling.
 */

export const CAPACITY_CREDIBILITY_RATIO_THRESHOLD = 2.5;
/** Single-day / window runs above this size get an extrapolation warning (GWh). */
export const CAPACITY_CREDIBILITY_ABSOLUTE_GWH = 50;

export type CapacityCredibility = {
  isExtrapolated: boolean;
  referenceCapacityMwh: number | null;
  ratioToReference: number | null;
};

export function assessCapacityCredibility(
  capacityMwh: number,
  referenceCapacityMwh: number | null | undefined
): CapacityCredibility {
  if (!(capacityMwh > 0)) {
    return { isExtrapolated: false, referenceCapacityMwh: null, ratioToReference: null };
  }

  const reference =
    referenceCapacityMwh !== null &&
    referenceCapacityMwh !== undefined &&
    referenceCapacityMwh > 0
      ? referenceCapacityMwh
      : null;

  const ratioToReference = reference !== null ? capacityMwh / reference : null;
  const exceedsRatio =
    ratioToReference !== null && ratioToReference > CAPACITY_CREDIBILITY_RATIO_THRESHOLD;
  const exceedsAbsolute = capacityMwh / 1_000 > CAPACITY_CREDIBILITY_ABSOLUTE_GWH;

  return {
    isExtrapolated: exceedsRatio || exceedsAbsolute,
    referenceCapacityMwh: reference,
    ratioToReference,
  };
}

export type IndicativeValuePresentation = {
  primaryLabel: string;
  primaryValue: string;
  secondaryValue: string | null;
  perMwhValue: string | null;
  warning: string | null;
};

type Language = "de" | "en";

function roundEur(value: number): number {
  return Math.round(value);
}

function formatEur(language: Language, value: number): string {
  return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(roundEur(value));
}

function formatEurPerMwh(language: Language, value: number): string {
  return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

export function formatPaybackYears(years: number, language: Language): string {
  const formatted = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(years);
  return language === "de" ? `${formatted} Jahre` : `${formatted} years`;
}

export function computeIndicativeEurPerMwhStored(
  valueEur: number | null,
  absorbedMwh: number | null
): number | null {
  if (valueEur === null || absorbedMwh === null || !(absorbedMwh > 1e-6)) {
    return null;
  }
  const perMwh = valueEur / absorbedMwh;
  return Number.isFinite(perMwh) && perMwh > 0 ? perMwh : null;
}

export function presentIndicativeEurTotal(input: {
  language: Language;
  valueEur: number | null;
  windowDays: number;
  absorbedMwh: number | null;
  capacityMwh: number;
  referenceCapacityMwh: number | null;
}): IndicativeValuePresentation {
  const { language, valueEur, windowDays, absorbedMwh, capacityMwh, referenceCapacityMwh } =
    input;

  if (valueEur === null || !Number.isFinite(valueEur)) {
    return {
      primaryLabel: language === "de" ? "Modellierter Nutzen" : "Modeled benefit",
      primaryValue: "—",
      secondaryValue: null,
      perMwhValue: null,
      warning: null,
    };
  }

  const credibility = assessCapacityCredibility(capacityMwh, referenceCapacityMwh);
  const perMwh = computeIndicativeEurPerMwhStored(valueEur, absorbedMwh);
  const safeWindowDays = Math.max(1, windowDays);
  const perDayEur = valueEur / safeWindowDays;

  const windowScope =
    safeWindowDays > 1
      ? language === "de"
        ? `${safeWindowDays} Tage`
        : `${safeWindowDays} days`
      : language === "de"
        ? "Fenster"
        : "window";

  const primaryLabel =
    language === "de" ? "Modellierter Nutzen (indik.)" : "Modeled benefit (indic.)";

  let primaryValue = formatEur(language, valueEur);
  let secondaryValue =
    safeWindowDays > 1
      ? language === "de"
        ? `≈ ${formatEur(language, perDayEur)} / Tag · ${windowScope}`
        : `≈ ${formatEur(language, perDayEur)} / day · ${windowScope}`
      : language === "de"
        ? `Gesamt im gewählten ${windowScope}`
        : `Total for selected ${windowScope}`;

  let perMwhValue =
    perMwh !== null
      ? language === "de"
        ? `${formatEurPerMwh(language, perMwh)} EUR/MWh eingelagert`
        : `${formatEurPerMwh(language, perMwh)} EUR/MWh stored`
      : null;

  let warning: string | null = null;

  if (credibility.isExtrapolated) {
    const refGwh =
      credibility.referenceCapacityMwh !== null
        ? credibility.referenceCapacityMwh / 1_000
        : null;
    warning =
      language === "de"
        ? refGwh !== null
          ? `Bei sehr großer Simulationskapazität skaliert der Betrag nahezu linear mit eingelagerter MWh — kein realistischer Flottenerlös. Zum Einordnen: Vergleich nahe ${formatGwhLabel(language, refGwh)} (Empfehlung/Automatik).`
          : `Bei sehr großer Simulationskapazität skaliert der Betrag nahezu linear mit eingelagerter MWh — kein realistischer Flottenerlös.`
        : refGwh !== null
          ? `At very large simulated capacity, € scales almost linearly with stored MWh — not a realistic fleet revenue. For context, compare near ${formatGwhLabel(language, refGwh)} (recommendation/auto).`
          : `At very large simulated capacity, € scales almost linearly with stored MWh — not a realistic fleet revenue.`;

    if (perMwh !== null) {
      primaryValue =
        language === "de"
          ? `${formatEurPerMwh(language, perMwh)} EUR/MWh`
          : `${formatEurPerMwh(language, perMwh)} EUR/MWh`;
      secondaryValue =
        language === "de"
          ? `Lineares Modell: ${formatEur(language, valueEur)} im ${windowScope} (nicht als Erlös lesen)`
          : `Linear model: ${formatEur(language, valueEur)} in ${windowScope} (do not read as revenue)`;
      perMwhValue = null;
    }
  }

  return {
    primaryLabel,
    primaryValue,
    secondaryValue,
    perMwhValue,
    warning,
  };
}

function formatGwhLabel(language: Language, gwh: number): string {
  const formatted = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(gwh);
  return `${formatted} GWh`;
}

export type ValueComponentBreakdown = {
  timeShiftEur: number | null;
  curtailmentToLoadEur: number | null;
  avoidedRedispatchEur: number | null;
  totalEur: number | null;
};

export function extractValueBreakdown(scenario: {
  bessRevenueTodayEur: number | null;
  avoidedCurtailmentValueEur: number | null;
  avoidedRedispatchCostsEur: number | null;
  totalValueCreatedEur: number | null;
}): ValueComponentBreakdown {
  return {
    timeShiftEur: scenario.bessRevenueTodayEur,
    curtailmentToLoadEur: scenario.avoidedCurtailmentValueEur,
    avoidedRedispatchEur: scenario.avoidedRedispatchCostsEur,
    totalEur: scenario.totalValueCreatedEur,
  };
}

export type ValueBreakdownLine = {
  id: "timeShift" | "curtailmentToLoad" | "avoidedRedispatch";
  label: string;
  value: string;
  hint: string;
  amountEur: number | null;
};

export function buildValueBreakdownLines(
  breakdown: ValueComponentBreakdown,
  language: Language,
  formatEurFn: (value: number | null) => string
): ValueBreakdownLine[] {
  return [
    {
      id: "timeShift",
      label: language === "de" ? "Zeitverschiebung" : "Time shift",
      value: formatEurFn(breakdown.timeShiftEur),
      amountEur: breakdown.timeShiftEur,
      hint:
        language === "de"
          ? "Spread auf Entladung in Defizit-Slots"
          : "Spread on discharge into deficit slots",
    },
    {
      id: "curtailmentToLoad",
      label: language === "de" ? "Abregelung → Last" : "Curtailment → load",
      value: formatEurFn(breakdown.curtailmentToLoadEur),
      amountEur: breakdown.curtailmentToLoadEur,
      hint:
        language === "de"
          ? "Gespeicherte Abregelung deckt später Defizit"
          : "Stored curtailment later serves deficit",
    },
    {
      id: "avoidedRedispatch",
      label: language === "de" ? "Redispatch vermieden" : "Avoided redispatch",
      value: formatEurFn(breakdown.avoidedRedispatchEur),
      amountEur: breakdown.avoidedRedispatchEur,
      hint:
        language === "de"
          ? "Abregel-MWh × Redispatch-Proxy"
          : "Curtailment MWh × redispatch proxy",
    },
  ];
}
