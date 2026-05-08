"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Skeleton } from "@/components/ui/skeleton";
import type { GermanyDispatchSlotsResponse } from "@/lib/energyChartsApi";
import { computeNetSurplusFleetAbsorption } from "@/lib/netSurplusFleetAbsorption";

const EVENING_HOUR_START = 17;
const EVENING_HOUR_END = 21;

const timeFormatter = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const integerFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const pctFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const energyFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

type ChartRow = GermanyDispatchSlotsResponse["slots"][number] & {
  timeLabel: string;
  /** Domestic generation − load (positive = surplus MW, negative = deficit). */
  netBalanceMw: number;
  inferredFleetSocPct: number;
};

export type GermanyDayEnergyFlowProps = {
  flow: GermanyDispatchSlotsResponse | null;
  fleetCapacityGwh?: number | null;
  fleetPowerGw?: number | null;
  language: "en" | "de";
  isLoading?: boolean;
};

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}

function formatSignedMw(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${integerFormatter.format(n)} MW`;
}

function formatEnergyFromMwh(mwh: number): string {
  const gwh = mwh / 1_000;
  if (Math.abs(gwh) >= 1) {
    return `${energyFormatter.format(gwh)} GWh`;
  }
  return `${integerFormatter.format(mwh)} MWh`;
}

export default function GermanyDayEnergyFlow({
  flow,
  fleetCapacityGwh,
  fleetPowerGw,
  language,
  isLoading,
}: GermanyDayEnergyFlowProps) {
  const t =
    language === "de"
      ? {
          eyebrow: "Energy-Charts Daily Profile",
          title: "Deutschland-Tagesprofil – beobachteter Ueberschuss, Defizit & theoretischer Flotten-SoC",
          subtitleFallback:
            "Kombinierte Darstellung: domestische Erzeugung minus Last aus Energy-Charts (Viertelstunden), plus theoretischer Flotten-Lade-SoC, wenn Ueberschuss-Leistung voll mit der heutigen Kapazitaet aufgenommen werden koennte.",
          chartTitle: "Ueberschuss / Defizit",
          legendNet: "+Ueberschuss / −Defizit (Erz. − Last)",
          legendFleetSoc: "Potenzieller Flotten-SoC (nur Laden)",
          legendEvening: "Abendfenster",
          netFootnote:
            "Nettobilanz = Summe inländischer Erzeugung (Alle Erzeugungsreihen wie im Snapshot) minus Last. Positive Werte sind strukturelle Ueberschuss-Leistung im Slot vor Nettoimport/Export; negative Werte strukturelle Luecke.",
          socFootnote:
            "SoC-Kurve: Reihenfolge der Viertelstunden wie im Chart; je Slot Begrenzung durch installierte Energiekapazitaet sowie AC-Leistung (MW × ¼ h) der Flotte — keine gemessenen Einzel-Anlagen-Staende.",
          kpiGross: "Brutto-Ueberschuss (Erz. − Last)",
          kpiAbsorbed: "Theoretisch speicherbar (Kap. + MW)",
          kpiMissed: "Verpasste Ueberschuss-Energie",
          kpiMethod:
            "Vereinfachtes Ladebandmodell ueber den beobachteten Tag; keine Netzengpaesse, keine beobachteten Ladearbeitspunkte. Teil-Tag proportional.",
          coverage: (n: number, pct: string, date: string) =>
            `${n} Viertelstunden beobachtet (${pct}% des Tages) · ${date}`,
          axisMw: "MW",
          axisSoc: "SoC (%)",
          simulatorHint:
            "Basierend auf diesem beobachteten Profil testen Sie im BESS Dispatch Simulator darunter, wie zusaetzliche Speicherkapazitaet sich heute verkaufen wuerde — exakt dieselbe Viertelstunden-Reihe, nur mit modellierter Zubau-Leistung und -Energie obenauf.",
          unavailable:
            "Für keine Berlin-Tag-Linie reichenzeitig genug brauchbare Viertelstunden — bitte später erneut laden.",
          loadingEyebrow: "Marktdaten werden geladen",
        }
      : {
          eyebrow: "Energy-Charts daily profile",
          title: "Germany Day Profile – Observed Surplus, Deficit & Theoretical Fleet SoC",
          subtitleFallback:
            "One combined line: domestic generation minus load from Energy-Charts (15-minute steps), plus a theoretical fleet charging SoC if surplus power could be fully absorbed with today's nameplate capacity.",
          chartTitle: "Surplus / deficit",
          legendNet: "+surplus / −deficit (gen − load)",
          legendFleetSoc: "Potential fleet SoC (charge-only)",
          legendEvening: "Evening window",
          netFootnote:
            "Net balance = summed domestic generation in the snapshot stack minus load. Positive slots are structural surplus power before netting cross-border flows; negative slots structural shortfall.",
          socFootnote:
            "SoC path: walks quarter-hours in order; each slot is limited by fleet energy capacity and fleet AC power (MW × ¼ h) — not metered asset-level SOC.",
          kpiGross: "Gross surplus (gen − load)",
          kpiAbsorbed: "Theoretically storable (cap + MW)",
          kpiMissed: "Missed surplus energy",
          kpiMethod:
            "Simplified greedy charge model over the observed hours; ignores grid/export constraints and actual dispatch states. Partial-day caveat applies.",
          coverage: (n: number, pct: string, date: string) =>
            `${n} quarter-hours observed (${pct}% of day) · ${date}`,
          axisMw: "MW",
          axisSoc: "SoC (%)",
          simulatorHint:
            "Based on this observed profile, use the BESS Dispatch Simulator below to test how incremental storage capacity would perform today—the same quarter-hour series, with modeled additional power and energy layered on top.",
          unavailable: "Not enough usable quarter-hours for a Berlin-day series yet — try again shortly.",
          loadingEyebrow: "Loading market data",
        };

  const fleetEnergyCapacityMwh =
    fleetCapacityGwh !== null &&
    fleetCapacityGwh !== undefined &&
    Number.isFinite(fleetCapacityGwh) &&
    fleetCapacityGwh > 0
      ? fleetCapacityGwh * 1_000
      : null;

  const fleetPowerMw =
    fleetPowerGw !== null && fleetPowerGw !== undefined && Number.isFinite(fleetPowerGw) && fleetPowerGw > 0
      ? fleetPowerGw * 1_000
      : null;

  const absorption = useMemo(() => {
    if (!flow?.slots.length) {
      return null;
    }
    return computeNetSurplusFleetAbsorption(flow.slots, fleetEnergyCapacityMwh, fleetPowerMw);
  }, [flow, fleetEnergyCapacityMwh, fleetPowerMw]);

  const chartRows: ChartRow[] = useMemo(() => {
    if (!flow?.slots.length || !absorption) {
      return [];
    }
    return flow.slots.map((s, i) => {
      const netBalanceMw = s.totalGenerationMw - s.loadMw;
      return {
        ...s,
        timeLabel: timeFormatter.format(new Date(s.timestampIso)),
        netBalanceMw,
        inferredFleetSocPct: absorption.inferredFleetSocPctSeries[i] ?? 0,
      };
    });
  }, [flow, absorption]);

  const eveningBounds = useMemo(() => {
    if (chartRows.length === 0) {
      return null;
    }
    const idxs = chartRows
      .map((row, i) =>
        row.hourBerlin >= EVENING_HOUR_START && row.hourBerlin < EVENING_HOUR_END ? i : -1
      )
      .filter((i) => i >= 0);
    if (idxs.length === 0) {
      return null;
    }
    return { startIdx: idxs[0], endIdx: idxs[idxs.length - 1] };
  }, [chartRows]);

  const xEveningStart = eveningBounds ? chartRows[eveningBounds.startIdx]?.timeLabel : undefined;
  const xEveningEnd = eveningBounds ? chartRows[eveningBounds.endIdx]?.timeLabel : undefined;

  const xAxisInterval = Math.max(0, Math.floor(chartRows.length / 12) - 1);

  const dayStoryParagraphs = useMemo(() => {
    if (!flow?.slots.length || !absorption) {
      return null;
    }
    const pctDay = pctFormatter.format(flow.pointFractionOfDay * 100);
    const grossFmt = formatEnergyFromMwh(absorption.grossSurplusEnergyMwh);
    const hasFleetKpis =
      fleetEnergyCapacityMwh !== null &&
      fleetEnergyCapacityMwh > 0 &&
      fleetPowerMw !== null &&
      fleetPowerMw > 0;
    const dateLine =
      language === "de"
        ? `Am Berlin-Referenzdatum ${flow.dateBerlin} liegen ${flow.samplePoints.toString()} Viertelstunden vor (${pctDay}% des Kalendertages). `
        : `On the Berlin reference day ${flow.dateBerlin}, we have ${flow.samplePoints.toString()} quarter-hours (${pctDay}% of the calendar day). `;
    if (language === "de") {
      const spine =
        `${dateLine}Die Netz-Kurve zeigt strukturelle Ueber- oder Unterdeckung der Last durch die domestische Viertelstunden-Erzeugung aus Energy-Charts, bevor Imports/Exports einkalkuliert sind.`;
      if (!hasFleetKpis) {
        return {
          primary: spine,
          secondary:
            "Kombinierte Darstellung: domestische Erzeugung minus Last aus Energy-Charts (Viertelstunden), plus theoretischer Flotten-Lade-SoC, wenn Ueberschuss-Leistung voll mit der heutigen Kapazitaet aufgenommen werden koennte.",
        };
      }
      return {
        primary: spine,
        secondary: `Als erste Energiesumme liegen etwa ${grossFmt} strukturelle Brutto-Ueberschussenergie ueber einen reinen Laden-Pfad ohne Netzkupplungen. Unter heute angenommenen Flotten-MW plus Energiekappe sind davon etwa ${formatEnergyFromMwh(
          absorption.absorbedEnergyMwh
        )} theoretisch speicherbar — rund ${formatEnergyFromMwh(
          absorption.missedSurplusEnergyMwh
        )} verbleiben in diesem Vereinfachungsmodell.`,
        tertiary:
          "Der violett gestrichelte SoC folgt denselben Viertelstunden ohne Netzzwang; das gelbe Abendfenster hebt das typische Spannungsband fuer Entladung hervor.",
      };
    }
    const spineEn = `${dateLine}The balance trace alternates structural surplus versus structural deficit (generation vs load within Energy-Charts totals) before imports and exports re-balance flows.`;
    if (!hasFleetKpis) {
      return {
        primary: spineEn,
        secondary:
          "One combined line: domestic generation minus load from Energy-Charts (15-minute steps), plus a theoretical fleet charging SoC if surplus power could be fully absorbed with today's nameplate capacity.",
      };
    }
    return {
      primary: spineEn,
      secondary: `Gross daytime structural surplus aggregates to roughly ${grossFmt} before cross-border netting. Against today's nominal fleet MW and energy cap about ${formatEnergyFromMwh(
        absorption.absorbedEnergyMwh
      )} could enter a hypothetical charge-only funnel, leaving ~${formatEnergyFromMwh(
        absorption.missedSurplusEnergyMwh
      )} outside this simplification.`,
      tertiary:
        "The dashed violet SoC path mirrors the same chronological order without grid/export constraints—the amber evening band anchors the habitual discharge-pressure window.",
    };
  }, [absorption, flow, fleetEnergyCapacityMwh, fleetPowerMw, language]);

  if (isLoading) {
    return (
      <article className="scroll-mt-8 space-y-6 rounded-3xl border-2 border-slate-300/50 bg-white/80 p-6 shadow-lg md:p-8 dark:border-slate-500/40 dark:bg-slate-900/70 dark:shadow-black/35">
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
          {t.loadingEyebrow}
        </p>
        <Skeleton className="h-10 max-w-xl rounded-xl" />
        <Skeleton className="h-[min(460px,calc(72vw))] min-h-[320px] w-full rounded-2xl" />
      </article>
    );
  }

  if (!flow || chartRows.length === 0) {
    return (
      <article className="scroll-mt-8 rounded-2xl border border-dashed border-slate-300/65 bg-white/60 p-5 md:p-6 dark:border-slate-600/45 dark:bg-slate-900/40">
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{t.eyebrow}</p>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{t.unavailable}</p>
      </article>
    );
  }

  const coveragePct = pctFormatter.format(flow.pointFractionOfDay * 100);

  const showMissedKpis = fleetEnergyCapacityMwh !== null && absorption !== null;

  return (
    <article
      id="germany-day-energy-flow"
      className="scroll-mt-8 space-y-6 rounded-3xl border-2 border-slate-400/35 bg-gradient-to-b from-white via-white to-slate-50/90 p-6 shadow-[0_24px_64px_rgba(15,23,42,0.08)] md:space-y-7 md:p-8 lg:p-10 dark:border-slate-500/45 dark:from-slate-900 dark:via-slate-900/95 dark:to-slate-950/90 dark:shadow-[0_28px_70px_rgba(0,0,0,0.45)]"
    >
      <header className="space-y-2">
        <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase dark:text-slate-400">
          {t.eyebrow}
        </p>
        <h2 className="text-2xl font-semibold leading-tight tracking-tight text-slate-950 md:text-[1.95rem] md:leading-snug lg:text-4xl dark:text-white">
          {t.title}
        </h2>
        <div className="mt-3 max-w-4xl space-y-3 text-[15px] leading-relaxed text-slate-700 md:text-base dark:text-slate-300">
          {dayStoryParagraphs ? (
            <>
              <p>{dayStoryParagraphs.primary}</p>
              <p>{dayStoryParagraphs.secondary}</p>
              {dayStoryParagraphs.tertiary ? <p>{dayStoryParagraphs.tertiary}</p> : null}
            </>
          ) : (
            <p>{t.subtitleFallback}</p>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t.coverage(flow.samplePoints, coveragePct, flow.dateBerlin)}
        </p>
      </header>

      {showMissedKpis && absorption ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200/85 bg-white/90 p-3.5 dark:border-slate-500/35 dark:bg-slate-900/50">
            <p className="text-[10px] font-medium tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
              {t.kpiGross}
            </p>
            <p className="mt-1.5 text-xl font-bold tabular-nums text-slate-900 md:text-2xl dark:text-white">
              {formatEnergyFromMwh(absorption.grossSurplusEnergyMwh)}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200/85 bg-white/90 p-3.5 dark:border-slate-500/35 dark:bg-slate-900/50">
            <p className="text-[10px] font-medium tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
              {t.kpiAbsorbed}
            </p>
            <p className="mt-1.5 text-xl font-bold tabular-nums text-slate-900 md:text-2xl dark:text-white">
              {formatEnergyFromMwh(absorption.absorbedEnergyMwh)}
            </p>
          </div>
          <div className="rounded-xl border border-amber-200/80 bg-amber-50/95 p-3.5 dark:border-amber-400/25 dark:bg-amber-400/12">
            <p className="text-[10px] font-medium tracking-[0.14em] text-amber-900/80 uppercase dark:text-amber-200/90">
              {t.kpiMissed}
            </p>
            <p className="mt-1.5 text-xl font-bold tabular-nums text-amber-950 md:text-2xl dark:text-amber-50">
              {formatEnergyFromMwh(absorption.missedSurplusEnergyMwh)}
            </p>
            {absorption.grossSurplusEnergyMwh > 1e-6 ? (
              <p className="mt-2 text-[11px] font-medium text-amber-950/85 dark:text-amber-50/85">
                {pctFormatter.format(
                  (absorption.missedSurplusEnergyMwh / absorption.grossSurplusEnergyMwh) * 100
                )}
                % {language === "de" ? "des Brutto-Ueberschusses" : "of gross surplus"}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {showMissedKpis ? (
        <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t.kpiMethod}</p>
      ) : null}

      <div className="rounded-2xl border border-slate-300/55 bg-white/95 p-4 shadow-inner dark:border-slate-500/35 dark:bg-slate-950/55 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {t.chartTitle}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <LegendDot color="rgb(71,85,105)" label={t.legendNet} />
            <LegendDot color="rgb(79,70,229)" label={t.legendFleetSoc} />
            <LegendDot color="rgba(251,191,36,0.95)" label={t.legendEvening} />
          </div>
        </div>
        <div className="mt-3 h-[min(520px,min(72vw,900px))] min-h-[360px] w-full lg:min-h-[400px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartRows} margin={{ top: 8, right: 8, bottom: 6, left: 4 }}>
              <CartesianGrid stroke="rgba(148,163,184,0.18)" strokeDasharray="3 3" />
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 9, fill: "rgb(100,116,139)" }}
                interval={xAxisInterval}
              />
              <YAxis
                yAxisId="net"
                tick={{ fontSize: 10, fill: "rgb(100,116,139)" }}
                width={48}
                tickFormatter={(v) => integerFormatter.format(typeof v === "number" ? v : 0)}
                label={{
                  value: t.axisMw,
                  angle: -90,
                  position: "insideLeft",
                  fontSize: 9,
                  fill: "rgb(100,116,139)",
                }}
              />
              <YAxis
                yAxisId="soc"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: 9, fill: "rgb(100,116,139)" }}
                width={44}
                tickFormatter={(v) => `${typeof v === "number" ? v : Number(v ?? 0)}%`}
                label={{
                  value: t.axisSoc,
                  angle: 90,
                  position: "insideRight",
                  fontSize: 9,
                  fill: "rgb(100,116,139)",
                }}
              />
              {xEveningStart !== undefined && xEveningEnd !== undefined ? (
                <ReferenceArea
                  x1={xEveningStart}
                  x2={xEveningEnd}
                  yAxisId="net"
                  fill="rgba(251,191,36,0.16)"
                  stroke="rgba(245,158,11,0.28)"
                />
              ) : null}
              <ReferenceLine
                yAxisId="net"
                y={0}
                stroke="rgba(148,163,184,0.55)"
                strokeDasharray="4 4"
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(255,255,255,0.97)",
                  border: "1px solid rgba(148,163,184,0.45)",
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(value, name) => {
                  const n = typeof value === "number" ? value : Number(value ?? 0);
                  const label = typeof name === "string" ? name : String(name ?? "");
                  if (label === t.legendFleetSoc) {
                    return [`${pctFormatter.format(n)}%`, label];
                  }
                  return [formatSignedMw(n), label];
                }}
              />
              <Line
                yAxisId="net"
                type="monotone"
                dataKey="netBalanceMw"
                name={t.legendNet}
                stroke="rgb(71,85,105)"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive
                animationDuration={480}
              />
              <Line
                yAxisId="soc"
                type="monotone"
                dataKey="inferredFleetSocPct"
                name={t.legendFleetSoc}
                stroke="rgb(79,70,229)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive
                animationDuration={480}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t.netFootnote}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t.socFootnote}</p>
      </div>

      <p className="text-xs text-slate-600 dark:text-slate-400">{t.simulatorHint}</p>
    </article>
  );
}
