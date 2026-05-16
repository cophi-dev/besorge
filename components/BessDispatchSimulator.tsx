"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BatteryCharging, Loader2, Zap } from "lucide-react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { z } from "zod";

import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage, type AppLanguage } from "@/components/language-context";
import { createLogger } from "@/lib/debug";
import { getMegapackEquivalent } from "@/lib/teslaMegapack";

const log = createLogger("dispatch-simulator");

const STRATEGY_VALUE = "auto_policy_v1" as const;

const POWER_MIN_MW = 50;
const POWER_MAX_MW = 2_000;
const CAPACITY_MIN_MWH = 100;
const CAPACITY_MAX_MWH = 8_000;
const RTE_MIN_PCT = 80;
const RTE_MAX_PCT = 99;

const DEFAULT_INPUTS = {
  powerMw: 500,
  capacityMwh: 2_000,
  rteEfficiencyPct: 92,
  strategy: STRATEGY_VALUE,
} as const;

const QUARTER_HOUR_HOURS_DISPATCH = 0.25;

const EVENING_GAP_HOUR_START = 17;

/** Reference scale for illustrative “what if MW” in Key Learning (can exceed slider max). */
const KEY_LEARNING_SCALE_POWER_MW = 5_000;

const isEveningGapHour = (hourBerlin: number) =>
  hourBerlin >= EVENING_GAP_HOUR_START && hourBerlin < 21;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const responseSchema = z.object({
  inputs: z.object({
    powerMw: z.number(),
    capacityMwh: z.number(),
    rteEfficiencyPct: z.number(),
    strategy: z.literal(STRATEGY_VALUE),
  }),
  dataset: z.object({
    dateBerlin: z.string(),
    samplePoints: z.number(),
    pointFractionOfDay: z.number(),
    source: z.literal("energy-charts.total_power"),
  }),
  market: z.object({
    priceSource: z.enum(["smard_spot", "residual_proxy", "mixed"]),
    positiveRedispatchCostEurPerMwh: z.number(),
    negativeRedispatchCostEurPerMwh: z.number(),
    redispatchSourceLabel: z.string(),
  }),
  schedule: z.array(
    z.object({
      timestampIso: z.string(),
      hourBerlin: z.number(),
      residualLoadMw: z.number(),
      loadMw: z.number().nullable(),
      totalGenerationMw: z.number().nullable(),
      renewableGenerationMw: z.number().nullable(),
      crossBorderElectricityTradingMw: z.number().nullable(),
      simulatedCrossBorderElectricityTradingMw: z.number().nullable(),
      priceProxyEurPerMwh: z.number(),
      action: z.enum(["charge", "discharge", "idle"]),
      decisionReason: z.string(),
      powerMw: z.number(),
      socMwh: z.number(),
      socPct: z.number(),
      chargeHeadroomMwh: z.number(),
      dischargeHeadroomMwh: z.number(),
      maxReachableSocPct: z.number(),
    })
  ),
  results: z.object({
    energyChargedFromGridMwh: z.number(),
    energyDischargedToGridMwh: z.number(),
    avgChargePriceEurPerMwh: z.number(),
    avgDischargePriceEurPerMwh: z.number(),
    grossRevenueEur: z.number(),
    arbitrageRevenueEur: z.number(),
    chargedFromCurtailmentMwh: z.number(),
    avoidedRedispatchCostEur: z.number(),
    totalValueEur: z.number(),
    cycles: z.number(),
    eveningDeliveredMwh: z.number(),
    eveningCoveragePct: z.number(),
    observedImportEnergyMwh: z.number(),
    observedExportEnergyMwh: z.number(),
    simulatedImportEnergyMwh: z.number(),
    simulatedExportEnergyMwh: z.number(),
    importDeltaEnergyMwh: z.number(),
    exportDeltaEnergyMwh: z.number(),
    averageSpreadEurPerMwh: z.number(),
    roundTripLossPct: z.number(),
    maxReachableSocByEveningPct: z.number(),
    maxReachableSocPeakPct: z.number(),
    uncapturedSurplusMwh: z.number(),
  }),
  diagnostics: z.object({
    samplePoints: z.number(),
    chargeSlots: z.number(),
    dischargeSlots: z.number(),
    priceProxyMinEurPerMwh: z.number(),
    priceProxyMaxEurPerMwh: z.number(),
    priceSource: z.enum(["smard_spot", "residual_proxy", "mixed"]),
    positiveRedispatchCostEurPerMwh: z.number(),
  }),
});

type DispatchResponse = z.infer<typeof responseSchema>;

type DispatchDerived = {
  activeQuarterSlots: number;
  activeHoursApprox: number;
  eveningDischargeQuarterSlots: number;
  avgEveningDischargeMw: number;
  dayChargeQuarterSlots: number;
  dischargeQuarterSlotsTotal: number;
  chargeQuarterSlotsTotal: number;
};

function computeDispatchDerived(schedule: DispatchResponse["schedule"]): DispatchDerived {
  let activeQuarterSlots = 0;
  let eveningDischargeQuarterSlots = 0;
  let eveningDischargePowerSumMw = 0;
  let dayChargeQuarterSlots = 0;
  let dischargeQuarterSlotsTotal = 0;
  let chargeQuarterSlotsTotal = 0;

  for (const s of schedule) {
    if (s.action === "charge") {
      chargeQuarterSlotsTotal += 1;
      if (s.hourBerlin < EVENING_GAP_HOUR_START) {
        dayChargeQuarterSlots += 1;
      }
      activeQuarterSlots += 1;
    } else if (s.action === "discharge") {
      dischargeQuarterSlotsTotal += 1;
      activeQuarterSlots += 1;
      if (isEveningGapHour(s.hourBerlin)) {
        eveningDischargeQuarterSlots += 1;
        eveningDischargePowerSumMw += s.powerMw;
      }
    }
  }

  const activeHoursApprox = activeQuarterSlots * QUARTER_HOUR_HOURS_DISPATCH;
  const avgEveningDischargeMw =
    eveningDischargeQuarterSlots > 0
      ? eveningDischargePowerSumMw / eveningDischargeQuarterSlots
      : 0;

  return {
    activeQuarterSlots,
    activeHoursApprox,
    eveningDischargeQuarterSlots,
    avgEveningDischargeMw,
    dayChargeQuarterSlots,
    dischargeQuarterSlotsTotal,
    chargeQuarterSlotsTotal,
  };
}

function scaledEveningCoveragePct(params: {
  eveningDeliveredMwh: number;
  eveningResidualGapMwh: number;
  baselinePowerMw: number;
  targetPowerMw: number;
}): number {
  const { eveningDeliveredMwh, eveningResidualGapMwh, baselinePowerMw, targetPowerMw } = params;
  if (eveningResidualGapMwh <= 1e-6 || baselinePowerMw <= 1e-6) {
    return 0;
  }
  const ratio = clamp(targetPowerMw / baselinePowerMw, 0, 25);
  const scaledDelivered = Math.min(
    eveningResidualGapMwh,
    eveningDeliveredMwh * ratio
  );
  return Math.min(100, (scaledDelivered / eveningResidualGapMwh) * 100);
}

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const INTEGER_FORMATTER = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const EUR_FORMATTER = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const MWH_DETAIL_FORMATTER = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 3,
});

function formatEnergyFromMwh(mwh: number): string {
  const magnitudeMwh = Math.abs(mwh);
  const magnitudeGwh = magnitudeMwh / 1_000;
  if (magnitudeGwh >= 1) {
    return `${NUMBER_FORMATTER.format(magnitudeGwh)} GWh`;
  }
  return `${NUMBER_FORMATTER.format(magnitudeMwh)} MWh`;
}

function formatSignedEnergyFromMwh(mwh: number): string {
  const sign = mwh > 0 ? "+" : mwh < 0 ? "−" : "";
  return `${sign}${formatEnergyFromMwh(Math.abs(mwh))}`;
}

function formatSignedMw(mw: number): string {
  const sign = mw > 0 ? "+" : mw < 0 ? "−" : "";
  return `${sign}${NUMBER_FORMATTER.format(Math.abs(mw))} MW`;
}

