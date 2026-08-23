"use client";

import { Battery, LineChart, Zap } from "lucide-react";

type HeroValuePropProps = {
  language: "en" | "de";
};

export function HeroValueProp({ language }: HeroValuePropProps) {
  const t =
    language === "de"
      ? {
          tagline: "Für TGA-Planer, Stadtwerke & Energie-Ingenieure",
          headline:
            "Batteriespeicher-Potenzial in Echtzeit sehen — Dimensionierung starten, ohne Anruf.",
          subline:
            "Live-Daten aus Energy-Charts: Erkennen Sie Überschuss-/Defizit-Muster und lassen Sie eine transparente Greedy-Simulation Ihren Speicherbedarf abschätzen.",
          noticeLabel: "Kein",
          noticeItems: ["SCADA", "Handelsempfehlung", "Netzbetreiber-Interna"],
          ctaLabel: "So geht's",
          step1: "Live-Snapshot checken",
          step1Desc: "Aktuelle Erzeugung vs. Last in DE",
          step2: "Tagesprofil erkunden",
          step2Desc: "Überschuss-/Defizit-Fenster im Chart",
          step3: "Speicher-Empfehlung mitnehmen",
          step3Desc: "GWh-Sizing & Coverage-Anteil",
        }
      : {
          tagline: "For building-services planners, utilities & energy engineers",
          headline:
            "See BESS potential in real time — start sizing without a call.",
          subline:
            "Live data from Energy-Charts: spot surplus/deficit patterns and let a transparent greedy simulation estimate your storage need.",
          noticeLabel: "Not",
          noticeItems: ["SCADA", "trading advice", "grid-operator internals"],
          ctaLabel: "How it works",
          step1: "Check the live snapshot",
          step1Desc: "Current generation vs. load in DE",
          step2: "Explore the day profile",
          step2Desc: "Surplus/deficit windows in the chart",
          step3: "Take away a sizing estimate",
          step3Desc: "GWh capacity & coverage share",
        };

  return (
    <section className="relative overflow-hidden rounded-3xl border border-emerald-200/50 bg-gradient-to-br from-emerald-50/80 via-white to-sky-50/60 px-5 py-6 shadow-[0_20px_50px_-20px_rgba(16,185,129,0.18)] dark:border-emerald-500/20 dark:from-emerald-950/30 dark:via-slate-900/80 dark:to-sky-950/20 dark:shadow-[0_20px_50px_-20px_rgba(0,0,0,0.5)] md:px-8 md:py-8">
      <p className="text-[10px] font-bold tracking-[0.28em] text-emerald-700/90 uppercase dark:text-emerald-400/90">
        {t.tagline}
      </p>
      <h1 className="mt-2 text-xl font-bold leading-tight tracking-tight text-slate-900 sm:text-2xl md:text-[1.7rem] dark:text-white [font-family:var(--font-heading)]">
        {t.headline}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-300 md:text-[15px]">
        {t.subline}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
        <span className="rounded-md bg-rose-100/70 px-2 py-0.5 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
          {t.noticeLabel}:
        </span>
        {t.noticeItems.map((item, i) => (
          <span
            key={item}
            className="rounded-md bg-slate-100 px-2 py-0.5 dark:bg-slate-800"
          >
            {item}
            {i < t.noticeItems.length - 1 ? "" : ""}
          </span>
        ))}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <StepCard
          number={1}
          icon={<Zap className="size-4" />}
          title={t.step1}
          desc={t.step1Desc}
        />
        <StepCard
          number={2}
          icon={<LineChart className="size-4" />}
          title={t.step2}
          desc={t.step2Desc}
        />
        <StepCard
          number={3}
          icon={<Battery className="size-4" />}
          title={t.step3}
          desc={t.step3Desc}
        />
      </div>

      <IoSummary language={language} />
    </section>
  );
}

function StepCard({
  number,
  icon,
  title,
  desc,
}: {
  number: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/50 bg-white/70 px-3 py-3 shadow-sm dark:border-white/[0.06] dark:bg-slate-800/50">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
        <span className="text-xs font-bold">{number}</span>
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-white">
          {icon}
          <span>{title}</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {desc}
        </p>
      </div>
    </div>
  );
}

function IoSummary({ language }: { language: "en" | "de" }) {
  const t =
    language === "de"
      ? {
          title: "Input / Output",
          inputLabel: "Input",
          inputText: "Öffentliche Viertelstunden-Daten (Energy-Charts, Netztransparenz)",
          outputLabel: "Output",
          outputText: "GWh-Dimensionierung, Coverage-%, simulierte Speicher-Trajektorie",
          tryLabel: "Ausprobieren",
          tryText: "Scrollen Sie zum Live-Snapshot — kein Login, keine E-Mail",
        }
      : {
          title: "Input / Output",
          inputLabel: "Input",
          inputText: "Public quarter-hour data (Energy-Charts, Netztransparenz)",
          outputLabel: "Output",
          outputText: "GWh sizing, coverage %, simulated storage trajectory",
          tryLabel: "Try it",
          tryText: "Scroll to the live snapshot — no login, no email",
        };

  return (
    <div className="mt-5 rounded-xl border border-slate-200/70 bg-white/60 px-4 py-3 text-xs dark:border-slate-700/50 dark:bg-slate-800/40">
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <span className="font-semibold text-slate-700 dark:text-slate-200">{t.inputLabel}:</span>{" "}
          <span className="text-slate-600 dark:text-slate-400">{t.inputText}</span>
        </div>
        <div>
          <span className="font-semibold text-slate-700 dark:text-slate-200">{t.outputLabel}:</span>{" "}
          <span className="text-slate-600 dark:text-slate-400">{t.outputText}</span>
        </div>
        <div>
          <span className="font-semibold text-emerald-700 dark:text-emerald-400">{t.tryLabel}:</span>{" "}
          <span className="text-slate-600 dark:text-slate-400">{t.tryText}</span>
        </div>
      </div>
    </div>
  );
}
