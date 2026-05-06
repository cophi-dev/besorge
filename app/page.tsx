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
const DATA_FETCH_RETRIES = 2;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function formatAdaptivePower(valueMw: number): string {
  if (Math.abs(valueMw) >= 1000) {
    return `${NUMBER_FORMATTER.format(valueMw / 1000)} GW`;
  }
  return `${NUMBER_FORMATTER.format(valueMw)} MW`;
}

function buildTodaysKeyStory({
  market,
  assessment,
  residualLoadValue,
}: {
  market: MarketSnapshot | null;
  assessment: Assessment | null;
  residualLoadValue: string;
}): string {
  if (!market || !assessment) {
    return "Live data is syncing, and the market setup remains constructive for disciplined BESS positioning. Germany is entering a familiar evening stress window where fast-response capacity consistently earns value. Focus stays on execution quality rather than headline momentum.";
  }

  const volatility = Math.round(assessment.scoreBreakdown.volatility);
  const opportunity = Math.round(assessment.score);
  const bessPower = `${NUMBER_FORMATTER.format(market.bess.installedPowerGw)} ${market.bess.powerUnit}`;

  const confidenceCue =
    opportunity >= 60
      ? "supporting near-term additions with disciplined execution"
      : opportunity >= 45
        ? "mixed but viable for selective additions"
        : "cautious, favoring tightly risk-controlled deployments";

  return `Germany is carrying elevated residual load near ${residualLoadValue} as solar output fades into the evening window. Volatility at ${volatility}/100 and opportunity at ${opportunity}/100 are ${confidenceCue}. The existing ${bessPower} fleet helps stabilize conditions, but peak-hour headroom remains. Near-term value favors teams that keep dispatch discipline and conservative assumptions.`;
}

