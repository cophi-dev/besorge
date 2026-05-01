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

import type { ProjectMegapackConfig } from "@/components/MegapackConfigurator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";

type FinancialDashboardProps = {
  config?: ProjectMegapackConfig;
};

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

const formatCurrencyValue = (value: number | string | readonly (number | string)[] | undefined) => {
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

export default function FinancialDashboard({ config }: FinancialDashboardProps) {
  const [dailyCycles, setDailyCycles] = useState(1);
  const [priceSpread, setPriceSpread] = useState(85);
  const [projectLifetimeYears, setProjectLifetimeYears] = useState(20);
  const [inflationRate, setInflationRate] = useState(2);

  const powerMw = config?.totalPowerMw ?? 0;
  const energyMwh = config?.totalEnergyMwh ?? 0;
  const efficiency = (config?.roundTripEfficiency ?? 0) / 100;

  const metrics = useMemo(() => {
    const annualEnergyMwh = powerMw * energyMwh * efficiency * dailyCycles * 365;
    const annualArbitrageRevenue = annualEnergyMwh * priceSpread * 0.6;
    const annualPeakShavingRevenue = annualEnergyMwh * priceSpread * 0.25;
    const annualGridServicesRevenue = annualEnergyMwh * priceSpread * 0.15;
    const annualRevenue =
      annualArbitrageRevenue + annualPeakShavingRevenue + annualGridServicesRevenue;

    const capex = energyMwh * 220_000;
    const annualOperatingCosts = capex * 0.015;
    const annualNetCashflow = annualRevenue - annualOperatingCosts;

    const yearlyRevenues = Array.from({ length: projectLifetimeYears }, (_, idx) => {
      const year = idx + 1;
      const inflationMultiplier = (1 + inflationRate / 100) ** idx;
      const revenue = annualRevenue * inflationMultiplier;
      return {
        year,
        revenue,
      };
    });

    const totalRevenueOverLifetime = yearlyRevenues.reduce(
      (sum, entry) => sum + entry.revenue,
      0
    );

    const paybackYears =
      annualNetCashflow > 0 ? capex / annualNetCashflow : Number.POSITIVE_INFINITY;

    const grossIrr =
      capex > 0 && totalRevenueOverLifetime > 0
        ? ((totalRevenueOverLifetime / capex) ** (1 / projectLifetimeYears) - 1) * 100
        : 0;

    const lifetimeEnergy = annualEnergyMwh * projectLifetimeYears;
    const lcoe =
      lifetimeEnergy > 0
        ? (capex + annualOperatingCosts * projectLifetimeYears) / lifetimeEnergy
        : 0;

    return {
      annualRevenue,
      annualArbitrageRevenue,
      annualPeakShavingRevenue,
      annualGridServicesRevenue,
      yearlyRevenues,
      totalRevenueOverLifetime,
      paybackYears: Number.isFinite(paybackYears) ? paybackYears : 0,
      grossIrr,
      lcoe,
    };
  }, [dailyCycles, efficiency, energyMwh, inflationRate, powerMw, priceSpread, projectLifetimeYears]);

  const breakdownData = [
    { name: "Arbitrage", value: metrics.annualArbitrageRevenue },
    { name: "Peak Shaving", value: metrics.annualPeakShavingRevenue },
    { name: "Grid Services", value: metrics.annualGridServicesRevenue },
  ];

  const hasConfig = Boolean(config);

  return (
    <Card className="glass-card rounded-3xl border border-white/10 bg-[#111116]/85">
      <CardHeader className="space-y-2">
        <p className="text-xs tracking-[0.2em] text-[#E31937] uppercase">Financial Dashboard</p>
        <CardTitle className="text-3xl font-semibold tracking-tight text-white">
          Revenue & Economics
        </CardTitle>
        <p className="text-sm text-[#A1A1AA]">
          Live-Finanzmodell basierend auf deiner aktuellen Megapack-Konfiguration.
        </p>
      </CardHeader>

      <CardContent className="space-y-8">
        {!hasConfig ? (
          <p className="rounded-xl border border-[#E31937]/30 bg-[#E31937]/10 p-4 text-sm text-[#F5BDC7]">
            Passe im Konfigurator eine Anlage an, um Live-KPIs und Charts zu sehen.
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-2">
            <span className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">
              Expected Daily Cycles
            </span>
            <Slider
              value={[dailyCycles]}
              min={0.5}
              max={2}
              step={0.1}
              onValueChange={(value) => setDailyCycles(clamp(getSliderValue(value), 0.5, 2))}
              className="[&_[data-slot=slider-range]]:bg-[#E31937]"
            />
            <p className="text-sm text-white">{NUMBER_FORMATTER.format(dailyCycles)}</p>
          </label>

          <label className="space-y-2">
            <span className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">
              Average Price Spread (EUR/MWh)
            </span>
            <input
              type="number"
              value={priceSpread}
              min={0}
              step={1}
              onChange={(event) => setPriceSpread(Math.max(0, Number(event.target.value) || 0))}
              className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-white outline-none transition focus:border-[#E31937]/80"
            />
          </label>

          <label className="space-y-2">
            <span className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">
              Project Lifetime (Jahre)
            </span>
            <input
              type="number"
              value={projectLifetimeYears}
              min={1}
              max={40}
              step={1}
              onChange={(event) =>
                setProjectLifetimeYears(clamp(Number(event.target.value) || 1, 1, 40))
              }
              className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-white outline-none transition focus:border-[#E31937]/80"
            />
          </label>

          <label className="space-y-2">
            <span className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase">
              Electricity Price Inflation (%)
            </span>
            <input
              type="number"
              value={inflationRate}
              min={0}
              max={12}
              step={0.1}
              onChange={(event) => setInflationRate(clamp(Number(event.target.value) || 0, 0, 12))}
              className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-white outline-none transition focus:border-[#E31937]/80"
            />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <KpiCard title="Annual Revenue" value={CURRENCY_FORMATTER.format(metrics.annualRevenue)} />
          <KpiCard
            title="Total Revenue over Lifetime"
            value={CURRENCY_FORMATTER.format(metrics.totalRevenueOverLifetime)}
          />
          <KpiCard
            title="Simple Payback"
            value={`${NUMBER_FORMATTER.format(metrics.paybackYears)} Jahre`}
          />
          <KpiCard title="IRR (grob)" value={`${NUMBER_FORMATTER.format(metrics.grossIrr)} %`} />
          <KpiCard title="LCOE" value={`${NUMBER_FORMATTER.format(metrics.lcoe)} EUR/MWh`} />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="mb-4 text-sm font-medium text-white">Revenue Development</p>
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
            <p className="mb-4 text-sm font-medium text-white">Revenue Breakdown</p>
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