const copy = {
  en: {
    eyebrow: "Layer incremental capacity on the same day",
    title: "SpeicherPilot Dispatch Simulator",
    flowBridge:
      "Based on the observed Germany Day Profile directly above—same timestamps, quarters, and Energy-Charts series—this simulator layers additional nameplate MW/MWh your chart does not assume for the fleet today.",
    dataMatchNote:
      "Same ingestion as the daily profile chart above: identical Berlin-day quarter-hours and totals. Dispatch here is hypothetical incremental storage on top of that path (not re-simulating the whole market).",
    intro:
      "Dial in extra power and energy to see how that marginal block would have charged, discharged, and contributed to the evening gap on this exact day—using the same residual-load proxy and policy as the backend run.",
    powerLabel: "Power (MW)",
    powerHint: "AC nameplate power, charge and discharge symmetric.",
    capacityLabel: "Capacity (MWh)",
    capacityHint: "Usable energy capacity. Default 2,000 MWh ≈ 4h at 500 MW.",
    megapackRefTitle: "Megapack reference",
    megapackRefHeadline: (packs: string) =>
      `This simulator size is roughly ${packs} Megapack 2 XL units.`,
    megapackRefDetail: (powerPacks: string, energyPacks: string) =>
      `Power basis ${powerPacks} packs · Energy basis ${energyPacks} packs.`,
    rteLabel: "Round-trip efficiency (%)",
    rteHint: "Applied symmetrically as √η on each side.",
    strategyLabel: "Strategy",
    strategyOption: "Auto Policy v1 (forecast-aware)",
    strategyDescription:
      "Automatically chooses charge/discharge/idle per slot using surplus capture, evening risk, and residual-price regime.",
    runButton: "Run dispatch",
    runButtonLoading: "Running simulation...",
    sourceNote:
      "Backed by today's Energy-Charts quarter-hour totals — same ingestion as the daily profile headline chart.",
    durationLabel: "Duration",
    cyclesLabel: "Cycles",
    placeholderTitle: "Configure incremental storage and run dispatch.",
    placeholderBody:
      "After the chart, stress-test how more MW/MWh would behave on the same quarter-hour tape—coverage of the 17–21 proxy window, gross revenue (price proxy), and SoC path.",
    errorTitle: "Could not run simulation",
    errorRetry: "Try again",
    kpiRevenue: "Total value",
    kpiRedispatch: "Avoided redispatch",
    kpiSpread: "Captured spread",
    kpiDelivered: "Delivered to grid",
    kpiEvening: "Evening coverage",
    kpiCharge: "Avg charge price",
    kpiDischarge: "Avg discharge price",
    kpiRteLoss: "Round-trip loss",
    kpiCycles: "Equivalent cycles",
    chartTitle: "Daily dispatch schedule",
    chartLegendCharge: "Charge",
    chartLegendDischarge: "Discharge",
    chartLegendSoc: "State of charge",
    chartLegendEvening: "Evening window",
    datasetLabel: "Berlin day",
    datasetSamples: (n: number, pct: number) =>
      `${n} quarter-hours observed (${INTEGER_FORMATTER.format(pct)}% of day)`,
    invalidInputs: "Inputs are out of range. Adjust and retry.",
    kpiEstimatedRevenueToday: "Estimated total value today",
    kpiEveningGapCoverage: "Evening gap coverage",
    kpiCyclesToday: "Cycles today",
    kpiMaxReachableEveningSoc: "Max reachable SoC by 17:00",
    kpiImportsAfterBess: "Imports after BESS",
    kpiExportsAfterBess: "Exports after BESS",
    kpiObservedVsDelta: (observed: string, delta: string) =>
      `Observed ${observed} · Δ ${delta} vs observed`,
    kpiCurrentMode: "Current BESS mode",
    kpiPriceProxyHint:
      "SMARD quarter-hour spot price when available; otherwise residual-load proxy fallback.",
    chartSocTitle: "State of charge",
    chartSocTrajectoryTitle: "SoC through the day",
    chartSocTrajectorySubtitle:
      "Simulated stored energy for your configured battery — quarter-hour resolution.",
    chartAxisStoredEnergy: "Stored energy (MWh)",
    chartLegendSocStored: "Stored energy",
    socStatStart: "Start",
    socStatEnd: "Now / end",
    socStatMin: "Min",
    socStatMax: "Max",
    chartResidualTitle: "Residual surplus / deficit",
    chartDispatchTitle: "Dispatch timeline",
    chartAxisTime: "Time (Berlin)",
    chartAxisSoc: "SoC",
    chartAxisPowerDispatch: "Charge / discharge (MW)",
    chartLegendResidualOverlay: "Residual load",
    chartLegendResidualDeficit: "Residual (+deficit / -surplus)",
    tooltipTotalGeneration: "Domestic generation",
    tooltipLoad: "Load",
    tooltipRenewables: "Renewables",
    tooltipAction: "Action",
    tooltipChargeHeadroom: "Charge headroom",
    tooltipDischargeHeadroom: "Discharge headroom",
    tooltipChargeAction: "Charge",
    tooltipDischargeAction: "Discharge",
    tooltipIdleAction: "Idle",
    modeCharging: "Charging",
    modeDischarge: "Discharging",
    modeIdle: "Idle",
    resultsMetaEyebrow: "Simulation result",
    kpiEveningGapFootnote: "Share of Σ max(0, residual) × ¼ h in 17–21 h (Berlin proxy).",
    kpiMaxReachableEveningSocHint: "Best-case from intraday surplus only (power/capacity/RTE constrained).",
    chartLegendMaxReachableSoc: "Max reachable SoC",
    resultsHeadline: (powerMw: number, capMwh: number, revenueEur: string, covPct: string) =>
      `Your virtual ${INTEGER_FORMATTER.format(powerMw)} MW / ${INTEGER_FORMATTER.format(capMwh)} MWh BESS would have created about ${revenueEur} of total value today and covered ${covPct}% of the evening-gap proxy (17–21, Berlin).`,
    socExplainTitle: "Why the SoC looks like this",
    socNarrativeLow:
      "The battery barely moved—few lucrative charge/discharge windows versus your power and RTE, so stored energy stays in a narrow band.",
    socNarrativeArbitrage:
      "Stored energy ramps up across surplus-heavy slots earlier in the day, then drains into the amber evening band—typical aggressive spread / evening-relief shaping on this proxy curve.",
    socNarrativeEveningHeavy:
      "Discharge concentrates in the evening window while charging is limited; the SoC trace tilts toward supporting the 17–21 gap rather than cycling widely across the day.",
    socNarrativeMixed:
      "Charge and discharge interleave with the residual path; the SoC follows the policy’s trade-offs between surplus capture, headroom, and evening delivery rather than a single smooth ramp.",
    insightsTitle: "Simulator insights",
    insightEveningAvgMw: (mw: string) =>
      `Average discharge power across evening discharge slots: ${mw} MW (proxy window 17–21).`,
    insightEveningAvgNone:
      "No dedicated evening discharge quarters in this run—the policy did not push power into the 17–21 proxy band on these slots.",
    insightActiveHours: (h: string) =>
      `Battery active (charging or discharging) for about ${h} hours of the observed series.`,
    insightSpread: (eur: string) => `Realized buy-sell spread (proxy): ${eur} /MWh (discharge minus charge energy-weighted).`,
    keyLearningTitle: "Key learning",
    keyLearningScaled: (cur: string, refMw: string, scaled: string) =>
      `At this configuration you covered about ${cur}% of today’s evening-gap proxy; at ${refMw} MW nameplate (same duration & RTE, illustrative linear power scaling) that proxy share would approach ${scaled}%.`,
    keyLearningScaledNote:
      "Illustrative scaling: assumes deliverable evening energy scales with discharge nameplate until the gap saturates—not a full re-optimization.",
    worthItClosing:
      "You kept the identical market tape as the profile above but isolated how much incremental BESS could extract—use the scaled line to sanity-check sizing.",
  },
  de: {
    eyebrow: "Zusätzliche Kapazität – gleicher Tag",
    title: "SpeicherPilot Dispatch Simulator",
    flowBridge:
      "Bezugspunkt ist das Deutschland-Tagesprofil direkt darüber — dieselben Zeitstempel, Viertelstunden und Energy-Charts-Totale. Hier legen wir nur modellierte zusätzliche Nennleistung und -energie obenauf, die das Chart für die heutige Flotte nicht annimmt.",
    dataMatchNote:
      "Gleiche Datenpipeline wie das Tagesprofil: identische Berliner Viertelstunden und Summen. Der Dispatch ist hypothetischer Zubau-Speicher auf genau diesem Pfad (keine komplette Markt-Neu-Simulation).",
    intro:
      "Stellen Sie zusätzliche Leistung und Kapazität ein und sehen Sie, wie dieser marginale Block heute geladen, entladen und am Abendlücken-Proxy beteiligt gewesen wäre — mit derselben Restlast-Proxy und Policy wie im Backend-Lauf.",
    powerLabel: "Leistung (MW)",
    powerHint: "AC-Nennleistung, symmetrisch für Lade- und Entladevorgang.",
    capacityLabel: "Kapazität (MWh)",
    capacityHint: "Nutzbare Energiekapazität. Default 2.000 MWh ≈ 4h bei 500 MW.",
    megapackRefTitle: "Megapack-Referenz",
    megapackRefHeadline: (packs: string) =>
      `Diese Simulator-Größe entspricht grob ${packs} Megapack 2 XL Einheiten.`,
    megapackRefDetail: (powerPacks: string, energyPacks: string) =>
      `Leistungsbasis ${powerPacks} Packs · Energiebasis ${energyPacks} Packs.`,
    rteLabel: "Round-Trip Efficiency (%)",
    rteHint: "Symmetrisch als √η auf jeder Seite angewandt.",
    strategyLabel: "Strategie",
    strategyOption: "Auto Policy v1 (forecast-aware)",
    strategyDescription:
      "Wählt Laden/Entladen/Stillstand je Slot automatisch anhand von Überschuss, Abendrisiko und Restlast-Preisregime.",
    runButton: "Dispatch simulieren",
    runButtonLoading: "Simulation läuft...",
    sourceNote:
      "Heute Energy-Charts Viertelstunden — gleiche Datenpipeline wie beim großen Deutschland-Tagesprofil.",
    durationLabel: "Dauer",
    cyclesLabel: "Zyklen",
    placeholderTitle: "Zubau konfigurieren und Dispatch starten.",
    placeholderBody:
      "Nach dem Chart dieselbe Viertelstunden-Spur unter Spannung setzen — Abdeckung 17–21 (Proxy), Bruttoerlös (Preis-Proxy) und SoC-Verlauf.",
    errorTitle: "Simulation konnte nicht ausgeführt werden",
    errorRetry: "Erneut versuchen",
    kpiRevenue: "Gesamtwert",
    kpiRedispatch: "Vermiedene Redispatch-Kosten",
    kpiSpread: "Eingefangener Spread",
    kpiDelivered: "Ans Netz geliefert",
    kpiEvening: "Abendabdeckung",
    kpiCharge: "Ø Ladepreis",
    kpiDischarge: "Ø Entladepreis",
    kpiRteLoss: "Round-Trip-Verlust",
    kpiCycles: "Äquivalente Zyklen",
    chartTitle: "Täglicher Dispatch-Plan",
    chartLegendCharge: "Laden",
    chartLegendDischarge: "Entladen",
    chartLegendSoc: "Ladezustand",
    chartLegendEvening: "Abendfenster",
    datasetLabel: "Berliner Tag",
    datasetSamples: (n: number, pct: number) =>
      `${n} Viertelstunden beobachtet (${INTEGER_FORMATTER.format(pct)}% des Tages)`,
    invalidInputs: "Eingaben außerhalb des Bereichs. Bitte anpassen und erneut versuchen.",
    kpiEstimatedRevenueToday: "Geschätzter Gesamtwert heute",
    kpiEveningGapCoverage: "Abendlücken-Abdeckung",
    kpiCyclesToday: "Zyklen heute",
    kpiMaxReachableEveningSoc: "Max. erreichbarer SoC bis 17:00",
    kpiImportsAfterBess: "Importe nach BESS",
    kpiExportsAfterBess: "Exporte nach BESS",
    kpiObservedVsDelta: (observed: string, delta: string) =>
      `Beobachtet ${observed} · Δ ${delta} ggü. Ist`,
    kpiCurrentMode: "Aktueller BESS-Modus",
    kpiPriceProxyHint:
      "SMARD Viertelstunden-Spotpreis soweit verfügbar, sonst Restlast-Proxy als Fallback.",
    chartSocTitle: "SoC-Verlauf",
    chartSocTrajectoryTitle: "SoC-Verlauf über den Tag",
    chartSocTrajectorySubtitle:
      "Simulierte gespeicherte Energie für Ihre konfigurierte Batterie — Viertelstundenbasis.",
    chartAxisStoredEnergy: "Gespeicherte Energie (MWh)",
    chartLegendSocStored: "Gespeicherte Energie",
    socStatStart: "Start",
    socStatEnd: "Jetzt / Ende",
    socStatMin: "Min",
    socStatMax: "Max",
    chartResidualTitle: "Residuale Über-/Unterdeckung",
    chartDispatchTitle: "Dispatch-Zeitleiste",
    chartAxisTime: "Uhrzeit (Berlin)",
    chartAxisSoc: "SoC",
    chartAxisPowerDispatch: "Laden / Entladen (MW)",
    chartLegendResidualOverlay: "Restlast",
    chartLegendResidualDeficit: "Restlast (+Defizit / -Überschuss)",
    tooltipTotalGeneration: "Inlands-Erzeugung",
    tooltipLoad: "Last",
    tooltipRenewables: "Erneuerbare",
    tooltipAction: "Aktion",
    tooltipChargeHeadroom: "Lade-Spielraum",
    tooltipDischargeHeadroom: "Entlade-Spielraum",
    tooltipChargeAction: "Laden",
    tooltipDischargeAction: "Entladen",
    tooltipIdleAction: "Stillstand",
    modeCharging: "Laden",
    modeDischarge: "Entladen",
    modeIdle: "Stillstand",
    resultsMetaEyebrow: "Simulationsergebnis",
    kpiEveningGapFootnote: "Anteil am Proxy Σ Restlast⁺ · ¼ h (17–21 Uhr, Berlin).",
    kpiMaxReachableEveningSocHint:
      "Best-Case nur aus Intraday-Überschuss (begrenzt durch Leistung/Kapazität/RTE).",
    chartLegendMaxReachableSoc: "Max. erreichbarer SoC",
    resultsHeadline: (powerMw: number, capMwh: number, revenueEur: string, covPct: string) =>
      `Ihr virtuelles ${INTEGER_FORMATTER.format(powerMw)} MW / ${INTEGER_FORMATTER.format(capMwh)} MWh BESS hätte heute rund ${revenueEur} Gesamtwert erzeugt und ${covPct}% des Abendlücken-Proxys (17–21, Berlin) abgedeckt.`,
    socExplainTitle: "Warum der SoC so verläuft",
    socNarrativeLow:
      "Die Batterie bewegt sich kaum — es gab relativ wenige lohnende Lade-/Entlade-Fenster gegenüber Ihrer Leistung und RTE, die gespeicherte Energie bleibt in einem schmalen Band.",
    socNarrativeArbitrage:
      "Die gespeicherte Energie steigt Über tagsüber in Überschuss-Slots und fällt im gelben Abendfenster ab — typisches aggressives Arbitrage-/Abend-Entlastungs-Muster auf diesem Proxy.",
    socNarrativeEveningHeavy:
      "Entladung konzentriert sich im Abendfenster, Laden ist begrenzt; der SoC zielt stärker auf 17–21 als auf breite Tageszyklen.",
    socNarrativeMixed:
      "Laden und Entladen wechseln mit der Restlast — der SoC spiegelt Policy-Kompromisse zwischen Überschussaufnahme, Spielraum und Abendlieferung statt eines einzelnen linearen Ramps.",
    insightsTitle: "Simulator-Insights",
    insightEveningAvgMw: (mw: string) =>
      `Mittlere Entladeleistung in Abend-Entlade-Slots: ${mw} MW (Proxy-Fenster 17–21).`,
    insightEveningAvgNone:
      "In diesem Lauf keine Abend-Entlade-Viertelstunden — die Policy hat in diese 17–21-Proxy-Slots keine Entladepower geschoben.",
    insightActiveHours: (h: string) =>
      `Batterie aktiv (Laden oder Entladen) für rund ${h} Stunden in der beobachteten Serie.`,
    insightSpread: (eur: string) =>
      `Realisierter Kauf-Verkauf-Spread (Proxy): ${eur} /MWh (energiegewichtet Entladen minus Laden).`,
    keyLearningTitle: "Kernaussage",
    keyLearningScaled: (cur: string, refMw: string, scaled: string) =>
      `Mit dieser Konfiguration hätten Sie rund ${cur}% des heutigen Abendlücken-Proxys abgedeckt — bei ${refMw} MW Nennleistung (gleiche Dauer & RTE, illustratives lineares MW-Skalieren) läge der Anteil am Proxy bei etwa ${scaled}%.`,
    keyLearningScaledNote:
      "Illustration: zulässige Abendenergie skaliert mit Entlade-Nennleistung, bis die Lücke sättigt — kein vollständiges Re-Optimizing.",
    worthItClosing:
      "Gleiche Marktspur wie oben, aber isoliert, wie viel Zubau-Speicher heute geholt hätte — die Skalierungszeile ist ein schneller Größen-Check.",
  },
} as const;

