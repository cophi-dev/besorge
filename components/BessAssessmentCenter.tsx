"use client";

import { useCallback, useEffect, useState } from "react";
import { Atom, ShieldCheck, Sparkle, TrendingUp } from "lucide-react";
import { motion } from "framer-motion";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

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
  asOf: string;
};

const verdictLabel: Record<AssessmentVerdict, string> = {
  beneficial_now: "Beneficial now",
  not_beneficial_now: "Not beneficial now",
  uncertain: "Uncertain",
};

const verdictTone: Record<AssessmentVerdict, string> = {
  beneficial_now: "border-emerald-200 bg-emerald-50 text-emerald-800",
  not_beneficial_now: "border-red-200 bg-red-50 text-red-800",
  uncertain: "border-amber-200 bg-amber-50 text-amber-800",
};

type BessAssessmentCenterProps = {
  compact?: boolean;
};

const ASSESSMENT_FETCH_RETRIES = 2;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export default function BessAssessmentCenter({ compact = false }: BessAssessmentCenterProps) {
  const [data, setData] = useState<AssessmentResponse | null>(null);
  const [loading, setLoading] = useState(true);
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
      setError(caught instanceof Error ? caught.message : "Unknown error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadAssessment();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadAssessment]);

  const refreshAssessment = async () => {
    setLoading(true);
    await loadAssessment();
  };

  return (
    <section
      className={`glass-card relative rounded-4xl ${
        compact ? "p-5 pb-8 md:p-6 md:pb-9" : "p-7 pb-10 md:p-9 md:pb-12"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-blue-600 uppercase dark:text-blue-300">AI decision support</p>
          <h2
            className={`mt-2 tracking-tight text-slate-900 [font-family:var(--font-heading)] ${
              compact ? "text-2xl md:text-3xl" : "text-3xl md:text-4xl"
            }`}
          >
            Should you add more BESS capacity now?
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void refreshAssessment()}
          className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-blue-300 dark:hover:text-blue-200"
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh assessment"}
        </button>
      </div>

      {loading ? (
        <p className="mt-5 rounded-xl border border-slate-300/60 bg-white/60 p-4 text-sm text-slate-700 dark:border-slate-500/35 dark:bg-slate-900/50 dark:text-slate-200">
          Running assessment...
        </p>
      ) : null}

      {error ? (
        <p className="mt-5 rounded-xl border border-red-400/45 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-200">
          Could not run assessment: {error}
        </p>
      ) : null}

      {data ? (
        <div className={`${compact ? "mt-6 space-y-6" : "mt-8 space-y-7 md:space-y-8"}`}>
          <Card className="border-0 bg-white/95 text-slate-900 shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
            <CardContent className="py-5">
              <div className="grid gap-4 md:grid-cols-[auto_1fr_auto] md:items-center">
                <div
                  className="relative flex h-24 w-24 items-center justify-center rounded-full border border-slate-200 bg-slate-50"
                  style={{
                    background: `conic-gradient(${scoreColor(data.score)} ${Math.max(
                      0,
                      Math.min(100, data.score)
                    )}%, rgba(148, 163, 184, 0.2) 0%)`,
                  }}
                  role="img"
                  aria-label={`Score gauge ${Math.round(data.score)} out of 100`}
                >
                  <div className="absolute inset-2 rounded-full bg-white" />
                  <div className="relative text-center">
                    <p className="text-[10px] tracking-[0.12em] text-slate-500 uppercase">Score</p>
                    <p className="text-2xl font-extrabold text-slate-900 [font-family:var(--font-sans)]">
                      {Math.round(data.score)}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Badge
                    variant="outline"
                    className={`rounded-full border px-4 py-1.5 text-xs font-semibold tracking-[0.12em] uppercase ${verdictTone[data.verdict]}`}
                  >
                    <ShieldCheck className="mr-1.5 size-3.5" />
                    Verdict: {verdictLabel[data.verdict]}
                  </Badge>
                  <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                    AETHER currently reads this window as <span className="font-semibold">{verdictLabel[data.verdict].toLowerCase()}</span> with moderate confidence. Near-term conditions support focused action when execution remains disciplined.
                  </p>
                </div>

                <Badge
                  variant="outline"
                  className="h-8 rounded-full border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-800"
                >
                  <Sparkle className="mr-1.5 size-3.5" />
                  Confidence {Math.round(data.confidence)}%
                </Badge>
              </div>
            </CardContent>
          </Card>

          {showFullAnalysis ? (
            <article className="rounded-2xl border border-slate-300/45 bg-white/75 p-5 dark:border-slate-500/35 dark:bg-slate-900/60 md:p-6">
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                Current system stress and short-term market dynamics support selective deployment decisions, but execution quality remains the differentiator. The signal is constructive rather than aggressive, so teams should align commitments with downside protection and clear trigger levels.
              </p>

              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <BriefList title="Key Drivers" items={data.keyDrivers.slice(0, 3)} />
                <BriefList title="Main Risks" items={data.risks.slice(0, 3)} />
                <BriefList title="Recommended Actions" items={data.recommendedNextActions.slice(0, 3)} />
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
              {showFullAnalysis ? "Hide analyst note" : "View full analysis"}
            </button>
          </div>

          <div className="rounded-xl bg-white/60 p-4 shadow-sm dark:bg-slate-900/50">
            <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">Horizon outlook</p>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <HorizonNode
                label="Now"
                verdict={data.horizonOutlook.now.recommendation}
                summary={firstSentence(data.horizonOutlook.now.rationale)}
                icon={<Sparkle className="size-3.5" />}
                current
                delay={0}
              />
              <HorizonNode
                label="Next 12m"
                verdict={data.horizonOutlook.next12m.recommendation}
                summary={firstSentence(data.horizonOutlook.next12m.rationale)}
                icon={<TrendingUp className="size-3.5" />}
                delay={0.08}
              />
              <HorizonNode
                label="Next 36m"
                verdict={data.horizonOutlook.next36m.recommendation}
                summary={firstSentence(data.horizonOutlook.next36m.rationale)}
                icon={<Atom className="size-3.5" />}
                delay={0.16}
              />
            </div>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            As of:{" "}
            {new Date(data.asOf).toLocaleString("de-DE", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>
      ) : null}

      <p className="pointer-events-none absolute right-6 bottom-4 left-6 text-center text-[10px] text-slate-400 dark:text-slate-500">
        AI output is advisory and should be validated with project-specific constraints.
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
