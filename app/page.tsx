"use client";

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";

import BessAssessmentCenter from "@/components/BessAssessmentCenter";

type MarketSnapshot = {
  retrievedAtIso: string;
  bess: {
    capacityUnit: "GWh";
    installedCapacityGwh: number;
    capacityYear: string;
    powerUnit: "GW";
    installedPowerGw: number;
    powerYear: string;
  };
  realtimeSystem: {
    unit: "MW";
    timestampIso: string;
    loadMw: number;
    domesticGenerationMw: number;
    residualLoadMw?: number;
    renewableShareOfLoadPct?: number;
  };
};

type Assessment = {
  score: number;
  shortTermSignal: string;
  verdict: "beneficial_now" | "not_beneficial_now" | "uncertain";
  scoreBreakdown: {
    volatility: number;
    adequacy: number;
  };
};

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const LIVE_UPDATE_LABEL = "Updated live";

function formatAdaptivePower(valueMw: number): string {
  if (Math.abs(valueMw) >= 1000) {
    return `${NUMBER_FORMATTER.format(valueMw / 1000)} GW`;
  }
  return `${NUMBER_FORMATTER.format(valueMw)} MW`;
}

export default function Home() {
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const loadData = async () => {
      const [marketResult, assessmentResult] = await Promise.allSettled([
        fetch("/api/market/de", { cache: "no-store", signal: controller.signal }),
        fetch("/api/assessment/de", { cache: "no-store", signal: controller.signal }),
      ]);

      if (marketResult.status === "fulfilled" && marketResult.value.ok) {
        setMarket((await marketResult.value.json()) as MarketSnapshot);
      }

      if (assessmentResult.status === "fulfilled" && assessmentResult.value.ok) {
        setAssessment((await assessmentResult.value.json()) as Assessment);
      }
    };
    void loadData();
    return () => controller.abort();
  }, []);

  const openAiChat = () => {
    window.dispatchEvent(new Event("aether:open-ai-chat"));
    window.location.hash = "ai-chat";
  };

  const renewableShareValue =
    market?.realtimeSystem.renewableShareOfLoadPct !== undefined
      ? `${NUMBER_FORMATTER.format(market.realtimeSystem.renewableShareOfLoadPct)}%`
      : market
        ? "temporarily unavailable"
        : "Loading...";

  const residualLoadValue =
    market?.realtimeSystem.residualLoadMw !== undefined
      ? formatAdaptivePower(market.realtimeSystem.residualLoadMw)
      : market
        ? formatAdaptivePower(market.realtimeSystem.loadMw - market.realtimeSystem.domesticGenerationMw)
        : "Loading...";

  const liveUpdateLabel = market
    ? `${LIVE_UPDATE_LABEL} • ${new Date(market.realtimeSystem.timestampIso).toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : `${LIVE_UPDATE_LABEL} • syncing`;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-16 px-8 pb-24 pt-16 lg:px-12">
      <section id="overview" className="space-y-8 border-b border-slate-300/45 pb-14">
        <p className="text-xs tracking-[0.12em] text-slate-500 uppercase">{liveUpdateLabel}</p>
        <h1 className="max-w-5xl text-5xl leading-tight text-slate-900 md:text-7xl [font-family:var(--font-heading)]">
          AETHER
        </h1>
        <p className="max-w-3xl text-xl text-slate-700 md:text-2xl">
          Clarity for Germany&apos;s energy transition
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600">
          Daily high-signal briefing for storage teams tracking demand stress, renewable penetration,
          and BESS deployment momentum.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <KpiCard
            title="Current demand"
            value={market ? formatAdaptivePower(market.realtimeSystem.loadMw) : "Loading..."}
            meaning="Live power needed in the grid."
          />
          <KpiCard
            title="Renewable share"
            value={renewableShareValue}
            meaning="Portion of demand served by renewables."
          />
          <KpiCard
            title="Residual Load"
            value={residualLoadValue}
            meaning="Demand remaining after renewable generation."
          />
          <KpiCard
            title="Installed BESS power"
            value={
              market
                ? `${NUMBER_FORMATTER.format(market.bess.installedPowerGw)} ${market.bess.powerUnit}`
                : "Loading..."
            }
            sublabel={market ? `(${market.bess.capacityYear})` : undefined}
            meaning="Operational utility-scale BESS power."
          />
          <KpiCard
            title="Installed BESS energy"
            value={
              market
                ? `${NUMBER_FORMATTER.format(market.bess.installedCapacityGwh)} ${market.bess.capacityUnit}`
                : "Loading..."
            }
            sublabel={market ? `(${market.bess.capacityYear})` : undefined}
            meaning="Available discharge energy capacity."
          />
        </div>
      </section>

      <section id="bess-value" className="space-y-8">
        <h2 className="text-3xl text-slate-900 md:text-4xl [font-family:var(--font-heading)]">
          Strategic Signal Review
        </h2>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <ValueCard
            title="Evening Stress"
            value={residualLoadValue}
            body="Net evening gap after solar fade."
          />
          <ValueCard
            title="Volatility"
            value={assessment ? `${Math.round(assessment.scoreBreakdown.volatility)}/100` : "n/a"}
            body="Short-term spread opportunity signal."
          />
          <ValueCard
            title="Ramps"
            value={assessment ? `${Math.round(assessment.scoreBreakdown.adequacy)}/100` : "n/a"}
            body="Fast-response value proxy."
          />
          <ValueCard
            title="Opportunity score"
            value={assessment ? `${Math.round(assessment.score)}/100` : "n/a"}
            body="Composite opportunity score now."
            tag={assessment ? assessment.verdict.replaceAll("_", " ") : undefined}
          />
        </div>
      </section>

      <section id="ai-assessment" className="rounded-3xl border border-slate-300/45 bg-white/65 p-6 md:p-9">
        <BessAssessmentCenter compact />
      </section>

      <button
        type="button"
        onClick={openAiChat}
        className="fixed right-6 bottom-6 z-40 inline-flex items-center gap-2 rounded-full border border-slate-300/75 bg-white/95 px-5 py-3 text-sm font-medium text-slate-800 transition hover:-translate-y-0.5 hover:border-primary hover:text-primary"
      >
        <MessageCircle className="h-4 w-4" />
        Ask the AETHER analyst
      </button>
    </div>
  );
}

function KpiCard({
  title,
  value,
  meaning,
  sublabel,
}: {
  title: string;
  value: string;
  meaning: string;
  sublabel?: string;
}) {
  return (
    <article className="border-l-2 border-primary/35 pl-4">
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase">{title}</p>
      <p className="mt-2 text-4xl font-black text-slate-900 md:text-5xl [font-family:var(--font-sans)]">
        {value}
      </p>
      {sublabel ? <p className="mt-1 text-xs text-slate-500">{sublabel}</p> : null}
      <p className="mt-2 text-sm leading-relaxed text-slate-700">{meaning}</p>
    </article>
  );
}

function ValueCard({
  title,
  value,
  body,
  tag,
}: {
  title: string;
  value: string;
  body: string;
  tag?: string;
}) {
  return (
    <article className="rounded-2xl border border-slate-300/50 bg-white/70 p-6">
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase">{title}</p>
      <p className="mt-3 text-4xl font-extrabold text-slate-900 [font-family:var(--font-sans)]">{value}</p>
      <p className="mt-3 text-sm leading-relaxed text-slate-700">{body}</p>
      {tag ? (
        <p className="mt-4 inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">
          {tag}
        </p>
      ) : null}
    </article>
  );
}
