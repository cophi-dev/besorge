"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import dynamic from "next/dynamic";
import { create } from "zustand";

import FinancialDashboard from "@/components/FinancialDashboard";
import GenerateProposalButton from "@/components/GenerateProposalButton";
import MegapackConfigurator, {
  type ProjectMegapackConfig,
} from "@/components/MegapackConfigurator";

const MegapackMap = dynamic(() => import("@/components/MegapackMap"), {
  ssr: false,
});

type ProjectStore = {
  selectedConfigurations: ProjectMegapackConfig[];
  addConfiguration: (config: ProjectMegapackConfig) => void;
};

const useProjectStore = create<ProjectStore>((set) => ({
  selectedConfigurations: [],
  addConfiguration: (config) =>
    set((state) => ({
      selectedConfigurations: [...state.selectedConfigurations, config],
    })),
}));

export default function Home() {
  const [liveConfiguration, setLiveConfiguration] =
    useState<ProjectMegapackConfig | undefined>(undefined);
  const [projectName, setProjectName] = useState("Tesla BESS Expansion");
  const selectedConfigurations = useProjectStore(
    (state) => state.selectedConfigurations
  );
  const addConfiguration = useProjectStore((state) => state.addConfiguration);
  const latestConfig = selectedConfigurations.at(-1);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 pb-16 pt-14 lg:px-10">
      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.75, ease: "easeOut" }}
        className="glass-card tesla-glow rounded-3xl px-8 py-16 md:px-14"
      >
        <span className="inline-flex rounded-full border border-[#E31937]/45 bg-[#E31937]/15 px-4 py-2 text-xs tracking-[0.18em] text-[#E31937]">
          TESLA BESS CONTROL HUB
        </span>
        <h1 className="tesla-glow-text mt-6 max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-white md:text-6xl">
          Configure Your Megapack Project
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-[#A1A1AA] md:text-xl">
          Clean, Tesla-like sizing with live technical preview and project state.
        </p>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: "easeOut", delay: 0.1 }}
      >
        <MegapackConfigurator
          onAddToProject={addConfiguration}
          onConfigChange={setLiveConfiguration}
        />
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: "easeOut", delay: 0.2 }}
      >
        <FinancialDashboard config={liveConfiguration} />
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: "easeOut", delay: 0.3 }}
      >
        <MegapackMap />
      </motion.section>

      <section className="glass-card rounded-2xl border border-white/10 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.18em] text-[#E31937] uppercase">
              Project State
            </p>
            <h3 className="mt-2 text-2xl font-semibold text-white">
              Added Configurations: {selectedConfigurations.length}
            </h3>
            <p className="mt-2 text-sm text-[#A1A1AA]">
              {latestConfig
                ? `${latestConfig.count}x ${latestConfig.label} | ${latestConfig.totalPowerMw.toFixed(2)} MW | ${latestConfig.totalEnergyMwh.toFixed(2)} MWh`
                : "No configuration added yet."}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {latestConfig ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-[#E31937]/50 bg-[#E31937]/15 px-3 py-1 text-xs font-medium text-[#E31937]">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ready
              </span>
            ) : null}
            <GenerateProposalButton
              projectName={projectName}
              config={liveConfiguration}
            />
          </div>
        </div>

        <div className="mt-5 max-w-md space-y-2">
          <label
            htmlFor="project-name"
            className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase"
          >
            Project Name
          </label>
          <input
            id="project-name"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="Enter project name"
            className="h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-white outline-none transition focus:border-[#E31937]/80"
          />
        </div>
      </section>
    </div>
  );
}
