"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, BatteryCharging, BatteryMedium, Gauge, Zap } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import type { ChartFleetSocSnapshot } from "@/lib/chartFleetSocSnapshot";
import type { FleetSocMomentEstimate } from "@/lib/socEstimator";

export type LiveSnapshotFleetMode = "charging" | "discharging" | "idle";

const gwFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const pctFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export type LiveSnapshotHeaderProps = {
  language: "en" | "de";
  isLoading: boolean;
  /** Total domestic generation in GW */
  generationGw: number | null;
  /** Renewable share of generation, 0–100, or null if unknown */
  renewableSharePct: number | null;
  /** Load in GW */
  demandGw: number | null;
  /** Generation minus load in GW (positive = surplus) */
  netPositionGw: number | null;
  fleetMode: LiveSnapshotFleetMode | null;
  /** Last point of the chart SoC line (preferred when present). */
  chartFleetSoc: ChartFleetSocSnapshot | null;
  /** Fallback heuristic before the chart has published a snapshot */
  fleetSocMoment: FleetSocMomentEstimate | null;
  /** ISO timestamp from API */
  updatedAtIso: string | null;
};

function useValueFlash<T>(value: T, enabled: boolean): boolean {
  const prev = useRef(value);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!enabled || prev.current === value) {
      prev.current = value;
      return;
    }
    prev.current = value;
    setFlash(true);
    const id = window.setTimeout(() => setFlash(false), 450);
    return () => window.clearTimeout(id);
  }, [value, enabled]);

  return flash;
}

