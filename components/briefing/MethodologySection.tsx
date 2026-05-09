"use client";

import { ChevronDown } from "lucide-react";

type MethodologySectionProps = {
  language: "en" | "de";
};

export function MethodologySection({ language }: MethodologySectionProps) {
  const t =
    language === "de"
      ? {
          title: "Methodik & Annahmen",
          lead:
            "Transparente Heuristik auf Basis veröffentlichter Energy-Charts-Viertelstunden (Gen−Last) — keine SCADA-, keine Beschaffungsempfehlung.",
          p95: "P95-Kapazität: 95. Perzentil des modellierten täglichen Speicherbedarfs im gewählten Fenster; konservativ/aggressiv aus Perzentilen der Tagesbedarfe im Trailing-Fenster.",
          greedy:
            "Greedy-Simulation: Viertelstunden in Reihenfolge; Überschuss lädt den Speicher bis Kapazität/Leistungsgrenze, Defizit entlädt priorisiert (zeitverschobene Deckung).",
          losses: "Verluste (RTE) können in dieser Ansicht idealisiert aus sein — siehe Einzel-Karten/Disclaimer.",
          sources: "Primärquelle: Energy-Charts.info (Fraunhofer ISE) — siehe Footer.",
        }
      : {
          title: "Methodology & assumptions",
          lead:
            "Transparent heuristics on published Energy-Charts quarter-hours (generation − load) — not SCADA telemetry, not procurement advice.",
          p95:
            "P95 capacity: 95th percentile of modeled daily storage need in the selected window; conservative/aggressive tiers derive from per-day percentiles across the trailing window.",
          greedy:
            "Greedy walk: quarter-hours processed in order; surplus charges up to power/energy limits, deficit discharges to meet residual need (time-shifted coverage).",
          losses: "Round-trip losses may be idealised in this view — see granular cards/disclaimer.",
          sources: "Primary source: Energy-Charts.info (Fraunhofer ISE) — see footer.",
        };

  return (
    <section className="border-t border-border/50 pt-8 md:pt-10">
      <details className="group rounded-xl border border-border/70 bg-card/50 shadow-sm backdrop-blur-sm dark:bg-card/30">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-left md:px-5 md:py-4">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
              {language === "de" ? "Details" : "Details"}
            </p>
            <p className="mt-1 text-lg font-semibold tracking-tight text-foreground [font-family:var(--font-heading)]">
              {t.title}
            </p>
          </div>
          <ChevronDown className="size-5 shrink-0 text-muted-foreground transition group-open:rotate-180" />
        </summary>
        <div className="border-t border-border/60 px-4 pb-4 md:px-5 md:pb-5">
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t.lead}</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-foreground/90 marker:text-emerald-500/90">
            <li>{t.p95}</li>
            <li>{t.greedy}</li>
            <li>{t.losses}</li>
            <li>{t.sources}</li>
          </ul>
        </div>
      </details>
    </section>
  );
}
