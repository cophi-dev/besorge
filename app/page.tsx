"use client";

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import dynamic from "next/dynamic";

import BessAssessmentCenter from "@/components/BessAssessmentCenter";
import { useLanguage } from "@/components/language-context";

const MegapackMap = dynamic(() => import("@/components/MegapackMap"), {
  ssr: false,
});

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
const LIVE_UPDATE_LABEL: Record<"en" | "de", string> = {
  en: "Updated live",
  de: "Live aktualisiert",
};
const DATA_FETCH_RETRIES = 2;
const BESS_OVERVIEW = {
  power: {
    totalGw: 18.3,
    utilityScaleGw: 15.2,
    smallScaleGw: 3.1,
  },
  energy: {
    totalGwh: 27.9,
    utilityScaleGwh: 23.1,
    smallScaleGwh: 4.8,
  },
};

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

function formatInstalledValue(value: number, unit: "GW" | "GWh"): string {
  return `${NUMBER_FORMATTER.format(value)} ${unit}`;
}

function buildTodaysKeyStory({
  market,
  assessment,
  residualLoadValue,
  language,
}: {
  market: MarketSnapshot | null;
  assessment: Assessment | null;
  residualLoadValue: string;
  language: "en" | "de";
}): string {
  if (!market || !assessment) {
    return language === "de"
      ? "Die Live-Daten synchronisieren noch, aber das aktuelle Umfeld bleibt für BESS selektiv konstruktiv. Nach sonnigen Tagen gehen viele Systeme meist mit solider Tagesladung in den Abend, was gezielte Entladeoptionen im Stressfenster eröffnet. Bis Restlast, Volatilität und Opportunity Score aktualisiert sind, ist eine disziplinierte und risikobewusste Fahrweise sinnvoller als ein aggressiver Einsatz."
      : "Live data is still syncing, but the setup remains selectively constructive for BESS. Recent sunny days typically leave batteries with healthy daytime charge, creating room to discharge into the evening stress window. Until residual load, volatility, and opportunity score refresh, the right stance is disciplined and risk-aware rather than aggressive.";
  }

  const volatility = Math.round(assessment.scoreBreakdown.volatility);
  const opportunity = Math.round(assessment.score);
  const bessPower = `${NUMBER_FORMATTER.format(market.bess.installedPowerGw)} ${market.bess.powerUnit}`;

  const directionalTakeaway =
    language === "de"
      ? opportunity >= 60
        ? "starkes, aber weiterhin selektives Zeitfenster"
        : opportunity >= 45
          ? "selektive Chancenlage"
          : "vorsichtiges Marktbild"
      : opportunity >= 60
        ? "strong but still selective window"
        : opportunity >= 45
          ? "selective opportunity"
          : "cautious setup";

  return language === "de"
    ? `Eine Restlast von rund ${residualLoadValue} deutet auf ein anziehendes Abend-System hin, in dem BESS-Flotten für Entladung in Spitzenstressphasen vergütet werden und Margen absichern können. Bei einer Volatilität von ${volatility}/100 und einem Opportunity Score von ${opportunity}/100 ergibt sich ein ${directionalTakeaway}: Preisspitzen gezielt nutzen, aber keine Zyklen erzwingen, wenn Spreads einengen. Nach mehreren sonnigen Tagen starten viele Batterien voraussichtlich mit gutem Ladezustand in den Abend, was die Flexibilität erhöht, aber die erste Entladestunde auch verdichten kann. Mit bereits ${bessPower} installierter Leistung ist das Erlöspotenzial für disziplinierten Dispatch real; das Hauptrisiko bleibt Überzyklisierung in kurzlebige Preisbewegungen.`
    : `Residual load near ${residualLoadValue} points to a tightening evening system, where BESS is paid to discharge into peak stress and protect margin. Volatility at ${volatility}/100 and opportunity score at ${opportunity}/100 suggest a ${directionalTakeaway}: monetize spikes, but avoid forcing cycles when spreads compress. After several sunny days, many batteries are likely entering the evening with solid state of charge from low-cost daytime charging, which improves optionality but can crowd the first discharge hour. With ${bessPower} already online, revenue potential is real for disciplined dispatch, while the main risk is overcycling into short-lived price moves.`;
}