type ChartDatum = {
  index: number;
  /** Quarter-hour label HH:mm (Berlin). */
  timeLabel: string;
  hourBerlin: number;
  action: "charge" | "discharge" | "idle";
  loadMw: number | null;
  totalGenerationMw: number | null;
  renewableGenerationMw: number | null;
  dischargeMw: number;
  /** Negative grid draw MW for bar chart. */
  chargeSignedMw: number;
  socPct: number;
  /** Stored energy at end of slot (MWh). */
  socMwh: number;
  chargeHeadroomMwh: number;
  dischargeHeadroomMwh: number;
  maxReachableSocPct: number;
  residualLoadMw: number;
  observedCrossBorderMw: number | null;
  simulatedCrossBorderMw: number | null;
};

export default function BessDispatchSimulator() {
  const { language } = useLanguage();
  const t = copy[language];
  const formId = useId();

  const [powerMw, setPowerMw] = useState<number>(DEFAULT_INPUTS.powerMw);
  const [capacityMwh, setCapacityMwh] = useState<number>(DEFAULT_INPUTS.capacityMwh);
  const [rteEfficiencyPct, setRteEfficiencyPct] = useState<number>(DEFAULT_INPUTS.rteEfficiencyPct);

  const [isRunning, setIsRunning] = useState(false);
  const [response, setResponse] = useState<DispatchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const durationHours = capacityMwh > 0 && powerMw > 0 ? capacityMwh / powerMw : 0;
  const megapackEquivalent = useMemo(
    () => getMegapackEquivalent({ powerMw, capacityMwh, referencePackType: "megapack-2-xl" }),
    [capacityMwh, powerMw]
  );

  const inputsValid =
    Number.isFinite(powerMw) &&
    Number.isFinite(capacityMwh) &&
    Number.isFinite(rteEfficiencyPct) &&
    powerMw >= POWER_MIN_MW &&
    powerMw <= POWER_MAX_MW &&
    capacityMwh >= CAPACITY_MIN_MWH &&
    capacityMwh <= CAPACITY_MAX_MWH &&
    rteEfficiencyPct >= RTE_MIN_PCT &&
    rteEfficiencyPct <= RTE_MAX_PCT;

  const runSimulation = async () => {
    if (!inputsValid) {
      setError(t.invalidInputs);
      return;
    }
    setIsRunning(true);
    setError(null);
    try {
      const apiResponse = await fetch("/api/dispatch/de", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          powerMw,
          capacityMwh,
          rteEfficiencyPct,
          strategy: STRATEGY_VALUE,
        }),
        cache: "no-store",
      });

      if (!apiResponse.ok) {
        const payload = (await apiResponse.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? `Request failed with status ${apiResponse.status}`);
      }

      const payload = await apiResponse.json();
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) {
        log("dispatch response failed schema validation %o", {
          errors: parsed.error.flatten(),
        });
        throw new Error("Unexpected response shape from dispatch API.");
      }

      setResponse(parsed.data);
    } catch (caught) {
      log("dispatch simulation failed %o", { error: caught });
      setError(caught instanceof Error ? caught.message : language === "de" ? "Unbekannter Fehler" : "Unknown error");
    } finally {
      setIsRunning(false);
    }
  };

  const chartData = useMemo<ChartDatum[]>(() => {
    if (!response) {
      return [];
    }
    return response.schedule.map((entry, index) => {
      const date = new Date(entry.timestampIso);
      const timeLabel = new Intl.DateTimeFormat("de-DE", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
      const dischargeMw = entry.action === "discharge" ? entry.powerMw : 0;
      return {
        index,
        timeLabel,
        hourBerlin: entry.hourBerlin,
        action: entry.action,
        loadMw: entry.loadMw,
        totalGenerationMw: entry.totalGenerationMw,
        renewableGenerationMw: entry.renewableGenerationMw,
        dischargeMw,
        chargeSignedMw: entry.action === "charge" ? entry.powerMw : 0,
        socPct: entry.socPct,
        socMwh: entry.socMwh,
        chargeHeadroomMwh: entry.chargeHeadroomMwh,
        dischargeHeadroomMwh: entry.dischargeHeadroomMwh,
        maxReachableSocPct: entry.maxReachableSocPct,
        residualLoadMw: entry.residualLoadMw,
        observedCrossBorderMw: entry.crossBorderElectricityTradingMw,
        simulatedCrossBorderMw: entry.simulatedCrossBorderElectricityTradingMw,
      };
    });
  }, [response]);

  const eveningBoundaries = useMemo(() => {
    if (chartData.length === 0) {
      return null;
    }
    const eveningSlots = chartData.filter((d) => isEveningGapHour(d.hourBerlin));
    if (eveningSlots.length === 0) {
      return null;
    }
    const startIndex = eveningSlots[0].index;
    const endIndex = eveningSlots[eveningSlots.length - 1].index;
    return { startIndex, endIndex };
  }, [chartData]);

  return (
    <section
      id="dispatch-simulator"
      className="relative my-10 overflow-hidden rounded-2xl border border-emerald-400/35 bg-gradient-to-b from-emerald-50/90 via-white to-white px-5 py-7 shadow-[0_14px_40px_rgba(5,150,105,0.08)] md:my-12 md:rounded-[1.75rem] md:px-8 md:py-9 dark:border-emerald-500/25 dark:from-emerald-950/40 dark:via-slate-900/92 dark:to-slate-950/95 dark:shadow-[0_18px_48px_rgba(16,185,129,0.06)]"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-emerald-400/18 via-transparent to-transparent dark:from-emerald-400/10" />

      <header className="relative space-y-3">
        <p className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-emerald-800 uppercase dark:text-emerald-200">
          <Zap className="h-3.5 w-3.5" /> {t.eyebrow}
        </p>
        <h2 className="max-w-4xl text-2xl leading-tight text-slate-900 md:text-[1.95rem] lg:text-4xl dark:text-white [font-family:var(--font-heading)]">
          {t.title}
        </h2>
        <p className="max-w-3xl text-sm font-medium leading-relaxed text-slate-700 md:text-[15px] dark:text-slate-200">
          {t.flowBridge}
        </p>
        <p className="max-w-3xl rounded-xl border border-emerald-400/35 bg-emerald-50/60 px-3 py-2 text-sm font-medium leading-snug text-emerald-950 md:text-[15px] dark:border-emerald-500/25 dark:bg-emerald-500/12 dark:text-emerald-50">
          {t.dataMatchNote}
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-600 md:text-[15px] dark:text-slate-300">
          {t.intro}
        </p>
      </header>

      <div
        className={`relative mt-10 grid min-w-0 gap-6 ${
          !response && !isRunning && !error
            ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
            : ""
        }`}
      >
        <form
          id={formId}
          className="min-w-0 rounded-2xl border border-slate-300/55 bg-white/85 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)] dark:border-slate-500/35 dark:bg-slate-900/70 md:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void runSimulation();
          }}
        >
          <NumberSliderField
            id={`${formId}-power`}
            label={t.powerLabel}
            unit="MW"
            min={POWER_MIN_MW}
            max={POWER_MAX_MW}
            step={10}
            value={powerMw}
            hint={t.powerHint}
            onChange={(value) => setPowerMw(clamp(value, POWER_MIN_MW, POWER_MAX_MW))}
          />

          <div className="mt-5">
            <NumberSliderField
              id={`${formId}-capacity`}
              label={t.capacityLabel}
              unit="MWh"
              min={CAPACITY_MIN_MWH}
              max={CAPACITY_MAX_MWH}
              step={50}
              value={capacityMwh}
              hint={t.capacityHint}
              onChange={(value) => setCapacityMwh(clamp(value, CAPACITY_MIN_MWH, CAPACITY_MAX_MWH))}
            />
          </div>

          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-slate-300/60 bg-white/70 px-3 py-1 text-xs text-slate-600 dark:border-slate-500/40 dark:bg-slate-900/60 dark:text-slate-300">
            <span className="font-medium">{t.durationLabel}</span>
            <span className="font-semibold text-slate-900 dark:text-white">
              {NUMBER_FORMATTER.format(durationHours)} h
            </span>
          </div>

          <div className="mt-4 rounded-2xl border border-emerald-400/30 bg-emerald-50/70 px-4 py-3 dark:border-emerald-400/20 dark:bg-emerald-500/8">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-emerald-800 uppercase dark:text-emerald-200">
              {t.megapackRefTitle}
            </p>
            <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
              {t.megapackRefHeadline(
                INTEGER_FORMATTER.format(megapackEquivalent.roundedRequiredPacks)
              )}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {t.megapackRefDetail(
                NUMBER_FORMATTER.format(megapackEquivalent.packsByPower),
                NUMBER_FORMATTER.format(megapackEquivalent.packsByEnergy)
              )}{" "}
              ({NUMBER_FORMATTER.format(megapackEquivalent.referencePack.powerMw)} MW /{" "}
              {NUMBER_FORMATTER.format(megapackEquivalent.referencePack.energyMwh)} MWh each).
            </p>
          </div>

          <div className="mt-5">
            <NumberSliderField
              id={`${formId}-rte`}
              label={t.rteLabel}
              unit="%"
              min={RTE_MIN_PCT}
              max={RTE_MAX_PCT}
              step={1}
              value={rteEfficiencyPct}
              hint={t.rteHint}
              onChange={(value) =>
                setRteEfficiencyPct(clamp(value, RTE_MIN_PCT, RTE_MAX_PCT))
              }
            />
          </div>

          <label className="mt-5 block">
            <span className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
              {t.strategyLabel}
            </span>
            <select
              className="apple-input mt-2 cursor-not-allowed appearance-none"
              value={STRATEGY_VALUE}
              onChange={() => {
                /* Single strategy MVP — no-op handler keeps select controlled. */
              }}
            >
              <option value={STRATEGY_VALUE}>{t.strategyOption}</option>
            </select>
            <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {t.strategyDescription}
            </p>
          </label>

          <div className="mt-7 space-y-2">
            <button
              type="submit"
              disabled={isRunning || !inputsValid}
              className="group relative inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-4 text-base font-semibold text-white shadow-[0_18px_36px_rgba(5,150,105,0.35)] transition hover:-translate-y-0.5 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 dark:bg-emerald-500 dark:hover:bg-emerald-400 md:text-lg"
            >
              {isRunning ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {t.runButtonLoading}
                </>
              ) : (
                <>
                  <BatteryCharging className="h-5 w-5" />
                  {t.runButton}
                </>
              )}
            </button>
            <p className="text-center text-xs text-slate-500 dark:text-slate-400">
              {t.sourceNote}
            </p>
          </div>
        </form>

        {!response && !isRunning && !error ? (
          <div className="min-w-0 rounded-2xl border border-slate-300/55 bg-white/65 p-5 dark:border-slate-500/35 dark:bg-slate-900/55 md:p-6">
            <PlaceholderState title={t.placeholderTitle} body={t.placeholderBody} />
          </div>
        ) : null}
      </div>

      <div className="relative mt-8 min-w-0 md:mt-10">
        <AnimatePresence mode="wait">
          {isRunning ? (
            <ResultsLoadingSkeleton key="loading" />
          ) : error ? (
            <div
              key="error"
              className="rounded-2xl border border-slate-300/55 bg-white/65 p-6 dark:border-slate-500/35 dark:bg-slate-900/55 md:p-8"
            >
              <ErrorState
                title={t.errorTitle}
                message={error}
                retryLabel={t.errorRetry}
                onRetry={() => void runSimulation()}
              />
            </div>
          ) : response ? (
            <ResultsPanel
              key={`results-${response.dataset.dateBerlin}-${response.inputs.powerMw}-${response.inputs.capacityMwh}-${response.results.totalValueEur}`}
              language={language}
              response={response}
              chartData={chartData}
              eveningBoundaries={eveningBoundaries}
              t={t}
            />
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

function NumberSliderField({
  id,
  label,
  unit,
  min,
  max,
  step,
  value,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor={id}
          className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300"
        >
          {label}
        </label>
        <span className="text-sm font-semibold text-slate-900 dark:text-white">
          {INTEGER_FORMATTER.format(value)} {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) {
            onChange(parsed);
          }
        }}
        className="mt-2 w-full accent-emerald-600 dark:accent-emerald-300"
      />
      <div className="mt-2 flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) {
              onChange(parsed);
            }
          }}
          className="apple-input h-9 w-28 text-sm"
        />
        <span className="text-xs text-slate-500 dark:text-slate-400">{unit}</span>
      </div>
      {hint ? (
        <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

function PlaceholderState({ title, body }: { title: string; body: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      className="flex h-full min-h-[420px] flex-col items-center justify-center gap-4 text-center"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-300/60 bg-emerald-50/80 text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-400/10 dark:text-emerald-200">
        <BatteryCharging className="h-7 w-7" />
      </div>
      <p className="max-w-md text-base font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </p>
      <p className="max-w-md text-sm text-slate-600 dark:text-slate-300">{body}</p>
    </motion.div>
  );
}

function ResultsLoadingSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="space-y-4"
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={`kpi-skel-${index}`} className="rounded-xl border border-slate-300/40 bg-white/70 p-4 dark:border-slate-500/35 dark:bg-slate-900/55">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="mt-3 h-7 w-2/3" />
            <Skeleton className="mt-2 h-3 w-3/4" />
          </div>
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-52 w-full rounded-xl" />
    </motion.div>
  );
}