function KpiValue({
  children,
  flash,
  className,
}: {
  children: React.ReactNode;
  flash: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-block tabular-nums transition-[transform,color,opacity] duration-300 ease-out [font-family:var(--font-sans)] ${
        flash ? "scale-[1.02] opacity-90" : "scale-100 opacity-100"
      } ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export function LiveSnapshotHeader({
  language,
  isLoading,
  generationGw,
  renewableSharePct,
  demandGw,
  netPositionGw,
  fleetMode,
  chartFleetSoc,
  fleetSocMoment,
  updatedAtIso,
}: LiveSnapshotHeaderProps) {
  const labels = {
    title: language === "de" ? "Live-Snapshot" : "Live snapshot",
    gen: language === "de" ? "Erzeugung" : "Generation",
    genSub: language === "de" ? "Anteil erneuerbar" : "Renewable share",
    demand: language === "de" ? "Last" : "Demand",
    net: language === "de" ? "Netto-Position" : "Net position",
    netSurplus: language === "de" ? "Überschuss" : "Surplus",
    netDeficit: language === "de" ? "Defizit" : "Deficit",
    bess: language === "de" ? "BESS-Status" : "BESS status",
    socChartFleet: language === "de" ? "Flotten-SoC (Diagramm)" : "Fleet SoC (chart curve)",
    socChartPractical: language === "de" ? "SoC (Praxis-Simulation)" : "SoC (practical sim)",
    estSoc: language === "de" ? "Flotten-SoC (Modell)" : "Fleet SoC (model)",
    berlinTz: language === "de" ? "Europa/Berlin" : "Europe/Berlin",
    livePrefix: language === "de" ? "Live" : "Live",
    unavailable: language === "de" ? "k. A." : "n/a",
    charging: language === "de" ? "Laden" : "Charging",
    discharging: language === "de" ? "Entladen" : "Discharging",
    idle: language === "de" ? "Leerlauf" : "Idle",
    fleetUnavailable:
      language === "de" ? "vorübergehend nicht verfügbar" : "temporarily unavailable",
  };

  const genFlash = useValueFlash(generationGw, !isLoading);
  const demandFlash = useValueFlash(demandGw, !isLoading);
  const netFlash = useValueFlash(netPositionGw, !isLoading);

  const chartBerlinClock =
    chartFleetSoc !== null
      ? new Intl.DateTimeFormat("de-DE", {
          timeZone: "Europe/Berlin",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
          .format(new Date(chartFleetSoc.lastSlotTimestampIso))
          .replace(", ", " ")
      : null;

  const socLabel =
    chartFleetSoc !== null
      ? chartFleetSoc.mode === "practical"
        ? labels.socChartPractical
        : labels.socChartFleet
      : labels.estSoc;

  const socMidpointPct =
    chartFleetSoc !== null
      ? chartFleetSoc.socPct
      : fleetSocMoment !== null
        ? fleetSocMoment.midpointPct
        : null;
  const socLowPct =
    chartFleetSoc !== null
      ? Math.max(0, chartFleetSoc.socPct - 4)
      : fleetSocMoment !== null
        ? fleetSocMoment.lowPct
        : null;
  const socHighPct =
    chartFleetSoc !== null
      ? Math.min(100, chartFleetSoc.socPct + 4)
      : fleetSocMoment !== null
        ? fleetSocMoment.highPct
        : null;

  const formattedTimestamp =
    updatedAtIso !== null
      ? new Date(updatedAtIso)
          .toLocaleString("de-DE", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
          .replace(", ", " ")
      : null;
  const subheadingAsOf =
    formattedTimestamp !== null
      ? `${labels.livePrefix} · ${formattedTimestamp}`
      : `${labels.livePrefix} · …`;

  const netTone =
    netPositionGw === null
      ? "text-slate-700 dark:text-slate-200"
      : netPositionGw > 0
        ? "text-emerald-700 dark:text-emerald-300"
        : netPositionGw < 0
          ? "text-rose-600 dark:text-rose-300"
          : "text-slate-700 dark:text-slate-200";

  const netBar =
    netPositionGw === null
      ? "from-slate-300/60 to-slate-200/30 dark:from-slate-600/50 dark:to-slate-700/30"
      : netPositionGw > 0
        ? "from-emerald-500/35 to-emerald-400/10"
        : netPositionGw < 0
          ? "from-rose-500/35 to-rose-400/10"
          : "from-slate-300/60 to-slate-200/30 dark:from-slate-600/50 dark:to-slate-700/30";

  const resolvedFleetMode = chartFleetSoc !== null ? chartFleetSoc.fleetMode : fleetMode;

  const fleetLabel =
    resolvedFleetMode === "charging"
      ? labels.charging
      : resolvedFleetMode === "discharging"
        ? labels.discharging
        : resolvedFleetMode === "idle"
          ? labels.idle
          : labels.fleetUnavailable;

  const fleetIcon =
    resolvedFleetMode === "charging" ? (
      <BatteryCharging className="h-6 w-6 text-violet-600 dark:text-violet-300" aria-hidden />
    ) : resolvedFleetMode === "discharging" ? (
      <Zap className="h-6 w-6 text-violet-600 dark:text-violet-300" aria-hidden />
    ) : resolvedFleetMode === "idle" ? (
      <BatteryMedium className="h-6 w-6 text-violet-500/80 dark:text-violet-400/90" aria-hidden />
    ) : (
      <BatteryMedium className="h-6 w-6 text-slate-400 dark:text-slate-500" aria-hidden />
    );

  return (
    <header className="sticky top-16 z-[100] -mx-5 mb-6 border-b border-border/50 bg-background/92 pb-4 backdrop-blur-md md:-mx-8 lg:top-[68px] lg:-mx-12">
      <div className="px-0 pt-0.5">
        <div className="mb-2 flex flex-col gap-0.5 sm:mb-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <p className="text-[10px] font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
            {labels.title}
          </p>
          {isLoading ? (
            <Skeleton className="h-3.5 w-40 sm:mt-0" />
          ) : (
            <p className="text-[11px] font-medium tracking-[0.02em] text-slate-500 tabular-nums sm:text-right dark:text-slate-400">
              {subheadingAsOf}
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          {/* Generation */}
          <article className="group relative overflow-hidden rounded-xl border border-border/80 bg-card px-3.5 py-3 shadow-sm transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-md dark:border-slate-600/45 dark:bg-slate-900/80 dark:shadow-[0_8px_28px_rgb(0_0_0_/_0.32)] dark:hover:shadow-[0_12px_36px_rgb(0_0_0_/_0.42)]">
            <div className="pointer-events-none absolute inset-y-2.5 left-0 w-1 rounded-full bg-emerald-500/70" aria-hidden />
            <div className="pl-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                  {labels.gen}
                </p>
                <Gauge className="h-4 w-4 text-emerald-600/80 dark:text-emerald-400/80" aria-hidden />
              </div>
              {isLoading ? (
                <div className="mt-3 space-y-2">
                  <Skeleton className="h-9 w-[min(100%,7rem)]" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ) : (
                <>
                  <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white md:text-[1.65rem]">
                    <KpiValue flash={genFlash}>
                      {generationGw !== null ? `${gwFormatter.format(generationGw)} GW` : labels.unavailable}
                    </KpiValue>
                  </p>
                  <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
                    {labels.genSub}:{" "}
                    <span className="font-medium text-emerald-700/90 dark:text-emerald-300/90">
                      {renewableSharePct !== null ? `${pctFormatter.format(renewableSharePct)} %` : labels.unavailable}
                    </span>
                  </p>
                </>
              )}
            </div>
          </article>

          {/* Demand */}
          <article className="group relative overflow-hidden rounded-xl border border-border/80 bg-card px-3.5 py-3 shadow-sm transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-md dark:border-slate-600/45 dark:bg-slate-900/80 dark:shadow-[0_8px_28px_rgb(0_0_0_/_0.32)] dark:hover:shadow-[0_12px_36px_rgb(0_0_0_/_0.42)]">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                {labels.demand}
              </p>
              <Activity className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden />
            </div>
            {isLoading ? (
              <div className="mt-3">
                <Skeleton className="h-9 w-[min(100%,7rem)]" />
              </div>
            ) : (
              <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white md:text-[1.65rem]">
                <KpiValue flash={demandFlash}>
                  {demandGw !== null ? `${gwFormatter.format(demandGw)} GW` : labels.unavailable}
                </KpiValue>
              </p>
            )}
          </article>

          {/* Net position */}
          <article
            className={`group relative overflow-hidden rounded-xl border bg-card px-3.5 py-3 shadow-sm transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-md dark:bg-slate-900/80 dark:shadow-[0_8px_28px_rgb(0_0_0_/_0.32)] dark:hover:shadow-[0_12px_36px_rgb(0_0_0_/_0.42)] ${
              netPositionGw === null
                ? "border-border/80 dark:border-slate-600/45"
                : netPositionGw > 0
                  ? "border-emerald-300/70 dark:border-emerald-500/35"
                  : netPositionGw < 0
                    ? "border-rose-300/70 dark:border-rose-500/35"
                    : "border-border/80 dark:border-slate-600/45"
            }`}
          >
            <div
              className={`pointer-events-none absolute inset-x-3 top-0 h-0.5 rounded-full bg-gradient-to-r ${netBar}`}
              aria-hidden
            />
            <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
              {labels.net}
            </p>
            {isLoading ? (
              <div className="mt-3 space-y-2">
                <Skeleton className="h-9 w-[min(100%,8rem)]" />
                <Skeleton className="h-3 w-20" />
              </div>
            ) : (
              <>
                <p className={`mt-2 text-2xl font-bold tracking-tight md:text-[1.65rem] ${netTone}`}>
                  <KpiValue flash={netFlash} className={netTone}>
                    {netPositionGw !== null ? (
                      <>
                        {netPositionGw > 0 ? labels.netSurplus : netPositionGw < 0 ? labels.netDeficit : "±0"}{" "}
                        {gwFormatter.format(Math.abs(netPositionGw))} GW
                      </>
                    ) : (
                      labels.unavailable
                    )}
                  </KpiValue>
                </p>
                {netPositionGw !== null ? (
                  <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
                    {language === "de" ? "Erzeugung − Last" : "Generation − demand"}
                  </p>
                ) : null}
              </>
            )}
          </article>

          {/* BESS fleet inference */}
          <article className="group relative overflow-hidden rounded-xl border border-violet-200/60 bg-card px-3.5 py-3 shadow-sm transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-md dark:border-violet-500/28 dark:bg-slate-900/80 dark:shadow-[0_8px_28px_rgb(0_0_0_/_0.32)] dark:hover:shadow-[0_12px_36px_rgb(0_0_0_/_0.42)]">
            <div className="pointer-events-none absolute inset-y-2.5 left-0 w-1 rounded-full bg-violet-500/65 dark:bg-violet-400/55" aria-hidden />
            <div className="flex items-start justify-between gap-3 pl-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                  {labels.bess}
                </p>
                {isLoading ? (
                  <div className="mt-3 space-y-2">
                    <Skeleton className="h-7 w-28" />
                    <Skeleton className="h-3 w-36" />
                  </div>
                ) : (
                  <>
                    <p className="mt-2 line-clamp-2 text-lg font-bold text-violet-900 dark:text-violet-100 md:text-xl">
                      {fleetLabel}
                    </p>
                    <p className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-slate-600 dark:text-slate-400">
                      <span className="block">
                        {socLabel}:{" "}
                        {socMidpointPct !== null && socLowPct !== null && socHighPct !== null ? (
                          <>
                            <span className="font-semibold tabular-nums text-violet-800 dark:text-violet-200">
                              ~{pctFormatter.format(socMidpointPct)} %
                            </span>
                            <span className="text-slate-500 dark:text-slate-500">
                              {" "}
                              ({pctFormatter.format(socLowPct)}–{pctFormatter.format(socHighPct)} %)
                            </span>
                          </>
                        ) : (
                          <span className="font-medium text-slate-500">{labels.unavailable}</span>
                        )}
                      </span>
                      {chartFleetSoc !== null && chartBerlinClock !== null ? (
                        <span className="block text-[10px] text-slate-500 dark:text-slate-500">
                          {labels.berlinTz} · {chartBerlinClock}
                        </span>
                      ) : fleetSocMoment !== null ? (
                        <span className="block text-[10px] text-slate-500 dark:text-slate-500">
                          {labels.berlinTz} · {fleetSocMoment.snapshotBerlinLabel}
                        </span>
                      ) : null}
                    </p>
                  </>
                )}
              </div>
              <div className="shrink-0 rounded-xl bg-violet-500/10 p-2 dark:bg-violet-400/10">{fleetIcon}</div>
            </div>
          </article>
        </div>
      </div>
    </header>
  );
}
