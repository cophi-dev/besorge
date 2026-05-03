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
  { value: "baseline", label: "Baseline" },
  { value: "moderate_grid_stress", label: "Moderate grid stress" },
  { value: "elevated_regulatory_risk", label: "Elevated regulatory risk" },
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
    <Card className="glass-card rounded-3xl border border-white/10 bg-[#111116]/85">
      <CardHeader className="space-y-2">
        <p className="text-xs tracking-[0.2em] text-[#E31937] uppercase">Financial Dashboard</p>
        <CardTitle className="text-3xl font-semibold tracking-tight text-white">
          Revenue & Economics
        </CardTitle>
        <p className="text-sm text-[#A1A1AA]">
          Indicative DE-market economics tied to your Megapack sizing. Uses aggregated project
          blocks when you have added configurations; otherwise the live configurator preview.
        </p>
        {usesAggregatedStack ? (
          <p className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-[#D4D4D8]">
            Finanz-KPIs basieren auf {selectedConfigurations.length} hinzugefügten Block(en)
            (aggregiert).
          </p>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-8">
        {!hasPhysical ? (
          <p className="rounded-xl border border-[#E31937]/30 bg-[#E31937]/10 p-4 text-sm text-[#F5BDC7]">
            Passe im Konfigurator eine Anlage an, um Live-KPIs und Charts zu sehen.
          </p>
        ) : null}

        <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-4">
          <p className="text-xs font-medium tracking-[0.14em] text-[#A1A1AA] uppercase">
            DE market / regulatory scenario (illustrative)
          </p>
          <p className="text-xs text-[#737373]">
            Keine Rechts- oder Tarifdatenbank — nur Skalierung für Sensitivität und
            Gesprächsstruktur (vgl. Stellenprofil: Tarife & Regulatorik).
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
                    ? "border-[#E31937] bg-[#E31937]/20 text-white"
                    : "border-white/15 bg-white/5 text-[#A1A1AA] hover:border-white/25"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-[#A1A1AA]">
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
              className="[&_[data-slot=slider-range]]:bg-[#E31937]"
            />
            <p className="text-sm text-white">
              {NUMBER_FORMATTER.format(economicsAssumptions.fullCycleEquivalentsPerDay)}
            </p>
            <p className="text-xs text-[#737373]">
              Namenleistung MWh × Äquivalente × 365 × RTE — vereinfachtes Lastprofil.
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
              className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-white outline-none transition focus:border-[#E31937]/80"
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
              className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-white outline-none transition focus:border-[#E31937]/80"
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
              className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-white outline-none transition focus:border-[#E31937]/80"
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
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="mb-4 text-sm font-medium text-white">Revenue development</p>
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
                      stroke="#E31937"
                      strokeWidth={3}
                      dot={false}
                    />
                  </LineChart>
                )}
              </ChartContainer>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="mb-4 text-sm font-medium text-white">Revenue breakdown</p>
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
                    <Bar dataKey="value" fill="#E31937" radius={[8, 8, 0, 0]} />
                  </BarChart>
                )}
              </ChartContainer>
            </div>
          </div>
        ) : null}

        {metrics ? (
          <ul className="space-y-1 rounded-xl border border-white/10 bg-black/15 p-4 text-xs text-[#737373]">
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
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">{title}</p>
      <p className="mt-2 text-xl font-semibold text-white">{value}</p>
    </div>
  );
}
