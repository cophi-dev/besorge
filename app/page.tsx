"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import dynamic from "next/dynamic";

import FinancialDashboard from "@/components/FinancialDashboard";
import BessAssessmentCenter from "@/components/BessAssessmentCenter";
import GermanyMarketSnapshot from "@/components/GermanyMarketSnapshot";
import GenerateProposalButton from "@/components/GenerateProposalButton";
import MegapackConfigurator from "@/components/MegapackConfigurator";
import { getFinancePhysicalConfig, useProjectStore } from "@/lib/projectStore";

const MegapackMap = dynamic(() => import("@/components/MegapackMap"), {
  ssr: false,
});

function SectionIntro({
  label,
  title,
  description,
}: {
  label: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4 md:mb-5">
      <p className="section-kicker">{label}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white md:text-3xl">
        {title}
      </h2>
      <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300">{description}</p>
    </div>
  );
}

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
      <section id="overview" className="hero-block rounded-3xl px-8 py-14 md:px-14 md:py-16">
        <span className="apple-pill">TESLA BESS PLANNING HUB</span>
        <h1 className="mt-6 max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-slate-900 dark:text-white md:text-6xl">
          Plan your battery project with confidence
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-slate-600 dark:text-slate-300 md:text-xl">
          Build your Megapack setup, explore market assumptions, add site context on the map, and
          export a proposal PDF that stays in sync with your latest numbers.
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <a href="#bess-data" className="jump-card">
            BESS data
          </a>
          <a href="#market-data" className="jump-card">
            Current energy data
          </a>
          <a href="#ai-assessment" className="jump-card">
            AI assessment
          </a>
          <a href="#planning" className="jump-card">
            Plan your BESS
          </a>
        </div>
      </section>

      <section id="bess-data" className="section-frame section-frame-neutral rounded-3xl p-5 md:p-6">
        <SectionIntro
          label="BESS Data"
          title="Review BESS deployment context"
          description="Explore mapped utility-scale and distributed BESS context in Germany to ground your project in existing market footprint."
        />
        <MegapackMap />
      </section>

      <section id="market-data" className="section-frame section-frame-neutral rounded-3xl p-5 md:p-6">
        <SectionIntro
          label="Current Energy Data"
          title="Track the latest Germany power context"
          description="Use current and trailing indicators to align planning discussions with real system conditions."
        />
        <GermanyMarketSnapshot />
      </section>

      <section id="ai-assessment" className="section-frame section-frame-neutral rounded-3xl p-5 md:p-6">
        <SectionIntro
          label="AI Insights"
          title="Review AI-based decision support"
          description="Get a scored recommendation with key drivers, risks, and next actions based on current and historical market context."
        />
        <BessAssessmentCenter />
      </section>

      <section id="planning" className="section-frame section-frame-primary rounded-3xl p-5 md:p-6">
        <SectionIntro
          label="Planning"
          title="Plan your BESS setup"
          description="Define technical sizing and test indicative economics together to build your project baseline before export."
        />
        <MegapackConfigurator
          onAddToProject={addConfiguration}
          onConfigChange={setLiveConfiguration}
        />
        <div className="mt-6">
          <FinancialDashboard />
        </div>
      </section>

      <section id="export" className="section-frame section-frame-primary rounded-3xl p-6">
        <SectionIntro
          label="Export"
          title="Finalize and generate your proposal"
          description="Confirm your current project state, set the proposal name, and export a document synchronized with your latest assumptions."
        />
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.18em] text-blue-600 uppercase dark:text-blue-300">
              Project status
            </p>
            <h3 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
              Configurations added: {selectedConfigurations.length}
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {latestConfig
                ? `${latestConfig.count}x ${latestConfig.label} | ${latestConfig.totalPowerMw.toFixed(2)} MW | ${latestConfig.totalEnergyMwh.toFixed(2)} MWh`
                : "No configuration yet. Use the configurator to get started."}
            </p>
            {physical ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Financials and the PDF currently use{" "}
                {selectedConfigurations.length > 0
                  ? "your combined project configurations"
                  : "your live configurator preview"}
                .
              </p>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-2">
            {physical ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-blue-400/55 bg-blue-500/15 px-3 py-1 text-xs font-medium text-blue-600 dark:text-blue-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ready to export
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
            placeholder="e.g. Hamburg Grid Support Phase 1"
            className="apple-input"
          />
        </div>
      </section>
    </div>
  );
}