function ErrorState({
  title,
  message,
  retryLabel,
  onRetry,
}: {
  title: string;
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="flex h-full min-h-[420px] flex-col items-center justify-center gap-4 text-center"
    >
      <p className="text-sm font-semibold text-red-700 dark:text-red-200">{title}</p>
      <p className="max-w-md rounded-xl border border-red-400/45 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-200">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-emerald-400 hover:text-emerald-700 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200"
      >
        {retryLabel}
      </button>
    </motion.div>
  );
}

function pickSocNarrative(params: {
  scheduleLength: number;
  derived: DispatchDerived;
  socSwingPct: number;
  t: (typeof copy)[keyof typeof copy];
}): string {
  const { scheduleLength, derived, socSwingPct, t } = params;
  const activeShare =
    scheduleLength > 0 ? derived.activeQuarterSlots / scheduleLength : 0;
  const eveningDischargeShare =
    derived.dischargeQuarterSlotsTotal > 0
      ? derived.eveningDischargeQuarterSlots / derived.dischargeQuarterSlotsTotal
      : 0;
  const dayChargeShare =
    derived.chargeQuarterSlotsTotal > 0
      ? derived.dayChargeQuarterSlots / derived.chargeQuarterSlotsTotal
      : 0;

  if (activeShare < 0.07 || socSwingPct < 10) {
    return t.socNarrativeLow;
  }
  if (dayChargeShare >= 0.42 && eveningDischargeShare >= 0.48 && socSwingPct >= 16) {
    return t.socNarrativeArbitrage;
  }
  if (eveningDischargeShare >= 0.52 && dayChargeShare < 0.38) {
    return t.socNarrativeEveningHeavy;
  }
  return t.socNarrativeMixed;
}

