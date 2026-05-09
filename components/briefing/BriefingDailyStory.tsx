"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Sparkles, Zap } from "lucide-react";
import { z } from "zod";

import { Skeleton } from "@/components/ui/skeleton";
import { createLogger } from "@/lib/debug";

const log = createLogger("daily-story");

const storyShape = z.object({
  headline: z.string(),
  narrative: z.string(),
  counterfactual: z.string(),
  dataAsOfNote: z.string().optional(),
});

const responseShape = z.object({
  dateBerlin: z.string(),
  language: z.enum(["en", "de"]),
  source: z.enum(["llm", "fallback_numeric"]),
  retrievedAtIso: z.string(),
  context: z.object({
    netStructuralBalanceGwh: z.number(),
    pointFractionOfDay: z.number(),
    samplePoints: z.number(),
    fleet: z.object({
      powerGw: z.number(),
      capacityGwh: z.number(),
    }),
    simulated: z.object({
      practicalCapacityGwh: z.number(),
      balancedPowerMw: z.number(),
      gridImpactReductionPct: z.number().nullable(),
      absorbedSurplusShare: z.number().nullable(),
      servedDeficitShare: z.number().nullable(),
    }),
  }),
  story: storyShape,
});

type StoryResponse = z.infer<typeof responseShape>;

type BriefingDailyStoryProps = {
  language: "en" | "de";
  /** Berlin calendar date (YYYY-MM-DD) the homepage is currently showing. */
  dateKey: string;
  /** Bumped to force a refetch (e.g. user pressed "Refresh"). */
  refreshNonce?: number;
};

const FETCH_TIMEOUT_MS = 18_000;

