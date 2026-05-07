"use client";

import { useCallback, useEffect, useState } from "react";
import { Atom, ShieldCheck, Sparkle, TrendingUp } from "lucide-react";
import { motion } from "framer-motion";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/components/language-context";

type AssessmentVerdict = "beneficial_now" | "not_beneficial_now" | "uncertain";

type AssessmentResponse = {
  verdict: AssessmentVerdict;
  score: number;
  confidence: number;
  timeHorizon: "now" | "next_12m" | "next_36m";
  shortTermSignal: string;
  structuralSignal: string;
  scoreBreakdown: {
    volatility: number;
    adequacy: number;
    policyAndRegulation: number;
    marketPressure: number;
  };
  confidenceDrivers: string[];
  confidenceLimitations: string[];
  keyDrivers: string[];
  risks: string[];
  recommendedNextActions: string[];
  horizonOutlook: {
    now: { recommendation: string; rationale: string };
    next12m: { recommendation: string; rationale: string };
    next36m: { recommendation: string; rationale: string };
  };
  dataGapsImpact: string;
  analystSummary: string;
  fullAnalysisSummary: string;
  asOf: string;
};

export type { AssessmentResponse };

const verdictLabel: Record<"en" | "de", Record<AssessmentVerdict, string>> = {
  en: {
    beneficial_now: "Beneficial now",
    not_beneficial_now: "Not beneficial now",
    uncertain: "Uncertain",
  },
  de: {
    beneficial_now: "Aktuell vorteilhaft",
    not_beneficial_now: "Aktuell nicht vorteilhaft",
    uncertain: "Unklar",
  },
};

const verdictTone: Record<AssessmentVerdict, string> = {
  beneficial_now: "border-emerald-200 bg-emerald-50 text-emerald-800",
  not_beneficial_now: "border-red-200 bg-red-50 text-red-800",
  uncertain: "border-amber-200 bg-amber-50 text-amber-800",
};

type BessAssessmentCenterProps = {
  compact?: boolean;
  initialData?: AssessmentResponse | null;
  pendingInitialData?: boolean;
  skipInitialFetch?: boolean;
};