function useAnimatedNumber(target: number, durationMs = 880) {
  const positionRef = useRef(target);
  const [display, setDisplay] = useState(target);

  useEffect(() => {
    const from = positionRef.current;
    let raf = 0;
    const start = performance.now();
    const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const v = from + (target - from) * easeOutCubic(t);
      positionRef.current = v;
      setDisplay(v);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        positionRef.current = target;
        setDisplay(target);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [target, durationMs]);

  return display;
}

function ResultsPanel({
  language,
  response,
  chartData,
  eveningBoundaries,
  t,
}: {
  language: AppLanguage;
  response: DispatchResponse;
  chartData: ChartDatum[];
  eveningBoundaries: { startIndex: number; endIndex: number } | null;
  t: (typeof copy)[keyof typeof copy];
}) {
  const gradientSuffix = useId().replace(/:/g, "");
  const socGradientId = `socfill-${gradientSuffix}`;
  const { results, dataset, inputs, market, schedule } = response;
  const samplePct = dataset.pointFractionOfDay * 100;

  const eveningResidualGapMwh = useMemo(
    () =>
      schedule
        .filter((s) => isEveningGapHour(s.hourBerlin))
        .reduce(
          (acc, s) => acc + Math.max(0, s.residualLoadMw) * QUARTER_HOUR_HOURS_DISPATCH,
          0
        ),
    [schedule]
  );

  const eveningGapCoveragePct = useMemo(() => {
    if (eveningResidualGapMwh > 1e-3) {
      return Math.min(100, (results.eveningDeliveredMwh / eveningResidualGapMwh) * 100);
    }
    return results.eveningCoveragePct;
  }, [
    eveningResidualGapMwh,
    results.eveningCoveragePct,
    results.eveningDeliveredMwh,
  ]);

  const dispatchDerived = useMemo(() => computeDispatchDerived(schedule), [schedule]);

  const scaledEveningForKeyLearningPct = useMemo(
    () =>
      scaledEveningCoveragePct({
        eveningDeliveredMwh: results.eveningDeliveredMwh,
        eveningResidualGapMwh,
        baselinePowerMw: inputs.powerMw,
        targetPowerMw: KEY_LEARNING_SCALE_POWER_MW,
      }),
    [
      eveningResidualGapMwh,
      inputs.powerMw,
      results.eveningDeliveredMwh,
    ]
  );

  const animRevenue = useAnimatedNumber(results.totalValueEur);
  const animRedispatch = useAnimatedNumber(results.avoidedRedispatchCostEur);
  const animEveningMwh = useAnimatedNumber(results.eveningDeliveredMwh);
  const animCoverage = useAnimatedNumber(eveningGapCoveragePct);
  const animCycles = useAnimatedNumber(results.cycles);
  const animMaxReachableEveningSoc = useAnimatedNumber(results.maxReachableSocByEveningPct);
  const animSimulatedImports = useAnimatedNumber(results.simulatedImportEnergyMwh);
  const animSimulatedExports = useAnimatedNumber(results.simulatedExportEnergyMwh);

  const powerLim = inputs.powerMw * 1.08;
  const xAxisInterval =
    chartData.length > 0 ? Math.max(2, Math.floor(chartData.length / 9)) : 0;

  const xEveningStart = eveningBoundaries
    ? chartData[eveningBoundaries.startIndex]?.timeLabel
    : undefined;
  const xEveningEnd = eveningBoundaries
    ? chartData[eveningBoundaries.endIndex]?.timeLabel
    : undefined;
  const actionLabel = (action: ChartDatum["action"]) => {
    if (action === "charge") {
      return t.modeCharging;
    }
    if (action === "discharge") {
      return t.modeDischarge;
    }
    return t.modeIdle;
  };
  const currentModeLabel = actionLabel(schedule[schedule.length - 1]?.action ?? "idle");
  const priceSourceLabel =
    market.priceSource === "smard_spot"
      ? language === "de"
        ? "Preis: SMARD Spot"
        : "Price: SMARD spot"
      : market.priceSource === "mixed"
        ? language === "de"
          ? "Preis: SMARD + Proxy"
          : "Price: SMARD + proxy"
        : language === "de"
          ? "Preis: Proxy"
          : "Price: proxy";

  const socTrajectoryStats = useMemo(() => {
    if (chartData.length === 0) {
      return null;
    }
    let minPct = chartData[0].socPct;
    let maxPct = chartData[0].socPct;
    let minMwh = chartData[0].socMwh;
    let maxMwh = chartData[0].socMwh;
    for (const d of chartData) {
      minPct = Math.min(minPct, d.socPct);
      maxPct = Math.max(maxPct, d.socPct);
      minMwh = Math.min(minMwh, d.socMwh);
      maxMwh = Math.max(maxMwh, d.socMwh);
    }
    const last = chartData.length - 1;
    return {
      startPct: chartData[0].socPct,
      endPct: chartData[last].socPct,
      startMwh: chartData[0].socMwh,
      endMwh: chartData[last].socMwh,
      minPct,
      maxPct,
      minMwh,
      maxMwh,
    };
  }, [chartData]);

  const socSwingPct =
    socTrajectoryStats === null ? 0 : socTrajectoryStats.maxPct - socTrajectoryStats.minPct;

  const socShapeNarrative = useMemo(
    () =>
      pickSocNarrative({
        scheduleLength: schedule.length,
        derived: dispatchDerived,
        socSwingPct,
        t,
      }),
    [dispatchDerived, schedule.length, socSwingPct, t]
  );

  const headlineRevenueStr = EUR_FORMATTER.format(Math.round(animRevenue));
  const headlineCoverageStr = NUMBER_FORMATTER.format(animCoverage);
  const headlineText = t.resultsHeadline(
    inputs.powerMw,
    inputs.capacityMwh,
    headlineRevenueStr,
    headlineCoverageStr
  );

  const activeHoursLabel = NUMBER_FORMATTER.format(dispatchDerived.activeHoursApprox);

  const spreadEuroStr = NUMBER_FORMATTER.format(results.averageSpreadEurPerMwh);

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="space-y-6 rounded-[1.75rem] border border-slate-300/55 bg-white/80 p-5 shadow-[0_22px_50px_rgba(15,23,42,0.07)] dark:border-slate-500/35 dark:bg-slate-900/65 md:p-8"
    >
      <div className="flex flex-col gap-3 border-b border-slate-300/45 pb-5 dark:border-slate-500/35 md:flex-row md:flex-wrap md:items-center md:justify-between">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.2em] text-emerald-700 uppercase dark:text-emerald-300/90">
            {t.resultsMetaEyebrow}
          </p>
          <p className="mt-1 inline-flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
            <span className="rounded-full border border-emerald-300/55 bg-emerald-50/90 px-3 py-1 text-xs tracking-[0.06em] text-emerald-900 uppercase dark:border-emerald-400/35 dark:bg-emerald-400/10 dark:text-emerald-100">
              {t.datasetLabel}: {dataset.dateBerlin}
            </span>
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 md:items-end">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t.datasetSamples(dataset.samplePoints, samplePct)}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <p className="rounded-full border border-slate-300/55 bg-white/80 px-3 py-1 text-xs font-medium text-slate-700 dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200">
              {t.kpiCurrentMode}: {currentModeLabel}
            </p>
            <p className="rounded-full border border-slate-300/55 bg-white/80 px-3 py-1 text-xs font-medium text-slate-700 dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200">
              {priceSourceLabel}
            </p>
          </div>
        </div>
      </div>

      <p className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.07] px-4 py-3 text-base leading-snug font-semibold text-emerald-950 md:px-5 md:py-4 md:text-lg dark:border-emerald-400/25 dark:bg-emerald-950/35 dark:text-emerald-50 [font-family:var(--font-heading)]">
        {headlineText}
      </p>

      <motion.div
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
        }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-7"
      >
        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-slate-300/50 bg-white/90 p-5 shadow-sm dark:border-slate-500/35 dark:bg-slate-900/75"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
            {t.kpiEstimatedRevenueToday}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {EUR_FORMATTER.format(Math.round(animRevenue))}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {t.kpiPriceProxyHint}
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-amber-400/35 bg-gradient-to-br from-amber-50/90 to-white/90 p-5 shadow-sm dark:border-amber-400/25 dark:from-amber-500/10 dark:to-slate-900/80"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-amber-900/80 uppercase dark:text-amber-200/90">
            {t.kpiRedispatch}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {EUR_FORMATTER.format(Math.round(animRedispatch))}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
            {MWH_DETAIL_FORMATTER.format(results.chargedFromCurtailmentMwh)} MWh ·{" "}
            {NUMBER_FORMATTER.format(market.positiveRedispatchCostEurPerMwh)} EUR/MWh
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-amber-400/35 bg-gradient-to-br from-amber-50/90 to-white/90 p-5 shadow-sm dark:border-amber-400/25 dark:from-amber-500/10 dark:to-slate-900/80"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-amber-900/80 uppercase dark:text-amber-200/90">
            {t.kpiEveningGapCoverage}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {MWH_DETAIL_FORMATTER.format(animEveningMwh)} MWh
          </p>
          <p className="mt-2 text-sm font-semibold text-amber-900/90 dark:text-amber-100/90">
            ({NUMBER_FORMATTER.format(animCoverage)}%)
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
            {t.kpiEveningGapFootnote}
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-emerald-400/35 bg-white/90 p-5 shadow-sm dark:border-emerald-400/25 dark:bg-slate-900/75"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-emerald-800 uppercase dark:text-emerald-200/90">
            {t.kpiCyclesToday}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {NUMBER_FORMATTER.format(animCycles)}
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-sky-400/35 bg-white/90 p-5 shadow-sm dark:border-sky-400/25 dark:bg-slate-900/75"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-sky-900/80 uppercase dark:text-sky-200/90">
            {t.kpiMaxReachableEveningSoc}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-sky-950 md:text-3xl dark:text-sky-100">
            {INTEGER_FORMATTER.format(Math.round(animMaxReachableEveningSoc))}%
          </p>
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
            {t.kpiMaxReachableEveningSocHint}
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-amber-400/35 bg-white/90 p-5 shadow-sm dark:border-amber-400/25 dark:bg-slate-900/75"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-amber-900/80 uppercase dark:text-amber-200/90">
            {t.kpiImportsAfterBess}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {formatEnergyFromMwh(animSimulatedImports)}
          </p>
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
            {t.kpiObservedVsDelta(
              formatEnergyFromMwh(results.observedImportEnergyMwh),
              formatSignedEnergyFromMwh(results.importDeltaEnergyMwh)
            )}
          </p>
        </motion.article>

        <motion.article
          variants={{
            hidden: { opacity: 0, y: 14 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.34, ease: "easeOut" } },
          }}
          className="rounded-2xl border border-emerald-400/35 bg-white/90 p-5 shadow-sm dark:border-emerald-400/25 dark:bg-slate-900/75"
        >
          <p className="text-[11px] font-semibold tracking-[0.14em] text-emerald-800 uppercase dark:text-emerald-200/90">
            {t.kpiExportsAfterBess}
          </p>
          <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl dark:text-white">
            {formatEnergyFromMwh(animSimulatedExports)}
          </p>
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
            {t.kpiObservedVsDelta(
              formatEnergyFromMwh(results.observedExportEnergyMwh),
              formatSignedEnergyFromMwh(results.exportDeltaEnergyMwh)
            )}
          </p>
        </motion.article>

      </motion.div>

      <motion.div
        id="dispatch-soc-trajectory"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.06, ease: "easeOut" }}
        className="rounded-2xl border-2 border-indigo-400/35 bg-gradient-to-b from-indigo-50/90 via-white/95 to-white p-4 shadow-[0_12px_40px_rgba(79,70,229,0.08)] md:p-6 dark:border-indigo-400/28 dark:from-indigo-950/45 dark:via-slate-900/85 dark:to-slate-900/75 dark:shadow-[0_12px_40px_rgba(99,102,241,0.06)]"
      >
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-[0.14em] text-indigo-800 uppercase dark:text-indigo-200">
              {t.chartSocTrajectoryTitle}
            </p>
            <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
              {t.chartSocTrajectorySubtitle}{" "}
              <span className="tabular-nums text-slate-500 dark:text-slate-500">
                ({INTEGER_FORMATTER.format(inputs.capacityMwh)} MWh nameplate · {NUMBER_FORMATTER.format(inputs.rteEfficiencyPct)}% RTE).
              </span>
            </p>
          </div>
        </div>

        {socTrajectoryStats ? (
          <div className="mt-4 grid grid-cols-2 gap-2 tabular-nums sm:grid-cols-4">
            <SocStatChip
              label={t.socStatStart}
              pct={socTrajectoryStats.startPct}
              mwh={socTrajectoryStats.startMwh}
            />
            <SocStatChip
              label={t.socStatEnd}
              pct={socTrajectoryStats.endPct}
              mwh={socTrajectoryStats.endMwh}
            />
            <SocStatChip label={t.socStatMin} pct={socTrajectoryStats.minPct} mwh={socTrajectoryStats.minMwh} />
            <SocStatChip label={t.socStatMax} pct={socTrajectoryStats.maxPct} mwh={socTrajectoryStats.maxMwh} />
          </div>
        ) : null}

        <div className="mt-4 rounded-xl border border-indigo-200/80 bg-indigo-50/50 px-3 py-3 dark:border-indigo-500/30 dark:bg-indigo-950/40 md:px-4 md:py-3.5">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-indigo-900 uppercase dark:text-indigo-200">
            {t.socExplainTitle}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-slate-800 dark:text-slate-100">{socShapeNarrative}</p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-slate-600 dark:text-slate-400">
          <LegendDot color="rgb(79,70,229)" label={t.chartLegendSoc} />
          <LegendDot color="rgb(124,58,237)" label={t.chartLegendSocStored} />
          <LegendDot color="rgb(14,116,144)" label={t.chartLegendMaxReachableSoc} />
          <LegendDot color="rgba(251,191,36,0.45)" label={t.chartLegendEvening} square />
          <span className="text-slate-400 dark:text-slate-500">·</span>
          <span>
            {t.chartAxisTime} · 15&nbsp;min
          </span>
        </div>

        <div className="mt-3 h-[min(400px,calc(62vh))] min-h-[300px] w-full sm:min-h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 4, bottom: 22, left: 4 }}>
              <defs>
                <linearGradient id={socGradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(79,70,229)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="rgb(79,70,229)" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(148,163,184,0.2)" strokeDasharray="3 3" />
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 11, fill: "rgb(100,116,139)" }}
                interval={xAxisInterval}
                height={36}
                axisLine={{ stroke: "rgba(148,163,184,0.45)" }}
                tickMargin={6}
              />
              <YAxis
                yAxisId="pct"
                domain={[0, 100]}
                orientation="left"
                tick={{ fontSize: 11, fill: "rgb(100,116,139)" }}
                tickFormatter={(v) => `${v}%`}
                width={44}
                label={{
                  value: t.chartAxisSoc,
                  angle: -90,
                  position: "insideLeft",
                  fontSize: 10,
                  fill: "rgb(100,116,139)",
                }}
              />
              <YAxis
                yAxisId="mwh"
                orientation="right"
                domain={[0, inputs.capacityMwh]}
                tick={{ fontSize: 11, fill: "rgb(100,116,139)" }}
                width={52}
                label={{
                  value: t.chartAxisStoredEnergy,
                  angle: 90,
                  position: "insideRight",
                  fontSize: 10,
                  fill: "rgb(100,116,139)",
                }}
                tickFormatter={(v) => INTEGER_FORMATTER.format(typeof v === "number" ? v : 0)}
              />
              {xEveningStart !== undefined && xEveningEnd !== undefined ? (
                <ReferenceArea
                  x1={xEveningStart}
                  x2={xEveningEnd}
                  yAxisId="pct"
                  fill="rgba(251,191,36,0.18)"
                  stroke="rgba(245,158,11,0.3)"
                />
              ) : null}
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) {
                    return null;
                  }
                  const point = payload[0]?.payload as ChartDatum | undefined;
                  if (!point) {
                    return null;
                  }
                  return (
                    <div className="rounded-xl border border-slate-300/60 bg-white/95 p-3 text-xs text-slate-700 shadow-lg dark:border-slate-500/50 dark:bg-slate-900/95 dark:text-slate-200">
                      <p className="mb-2 font-semibold">{String(label)}</p>
                      <p>
                        {t.tooltipAction}: {actionLabel(point.action)}
                      </p>
                      <p>
                        {t.chartLegendSoc}: {NUMBER_FORMATTER.format(point.socPct)}% (
                        {MWH_DETAIL_FORMATTER.format(point.socMwh)} MWh)
                      </p>
                      <p>
                        {t.chartLegendMaxReachableSoc}: {NUMBER_FORMATTER.format(point.maxReachableSocPct)}%
                      </p>
                    </div>
                  );
                }}
              />
              <Area
                yAxisId="pct"
                type="monotone"
                dataKey="socPct"
                stroke="transparent"
                fill={`url(#${socGradientId})`}
                isAnimationActive
                animationDuration={560}
              />
              <Line
                yAxisId="pct"
                type="monotone"
                dataKey="socPct"
                name={t.chartLegendSoc}
                stroke="rgb(79,70,229)"
                strokeWidth={2.6}
                dot={false}
                isAnimationActive
                animationDuration={620}
              />
              <Line
                yAxisId="pct"
                type="monotone"
                dataKey="maxReachableSocPct"
                name={t.chartLegendMaxReachableSoc}
                stroke="rgb(14,116,144)"
                strokeDasharray="5 4"
                strokeWidth={2}
                dot={false}
                isAnimationActive
                animationDuration={620}
              />
              <Line
                yAxisId="mwh"
                type="monotone"
                dataKey="socMwh"
                name={t.chartLegendSocStored}
                stroke="rgb(124,58,237)"
                strokeWidth={2}
                dot={false}
                strokeOpacity={0.95}
                isAnimationActive
                animationDuration={620}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.12, ease: "easeOut" }}
        className="rounded-2xl border border-slate-300/55 bg-white/92 p-4 md:p-5 dark:border-slate-500/35 dark:bg-slate-900/60"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {t.chartResidualTitle}
          </p>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-300">
            <LegendDot color="rgb(51,65,85)" label={t.chartLegendResidualDeficit} />
            <LegendDot color="rgba(251,191,36,0.45)" label={t.chartLegendEvening} square />
          </div>
        </div>
        <div className="mt-3 min-h-[240px] w-full md:min-h-[260px]" style={{ height: "clamp(240px, 42vw, 320px)" }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 6, bottom: 20, left: 4 }}>
              <CartesianGrid stroke="rgba(148,163,184,0.18)" strokeDasharray="3 3" />
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 10, fill: "rgb(100,116,139)" }}
                interval={xAxisInterval}
                height={34}
                tickMargin={8}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "rgb(100,116,139)" }}
                width={46}
                tickFormatter={(v) =>
                  `${v > 0 ? "+" : ""}${INTEGER_FORMATTER.format(typeof v === "number" ? v : 0)}`
                }
              />
              {xEveningStart !== undefined && xEveningEnd !== undefined ? (
                <ReferenceArea
                  x1={xEveningStart}
                  x2={xEveningEnd}
                  fill="rgba(251,191,36,0.22)"
                  stroke="rgba(245,158,11,0.35)"
                />
              ) : null}
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) {
                    return null;
                  }
                  const point = payload[0]?.payload as ChartDatum | undefined;
                  if (!point) {
                    return null;
                  }
                  return (
                    <div className="rounded-xl border border-slate-300/60 bg-white/95 p-3 text-xs text-slate-700 shadow-lg dark:border-slate-500/50 dark:bg-slate-900/95 dark:text-slate-200">
                      <p className="mb-2 font-semibold">{String(label)}</p>
                      <p>
                        {t.tooltipLoad}: {point.loadMw === null ? "n/a" : `${INTEGER_FORMATTER.format(point.loadMw)} MW`}
                      </p>
                      <p>
                        {t.tooltipTotalGeneration}:{" "}
                        {point.totalGenerationMw === null
                          ? "n/a"
                          : `${INTEGER_FORMATTER.format(point.totalGenerationMw)} MW`}
                      </p>
                      <p>
                        {t.tooltipRenewables}:{" "}
                        {point.renewableGenerationMw === null
                          ? "n/a"
                          : `${INTEGER_FORMATTER.format(point.renewableGenerationMw)} MW`}
                      </p>
                      <p>
                        {t.chartLegendResidualOverlay}:{" "}
                        {`${point.residualLoadMw >= 0 ? "+" : ""}${INTEGER_FORMATTER.format(point.residualLoadMw)} MW`}
                      </p>
                      {point.observedCrossBorderMw !== null ? (
                        <p>
                          {language === "de" ? "Grenzhandel beobachtet" : "Observed border flow"}:{" "}
                          {formatSignedMw(point.observedCrossBorderMw)}
                        </p>
                      ) : null}
                      {point.simulatedCrossBorderMw !== null ? (
                        <p>
                          {language === "de" ? "Grenzhandel mit BESS" : "Border flow with BESS"}:{" "}
                          {formatSignedMw(point.simulatedCrossBorderMw)}
                        </p>
                      ) : null}
                      <p>
                        {t.tooltipAction}: {actionLabel(point.action)}
                      </p>
                      <p>
                        SoC: {NUMBER_FORMATTER.format(point.socPct)}%
                      </p>
                      <p>
                        {t.tooltipChargeHeadroom}: {MWH_DETAIL_FORMATTER.format(point.chargeHeadroomMwh)} MWh
                      </p>
                      <p>
                        {t.tooltipDischargeHeadroom}:{" "}
                        {MWH_DETAIL_FORMATTER.format(point.dischargeHeadroomMwh)} MWh
                      </p>
                    </div>
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey="residualLoadMw"
                name={t.chartLegendResidualDeficit}
                stroke="rgb(51,65,85)"
                strokeWidth={1.8}
                dot={false}
                isAnimationActive
                animationDuration={500}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.18, ease: "easeOut" }}
        className="rounded-2xl border border-slate-300/55 bg-white/92 p-4 md:p-5 dark:border-slate-500/35 dark:bg-slate-900/60"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">
            {t.chartDispatchTitle}
          </p>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-300">
            <LegendDot color="rgb(34,197,94)" label={t.chartLegendCharge} />
            <LegendDot color="rgb(249,115,22)" label={t.chartLegendDischarge} />
            <LegendDot color="rgb(71,85,105)" label={t.chartLegendResidualOverlay} />
          </div>
        </div>
        <div className="mt-3 min-h-[240px] w-full md:min-h-[260px]" style={{ height: "clamp(240px, 42vw, 320px)" }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 6, bottom: 22, left: 4 }}>
              <CartesianGrid stroke="rgba(148,163,184,0.18)" strokeDasharray="3 3" />
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 10, fill: "rgb(100,116,139)" }}
                interval={xAxisInterval}
                height={34}
                tickMargin={8}
              />
              <YAxis
                yAxisId="p"
                domain={[-powerLim, powerLim]}
                tick={{ fontSize: 11, fill: "rgb(100,116,139)" }}
                width={46}
                label={{
                  value: t.chartAxisPowerDispatch,
                  angle: -90,
                  position: "insideLeft",
                  fontSize: 9,
                  fill: "rgb(100,116,139)",
                }}
              />
              <YAxis
                yAxisId="r"
                orientation="right"
                tick={{ fontSize: 9, fill: "rgb(100,116,139)" }}
                width={40}
                label={{
                  value: t.chartLegendResidualOverlay,
                  angle: 90,
                  position: "insideRight",
                  fontSize: 9,
                  fill: "rgb(100,116,139)",
                }}
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(255,255,255,0.97)",
                  border: "1px solid rgba(148,163,184,0.45)",
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(value, name) => {
                  const n = typeof value === "number" ? value : Number(value ?? 0);
                  const label = typeof name === "string" ? name : String(name ?? "");
                  if (label === t.chartLegendResidualOverlay) {
                    return [`${INTEGER_FORMATTER.format(n)} MW`, label];
                  }
                  return [`${NUMBER_FORMATTER.format(n)} MW`, label];
                }}
                labelFormatter={(label) => String(label)}
              />
              <Bar
                yAxisId="p"
                dataKey="chargeSignedMw"
                name={t.chartLegendCharge}
                fill="rgb(34,197,94)"
                radius={[4, 4, 0, 0]}
                maxBarSize={20}
              />
              <Bar
                yAxisId="p"
                dataKey="dischargeMw"
                name={t.chartLegendDischarge}
                fill="rgb(249,115,22)"
                radius={[4, 4, 0, 0]}
                maxBarSize={20}
              />
              <Line
                yAxisId="r"
                type="monotone"
                dataKey="residualLoadMw"
                name={t.chartLegendResidualOverlay}
                stroke="rgb(51,65,85)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive
                animationDuration={500}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.26, ease: "easeOut" }}
        className="space-y-5"
      >
        <div className="rounded-2xl border border-slate-300/45 bg-slate-50/90 px-4 py-4 md:px-5 md:py-5 dark:border-slate-500/35 dark:bg-slate-800/45">
          <p className="text-[11px] font-semibold tracking-[0.16em] text-slate-500 uppercase dark:text-slate-400">
            {t.insightsTitle}
          </p>
          <ul className="mt-3 list-none space-y-3 text-sm leading-snug text-slate-800 dark:text-slate-100">
            <li className="flex gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
              <span>
                {dispatchDerived.eveningDischargeQuarterSlots > 0
                  ? t.insightEveningAvgMw(
                      NUMBER_FORMATTER.format(dispatchDerived.avgEveningDischargeMw)
                    )
                  : t.insightEveningAvgNone}{" "}
                <span className="tabular-nums text-slate-600 dark:text-slate-300">
                  (
                  {language === "de" ? "abends geliefert" : "evening delivered"}:{" "}
                  {MWH_DETAIL_FORMATTER.format(animEveningMwh)} MWh ·{" "}
                  {NUMBER_FORMATTER.format(animCoverage)}%
                  {language === "de" ? " Proxy-Abdeckung" : " of proxy"})
                </span>
              </span>
            </li>
            <li className="flex gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" aria-hidden />
              <span>{t.insightActiveHours(activeHoursLabel)}</span>
            </li>
            <li className="flex gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
              <span>{t.insightSpread(spreadEuroStr)}</span>
            </li>
            <li className="flex gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" aria-hidden />
              <span>
                {language === "de" ? (
                  <>
                    Bis 17 Uhr rekonstruierbarer Spitzen-SoC (nur Über-Zeiten):{" "}
                    <span className="font-semibold tabular-nums">
                      {INTEGER_FORMATTER.format(Math.round(animMaxReachableEveningSoc))}%
                    </span>
                    .
                  </>
                ) : (
                  <>
                    Maximum reachable SOC by 17:00 from intraday surplus only:{" "}
                    <span className="font-semibold tabular-nums">
                      {INTEGER_FORMATTER.format(Math.round(animMaxReachableEveningSoc))}%
                    </span>
                    .
                  </>
                )}
              </span>
            </li>
          </ul>
        </div>

        <div className="rounded-2xl border border-violet-400/35 bg-gradient-to-br from-violet-50/95 via-white to-white px-4 py-4 shadow-sm md:px-5 md:py-5 dark:border-violet-400/28 dark:from-violet-950/50 dark:via-slate-900 dark:to-slate-900">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-violet-900 uppercase dark:text-violet-200">
            {t.keyLearningTitle}
          </p>
          <p className="mt-2 text-sm leading-relaxed font-medium text-slate-900 md:text-[15px] dark:text-white">
            {t.keyLearningScaled(
              NUMBER_FORMATTER.format(eveningGapCoveragePct),
              INTEGER_FORMATTER.format(KEY_LEARNING_SCALE_POWER_MW),
              NUMBER_FORMATTER.format(scaledEveningForKeyLearningPct)
            )}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">{t.keyLearningScaledNote}</p>
        </div>

        <p className="text-center text-sm leading-relaxed text-slate-600 dark:text-slate-300 md:text-[15px]">
          {t.worthItClosing}
        </p>
      </motion.div>
    </motion.div>
  );
}

function SocStatChip({ label, pct, mwh }: { label: string; pct: number; mwh: number }) {
  return (
    <div className="rounded-xl border border-slate-200/85 bg-white/85 px-3 py-2 dark:border-slate-600/45 dark:bg-slate-900/55">
      <dt className="text-[10px] font-medium tracking-[0.12em] text-slate-500 uppercase dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-bold leading-tight text-slate-900 dark:text-white">
        {NUMBER_FORMATTER.format(pct)}%
        <span className="mt-0.5 block text-[11px] font-semibold text-indigo-700 tabular-nums dark:text-indigo-300">
          {MWH_DETAIL_FORMATTER.format(mwh)} MWh
        </span>
      </dd>
    </div>
  );
}

function LegendDot({ color, label, square = false }: { color: string; label: string; square?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={square ? "inline-block h-3 w-3 rounded-sm" : "inline-block h-2 w-2 rounded-full"}
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
