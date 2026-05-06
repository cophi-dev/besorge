"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Atom, Info, Plus, ShieldCheck, Sparkle, TrendingUp } from "lucide-react";
import { motion } from "framer-motion";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
  beneficial_now:
    "border-emerald-400/50 bg-emerald-500/15 text-emerald-100 shadow-[0_0_30px_rgba(16,185,129,0.26)]",
  not_beneficial_now:
    "border-red-400/50 bg-red-500/15 text-red-100 shadow-[0_0_30px_rgba(248,113,113,0.2)]",
  uncertain:
    "border-amber-400/50 bg-amber-500/15 text-amber-100 shadow-[0_0_30px_rgba(251,191,36,0.2)]",
};

const termDefinitions: Record<string, string> = {
  "residual load":
    "Residual load is the remaining electricity demand after wind and solar output are subtracted.",
  "evening stress periods":
    "Evening stress periods are hours when demand stays high while solar generation fades, tightening the grid.",
  "residual volatility":
    "Residual volatility describes how quickly net demand and balancing needs fluctuate over short periods.",
  "P95 ramps":
    "P95 ramps are near-worst-case (95th percentile) changes in power over time, used to size flexibility needs.",
  "renewable share":
    "Renewable share is the percentage of total generation supplied by renewable sources in a given period.",
};