const ASSESSMENT_FETCH_RETRIES = 2;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export default function BessAssessmentCenter({
  compact = false,
  initialData = null,
  pendingInitialData = false,
  skipInitialFetch = false,
}: BessAssessmentCenterProps) {
  const { language } = useLanguage();
  const [data, setData] = useState<AssessmentResponse | null>(null);
  const [loading, setLoading] = useState(!skipInitialFetch && initialData === null);
  const [error, setError] = useState<string | null>(null);
  const [showFullAnalysis, setShowFullAnalysis] = useState(false);

  const loadAssessment = useCallback(async () => {
    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt <= ASSESSMENT_FETCH_RETRIES; attempt += 1) {
        response = await fetch("/api/assessment/de", {
          method: "GET",
          cache: "no-store",
        });

        if (response.ok) {
          break;
        }

        if (attempt < ASSESSMENT_FETCH_RETRIES) {
          await sleep(250 * 2 ** attempt);
        }
      }

      if (!response || !response.ok) {
        const payload = (await response?.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? `Request failed with status ${response?.status ?? 500}`);
      }
      const payload = (await response.json()) as AssessmentResponse;
      setData(payload);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : language === "de" ? "Unbekannter Fehler" : "Unknown error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    if (skipInitialFetch) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void loadAssessment();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadAssessment, skipInitialFetch]);

  const refreshAssessment = async () => {
    setLoading(true);
    await loadAssessment();
  };

  const resolvedData = data ?? initialData;
  const isLoading = loading || (pendingInitialData && resolvedData === null && error === null);

  return (
    <section
      className={`glass-card relative rounded-4xl ${
        compact ? "p-5 pb-8 md:p-6 md:pb-9" : "p-7 pb-10 md:p-9 md:pb-12"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-blue-600 uppercase dark:text-blue-300">
            {language === "de" ? "KI-Entscheidungsunterstützung" : "AI decision support"}
          </p>
          <h2
            className={`mt-2 tracking-tight text-slate-900 [font-family:var(--font-heading)] ${
              compact ? "text-2xl md:text-3xl" : "text-3xl md:text-4xl"
            }`}
          >
            {language === "de" ? "Sollten Sie jetzt zusätzliche BESS-Kapazität aufbauen?" : "Should you add more BESS capacity now?"}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void refreshAssessment()}
          className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-blue-300 dark:hover:text-blue-200"
          disabled={isLoading}
        >
          {isLoading ? (language === "de" ? "Aktualisiert..." : "Refreshing...") : language === "de" ? "Assessment aktualisieren" : "Refresh assessment"}
        </button>
      </div>

      {isLoading ? (
        <div className="mt-5 rounded-xl border border-slate-300/60 bg-white/60 p-4 dark:border-slate-500/35 dark:bg-slate-900/50">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-3 h-10 w-32" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-11/12" />
        </div>
      ) : null}

      {error ? (
        <p className="mt-5 rounded-xl border border-red-400/45 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-200">
          {language === "de" ? "Assessment konnte nicht berechnet werden:" : "Could not run assessment:"} {error}
        </p>
      ) : null}

      {resolvedData ? (
        <div className={`${compact ? "mt-6 space-y-6" : "mt-8 space-y-7 md:space-y-8"}`}>
          <Card className="border-0 bg-white/95 text-slate-900 shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
            <CardContent className="py-5">
              <div className="grid gap-4 md:grid-cols-[auto_1fr_auto] md:items-center">
                <div
                  className="relative flex h-24 w-24 items-center justify-center rounded-full border border-slate-200 bg-slate-50"
                  style={{
                    background: `conic-gradient(${scoreColor(resolvedData.score)} ${Math.max(
                      0,
                      Math.min(100, resolvedData.score)
                    )}%, rgba(148, 163, 184, 0.2) 0%)`,
                  }}
                  role="img"
                  aria-label={
                    language === "de"
                      ? `Score-Anzeige ${Math.round(resolvedData.score)} von 100`
                      : `Score gauge ${Math.round(resolvedData.score)} out of 100`
                  }
                >
                  <div className="absolute inset-2 rounded-full bg-white" />
                  <div className="relative text-center">
                    <p className="text-[10px] tracking-[0.12em] text-slate-500 uppercase">
                      {language === "de" ? "Score" : "Score"}
                    </p>
                    <p className="text-2xl font-extrabold text-slate-900 [font-family:var(--font-sans)]">
                      {Math.round(resolvedData.score)}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Badge
                    variant="outline"
                    className={`rounded-full border px-4 py-1.5 text-xs font-semibold tracking-[0.12em] uppercase ${verdictTone[resolvedData.verdict]}`}
                  >
                    <ShieldCheck className="mr-1.5 size-3.5" />
                    {language === "de" ? "Fazit" : "Verdict"}: {verdictLabel[language][resolvedData.verdict]}
                  </Badge>
                  <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                    {resolvedData.analystSummary}
                  </p>
                </div>

                <Badge
                  variant="outline"
                  className="h-8 rounded-full border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-800"
                >
                  <Sparkle className="mr-1.5 size-3.5" />
                  {language === "de" ? "Konfidenz" : "Confidence"} {Math.round(resolvedData.confidence)}%
                </Badge>
              </div>
            </CardContent>
          </Card>

          {showFullAnalysis ? (
            <article className="rounded-2xl border border-slate-300/45 bg-white/75 p-5 dark:border-slate-500/35 dark:bg-slate-900/60 md:p-6">
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                {resolvedData.fullAnalysisSummary}
              </p>

              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <BriefList title={language === "de" ? "Haupttreiber" : "Key Drivers"} items={resolvedData.keyDrivers.slice(0, 3)} />
                <BriefList title={language === "de" ? "Wesentliche Risiken" : "Main Risks"} items={resolvedData.risks.slice(0, 3)} />
                <BriefList title={language === "de" ? "Empfohlene Maßnahmen" : "Recommended Actions"} items={resolvedData.recommendedNextActions.slice(0, 3)} />
              </div>
            </article>
          ) : null}

          <div className="text-center">
            <button
              type="button"
              onClick={() => setShowFullAnalysis((current) => !current)}
              className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-blue-300 dark:hover:text-blue-200"
              aria-expanded={showFullAnalysis}
            >
              {showFullAnalysis
                ? language === "de"
                  ? "Analystennotiz ausblenden"
                  : "Hide analyst note"
                : language === "de"
                  ? "Vollständige Analyse anzeigen"
                  : "View full analysis"}
            </button>
          </div>

          <div className="rounded-xl bg-white/60 p-4 shadow-sm dark:bg-slate-900/50">
            <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
              {language === "de" ? "Horizont-Ausblick" : "Horizon outlook"}
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <HorizonNode
                label={language === "de" ? "Jetzt" : "Now"}
                verdict={resolvedData.horizonOutlook.now.recommendation}
                summary={firstSentence(resolvedData.horizonOutlook.now.rationale)}
                icon={<Sparkle className="size-3.5" />}
                current
                delay={0}
              />
              <HorizonNode
                label={language === "de" ? "Nächste 12M" : "Next 12m"}
                verdict={resolvedData.horizonOutlook.next12m.recommendation}
                summary={firstSentence(resolvedData.horizonOutlook.next12m.rationale)}
                icon={<TrendingUp className="size-3.5" />}
                delay={0.08}
              />
              <HorizonNode
                label={language === "de" ? "Nächste 36M" : "Next 36m"}
                verdict={resolvedData.horizonOutlook.next36m.recommendation}
                summary={firstSentence(resolvedData.horizonOutlook.next36m.rationale)}
                icon={<Atom className="size-3.5" />}
                delay={0.16}
              />
            </div>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            {language === "de" ? "Stand:" : "As of:"}{" "}
            {new Date(resolvedData.asOf).toLocaleString("de-DE", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>
      ) : null}

      <p className="pointer-events-none absolute right-6 bottom-4 left-6 text-center text-[10px] text-slate-400 dark:text-slate-500">
        {language === "de"
          ? "KI-Ausgaben sind beratend und müssen mit projektspezifischen Randbedingungen validiert werden."
          : "AI output is advisory and should be validated with project-specific constraints."}
      </p>
    </section>
  );
}

function BriefList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-slate-300/45 bg-white/85 p-4 dark:border-slate-500/35 dark:bg-slate-900/70">
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      <ul className="mt-2 space-y-2 text-sm text-slate-700 dark:text-slate-200">
        {items.map((item) => (
          <li key={item} className="leading-relaxed">
            - {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score > 70) {
    return "rgb(16, 185, 129)";
  }
  if (score >= 50) {
    return "rgb(245, 158, 11)";
  }
  return "rgb(239, 68, 68)";
}

function HorizonNode({
  label,
  verdict,
  summary,
  icon,
  current = false,
  delay,
}: {
  label: string;
  verdict: string;
  summary: string;
  icon: React.ReactNode;
  current?: boolean;
  delay: number;
}) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: "easeOut" }}
      className={`relative rounded-xl border p-3 ${
        current
          ? "scale-[1.02] border-blue-400/40 bg-blue-500/10 shadow-[0_10px_30px_rgba(59,130,246,0.16)]"
          : "border-slate-300/60 bg-white/70 dark:border-slate-500/40 dark:bg-slate-900/60"
      }`}
    >
      <div className="mb-2 inline-flex items-center gap-1 rounded-full border border-slate-300/70 bg-white/80 px-2 py-0.5 text-[11px] text-slate-700 dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200">
        {icon}
        <span className="font-semibold">{label}</span>
      </div>
      <p className="text-sm font-semibold text-slate-900 dark:text-white">{verdict}</p>
      <p className="mt-1 text-xs text-slate-700 dark:text-slate-200">{summary}</p>
    </motion.article>
  );
}

function firstSentence(text: string): string {
  const match = text.match(/[^.!?]+[.!?]/);
  return match ? match[0].trim() : text;
}
