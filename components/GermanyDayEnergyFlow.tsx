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
          eyebrow: "Energy-Charts Tagesprofil",
          title: "Tages-Nettobilanz",
          subtitle:
            "Eine kombinierte Linie: domestische Erzeugung minus Last aus Energy-Charts (Viertelstunden) — plus theoretischer Flotten-Lade-SoC, wenn diese Ueberschuss-Leistung voll eingespeichert werden koennte.",
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
            "Im Simulator darunter zusätzliche Speicherleistung/Kapazität einstellen, um Marginaleffekte auf diesen Tag zu sehen.",
          unavailable:
            "Für keine Berlin-Tag-Linie reichenzeitig genug brauchbare Viertelstunden — bitte später erneut laden.",
          loadingEyebrow: "Marktdaten werden geladen",
        }
      : {
          eyebrow: "Energy-Charts daily profile",
          title: "Daily net balance",
          subtitle:
            "One combined line: domestic generation minus load from Energy-Charts (15-minute steps), plus a theoretical fleet charging SoC if that surplus power could be fully absorbed.",
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
            "Use the simulator below to layer incremental power/capacity and see marginal effects against this observed day.",
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

  if (isLoading) {
    return (
      <article className="scroll-mt-8 space-y-4 rounded-2xl border border-slate-300/45 bg-white/75 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
          {t.loadingEyebrow}
        </p>
        <Skeleton className="h-6 max-w-xs rounded-lg" />
        <Skeleton className="h-[min(360px,50vw)] min-h-[260px] w-full rounded-xl" />
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
      className="scroll-mt-8 space-y-5 rounded-2xl border border-slate-300/45 bg-white/75 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55"
    >
      <div>
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{t.eyebrow}</p>
        <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white md:text-2xl">
          {t.title}
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300">{t.subtitle}</p>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {t.coverage(flow.samplePoints, coveragePct, flow.dateBerlin)}
        </p>
      </div>

      {showMissedKpis && absorption ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200/80 bg-white/85 p-3 dark:border-slate-500/35 dark:bg-slate-900/50">
            <p className="text-[10px] font-medium tracking-[0.12em] text-slate-500 uppercase dark:text-slate-400">
              {t.kpiGross}
            </p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-900 dark:text-white">
              {formatEnergyFromMwh(absorption.grossSurplusEnergyMwh)}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200/80 bg-white/85 p-3 dark:border-slate-500/35 dark:bg-slate-900/50">
            <p className="text-[10px] font-medium tracking-[0.12em] text-slate-500 uppercase dark:text-slate-400">
              {t.kpiAbsorbed}
            </p>
            <p className="mt-1 text-lg font-bold tabular-nums text-slate-900 dark:text-white">
              {formatEnergyFromMwh(absorption.absorbedEnergyMwh)}
            </p>
          </div>
          <div className="rounded-xl border border-amber-200/80 bg-amber-50/90 p-3 dark:border-amber-400/25 dark:bg-amber-400/10">
            <p className="text-[10px] font-medium tracking-[0.12em] text-amber-900/80 uppercase dark:text-amber-200/90">
              {t.kpiMissed}
            </p>
            <p className="mt-1 text-lg font-bold tabular-nums text-amber-950 dark:text-amber-100">
              {formatEnergyFromMwh(absorption.missedSurplusEnergyMwh)}
            </p>
            {absorption.grossSurplusEnergyMwh > 1e-6 ? (
              <p className="mt-1 text-[11px] text-amber-900/75 dark:text-amber-100/80">
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

      <div className="rounded-2xl border border-slate-300/50 bg-white/90 p-4 dark:border-slate-500/35 dark:bg-slate-900/55 md:p-5">
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
        <div className="mt-3 h-[min(360px,50vw)] min-h-[260px] w-full">
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
                strokeWidth={2}
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