export default function Home() {
  const { language } = useLanguage();
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
          prompt:
            language === "de"
              ? "Frage Grok zu den Daten: Wo liegen aktuell die größten Chancen und Risiken?"
              : "Ask Grok about the data: what are the biggest opportunities and risks right now?",
        },
      })
    );
    window.location.hash = "ai-chat";
  };

  const renewableGenerationValue = market
    ? market.realtimeSystem.residualLoadMw !== undefined
      ? Math.max(0, market.realtimeSystem.loadMw - market.realtimeSystem.residualLoadMw)
      : market.realtimeSystem.renewableShareOfLoadPct !== undefined
        ? (market.realtimeSystem.loadMw * market.realtimeSystem.renewableShareOfLoadPct) / 100
        : null
    : null;
  const conventionalGenerationValue =
    market && renewableGenerationValue !== null
      ? Math.max(0, market.realtimeSystem.domesticGenerationMw - renewableGenerationValue)
      : null;
  const netPositionMw = market ? market.realtimeSystem.domesticGenerationMw - market.realtimeSystem.loadMw : null;
  const renewableGenerationDisplay =
    renewableGenerationValue !== null
      ? formatAdaptivePower(renewableGenerationValue)
      : market
        ? language === "de"
          ? "vorübergehend nicht verfügbar"
          : "temporarily unavailable"
        : language === "de"
          ? "Lädt..."
          : "Loading...";
  const conventionalGenerationDisplay =
    conventionalGenerationValue !== null
      ? formatAdaptivePower(conventionalGenerationValue)
      : market
        ? language === "de"
          ? "vorübergehend nicht verfügbar"
          : "temporarily unavailable"
        : language === "de"
          ? "Lädt..."
          : "Loading...";

  const residualLoadValue =
    market?.realtimeSystem.residualLoadMw !== undefined
      ? formatAdaptivePower(market.realtimeSystem.residualLoadMw)
      : market
        ? renewableGenerationValue !== null
          ? formatAdaptivePower(market.realtimeSystem.loadMw - renewableGenerationValue)
          : language === "de"
            ? "vorübergehend nicht verfügbar"
            : "temporarily unavailable"
        : language === "de"
          ? "Lädt..."
          : "Loading...";

  const liveUpdateLabel = market
    ? `${LIVE_UPDATE_LABEL[language]} • ${new Date(market.realtimeSystem.timestampIso).toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : `${LIVE_UPDATE_LABEL[language]} • ${language === "de" ? "synchronisiert" : "syncing"}`;
  const todaysKeyStory = buildTodaysKeyStory({ market, assessment, residualLoadValue, language });
  const volatilityScore = assessment ? Math.round(assessment.scoreBreakdown.volatility) : null;
  const rampScore = assessment ? Math.round(assessment.scoreBreakdown.adequacy) : null;
  const opportunityScore = assessment ? Math.round(assessment.score) : null;

  const eveningStressInsight = market
    ? language === "de"
      ? `Die Restlast liegt weiter bei rund ${residualLoadValue} und markiert das abendliche Defizitfenster, das BESS-Flotten zwischen 17:00 und 21:00 Uhr gezielt bedienen können.`
      : `Residual load remains around ${residualLoadValue}, marking the evening deficit window BESS can target between 17:00-21:00.`
    : language === "de"
      ? "Die Live-Restlast synchronisiert noch; der abendliche Netto-Nachfragestress ist jedoch typischerweise das sauberste Spread-Fenster für flexible Speicher."
      : "Live residual load is syncing, but evening net-demand stress is typically where flexible storage captures the cleanest spreads.";
  const eveningStressWhy = market
    ? language === "de"
      ? "Warum das wichtig ist: In dieser Dispatch-Lücke wird Reaktionsgeschwindigkeit direkt in profitable Peak-Shaving- und Regelenergie-Werte übersetzt."
      : "Why this matters: This is the dispatch gap where battery response speed translates directly into profitable peak-shaving and balancing value."
    : language === "de"
      ? "Warum das wichtig ist: Bestätigter Abendstress ist die Grundlage für belastbare Auslegungs- und Dispatch-Annahmen in kommerziellen Angeboten."
      : "Why this matters: Confirming evening stress sets the baseline for sizing and dispatch assumptions in commercial proposals.";

  const volatilityInsight =
    volatilityScore !== null
      ? volatilityScore >= 55
        ? language === "de"
          ? `Eine Volatilität von ${volatilityScore}/100 signalisiert überdurchschnittliche Spread-Bewegungen und unterstützt in dieser Woche aktive Arbitrage plus Regelenergieerlöse.`
          : `Volatility at ${volatilityScore}/100 signals above-baseline spread movement and supports active arbitrage plus balancing revenue this week.`
        : language === "de"
          ? `Eine Volatilität von ${volatilityScore}/100 ist moderat: eher selektive Arbitragefenster statt breiter, ganztägiger Spread-Abgriffe.`
          : `Volatility at ${volatilityScore}/100 is moderate, with selective arbitrage windows rather than broad, all-day spread capture.`
      : language === "de"
        ? "Die Volatilität synchronisiert noch; ab Werten über 55 unterstützt die Marktdynamik typischerweise belastbare Arbitrage- und Balancing-Chancen."
        : "Volatility is syncing; once above 55, market movement typically supports meaningful arbitrage and balancing opportunities.";
  const volatilityWhy =
    volatilityScore !== null
      ? language === "de"
        ? "Warum das wichtig ist: Volatilität ist der schnellste Proxy für monetarisierbare Preisverwerfungen und damit für die Bruttomarge je Zyklus."
        : "Why this matters: Volatility is the fastest proxy for monetizable price dislocations, which drive gross margin per cycle."
      : language === "de"
        ? "Warum das wichtig ist: Dieses Signal hilft bei der Entscheidung, ob in der Auslegung Arbitrage im Fokus stehen sollte oder zusätzliche Wertströme."
        : "Why this matters: This signal helps decide whether to emphasize arbitrage economics or stack other value streams in sizing discussions.";

  const rampsInsight =
    rampScore !== null
      ? rampScore >= 60
        ? language === "de"
          ? `Rampen bei ${rampScore}/100 deuten auf erhöhten Ausgleichsdruck hin; schnell reagierende Assets sollten kurzfristig aktiv genutzt werden.`
          : `Ramps at ${rampScore}/100 indicate elevated balancing pressure, so fast-response assets should stay actively utilized in near-term operations.`
        : language === "de"
          ? `Rampen bei ${rampScore}/100 zeigen moderate Variabilität; die aktuelle Flotte scheint die meisten kurzfristigen Schwankungen bereits zu absorbieren.`
          : `Ramps at ${rampScore}/100 indicate moderate variability, and the current fleet appears to be absorbing most short-term fluctuations.`
      : language === "de"
        ? "Der Rampendruck synchronisiert noch; moderate Werte stehen meist für handhabbare Variabilität mit gezielten Balancing-Fenstern."
        : "Ramp pressure is syncing; moderate values usually indicate manageable variability with targeted balancing opportunities.";
  const rampsWhy =
    rampScore !== null
      ? language === "de"
        ? "Warum das wichtig ist: Rampenintensität bildet den operativen Wert von subsekundenschneller Reaktion und reservefähiger Batteriekapazität direkt ab."
        : "Why this matters: Ramp intensity maps directly to the operational value of sub-second response and reserve-ready battery capacity."
      : language === "de"
        ? "Warum das wichtig ist: Das zeigt, wie stark zusätzliche Schnellreaktionskapazität Zuverlässigkeit und Dispatch-Qualität verbessern kann."
        : "Why this matters: It clarifies how much additional fast-response capacity can improve reliability and dispatch outcomes.";

  const opportunityInsight =
    opportunityScore !== null
      ? opportunityScore >= 60
        ? language === "de"
          ? `Ein Opportunity Score von ${opportunityScore}/100 ist aktuell konstruktiv; mehrere Signale stehen auf kurzfristige BESS-Wertrealisierung.`
          : `Opportunity at ${opportunityScore}/100 is currently constructive, with multiple signals aligned for near-term BESS value capture.`
        : opportunityScore >= 45
          ? language === "de"
            ? `Ein Opportunity Score von ${opportunityScore}/100 ist gemischt, aber investierbar; sinnvoll sind gezielte Deployments mit disziplinierten Dispatch-Annahmen.`
            : `Opportunity at ${opportunityScore}/100 is mixed but investable, favoring targeted deployments with disciplined dispatch assumptions.`
          : language === "de"
            ? `Ein Opportunity Score von ${opportunityScore}/100 ist aktuell schwach und spricht für selektive Bindung, bis Stress- und Spread-Signale wieder anziehen.`
            : `Opportunity at ${opportunityScore}/100 is currently soft, suggesting selective commitment until stronger stress and spread signals reappear.`
      : language === "de"
        ? "Der Opportunity Score synchronisiert noch; dieser Kompositwert fasst zusammen, ob aktuelle Bedingungen sofortige BESS-Wertrealisierung tragen."
        : "Opportunity score is syncing; this composite will summarize whether current conditions support immediate BESS value capture.";
  const opportunityWhy =
    opportunityScore !== null
      ? language === "de"
        ? "Warum das wichtig ist: Diese Kompositsicht übersetzt rauschende Live-Metriken in ein klares Go/Hold-Signal für kommerzielle Timing-Entscheidungen."
        : "Why this matters: The composite view helps convert noisy live metrics into a clear go/hold signal for commercial timing decisions."
      : language === "de"
        ? "Warum das wichtig ist: Dieses Leitsignal hält Stakeholder-Entscheidungen synchron, auch wenn zugrunde liegende Metriken mit unterschiedlicher Geschwindigkeit aktualisieren."
        : "Why this matters: This headline signal keeps stakeholder decisions aligned when underlying metrics update at different speeds.";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-14 px-8 pb-24 pt-16 lg:px-12">
      <section id="overview" className="space-y-9 border-b border-slate-300/45 pb-14 dark:border-slate-500/35">
        <p className="text-xs tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{liveUpdateLabel}</p>
        <h1 className="max-w-5xl text-5xl leading-tight text-slate-900 md:text-7xl dark:text-white [font-family:var(--font-heading)]">
          AETHER
        </h1>
        <p className="max-w-3xl text-xl text-slate-700 dark:text-slate-200 md:text-2xl">
          {language === "de"
            ? "Klarheit für Deutschlands Energiewende"
            : "Clarity for Germany&apos;s energy transition"}
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {language === "de"
            ? "Tägliches High-Signal-Briefing für Storage-Teams, die Nachfragestress, Erneuerbaren-Anteil und Deployment-Dynamik der BESS-Flotte verfolgen."
            : "Daily high-signal briefing for storage teams tracking demand stress, renewable penetration, and BESS deployment momentum."}
        </p>
        <div className="mt-10 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <KpiCard
              title={language === "de" ? "Gesamterzeugung" : "Total generation"}
              value={market ? formatAdaptivePower(market.realtimeSystem.domesticGenerationMw) : language === "de" ? "Lädt..." : "Loading..."}
              meaning={language === "de" ? "Aktuelle inländische Stromerzeugung." : "Current domestic electricity generation."}
              detailRows={[
                { label: language === "de" ? "Erneuerbar" : "Renewable", value: renewableGenerationDisplay },
                { label: language === "de" ? "Konventionell" : "Conventional", value: conventionalGenerationDisplay },
              ]}
            />
            <KpiCard
              title={language === "de" ? "Aktuelle Last" : "Current demand"}
              value={market ? formatAdaptivePower(market.realtimeSystem.loadMw) : language === "de" ? "Lädt..." : "Loading..."}
              meaning={language === "de" ? "Live-Leistungsbedarf im Netz." : "Live power needed in the grid."}
            />
          </div>
          <div className="flex justify-center">
            <KpiCard
              className="w-full md:max-w-md"
              title={language === "de" ? "Netto-Position" : "Net position"}
              value={
                netPositionMw !== null
                  ? `${netPositionMw >= 0 ? (language === "de" ? "Überschuss" : "Surplus") : language === "de" ? "Defizit" : "Deficit"} ${formatAdaptivePower(Math.abs(netPositionMw))}`
                  : language === "de"
                    ? "Lädt..."
                    : "Loading..."
              }
              meaning={language === "de" ? "Saldo aus inländischer Erzeugung und aktueller Last." : "Domestic generation balance vs current demand."}
            />
          </div>
        </div>
        <article className="rounded-2xl border border-slate-300/45 bg-white/75 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
          <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {language === "de" ? "BESS-Flottenüberblick" : "BESS Fleet Overview"}
          </p>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
            {language === "de"
              ? "Summen basieren auf Energy-Charts; die Größensegmentierung auf Betriebsanlagen aus dem MaStR."
              : "Totals use Energy-Charts; size split uses MaStR operational registry units."}
          </p>
          <div className="mt-4 grid gap-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Installierte Leistung gesamt" : "Installed Power Total"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.power.totalGw, "GW")}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Utility-Scale (&gt;10 MW)" : "Utility-scale (&gt;10 MW)"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.power.utilityScaleGw, "GW")}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Small-Scale (&lt;10 MW)" : "Small-scale (&lt;10 MW)"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.power.smallScaleGw, "GW")}
                </p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Installierte Energie gesamt" : "Installed Energy Total"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.energy.totalGwh, "GWh")}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Utility-Scale (&gt;10 MW)" : "Utility-scale (&gt;10 MW)"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.energy.utilityScaleGwh, "GWh")}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200/75 bg-white/85 p-3 dark:border-slate-500/40 dark:bg-slate-900/55">
                <p className="text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">{language === "de" ? "Small-Scale (&lt;10 MW)" : "Small-scale (&lt;10 MW)"}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900 dark:text-white">
                  {formatInstalledValue(BESS_OVERVIEW.energy.smallScaleGwh, "GWh")}
                </p>
              </div>
            </div>
          </div>
        </article>
        <article className="rounded-2xl border border-slate-300/45 bg-white/75 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
          <div className="flex flex-wrap items-center gap-2 text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            <span>{language === "de" ? "BESS-Deployment-Karte" : "BESS Deployment Map"}</span>
            <span className="inline-flex items-center rounded-full border border-blue-300/60 bg-blue-50/90 px-2 py-0.5 text-[10px] tracking-[0.1em] text-blue-700 dark:border-blue-300/35 dark:bg-blue-400/10 dark:text-blue-200">
              {language === "de" ? "Utility-Scale-Pins" : "Utility-scale pins"}
            </span>
            <span className="inline-flex items-center rounded-full border border-cyan-300/60 bg-cyan-50/90 px-2 py-0.5 text-[10px] tracking-[0.1em] text-cyan-700 dark:border-cyan-300/35 dark:bg-cyan-400/10 dark:text-cyan-200">
              {language === "de" ? "Small-Scale-Dichte" : "Small-scale density"}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {language === "de"
              ? "Utility-Scale- und Small-Scale-BESS-Standorte in Deutschland (MaStR-Daten)."
              : "Utility-scale and small-scale BESS locations across Germany (MaStR data)."}
          </p>
          <div className="mt-4">
            <MegapackMap compact />
          </div>
        </article>
        <article className="rounded-2xl border border-slate-300/45 bg-white/70 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
          <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {language === "de" ? "Kernaussage des Tages" : "Today&apos;s Key Story"}
          </p>
          <p className="mt-3 max-w-5xl text-sm leading-relaxed text-slate-700 dark:text-slate-200">
            {todaysKeyStory}
          </p>
        </article>
      </section>

      <section id="bess-value" className="space-y-8">
        <h2 className="text-3xl text-slate-900 dark:text-white md:text-4xl [font-family:var(--font-heading)]">
          {language === "de" ? "Strategische Signalanalyse" : "Strategic Signal Review"}
        </h2>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <ValueCard
            title={language === "de" ? "Abendstress" : "Evening Stress"}
            value={residualLoadValue}
            insight={eveningStressInsight}
            whyThisMatters={eveningStressWhy}
            language={language}
          />
          <ValueCard
            title={language === "de" ? "Volatilität" : "Volatility"}
            value={volatilityScore !== null ? `${volatilityScore}/100` : language === "de" ? "k. A." : "n/a"}
            insight={volatilityInsight}
            whyThisMatters={volatilityWhy}
            language={language}
          />
          <ValueCard
            title={language === "de" ? "Rampen" : "Ramps"}
            value={rampScore !== null ? `${rampScore}/100` : language === "de" ? "k. A." : "n/a"}
            insight={rampsInsight}
            whyThisMatters={rampsWhy}
            language={language}
          />
          <ValueCard
            title={language === "de" ? "Opportunity Score" : "Opportunity score"}
            value={opportunityScore !== null ? `${opportunityScore}/100` : language === "de" ? "k. A." : "n/a"}
            insight={opportunityInsight}
            whyThisMatters={opportunityWhy}
            tag={
              assessment
                ? language === "de"
                  ? assessment.verdict === "beneficial_now"
                    ? "aktuell vorteilhaft"
                    : assessment.verdict === "not_beneficial_now"
                      ? "aktuell nicht vorteilhaft"
                      : "unklar"
                  : assessment.verdict.replaceAll("_", " ")
                : undefined
            }
            language={language}
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
        className="group fixed right-6 bottom-6 z-[1000] w-[min(340px,calc(100vw-3rem))] rounded-3xl border border-primary/35 bg-[#fbfaf8]/95 px-5 py-4 text-left text-slate-900 shadow-[0_18px_42px_rgba(15,118,110,0.16)] backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-[0_22px_48px_rgba(15,118,110,0.24)] dark:border-emerald-200/30 dark:bg-slate-900/95 dark:text-slate-100 dark:hover:border-emerald-200/60"
        aria-label={language === "de" ? "Frage AETHER alles" : "Ask AETHER anything"}
      >
        <span className="inline-flex items-center gap-2 text-[11px] tracking-[0.14em] text-primary uppercase dark:text-emerald-200">
          <MessageCircle className="h-4 w-4" />
          {language === "de" ? "AETHER Chat" : "AETHER Chat"}
        </span>
        <span className="mt-1 block text-sm font-semibold md:text-base">
          {language === "de" ? "Sprechen Sie mit AETHER." : "Talk with AETHER."}
        </span>
        <span className="mt-1 block text-xs text-slate-600 dark:text-slate-300">
          {language === "de"
            ? "Trends, Risiken und nächste Schritte auf einen Blick."
            : "Trends, risks, and next steps in one conversation."}
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
  className,
  detailRows,
}: {
  title: string;
  value: string;
  meaning: string;
  sublabel?: string;
  className?: string;
  detailRows?: Array<{ label: string; value: string }>;
}) {
  return (
    <article className={`relative rounded-2xl border border-slate-300/55 bg-white/80 p-5 dark:border-slate-500/40 dark:bg-slate-900/65 ${className ?? ""}`}>
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      <p className="mt-2 text-3xl font-black text-slate-900 dark:text-white md:text-4xl [font-family:var(--font-sans)]">
        {value}
      </p>
      {detailRows?.length ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700 dark:text-slate-200">
          {detailRows.map((detail) => (
            <p key={detail.label} className="inline-flex items-center gap-1.5">
              <span className="text-slate-500 dark:text-slate-300">{detail.label}:</span>
              <span className="font-semibold text-slate-900 dark:text-white">{detail.value}</span>
            </p>
          ))}
        </div>
      ) : null}
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
  language = "en",
}: {
  title: string;
  value: string;
  insight: string;
  whyThisMatters: string;
  tag?: string;
  language?: "en" | "de";
}) {
  return (
    <article className="rounded-2xl border border-slate-300/50 bg-white/70 p-6 dark:border-slate-500/40 dark:bg-slate-900/70">
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      <p className="mt-3 text-4xl font-extrabold text-slate-900 dark:text-white [font-family:var(--font-sans)]">{value}</p>
      <p className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{insight}</p>
      <p className="mt-4 text-[11px] tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">
        {language === "de" ? "Warum das wichtig ist" : "Why this matters"}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
        {whyThisMatters.replace(language === "de" ? /^Warum das wichtig ist:\s*/i : /^Why this matters:\s*/i, "")}
      </p>
      {tag ? (
        <p className="mt-4 inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary dark:text-blue-100">
          {tag}
        </p>
      ) : null}
    </article>
  );
}