export default function Home() {
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const fetchJsonWithRetry = async <T,>(url: string): Promise<T> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= DATA_FETCH_RETRIES; attempt += 1) {
        try {
          const response = await fetch(url, { cache: "no-store", signal: controller.signal });
          if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
          }
          return (await response.json()) as T;
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted || attempt >= DATA_FETCH_RETRIES) {
            break;
          }
          await sleep(250 * 2 ** attempt);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Unknown request failure");
    };

    const loadData = async () => {
      const [marketResult, assessmentResult] = await Promise.allSettled([
        fetchJsonWithRetry<MarketSnapshot>("/api/market/de"),
        fetchJsonWithRetry<Assessment>("/api/assessment/de"),
      ]);

      if (marketResult.status === "fulfilled") {
        setMarket(marketResult.value);
      }

      if (assessmentResult.status === "fulfilled") {
        setAssessment(assessmentResult.value);
      }
    };
    void loadData();
    return () => controller.abort();
  }, []);

  const openAiChat = () => {
    window.dispatchEvent(
      new CustomEvent("aether:open-ai-chat", {
        detail: {
          prompt: "Ask Grok about the data: what are the biggest opportunities and risks right now?",
        },
      })
    );
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
  const todaysKeyStory = buildTodaysKeyStory({ market, assessment, residualLoadValue });
  const volatilityScore = assessment ? Math.round(assessment.scoreBreakdown.volatility) : null;
  const rampScore = assessment ? Math.round(assessment.scoreBreakdown.adequacy) : null;
  const opportunityScore = assessment ? Math.round(assessment.score) : null;

  const eveningStressInsight = market
    ? `Residual load remains around ${residualLoadValue}, marking the evening deficit window BESS can target between 17:00-21:00.`
    : "Live residual load is syncing, but evening net-demand stress is typically where flexible storage captures the cleanest spreads.";
  const eveningStressWhy = market
    ? "Why this matters: This is the dispatch gap where battery response speed translates directly into profitable peak-shaving and balancing value."
    : "Why this matters: Confirming evening stress sets the baseline for sizing and dispatch assumptions in commercial proposals.";

  const volatilityInsight =
    volatilityScore !== null
      ? volatilityScore >= 55
        ? `Volatility at ${volatilityScore}/100 signals above-baseline spread movement and supports active arbitrage plus balancing revenue this week.`
        : `Volatility at ${volatilityScore}/100 is moderate, with selective arbitrage windows rather than broad, all-day spread capture.`
      : "Volatility is syncing; once above 55, market movement typically supports meaningful arbitrage and balancing opportunities.";
  const volatilityWhy =
    volatilityScore !== null
      ? "Why this matters: Volatility is the fastest proxy for monetizable price dislocations, which drive gross margin per cycle."
      : "Why this matters: This signal helps decide whether to emphasize arbitrage economics or stack other value streams in sizing discussions.";

  const rampsInsight =
    rampScore !== null
      ? rampScore >= 60
        ? `Ramps at ${rampScore}/100 indicate elevated balancing pressure, so fast-response assets should stay actively utilized in near-term operations.`
        : `Ramps at ${rampScore}/100 indicate moderate variability, and the current fleet appears to be absorbing most short-term fluctuations.`
      : "Ramp pressure is syncing; moderate values usually indicate manageable variability with targeted balancing opportunities.";
  const rampsWhy =
    rampScore !== null
      ? "Why this matters: Ramp intensity maps directly to the operational value of sub-second response and reserve-ready battery capacity."
      : "Why this matters: It clarifies how much additional fast-response capacity can improve reliability and dispatch outcomes.";

  const opportunityInsight =
    opportunityScore !== null
      ? opportunityScore >= 60
        ? `Opportunity at ${opportunityScore}/100 is currently constructive, with multiple signals aligned for near-term BESS value capture.`
        : opportunityScore >= 45
          ? `Opportunity at ${opportunityScore}/100 is mixed but investable, favoring targeted deployments with disciplined dispatch assumptions.`
          : `Opportunity at ${opportunityScore}/100 is currently soft, suggesting selective commitment until stronger stress and spread signals reappear.`
      : "Opportunity score is syncing; this composite will summarize whether current conditions support immediate BESS value capture.";
  const opportunityWhy =
    opportunityScore !== null
      ? "Why this matters: The composite view helps convert noisy live metrics into a clear go/hold signal for commercial timing decisions."
      : "Why this matters: This headline signal keeps stakeholder decisions aligned when underlying metrics update at different speeds.";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-14 px-8 pb-24 pt-16 lg:px-12">
      <section id="overview" className="space-y-9 border-b border-slate-300/45 pb-14 dark:border-slate-500/35">
        <p className="text-xs tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{liveUpdateLabel}</p>
        <h1 className="max-w-5xl text-5xl leading-tight text-slate-900 md:text-7xl dark:text-white [font-family:var(--font-heading)]">
          AETHER
        </h1>
        <p className="max-w-3xl text-xl text-slate-700 dark:text-slate-200 md:text-2xl">
          Clarity for Germany&apos;s energy transition
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
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
        <article className="rounded-2xl border border-slate-300/45 bg-white/70 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
          <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            Today&apos;s Key Story
          </p>
          <p className="mt-3 max-w-5xl text-sm leading-relaxed text-slate-700 dark:text-slate-200">
            {todaysKeyStory}
          </p>
        </article>
      </section>

      <section id="bess-value" className="space-y-8">
        <h2 className="text-3xl text-slate-900 dark:text-white md:text-4xl [font-family:var(--font-heading)]">
          Strategic Signal Review
        </h2>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <ValueCard
            title="Evening Stress"
            value={residualLoadValue}
            insight={eveningStressInsight}
            whyThisMatters={eveningStressWhy}
          />
          <ValueCard
            title="Volatility"
            value={volatilityScore !== null ? `${volatilityScore}/100` : "n/a"}
            insight={volatilityInsight}
            whyThisMatters={volatilityWhy}
          />
          <ValueCard
            title="Ramps"
            value={rampScore !== null ? `${rampScore}/100` : "n/a"}
            insight={rampsInsight}
            whyThisMatters={rampsWhy}
          />
          <ValueCard
            title="Opportunity score"
            value={opportunityScore !== null ? `${opportunityScore}/100` : "n/a"}
            insight={opportunityInsight}
            whyThisMatters={opportunityWhy}
            tag={assessment ? assessment.verdict.replaceAll("_", " ") : undefined}
          />
        </div>
      </section>

      <section
        className="mx-auto w-full max-w-4xl rounded-2xl border border-slate-300/35 bg-white/55 p-4 dark:border-slate-500/35 dark:bg-slate-900/35 md:p-5"
        id="ai-assessment"
      >
        <BessAssessmentCenter compact />
      </section>

      <button
        type="button"
        onClick={openAiChat}
        className="group fixed right-6 bottom-6 z-40 w-[min(330px,calc(100vw-3rem))] rounded-2xl border border-blue-400/35 bg-white/95 px-5 py-4 text-left text-slate-900 shadow-[0_14px_34px_rgba(37,99,235,0.14)] transition hover:-translate-y-0.5 hover:border-blue-500/65 hover:shadow-[0_18px_40px_rgba(37,99,235,0.2)] dark:border-blue-300/35 dark:bg-slate-900/95 dark:text-slate-100 dark:hover:border-blue-300/70"
        aria-label="Ask AETHER anything"
      >
        <span className="inline-flex items-center gap-2 text-[11px] tracking-[0.14em] text-blue-700 uppercase dark:text-blue-200">
          <MessageCircle className="h-4 w-4" />
          Insight mode
        </span>
        <span className="mt-1 block text-sm font-semibold md:text-base">Ask AETHER anything.</span>
        <span className="mt-1 block text-xs text-slate-600 dark:text-slate-300">
          Trends, risks, and what to do next.
        </span>
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
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      <p className="mt-2 text-4xl font-black text-slate-900 dark:text-white md:text-5xl [font-family:var(--font-sans)]">
        {value}
      </p>
      {sublabel ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-300">{sublabel}</p> : null}
      <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{meaning}</p>
    </article>
  );
}

function ValueCard({
  title,
  value,
  insight,
  whyThisMatters,
  tag,
}: {
  title: string;
  value: string;
  insight: string;
  whyThisMatters: string;
  tag?: string;
}) {
  return (
    <article className="rounded-2xl border border-slate-300/50 bg-white/70 p-6 dark:border-slate-500/40 dark:bg-slate-900/70">
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      <p className="mt-3 text-4xl font-extrabold text-slate-900 dark:text-white [font-family:var(--font-sans)]">{value}</p>
      <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{insight}</p>
      <p className="mt-4 text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">
        Why this matters
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
        {whyThisMatters.replace(/^Why this matters:\s*/i, "")}
      </p>
      {tag ? (
        <p className="mt-4 inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary dark:text-blue-100">
          {tag}
        </p>
      ) : null}
    </article>
  );
}
