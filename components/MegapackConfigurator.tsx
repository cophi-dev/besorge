"use client";

import { type ComponentType, useEffect, useMemo, useState } from "react";
import { BatteryCharging, LayoutGrid, Weight, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PackType, ProjectMegapackConfig } from "@/lib/bessEconomics";

export type { ProjectMegapackConfig } from "@/lib/bessEconomics";

type PackSpec = {
  id: PackType;
  label: string;
  powerMw: number;
  energyMwh: number;
  footprintM2: number;
  weightTons: number;
  efficiency: number;
};

type MegapackConfiguratorProps = {
  onAddToProject: (config: ProjectMegapackConfig) => void;
  onConfigChange?: (config: ProjectMegapackConfig) => void;
};

const packSpecs: Record<PackType, PackSpec> = {
  "megapack-2-xl": {
    id: "megapack-2-xl",
    label: "Megapack 2 XL",
    powerMw: 1.927,
    energyMwh: 3.854,
    footprintM2: 57.4,
    weightTons: 38.2,
    efficiency: 92.5,
  },
  "megapack-2": {
    id: "megapack-2",
    label: "Megapack 2",
    powerMw: 1.9,
    energyMwh: 3.2,
    footprintM2: 52.1,
    weightTons: 35.8,
    efficiency: 92.0,
  },
  custom: {
    id: "custom",
    label: "Custom",
    powerMw: 2.2,
    energyMwh: 4.1,
    footprintM2: 59.6,
    weightTons: 39.4,
    efficiency: 92.5,
  },
};

const getSliderValue = (value: number | readonly number[]) =>
  Array.isArray(value) ? value[0] ?? 0 : value;

function AnimatedValue({
  value,
  decimals = 1,
}: {
  value: number;
  decimals?: number;
}) {
  return <span>{value.toFixed(decimals)}</span>;
}

function MetricCard({
  title,
  value,
  unit,
  icon: Icon,
  decimals = 1,
}: {
  title: string;
  value: number;
  unit: string;
  icon: ComponentType<{ className?: string }>;
  decimals?: number;
}) {
  return (
    <div className="rounded-xl">
      <Card className="glass-card rounded-xl border-slate-300/60 dark:border-slate-500/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs tracking-[0.16em] text-slate-500 uppercase dark:text-slate-300">
            <Icon className="h-3.5 w-3.5 text-blue-500 dark:text-blue-300" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white md:text-4xl">
            <AnimatedValue value={value} decimals={decimals} />{" "}
            <span className="text-base font-medium text-slate-500 dark:text-slate-300">{unit}</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function MegapackConfigurator({
  onAddToProject,
  onConfigChange,
}: MegapackConfiguratorProps) {
  const [packType, setPackType] = useState<PackType>("megapack-2-xl");
  const [count, setCount] = useState(12);

  const selectedPack = packSpecs[packType];

  const totals = useMemo(() => {
    return {
      totalPowerMw: selectedPack.powerMw * count,
      totalEnergyMwh: selectedPack.energyMwh * count,
      footprintM2: selectedPack.footprintM2 * count,
      weightTons: selectedPack.weightTons * count,
    };
  }, [count, selectedPack]);

  const liveConfig = useMemo<ProjectMegapackConfig>(
    () => ({
      packType,
      label: selectedPack.label,
      count,
      totalPowerMw: totals.totalPowerMw,
      totalEnergyMwh: totals.totalEnergyMwh,
      footprintM2: totals.footprintM2,
      weightTons: totals.weightTons,
      roundTripEfficiency: selectedPack.efficiency,
    }),
    [count, packType, selectedPack.efficiency, selectedPack.label, totals]
  );

  useEffect(() => {
    onConfigChange?.(liveConfig);
  }, [liveConfig, onConfigChange]);

  return (
    <Card className="glass-card rounded-3xl p-0">
      <CardContent className="space-y-8 p-6 md:p-8">
        <div className="space-y-3">
          <p className="text-xs tracking-[0.2em] text-blue-600 uppercase dark:text-blue-300">
            Planning workspace
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">
            Configure your BESS sizing
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Pick a Megapack type and quantity to generate the technical baseline used across the
            rest of this page.
          </p>
        </div>

        <Tabs value={packType} onValueChange={(value) => setPackType(value as PackType)}>
          <TabsList
            className="h-auto w-full rounded-xl border border-slate-300/60 bg-white/55 p-1 dark:border-slate-500/30 dark:bg-slate-900/45"
            variant="default"
          >
            <TabsTrigger
              value="megapack-2-xl"
              className="data-active:bg-blue-500 data-active:text-white dark:data-active:bg-blue-400 dark:data-active:text-slate-900"
            >
              Megapack 2 XL
            </TabsTrigger>
            <TabsTrigger
              value="megapack-2"
              className="data-active:bg-blue-500 data-active:text-white dark:data-active:bg-blue-400 dark:data-active:text-slate-900"
            >
              Megapack 2
            </TabsTrigger>
            <TabsTrigger
              value="custom"
              className="data-active:bg-blue-500 data-active:text-white dark:data-active:bg-blue-400 dark:data-active:text-slate-900"
            >
              Custom
            </TabsTrigger>
          </TabsList>

          <TabsContent value={packType} className="mt-6 space-y-6">
            <div className="rounded-2xl border border-slate-300/60 bg-white/55 p-5 dark:border-slate-500/30 dark:bg-slate-900/45">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs tracking-[0.16em] text-slate-500 uppercase dark:text-slate-300">
                  Number of units
                </span>
                <span className="text-xl font-semibold">
                  {count}
                </span>
              </div>
              <Slider
                value={[count]}
                min={1}
                max={50}
                step={1}
                onValueChange={(value) => setCount(getSliderValue(value))}
                className="[&_[data-slot=slider-range]]:bg-blue-500 dark:[&_[data-slot=slider-range]]:bg-blue-300"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <MetricCard title="Total Power" value={totals.totalPowerMw} unit="MW" icon={Zap} decimals={2} />
              <MetricCard
                title="Total Energy"
                value={totals.totalEnergyMwh}
                unit="MWh"
                icon={BatteryCharging}
                decimals={2}
              />
              <MetricCard
                title="Footprint"
                value={totals.footprintM2}
                unit="m²"
                icon={LayoutGrid}
                decimals={0}
              />
              <MetricCard
                title="Estimated Weight"
                value={totals.weightTons}
                unit="tons"
                icon={Weight}
                decimals={1}
              />
            </div>

            <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-blue-400/45 bg-blue-500/10 p-5 md:flex-row md:items-center dark:border-blue-300/45 dark:bg-blue-300/12">
              <div className="space-y-1">
                <p className="text-xs tracking-[0.16em] text-blue-600 uppercase dark:text-blue-300">
                  Round-trip Efficiency
                </p>
                <p className="text-lg font-semibold text-slate-900 dark:text-white">
                  {selectedPack.efficiency.toFixed(1)}%
                </p>
              </div>
              <Button
                className="h-10 rounded-full bg-blue-500 px-6 font-semibold text-white hover:bg-blue-600 dark:bg-blue-300 dark:text-slate-900 dark:hover:bg-blue-200"
                onClick={() => onAddToProject(liveConfig)}
              >
                Add configuration
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