async function fetchStory(
  dateKey: string,
  language: "en" | "de",
  signal: AbortSignal
): Promise<StoryResponse> {
  const params = new URLSearchParams({ date: dateKey, language });
  const res = await fetch(`/api/briefing/story?${params.toString()}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  return responseShape.parse(json);
}

const labels = {
  en: {
    kicker: "Daily story · Berlin",
    counterfactualLabel: "What an optimal BESS would have done",
    poweredBy: "Aether analyst (LLM)",
    poweredByFallback: "Aether analyst (deterministic — model offline)",
    loading: "Drafting today's analyst note…",
    error: "Could not draft today's analyst note.",
    retry: "Retry",
    asOfPrefix: "As of",
  },
  de: {
    kicker: "Story des Tages · Berlin",
    counterfactualLabel: "Was ein optimaler BESS bewirkt hätte",
    poweredBy: "AETHER-Analyst (LLM)",
    poweredByFallback: "AETHER-Analyst (deterministisch — Modell offline)",
    loading: "Analystennotiz wird erstellt…",
    error: "Heutige Analystennotiz konnte nicht erstellt werden.",
    retry: "Erneut versuchen",
    asOfPrefix: "Stand",
  },
} as const;

export function BriefingDailyStory({ language, dateKey, refreshNonce = 0 }: BriefingDailyStoryProps) {
  const [data, setData] = useState<StoryResponse | null>(null);
  /**
   * Initial state is "loading" so the very first paint already renders the
   * skeleton. We only flip back into "loading" on subsequent dependency
   * changes (refresh / date / language), and that flip is deferred via a
   * rAF microtask to avoid the React 19 `set-state-in-effect` cascade
   * warning.
   */
  const [loadingState, setLoadingState] = useState<"idle" | "loading" | "error">("loading");
  const [retryNonce, setRetryNonce] = useState(0);
  const lastReqId = useRef(0);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    const reqId = ++lastReqId.current;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let rafId = 0;
    if (hasMountedRef.current) {
      rafId = requestAnimationFrame(() => setLoadingState("loading"));
    } else {
      hasMountedRef.current = true;
    }

    fetchStory(dateKey, language, controller.signal)
      .then((result) => {
        if (reqId !== lastReqId.current) {
          return;
        }
        setData(result);
        setLoadingState("idle");
      })
      .catch((err: unknown) => {
        if (reqId !== lastReqId.current) {
          return;
        }
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        log("daily story fetch failed %o", err);
        setLoadingState("error");
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [dateKey, language, refreshNonce, retryNonce]);

  const t = labels[language];

  const headerNumbers = useMemo(() => {
    if (!data) return null;
    const fmt = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
      maximumFractionDigits: 1,
    });
    const net = data.context.netStructuralBalanceGwh;
    return {
      netSign: net >= 0 ? "+" : "−",
      netAbs: fmt.format(Math.abs(net)),
      gridPct: data.context.simulated.gridImpactReductionPct,
      gridPctText:
        data.context.simulated.gridImpactReductionPct !== null
          ? fmt.format(data.context.simulated.gridImpactReductionPct)
          : null,
      capGwh: fmt.format(data.context.simulated.practicalCapacityGwh),
      pwGw: fmt.format(data.context.simulated.balancedPowerMw / 1000),
    };
  }, [data, language]);

  return (
    <section
      data-state={loadingState}
      className="group relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-emerald-50/30 px-5 py-5 shadow-[0_1px_0_rgb(255_255_255_/_0.6)_inset,0_18px_44px_-22px_rgb(15_23_42_/_0.18)] transition-shadow duration-300 dark:border-white/[0.06] dark:from-[rgba(13,19,36,0.92)] dark:via-[rgba(13,19,36,0.85)] dark:to-emerald-950/20 dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05),0_22px_60px_-28px_rgb(0_0_0_/_0.7)] md:px-7 md:py-6"
      aria-busy={loadingState === "loading"}
    >
      {/* Subtle ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-16 size-48 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-400/[0.08]"
      />

      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Sparkles
            className="size-3.5 text-emerald-600 dark:text-emerald-300"
            aria-hidden
          />
          <p className="text-[10.5px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            {t.kicker}
          </p>
        </div>
        {data ? (
          <p className="text-[10.5px] tracking-[0.16em] text-muted-foreground/80 uppercase tabular-nums">
            {t.asOfPrefix} · {data.dateBerlin}
          </p>
        ) : null}
      </header>

      {loadingState === "loading" && !data ? (
        <div className="mt-5 space-y-3">
          <Skeleton className="h-7 w-3/4 max-w-2xl" />
          <Skeleton className="h-4 w-full max-w-3xl" />
          <Skeleton className="h-4 w-5/6 max-w-2xl" />
          <div className="mt-5 rounded-xl border border-dashed border-border/60 p-3.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="mt-2 h-4 w-full max-w-xl" />
          </div>
          <p className="mt-4 text-[11px] text-muted-foreground/70">{t.loading}</p>
        </div>
      ) : loadingState === "error" ? (
        <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-300/40 bg-amber-50/40 p-3.5 dark:border-amber-500/30 dark:bg-amber-950/20">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300"
            aria-hidden
          />
          <div className="flex-1 text-sm">
            <p className="text-amber-900 dark:text-amber-100">{t.error}</p>
            <button
              type="button"
              onClick={() => setRetryNonce((n) => n + 1)}
              className="mt-2 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-500/20 dark:text-amber-100"
            >
              {t.retry}
            </button>
          </div>
        </div>
      ) : data ? (
        <>
          <h2 className="mt-3 text-[19px] leading-snug font-medium tracking-tight text-foreground md:text-[22px] [font-family:var(--font-heading)]">
            {data.story.headline}
          </h2>
          <p className="mt-3 max-w-3xl text-[13.5px] leading-relaxed text-foreground/80 md:text-sm dark:text-slate-200/90">
            {data.story.narrative}
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-stretch">
            <div className="relative rounded-xl border border-emerald-300/40 bg-emerald-50/50 px-4 py-3 dark:border-emerald-400/25 dark:bg-emerald-950/30">
              <div className="flex items-center gap-2">
                <Zap
                  className="size-3.5 text-emerald-700 dark:text-emerald-300"
                  aria-hidden
                />
                <p className="text-[10px] font-semibold tracking-[0.18em] text-emerald-800/90 uppercase dark:text-emerald-200/90">
                  {t.counterfactualLabel}
                </p>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-emerald-950/90 md:text-[13.5px] dark:text-emerald-50/95">
                {data.story.counterfactual}
              </p>
            </div>

            {headerNumbers ? (
              <dl className="grid grid-cols-3 gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 text-center sm:gap-4 md:flex md:flex-col md:gap-1.5 md:py-3 md:text-right">
                <NumberCallout
                  label={language === "de" ? "Bilanz" : "Balance"}
                  value={`${headerNumbers.netSign}${headerNumbers.netAbs}`}
                  unit="GWh"
                  tone={data.context.netStructuralBalanceGwh >= 0 ? "positive" : "negative"}
                />
                <NumberCallout
                  label={language === "de" ? "Optimal-BESS" : "Optimal BESS"}
                  value={`${headerNumbers.capGwh}`}
                  unit="GWh"
                />
                <NumberCallout
                  label={language === "de" ? "Δ Netz" : "Grid Δ"}
                  value={headerNumbers.gridPctText !== null ? headerNumbers.gridPctText : "—"}
                  unit={headerNumbers.gridPctText !== null ? "%" : ""}
                  tone="accent"
                />
              </dl>
            ) : null}
          </div>

          <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-muted-foreground/80">
            <span>
              {data.source === "llm" ? t.poweredBy : t.poweredByFallback}
            </span>
            {data.story.dataAsOfNote ? (
              <span className="text-muted-foreground/70">
                {data.story.dataAsOfNote}
              </span>
            ) : null}
          </footer>
        </>
      ) : null}
    </section>
  );
}

type NumberCalloutProps = {
  label: string;
  value: string;
  unit: string;
  tone?: "positive" | "negative" | "accent" | "neutral";
};

function NumberCallout({ label, value, unit, tone = "neutral" }: NumberCalloutProps) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "negative"
        ? "text-rose-600 dark:text-rose-300"
        : tone === "accent"
          ? "text-foreground"
          : "text-foreground";
  return (
    <div className="leading-tight">
      <p className="text-[9.5px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className={`mt-0.5 text-base font-semibold tabular-nums md:text-[15px] ${toneClass}`}>
        {value}
        <span className="ml-0.5 text-[10px] font-medium tracking-tight text-muted-foreground/80">
          {unit}
        </span>
      </p>
    </div>
  );
}
