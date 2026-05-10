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
          netVsGross:
            "Netto vs. Brutto: Die strukturelle Tages-Nettobilanz ist die Summe vorzeichen-behafteter Viertelstunden (Generation − Last). Brutto-Ueberschuss- bzw. -Defizitenergie sind die Summen nur ueber Zeitscheiben mit positivem bzw. negativem strukturellen Netto.",
          gridL1:
            "Daempfungsquote (Σ|slot|): Prozentualer Rueckgang der Summe der Absolutbeträge struktureller Viertelstunden-Nettos nach der modellierten Greedy-BESS-Schicht gegenueber Rohdaten gleicher Reihenfolge.",
          storyVsWindow:
            "Taegliche Story-/Briefing-Zahlen beziehen sich auf den gesamten Berlin-Kalendertag; KPIs unterhalb des Deutschland-Charts verwenden das aktuell gewaehlte Chart-Fenster (Auswahl).",
          kpiVsChart:
            "Brutto-Anteile im simulierten Modus nutzen dieselbe Greedy-Schicht wie die Chart-Simulation (Balanced-Leistungsgrenze; Start-SoC aus verketteten Vortagen soweit Daten da sind).",
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
          netVsGross:
            "Net vs gross: the day’s net structural balance is the signed sum of quarter-hour (generation − load). Gross structural surplus energy and gross structural deficit energy are the sums over slots with positive and negative structural net respectively.",
          gridL1:
            "Imbalance damping (Σ|slot|): percentage drop in the sum of absolute quarter-hour structural net magnitudes after the modeled greedy BESS walk versus the raw series in the same order.",
          storyVsWindow:
            "The daily briefing story uses the full Berlin calendar day; KPIs under the Germany chart use the currently selected chart window.",
          kpiVsChart:
            "In simulated mode, gross surplus/deficit shares use the same greedy walk as the chart (balanced power cap; starting SoC stitched from prior days when those series load).",
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
            <li>{t.netVsGross}</li>
            <li>{t.gridL1}</li>
            <li>{t.storyVsWindow}</li>
            <li>{t.kpiVsChart}</li>
            <li>{t.losses}</li>
            <li>{t.sources}</li>
          </ul>
        </div>
      </details>
    </section>
  );
}
