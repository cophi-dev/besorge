"use client";

import { useEffect, useMemo, useState } from "react";

type GermanyMarketSnapshot = {
  retrievedAtIso: string;
  energyUsage: {
    unit: "MW";
    latestValueMw: number;
    latestTimestampIso: string;
    trailing24hAverageMw: number;
  };
  bess: {
    capacityUnit: "GWh";
    installedCapacityGwh: number;
    capacityYear: string;
    powerUnit: "GW";
    installedPowerGw: number;
    powerYear: string;
  };
  realtimeSystem: {
    unit: "MW";
    timestampIso: string;
    loadMw: number;
    domesticGenerationMw: number;
    batteryStorageMw: number | null;
    residualLoadMw?: number;
    renewableShareOfLoadPct?: number;
  };
};

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
});
const MW_PER_GW = 1_000;

const formatAdaptivePower = (valueMw: number) => {
  if (Math.abs(valueMw) >= MW_PER_GW) {
    return `${NUMBER_FORMATTER.format(valueMw / MW_PER_GW)} GW`;
  }
  return `${NUMBER_FORMATTER.format(valueMw)} MW`;
};

export default function GermanyMarketSnapshot() {
  const [data, setData] = useState<GermanyMarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetch("/api/market/de", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const payload = (await response.json()) as GermanyMarketSnapshot;
        setData(payload);
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) {
          return;
        }
        setError(caught instanceof Error ? caught.message : "Unknown error");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    load();

    return () => controller.abort();
  }, []);

  const updatedLabel = useMemo(() => {
    if (!data) {
      return null;
    }
    return new Date(data.retrievedAtIso).toLocaleString("de-DE", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }, [data]);

  return (
    <section className="glass-card rounded-3xl p-6 md:p-8">
      <p className="text-xs tracking-[0.18em] text-blue-600 uppercase dark:text-blue-300">
        Current energy data
      </p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white md:text-3xl">
        Real-time power usage and installed BESS capacity
      </h2>
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        Source: Fraunhofer ISE Energy-Charts. Live load is current total German electricity demand;
        installed BESS values use latest available annual entries.
      </p>
      <p className="mt-2 rounded-lg border border-slate-300/60 bg-white/60 px-3 py-2 text-xs text-slate-600 dark:border-slate-500/35 dark:bg-slate-900/50 dark:text-slate-300">
        Data freshness can differ by metric: real-time demand updates intraday while installed BESS
        values update on annual publication cycles.
      </p>

      {loading ? (
        <p className="mt-5 rounded-xl border border-slate-300/60 bg-white/60 p-4 text-sm text-slate-700 dark:border-slate-500/35 dark:bg-slate-900/50 dark:text-slate-200">
          Loading market data...
        </p>
      ) : null}

      {error ? (
        <p className="mt-5 rounded-xl border border-red-400/45 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-200">
          Could not load market data: {error}
        </p>
      ) : null}

      {data ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title="Current DE load"
            value={formatAdaptivePower(data.energyUsage.latestValueMw)}
            detail={new Date(data.energyUsage.latestTimestampIso).toLocaleString("de-DE", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          />
          <MetricCard
            title="24h average load"
            value={formatAdaptivePower(data.energyUsage.trailing24hAverageMw)}
            detail="Rolling 24h window (15-min data)"
          />
          <MetricCard
            title="Installed BESS capacity"
            value={`${NUMBER_FORMATTER.format(data.bess.installedCapacityGwh)} ${data.bess.capacityUnit}`}
            detail={`Latest year: ${data.bess.capacityYear}`}
          />
          <MetricCard
            title="Installed BESS power"
            value={`${NUMBER_FORMATTER.format(data.bess.installedPowerGw)} ${data.bess.powerUnit}`}
            detail={`Latest year: ${data.bess.powerYear}`}
          />
        </div>
      ) : null}

      {data?.realtimeSystem ? (
        <RealtimeSystemPanel realtime={data.realtimeSystem} />
      ) : null}

      {updatedLabel ? (
        <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">Updated: {updatedLabel}</p>
      ) : null}
    </section>
  );
}

function MetricCard({
  title,
  value,
  detail,
}: {
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-slate-300/60 bg-white/65 p-4 dark:border-slate-500/30 dark:bg-slate-900/55">
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      <p className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</p>
    </div>
  );
}

function RealtimeSystemPanel({
  realtime,
}: {
  realtime: GermanyMarketSnapshot["realtimeSystem"];
}) {
  const surplusMw = realtime.domesticGenerationMw - realtime.loadMw;
  const timestampLabel = new Date(realtime.timestampIso).toLocaleString("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="mt-6 rounded-xl border border-slate-300/50 bg-white/50 p-4 dark:border-slate-500/25 dark:bg-slate-900/40">
      <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400">
        System context (latest quarter-hour)
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{timestampLabel}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200/80 bg-white/60 px-3 py-2 dark:border-slate-600/40 dark:bg-slate-950/30">
          <p className="text-[10px] uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
            Demand
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
            {formatAdaptivePower(realtime.loadMw)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200/80 bg-white/60 px-3 py-2 dark:border-slate-600/40 dark:bg-slate-950/30">
          <p className="text-[10px] uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
            Domestic generation
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
            {formatAdaptivePower(realtime.domesticGenerationMw)}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200/80 bg-white/60 px-3 py-2 dark:border-slate-600/40 dark:bg-slate-950/30">
          <p className="text-[10px] uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
            Battery (grid)
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
            {realtime.batteryStorageMw === null
              ? "n/a"
              : formatAdaptivePower(realtime.batteryStorageMw)}
          </p>
          {realtime.batteryStorageMw === null ? (
            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
              Series not provided in this feed
            </p>
          ) : null}
        </div>
      </div>

      <p className="mt-4 text-sm font-medium text-slate-800 dark:text-slate-100">
        Domestic surplus / deficit (excl. imports):{" "}
        <span className={surplusMw >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-amber-800 dark:text-amber-300"}>
          {surplusMw >= 0 ? "+" : ""}
          {formatAdaptivePower(surplusMw)}
        </span>
      </p>

      {realtime.residualLoadMw !== undefined || realtime.renewableShareOfLoadPct !== undefined ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          {realtime.residualLoadMw !== undefined ? (
            <>
              Residual load: {formatAdaptivePower(realtime.residualLoadMw)}
              {realtime.renewableShareOfLoadPct !== undefined ? " · " : ""}
            </>
          ) : null}
          {realtime.renewableShareOfLoadPct !== undefined ? (
            <>Renewable share of load: {NUMBER_FORMATTER.format(realtime.renewableShareOfLoadPct)}%</>
          ) : null}
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        Load does not equal domestic generation plus imports exactly (losses and reconciliation).
        This strip is an indicator snapshot, not a closed balance.
      </p>
    </div>
  );
}
