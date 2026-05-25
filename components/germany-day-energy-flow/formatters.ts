import {
  energyFormatter,
  integerFormatter,
  powerFormatter,
} from "./constants";

export function formatSignedMw(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${integerFormatter.format(n)} MW`;
}

export function formatEnergyFromMwh(mwh: number): string {
  const gwh = mwh / 1_000;
  if (Math.abs(gwh) >= 1) {
    return `${energyFormatter.format(gwh)} GWh`;
  }
  return `${integerFormatter.format(mwh)} MWh`;
}

export function formatPowerFromMw(mw: number): string {
  if (!Number.isFinite(mw) || mw <= 0) {
    return "0 MW";
  }
  if (mw >= 1000) {
    return `${energyFormatter.format(mw / 1000)} GW`;
  }
  return `${powerFormatter.format(mw)} MW`;
}

export function formatSignedEnergyFromMwh(mwh: number): string {
  const sign = mwh > 0 ? "+" : mwh < 0 ? "−" : "";
  return `${sign}${formatEnergyFromMwh(Math.abs(mwh))}`;
}

export function parseCapacityGwhInput(value: string): number | null {
  const normalized = value.trim().replace(/,/g, ".");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed * 1_000;
}

export function formatCurrencyCompact(value: number | null, language: "de" | "en" = "de"): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  const locale = language === "de" ? "de-DE" : "en-GB";
  if (Math.abs(value) >= 100_000) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "EUR",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}
