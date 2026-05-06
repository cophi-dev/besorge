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
};

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
});

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
        Germany market snapshot
      </p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white md:text-3xl">
        Real-time power usage and installed BESS capacity
      </h2>
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        Source: Fraunhofer ISE Energy-Charts. Live load is current total German electricity demand;
        installed BESS values use latest available annual entries.
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
            value={`${NUMBER_FORMATTER.format(data.energyUsage.latestValueMw)} ${data.energyUsage.unit}`}
            detail={new Date(data.energyUsage.latestTimestampIso).toLocaleString("de-DE", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          />
          <MetricCard
            title="24h average load"
            value={`${NUMBER_FORMATTER.format(data.energyUsage.trailing24hAverageMw)} ${data.energyUsage.unit}`}
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
