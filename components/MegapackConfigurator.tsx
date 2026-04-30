"use client";

import { type ComponentType, useEffect, useMemo, useState } from "react";
import { animate, motion } from "framer-motion";
import { BatteryCharging, LayoutGrid, Weight, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type PackType = "megapack-2-xl" | "megapack-2" | "custom";

type PackSpec = {
  id: PackType;
  label: string;
  powerMw: number;
  energyMwh: number;
  footprintM2: number;
  weightTons: number;
  efficiency: number;
};

export type ProjectMegapackConfig = {
  packType: PackType;
  label: string;
  count: number;
  totalPowerMw: number;
  totalEnergyMwh: number;
  footprintM2: number;
  weightTons: number;
  roundTripEfficiency: number;
};

type MegapackConfiguratorProps = {
  onAddToProject: (config: ProjectMegapackConfig) => void;
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

function AnimatedValue({
  value,
  decimals = 1,
}: {
  value: number;
  decimals?: number;
}) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const controls = animate(displayValue, value, {
      duration: 0.6,
      ease: "easeOut",
      onUpdate: (latest) => setDisplayValue(latest),
    });
    return () => controls.stop();
  }, [displayValue, value]);

  return <span>{displayValue.toFixed(decimals)}</span>;
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
    <motion.div
      key={`${title}-${value}`}
      initial={{ boxShadow: "0 0 0 0 rgba(227, 25, 55, 0)" }}
      animate={{
        boxShadow: [
          "0 0 0 0 rgba(227, 25, 55, 0)",
          "0 0 30px 2px rgba(227, 25, 55, 0.35)",
          "0 0 0 0 rgba(227, 25, 55, 0)",
        ],
      }}
      transition={{ duration: 0.8, ease: "easeOut" }}
      className="rounded-xl"
    >
      <Card className="glass-card rounded-xl border border-white/10 bg-[#121216]/80">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs tracking-[0.16em] text-[#A1A1AA] uppercase">
            <Icon className="h-3.5 w-3.5 text-[#E31937]" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
            <AnimatedValue value={value} decimals={decimals} />{" "}
            <span className="text-base font-medium text-[#A1A1AA]">{unit}</span>
          </p>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default function MegapackConfigurator({
  onAddToProject,
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

  return (
    <Card className="glass-card tesla-glow rounded-3xl border border-white/10 bg-[#111116]/85 p-0">
      <CardContent className="space-y-8 p-6 md:p-8">
        <div className="space-y-3">
          <p className="text-xs tracking-[0.2em] text-[#E31937] uppercase">
            Megapack Configurator
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-white">
            Utility-Scale Battery Sizing
          </h2>
          <p className="text-sm text-[#A1A1AA]">
            Tesla-like sizing workflow with live technical preview.
          </p>
        </div>

        <Tabs value={packType} onValueChange={(value) => setPackType(value as PackType)}>
          <TabsList
            className="h-auto w-full rounded-xl border border-white/10 bg-white/5 p-1"
            variant="default"
          >
            <TabsTrigger
              value="megapack-2-xl"
              className="data-active:bg-[#E31937] data-active:text-white"
            >
              Megapack 2 XL
            </TabsTrigger>
            <TabsTrigger
              value="megapack-2"
              className="data-active:bg-[#E31937] data-active:text-white"
            >
              Megapack 2
            </TabsTrigger>
            <TabsTrigger
              value="custom"
              className="data-active:bg-[#E31937] data-active:text-white"
            >
              Custom
            </TabsTrigger>
          </TabsList>

          <TabsContent value={packType} className="mt-6 space-y-6">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs tracking-[0.16em] text-[#A1A1AA] uppercase">
                  Number of Megapacks
                </span>
                <motion.span
                  key={count}
                  initial={{ scale: 1.08, color: "#E31937" }}
                  animate={{ scale: 1, color: "#FFFFFF" }}
                  className="text-xl font-semibold"
                >
                  {count}
                </motion.span>
              </div>
              <Slider
                value={[count]}
                min={1}
                max={50}
                step={1}
                onValueChange={(value) => setCount(value[0] ?? 1)}
                className="[&_[data-slot=slider-range]]:bg-[#E31937]"
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

            <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-[#E31937]/35 bg-[#E31937]/10 p-5 md:flex-row md:items-center">
              <div className="space-y-1">
                <p className="text-xs tracking-[0.16em] text-[#E31937] uppercase">
                  Round-trip Efficiency
                </p>
                <p className="text-lg font-semibold text-white">
                  {selectedPack.efficiency.toFixed(1)}%
                </p>
              </div>
              <Button
                className="h-10 rounded-full bg-[#E31937] px-6 font-semibold text-white hover:bg-[#f02445]"
                onClick={() =>
                  onAddToProject({
                    packType,
                    label: selectedPack.label,
                    count,
                    totalPowerMw: totals.totalPowerMw,
                    totalEnergyMwh: totals.totalEnergyMwh,
                    footprintM2: totals.footprintM2,
                    weightTons: totals.weightTons,
                    roundTripEfficiency: selectedPack.efficiency,
                  })
                }
              >
                Add to Project
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