const glossaryPattern = new RegExp(
  `\\b(${Object.keys(termDefinitions)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "gi"
);

export default function BessAssessmentCenter() {
  const [data, setData] = useState<AssessmentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDriverBars, setShowDriverBars] = useState(false);

  const loadAssessment = useCallback(async () => {
    try {
      const response = await fetch("/api/assessment/de", {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? `Request failed with status ${response.status}`);
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

  useEffect(() => {
    setShowDriverBars(false);
    if (!data) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setShowDriverBars(true);
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [data]);

  const refreshAssessment = async () => {
    setLoading(true);
    await loadAssessment();
  };

  const openAiChat = () => {
    window.dispatchEvent(new Event("bessforge:open-ai-chat"));
    window.location.hash = "ai-chat";
  };

  const scoreBreakdown = useMemo(() => {
    if (!data) {
      return [];
    }
    return [
      {
        label: "Volatility",
        value: data.scoreBreakdown.volatility,
        helpText:
          "Captures short-term balancing and price swings that can improve fast-response BESS value.",
      },
      {
        label: "Adequacy",
        value: data.scoreBreakdown.adequacy,
        helpText:
          "Represents system tightness and reserve margins that influence the need for flexible capacity.",
      },
      {
        label: "Policy",
        value: data.scoreBreakdown.policyAndRegulation,
        helpText:
          "Reflects current regulatory and policy direction affecting project viability and market access.",
      },
      {
        label: "Market pressure",
        value: data.scoreBreakdown.marketPressure,
        helpText:
          "Measures structural competition and demand pressure shaping spreads and capture opportunities.",
      },
    ];
  }, [data]);

  return (
    <section className="glass-card relative rounded-3xl p-6 pb-12 md:p-8 md:pb-14">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs tracking-[0.18em] text-blue-600 uppercase dark:text-blue-300">
            AI decision support
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white md:text-3xl">
            Should you add more BESS capacity now?
          </h2>
          <p className="mt-3 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
            This view blends immediate system conditions with structural 12-36 month signals to
            produce a fast recommendation. Use it to prioritize decisions, then validate with your
            project-specific technical and commercial constraints.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-start justify-end gap-2">
          <details className="rounded-full border border-slate-300/60 bg-white/65 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-500/35 dark:bg-slate-900/60 dark:text-slate-300">
            <summary className="cursor-pointer list-none select-none font-medium">
              How this works
            </summary>
            <div className="mt-2 w-72 space-y-2 rounded-lg border border-slate-300/55 bg-white/90 p-2.5 text-[11px] leading-relaxed text-slate-600 shadow-sm dark:border-slate-500/35 dark:bg-slate-900/90 dark:text-slate-300">
              <p>
                How to read this: use <span className="font-semibold">Verdict + Score</span> for
                quick direction, then check <span className="font-semibold">Immediate</span>,{" "}
                <span className="font-semibold">Structural</span>, and{" "}
                <span className="font-semibold">Uncertainty</span> before taking action.
              </p>
              <p>
                AI output is advisory and should be validated with project-specific engineering,
                permitting, and commercial constraints. This is decision support, not investment
                advice.
              </p>
            </div>
          </details>
          <button
            type="button"
            onClick={() => void refreshAssessment()}
            className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-blue-300 dark:hover:text-blue-200"
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh assessment"}
          </button>
          <button
            type="button"
            onClick={openAiChat}
            className="rounded-full border border-blue-400/60 bg-blue-500/10 px-4 py-2 text-xs font-medium text-blue-700 transition hover:border-blue-500 hover:bg-blue-500/20 dark:border-blue-300/50 dark:text-blue-100"
          >
            Let&apos;s talk about it
          </button>
        </div>
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
        <div className="mt-10 space-y-8 md:mt-12 md:space-y-8">
          <Card className="border border-blue-200/20 bg-gradient-to-br from-[#061429] via-[#0A1F3F] to-[#071225] text-white ring-1 ring-emerald-400/20">
            <CardContent className="space-y-8 py-7">
              <div className="flex items-center justify-center">
                <Badge
                  variant="outline"
                  className={`rounded-full border px-6 py-2 text-base font-semibold tracking-[0.16em] uppercase ${verdictTone[data.verdict]}`}
                >
                  <ShieldCheck className="mr-2 size-4" />
                  Verdict: {verdictLabel[data.verdict]}
                </Badge>
              </div>
              <div className="grid items-center gap-6 md:grid-cols-[1fr_auto]">
                <div className="mx-auto flex h-56 w-56 items-center justify-center rounded-full border border-white/10 bg-[#021024]/70 p-4 shadow-[inset_0_0_40px_rgba(34,197,94,0.08)]">
                  <div
                    className="relative flex h-48 w-48 items-center justify-center rounded-full border border-white/5 transition-all duration-700 ease-out"
                    style={{
                      background: `conic-gradient(${scoreColor(data.score)} ${Math.max(
                        0,
                        Math.min(100, data.score)
                      )}%, rgba(148, 163, 184, 0.18) 0%)`,
                    }}
                    role="img"
                    aria-label={`Score gauge ${Math.round(data.score)} out of 100`}
                  >
                    <div className="absolute inset-5 rounded-full bg-[#071a34]" />
                    <div className="relative text-center">
                      <p className="text-xs tracking-[0.14em] text-slate-300 uppercase">Score</p>
                      <p className="mt-1 text-4xl font-semibold text-white">{Math.round(data.score)}</p>
                      <p className="text-xs text-slate-300">/ 100</p>
                    </div>
                  </div>
                </div>
                <div className="mx-auto flex w-full max-w-xs justify-center md:justify-end">
                  <Badge
                    variant="outline"
                    className="h-9 rounded-full border-emerald-300/35 bg-emerald-500/12 px-4 text-sm font-medium text-emerald-100"
                  >
                    <Sparkle className="mr-2 size-4" />
                    Confidence {Math.round(data.confidence)}%
                  </Badge>
                </div>
              </div>
              <div className="space-y-4 rounded-xl bg-[#05162E]/55 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <p className="text-xs tracking-[0.14em] text-slate-200 uppercase">
                  Key Drivers (last 7 days)
                </p>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {scoreBreakdown.map((entry) => (
                    <MiniDriverBar
                      key={entry.label}
                      label={entry.label}
                      value={entry.value}
                      helpText={entry.helpText}
                      animateIn={showDriverBars}
                    />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="h-px bg-gradient-to-r from-transparent via-blue-300/35 to-transparent" />

          <div className="grid gap-4 md:gap-6 md:grid-cols-2">
            <SignalCard
              title="Immediate signal"
              icon={<TrendingUp className="size-4 text-emerald-300" />}
              points={[data.shortTermSignal]}
              collapseOverflow
            />
            <SignalCard
              title="Structural signal"
              icon={<Atom className="size-4 text-blue-200" />}
              points={[data.structuralSignal]}
            />
          </div>

          <div className="h-px bg-gradient-to-r from-transparent via-slate-300/60 to-transparent dark:via-slate-500/35" />
          <div className="space-y-6 rounded-2xl bg-white/45 p-4 shadow-sm dark:bg-slate-900/35 md:space-y-8 md:p-5">
            <AccordionListCard
              title="Why the confidence is only 55%"
              items={data.confidenceLimitations}
              defaultClosed
            />
            <ListCard title="Confidence drivers" items={data.confidenceDrivers} />
            <AccordionListCard title="Key Risks to Consider" items={data.risks} defaultClosed />
            <ListCard title="Recommended next actions" items={data.recommendedNextActions} />
          </div>
          <div className="rounded-xl bg-white/60 p-4 shadow-sm dark:bg-slate-900/50">
            <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
              Horizon outlook
            </p>
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
          <AccordionListCard title="Data Limitations & Impact" items={[data.dataGapsImpact]} defaultClosed />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Horizon anchor: {data.timeHorizon.replace("_", " ")}.
          </p>
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

function SignalCard({
  title,
  icon,
  points,
  collapseOverflow = false,
}: {
  title: string;
  icon: ReactNode;
  points: string[];
  collapseOverflow?: boolean;
}) {
  return (
    <Card className="bg-gradient-to-b from-[#0A1E3B] to-[#0A1730] text-slate-100 shadow-[0_10px_30px_rgba(2,6,23,0.35)] ring-1 ring-white/6">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm tracking-[0.12em] uppercase text-slate-200">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <ul className="space-y-2 text-sm text-slate-200">
          {points.map((point) => (
            <li key={point} className="flex items-start gap-2">
              <Activity className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
              {collapseOverflow ? (
                <SignalOverflowText text={point} />
              ) : (
                <span>
                  <InlineGlossaryText text={point} />
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function MiniDriverBar({
  label,
  value,
  helpText,
  animateIn,
}: {
  label: string;
  value: number;
  helpText: string;
  animateIn: boolean;
}) {
  const roundedValue = Math.round(value);
  const barColor =
    roundedValue >= 70
      ? "from-emerald-400 via-green-300 to-lime-200"
      : "from-amber-400 via-yellow-300 to-orange-200";

  return (
    <div className="rounded-lg bg-[#071B36]/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-slate-100 uppercase">{label}</span>
        <span className="text-xs font-semibold text-slate-200">{roundedValue}</span>
        <div className="group relative">
          <Info className="size-3.5 text-slate-300/90" />
          <span className="pointer-events-none absolute right-0 bottom-[calc(100%+6px)] z-20 w-52 rounded-md border border-white/10 bg-[#031024] px-2 py-1.5 text-[10px] leading-relaxed text-slate-200 opacity-0 shadow-lg transition-opacity duration-200 group-hover:opacity-100">
            {helpText}
          </span>
        </div>
      </div>
      <div className="mt-2 h-3 rounded-full bg-slate-700/65">
        <div
          className={`h-3 rounded-full bg-gradient-to-r ${barColor} shadow-[0_0_14px_rgba(110,231,183,0.25)] transition-all duration-700 ease-out`}
          style={{ width: `${animateIn ? Math.max(6, Math.min(100, roundedValue)) : 0}%` }}
          aria-label={`${label} impact ${roundedValue}`}
        />
      </div>
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

function ListCard({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl bg-white/60 p-4 shadow-sm dark:bg-slate-900/50">
      <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
      <ul className="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-200">
        {items.map((item) => (
          <li key={item}>
            - <InlineGlossaryText text={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccordionListCard({
  title,
  items,
  defaultClosed = false,
}: {
  title: string;
  items: string[];
  defaultClosed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultClosed);

  return (
    <div className="rounded-xl bg-white/60 shadow-sm dark:bg-slate-900/50">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
        aria-expanded={open}
      >
        <span className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
          {title}
        </span>
        <Plus
          className={`size-3.5 text-slate-500 transition-transform duration-200 dark:text-slate-300 ${
            open ? "rotate-45" : ""
          }`}
        />
      </button>
      <div
        className={`grid overflow-hidden transition-all duration-300 ease-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 px-4 pb-4">
          <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-200">
            {items.map((item) => (
              <li key={item}>
                - <InlineGlossaryText text={item} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SignalOverflowText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lead = firstSentence(text);
  const remainder = text.slice(lead.length).trim();

  if (!remainder) {
    return (
      <span>
        <InlineGlossaryText text={text} />
      </span>
    );
  }

  return (
    <div className="w-full">
      <span>
        <InlineGlossaryText text={lead} />
      </span>
      <div
        className={`grid overflow-hidden transition-all duration-300 ease-out ${
          open ? "mt-1 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <span className="min-h-0">
          <InlineGlossaryText text={remainder} />
        </span>
      </div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-blue-200/90 transition hover:text-blue-100"
        aria-expanded={open}
      >
        <Plus className={`size-3 transition-transform duration-200 ${open ? "rotate-45" : ""}`} />
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

function InlineGlossaryText({ text }: { text: string }) {
  const glossaryRegex = new RegExp(glossaryPattern.source, glossaryPattern.flags);
  const matches = Array.from(text.matchAll(glossaryRegex));
  if (matches.length === 0) {
    return <>{text}</>;
  }

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  matches.forEach((match, index) => {
    const fullMatch = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    const normalized = fullMatch.toLowerCase();
    nodes.push(
      <span key={`${normalized}-${start}-${index}`} className="inline-flex items-center gap-1">
        <span>{fullMatch}</span>
        <GlossaryTerm term={normalized} />
      </span>
    );
    lastIndex = start + fullMatch.length;
  });

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return <>{nodes}</>;
}

function GlossaryTerm({ term }: { term: string }) {
  const definition = termDefinitions[term];
  if (!definition) {
    return null;
  }

  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        className="inline-flex cursor-pointer items-center rounded-full border border-slate-300/60 bg-white/80 p-0.5 text-slate-600 transition hover:border-blue-400 hover:text-blue-700 focus-visible:border-blue-400 focus-visible:outline-none dark:border-slate-500/50 dark:bg-slate-900/70 dark:text-slate-300"
        aria-label={`What does ${term} mean?`}
      >
        <Info className="size-3" />
      </button>
      <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 w-56 -translate-x-1/2 rounded-md border border-white/10 bg-[#031024] px-2 py-1.5 text-[10px] leading-relaxed text-slate-200 opacity-0 shadow-lg transition-opacity duration-200 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        {definition}
      </span>
    </span>
  );
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
  icon: ReactNode;
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
      <div className="absolute -top-2 left-1/2 hidden h-0.5 w-[calc(100%+1rem)] -translate-x-1/2 bg-gradient-to-r from-blue-300/0 via-blue-300/50 to-blue-300/0 md:block" />
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
