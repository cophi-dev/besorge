"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import dynamic from "next/dynamic";

import FinancialDashboard from "@/components/FinancialDashboard";
import GenerateProposalButton from "@/components/GenerateProposalButton";
import MegapackConfigurator from "@/components/MegapackConfigurator";
import { getFinancePhysicalConfig, useProjectStore } from "@/lib/projectStore";

const MegapackMap = dynamic(() => import("@/components/MegapackMap"), {
  ssr: false,
});

export default function Home() {
  const [projectName, setProjectName] = useState("Tesla BESS Expansion");
  const selectedConfigurations = useProjectStore((state) => state.selectedConfigurations);
  const addConfiguration = useProjectStore((state) => state.addConfiguration);
  const setLiveConfiguration = useProjectStore((state) => state.setLiveConfiguration);
  const liveConfiguration = useProjectStore((state) => state.liveConfiguration);

  const physical = getFinancePhysicalConfig({
    selectedConfigurations,
    liveConfiguration,
  });
  const latestConfig = selectedConfigurations.at(-1) ?? liveConfiguration;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 pb-16 pt-14 lg:px-10">
      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.75, ease: "easeOut" }}
        className="glass-card tesla-glow rounded-3xl px-8 py-16 md:px-14"
      >
        <span className="inline-flex rounded-full border border-[#E31937]/45 bg-[#E31937]/15 px-4 py-2 text-xs tracking-[0.18em] text-[#E31937]">
          TESLA BESS PRE-SALES HUB
        </span>
        <h1 className="tesla-glow-text mt-6 max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-white md:text-6xl">
          Technical sizing & indicative economics
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-[#A1A1AA] md:text-xl">
          Hamburg / EMEA-oriented workflow: stack Megapacks, stress DE-market assumptions,
          capture map context, and export a proposal PDF aligned with the live financial model.
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
        <FinancialDashboard />
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
            <p className="text-xs tracking-[0.18em] text-[#E31937] uppercase">Project state</p>
            <h3 className="mt-2 text-2xl font-semibold text-white">
              Added configurations: {selectedConfigurations.length}
            </h3>
            <p className="mt-2 text-sm text-[#A1A1AA]">
              {latestConfig
                ? `${latestConfig.count}x ${latestConfig.label} | ${latestConfig.totalPowerMw.toFixed(2)} MW | ${latestConfig.totalEnergyMwh.toFixed(2)} MWh`
                : "No configuration preview yet — adjust the configurator."}
            </p>
            {physical ? (
              <p className="mt-2 text-xs text-[#737373]">
                Finance / PDF use{" "}
                {selectedConfigurations.length > 0
                  ? "aggregated project blocks"
                  : "the live configurator preview"}
                .
              </p>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-2">
            {physical ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-[#E31937]/50 bg-[#E31937]/15 px-3 py-1 text-xs font-medium text-[#E31937]">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ready
              </span>
            ) : null}
            <GenerateProposalButton projectName={projectName} />
          </div>
        </div>

        <div className="mt-5 max-w-md space-y-2">
          <label
            htmlFor="project-name"
            className="text-xs tracking-[0.14em] text-[#A1A1AA] uppercase"
          >
            Project name
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
