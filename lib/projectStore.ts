import { create } from "zustand";
import { z } from "zod";

import {
  aggregateProjectConfigurations,
  defaultEconomicsAssumptions,
  parseEconomicsAssumptions,
  projectMegapackConfigSchema,
  type EconomicsAssumptions,
  type ProjectMegapackConfig,
} from "@/lib/bessEconomics";

export const sitePlacementSchema = z.object({
  id: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
  capacityMwh: z.number().positive(),
  linkedLabel: z.string().optional(),
});

export type SitePlacement = z.infer<typeof sitePlacementSchema>;

export type ProjectStoreState = {
  liveConfiguration: ProjectMegapackConfig | undefined;
  selectedConfigurations: ProjectMegapackConfig[];
  economicsAssumptions: EconomicsAssumptions;
  sitePlacements: SitePlacement[];
  setLiveConfiguration: (config: ProjectMegapackConfig | undefined) => void;
  addConfiguration: (config: ProjectMegapackConfig) => void;
  setEconomicsAssumptions: (patch: Partial<EconomicsAssumptions>) => void;
  setSitePlacements: (placements: SitePlacement[]) => void;
  addSitePlacement: (placement: Omit<SitePlacement, "id"> & { id?: string }) => void;
  clearSitePlacements: () => void;
};

export function getFinancePhysicalConfig(state: {
  selectedConfigurations: ProjectMegapackConfig[];
  liveConfiguration: ProjectMegapackConfig | undefined;
}): ProjectMegapackConfig | null {
  if (state.selectedConfigurations.length > 0) {
    return aggregateProjectConfigurations(state.selectedConfigurations);
  }
  return state.liveConfiguration ?? null;
}

export const useProjectStore = create<ProjectStoreState>((set) => ({
  liveConfiguration: undefined,
  selectedConfigurations: [],
  economicsAssumptions: defaultEconomicsAssumptions,
  sitePlacements: [],
  setLiveConfiguration: (config) =>
    set({
      liveConfiguration: config ? projectMegapackConfigSchema.parse(config) : undefined,
    }),
  addConfiguration: (config) =>
    set((state) => ({
      selectedConfigurations: [
        ...state.selectedConfigurations,
        projectMegapackConfigSchema.parse(config),
      ],
    })),
  setEconomicsAssumptions: (patch) =>
    set((state) => ({
      economicsAssumptions: parseEconomicsAssumptions({
        ...state.economicsAssumptions,
        ...patch,
      }),
    })),
  setSitePlacements: (placements) =>
    set({
      sitePlacements: placements.map((placement) => sitePlacementSchema.parse(placement)),
    }),
  addSitePlacement: (placement) =>
    set((state) => ({
      sitePlacements: [
        ...state.sitePlacements,
        sitePlacementSchema.parse({
          ...placement,
          id: placement.id ?? globalThis.crypto.randomUUID(),
        }),
      ],
    })),
  clearSitePlacements: () => set({ sitePlacements: [] }),
}));
