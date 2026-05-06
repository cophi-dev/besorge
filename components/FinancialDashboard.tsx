"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  computeEconomics,
  regulatoryScenarioDescription,
  type GridRegulatoryScenario,
} from "@/lib/bessEconomics";
import { getFinancePhysicalConfig, useProjectStore } from "@/lib/projectStore";

const CURRENCY_FORMATTER = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const getSliderValue = (value: number | readonly number[]) =>
  Array.isArray(value) ? value[0] ?? 0 : value;

const formatCurrencyValue = (
  value: number | string | readonly (number | string)[] | undefined
) => {
  if (typeof value === "number") {
    return CURRENCY_FORMATTER.format(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? CURRENCY_FORMATTER.format(parsed) : value;
  }

  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === "number") {
      return CURRENCY_FORMATTER.format(first);
    }
    const parsed = Number(first);
    return Number.isFinite(parsed) ? CURRENCY_FORMATTER.format(parsed) : String(first);
  }

  return "-";
};

function ChartContainer({
  children,
}: {
  children: (size: { width: number; height: number }) => ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const nextWidth = Math.max(0, element.clientWidth);
      const nextHeight = Math.max(0, element.clientHeight);
      setSize((previous) =>
        previous.width === nextWidth && previous.height === nextHeight
          ? previous
          : { width: nextWidth, height: nextHeight }
      );
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef} className="h-72 w-full">
      {size.width > 0 && size.height > 0 ? children(size) : null}
    </div>
  );
}

const REGULATORY_OPTIONS: { value: GridRegulatoryScenario; label: string }[] = [
  { value: "baseline", label: "Stable market conditions" },
  { value: "moderate_grid_stress", label: "Moderate grid stress" },
  { value: "elevated_regulatory_risk", label: "Higher regulatory pressure" },
];

