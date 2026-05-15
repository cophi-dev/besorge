import type { PackType } from "@/lib/bessEconomics";

export type TeslaMegapackSpec = {
  id: PackType;
  label: string;
  powerMw: number;
  energyMwh: number;
  footprintM2: number;
  weightTons: number;
  efficiency: number;
};

export const teslaMegapackSpecs: Record<PackType, TeslaMegapackSpec> = {
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

export function getMegapackEquivalent(params: {
  powerMw: number;
  capacityMwh: number;
  referencePackType?: PackType;
}) {
  const { powerMw, capacityMwh, referencePackType = "megapack-2-xl" } = params;
  const referencePack = teslaMegapackSpecs[referencePackType];
  const packsByPower = referencePack.powerMw > 0 ? powerMw / referencePack.powerMw : 0;
  const packsByEnergy = referencePack.energyMwh > 0 ? capacityMwh / referencePack.energyMwh : 0;
  const requiredPacks = Math.max(packsByPower, packsByEnergy);

  return {
    referencePack,
    packsByPower,
    packsByEnergy,
    requiredPacks,
    roundedRequiredPacks: Math.ceil(requiredPacks),
  };
}