export default function FinancialDashboard() {
  const liveConfiguration = useProjectStore((state) => state.liveConfiguration);
  const selectedConfigurations = useProjectStore((state) => state.selectedConfigurations);
  const economicsAssumptions = useProjectStore((state) => state.economicsAssumptions);
  const setEconomicsAssumptions = useProjectStore((state) => state.setEconomicsAssumptions);

  const physical = useMemo(
    () =>
      getFinancePhysicalConfig({
        selectedConfigurations,
        liveConfiguration,
      }),
    [liveConfiguration, selectedConfigurations]
  );

  const metrics = useMemo(() => {
    if (!physical) {
      return null;
    }
    return computeEconomics(physical, economicsAssumptions);
  }, [economicsAssumptions, physical]);

  const breakdownData = metrics
    ? [
        { name: "Arbitrage", value: metrics.annualArbitrageRevenue },
        { name: "Peak Shaving", value: metrics.annualPeakShavingRevenue },
        { name: "Grid Services", value: metrics.annualGridServicesRevenue },
      ]
    : [];

  const hasPhysical = Boolean(physical);
  const usesAggregatedStack = selectedConfigurations.length > 0;

  return (
    <Card className="glass-card rounded-3xl">
      <CardHeader className="space-y-2">
        <p className="text-xs tracking-[0.2em] text-blue-600 uppercase dark:text-blue-300">
          Financial dashboard
        </p>
        <CardTitle className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">
          Revenue and project outlook
        </CardTitle>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Explore indicative Germany-focused economics based on your current Megapack sizing.
          We use your added configurations when available, otherwise your live preview.
        </p>
        {usesAggregatedStack ? (
          <p className="rounded-lg border border-slate-300/60 bg-white/60 px-3 py-2 text-xs text-slate-700 dark:border-slate-500/35 dark:bg-slate-900/50 dark:text-slate-200">
            KPIs are based on {selectedConfigurations.length} added configuration block(s),
            combined into one project view.
          </p>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-8">
        {!hasPhysical ? (
          <p className="rounded-xl border border-blue-400/45 bg-blue-500/10 p-4 text-sm text-blue-700 dark:text-blue-200">
            Adjust your setup in the configurator to unlock live KPIs and charts.
          </p>
        ) : null}

        <div className="space-y-2 rounded-xl border border-slate-300/60 bg-white/55 p-4 dark:border-slate-500/30 dark:bg-slate-900/45">
          <p className="text-xs font-medium tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            DE market / regulatory scenario (illustrative)
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            This is an illustrative scenario tool, not a legal or tariff database. Use it to test
            sensitivity and support customer discussions.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {REGULATORY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  setEconomicsAssumptions({ gridRegulatoryScenario: option.value })
                }
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                  economicsAssumptions.gridRegulatoryScenario === option.value
                    ? "border-blue-400 bg-blue-500/20 text-slate-900 dark:text-white"
                    : "border-slate-300/60 bg-white/70 text-slate-600 hover:border-slate-400 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:border-slate-400"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-300">
            {regulatoryScenarioDescription(economicsAssumptions.gridRegulatoryScenario)}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-2">
            <span className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">
              Full-cycle equivalents / day
            </span>
            <Slider
              value={[economicsAssumptions.fullCycleEquivalentsPerDay]}
              min={0.5}
              max={2}
              step={0.1}
              onValueChange={(value) =>
                setEconomicsAssumptions({
                  fullCycleEquivalentsPerDay: clamp(getSliderValue(value), 0.5, 2),
                })
              }
              className="[&_[data-slot=slider-range]]:bg-blue-500 dark:[&_[data-slot=slider-range]]:bg-blue-300"
            />
            <p className="text-sm text-slate-900 dark:text-white">
              {NUMBER_FORMATTER.format(economicsAssumptions.fullCycleEquivalentsPerDay)}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Nameplate MWh x cycle equivalents x 365 x RTE. Simplified operating profile.
            </p>
          </label>

          <label className="space-y-2">
            <span className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">
              Average price spread (EUR/MWh)
            </span>
            <input
              type="number"
              value={economicsAssumptions.averagePriceSpreadEurPerMwh}
              min={0}
              step={1}
              onChange={(event) =>
                setEconomicsAssumptions({
                  averagePriceSpreadEurPerMwh: Math.max(0, Number(event.target.value) || 0),
                })
              }
              className="apple-input"
            />
          </label>

          <label className="space-y-2">
            <span className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">
              Project lifetime (years)
            </span>
            <input
              type="number"
              value={economicsAssumptions.projectLifetimeYears}
              min={1}
              max={40}
              step={1}
              onChange={(event) =>
                setEconomicsAssumptions({
                  projectLifetimeYears: clamp(Number(event.target.value) || 1, 1, 40),
                })
              }
              className="apple-input"
            />
          </label>

          <label className="space-y-2">
            <span className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">
              Revenue inflation (%/year)
            </span>
            <input
              type="number"
              value={economicsAssumptions.electricityPriceInflationPercent}
              min={0}
              max={12}
              step={0.1}
              onChange={(event) =>
                setEconomicsAssumptions({
                  electricityPriceInflationPercent: clamp(
                    Number(event.target.value) || 0,
                    0,
                    12
                  ),
                })
              }
              className="apple-input"
            />
          </label>
        </div>

        {metrics && hasPhysical ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
            <KpiCard
              title="Annual discharged energy"
              value={`${NUMBER_FORMATTER.format(metrics.annualDischargedMwh)} MWh`}
            />
            <KpiCard title="Annual revenue" value={CURRENCY_FORMATTER.format(metrics.annualRevenue)} />
            <KpiCard
              title="Lifetime revenue"
              value={CURRENCY_FORMATTER.format(metrics.totalRevenueOverLifetime)}
            />
            <KpiCard
              title="Simple payback"
              value={`${NUMBER_FORMATTER.format(metrics.paybackYears)} yrs`}
            />
            <KpiCard title="IRR (gross)" value={`${NUMBER_FORMATTER.format(metrics.grossIrr)} %`} />
            <KpiCard title="LCOE" value={`${NUMBER_FORMATTER.format(metrics.lcoeEurPerMwh)} EUR/MWh`} />
          </div>
        ) : null}

        {metrics && hasPhysical ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-300/60 bg-white/55 p-4 dark:border-slate-500/30 dark:bg-slate-900/45">
              <p className="mb-4 text-sm font-medium text-slate-900 dark:text-white">
                Revenue over time
              </p>
              <ChartContainer>
                {({ width, height }) => (
                  <LineChart width={width} height={height} data={metrics.yearlyRevenues}>
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" />
                    <XAxis dataKey="year" stroke="#A1A1AA" />
                    <YAxis
                      stroke="#A1A1AA"
                      tickFormatter={(value) => `${Math.round(value / 1_000_000)}M`}
                    />
                    <Tooltip
                      formatter={(value) => formatCurrencyValue(value)}
                      contentStyle={{
                        background: "#121216",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: "10px",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="revenue"
                      stroke="#3b82f6"
                      strokeWidth={3}
                      dot={false}
                    />
                  </LineChart>
                )}
              </ChartContainer>
            </div>

            <div className="rounded-2xl border border-slate-300/60 bg-white/55 p-4 dark:border-slate-500/30 dark:bg-slate-900/45">
              <p className="mb-4 text-sm font-medium text-slate-900 dark:text-white">
                Revenue mix
              </p>
              <ChartContainer>
                {({ width, height }) => (
                  <BarChart width={width} height={height} data={breakdownData}>
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" />
                    <XAxis dataKey="name" stroke="#A1A1AA" />
                    <YAxis
                      stroke="#A1A1AA"
                      tickFormatter={(value) => `${Math.round(value / 1_000_000)}M`}
                    />
                    <Tooltip
                      formatter={(value) => formatCurrencyValue(value)}
                      contentStyle={{
                        background: "#121216",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: "10px",
                      }}
                    />
                    <Bar dataKey="value" fill="#3b82f6" radius={[8, 8, 0, 0]} />
                  </BarChart>
                )}
              </ChartContainer>
            </div>
          </div>
        ) : null}

        {metrics ? (
          <ul className="space-y-1 rounded-xl border border-slate-300/60 bg-white/55 p-4 text-xs text-slate-600 dark:border-slate-500/30 dark:bg-slate-900/45 dark:text-slate-300">
            {metrics.assumptionFootnotes.map((line) => (
              <li key={line}>• {line}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function KpiCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-300/60 bg-white/65 p-4 dark:border-slate-500/30 dark:bg-slate-900/55">
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      <p className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">{value}</p>
    </div>
  );
}
