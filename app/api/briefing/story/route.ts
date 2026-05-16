import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { z } from "zod";

import { createLogger } from "@/lib/debug";
import { dailyStorySchema, generateDailyStory } from "@/lib/dailyStoryLlm";
import {
  berlinDateKeySchema,
  berlinIsoWeekKeySchema,
  berlinMonthKeySchema,
  normalizeBerlinCustomDateRange,
  resolveGermanyEnergyFlowBerlinRangeForCustomRange,
  resolveGermanyEnergyFlowBerlinRangeForMonth,
  resolveGermanyEnergyFlowBerlinRangeForWeek,
} from "@/lib/germanyEnergyFlowPeriod";
import {
  buildMorningBriefingContext,
  buildMorningBriefingContextForBerlinRange,
  yesterdayBerlinDateKey,
  type MorningBriefingContext,
} from "@/lib/morningBriefingContext";

const log = createLogger("api:briefing:story");

const querySchema = z
  .object({
    date: berlinDateKeySchema.optional(),
    week: berlinIsoWeekKeySchema.optional(),
    month: berlinMonthKeySchema.optional(),
    start: berlinDateKeySchema.optional(),
    end: berlinDateKeySchema.optional(),
    language: z.enum(["en", "de"]).default("en"),
  })
  .superRefine((data, ctx) => {
    const hasRange = Boolean(data.start) || Boolean(data.end);
    const n =
      Number(Boolean(data.date)) +
      Number(Boolean(data.week)) +
      Number(Boolean(data.month)) +
      Number(hasRange);
    if (n > 1) {
      ctx.addIssue({
        code: "custom",
        message: "Specify at most one of date, week, month, or start+end range.",
      });
    }
    if (hasRange && (!data.start || !data.end)) {
      ctx.addIssue({
        code: "custom",
        message: "Custom range requires both start and end.",
        path: ["start"],
      });
    }
  });

function serializedStoryFromQuery(data: z.infer<typeof querySchema>): string {
  if (data.week) {
    return `w:${data.week}`;
  }
  if (data.month) {
    return `m:${data.month}`;
  }
  if (data.start && data.end) {
    const { startKey, endKey } = normalizeBerlinCustomDateRange(data.start, data.end);
    return `r:${startKey}:${endKey}`;
  }
  if (data.date) {
    return `d:${data.date}`;
  }
  return "d:__yesterday__";
}

async function loadBriefingContext(serialized: string): Promise<MorningBriefingContext | null> {
  const now = new Date();
  if (serialized.startsWith("w:")) {
    const weekKey = serialized.slice(2);
    return buildMorningBriefingContextForBerlinRange(
      resolveGermanyEnergyFlowBerlinRangeForWeek(weekKey, now),
      now
    );
  }
  if (serialized.startsWith("m:")) {
    const monthKey = serialized.slice(2);
    return buildMorningBriefingContextForBerlinRange(
      resolveGermanyEnergyFlowBerlinRangeForMonth(monthKey, now),
      now
    );
  }
  if (serialized.startsWith("r:")) {
    const [, startKey, endKey] = serialized.split(":");
    if (!startKey || !endKey) {
      return null;
    }
    try {
      return buildMorningBriefingContextForBerlinRange(
        resolveGermanyEnergyFlowBerlinRangeForCustomRange(startKey, endKey, now),
        now
      );
    } catch {
      return null;
    }
  }
  const rest = serialized.slice(2);
  const dateKey = rest === "__yesterday__" ? yesterdayBerlinDateKey(now) : rest;
  return buildMorningBriefingContext(dateKey);
}

const NUMBER_FORMATTER_EN = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const NUMBER_FORMATTER_DE = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

function fmt(n: number, language: "en" | "de"): string {
  return (language === "de" ? NUMBER_FORMATTER_DE : NUMBER_FORMATTER_EN).format(n);
}

function signedStructuralGwh(n: number, language: "en" | "de"): string {
  const sign = n >= 0 ? "+" : "\u2212";
  return `${sign}${fmt(Math.abs(n), language)}`;
}

type StructuralWindowKey = keyof MorningBriefingContext["dayShape"]["structuralNetGwhByWindow"];

const INSIGHT_MAX = 160;
const INSIGHT_MIN = 14;
const HEADLINE_MAX = 180;
/** `dailyStorySchema.counterfactual` hard cap — keep deterministic copy under this. */
const COUNTERFACTUAL_MAX = 400;

function clampCounterfactualCopy(s: string): string {
  if (s.length <= COUNTERFACTUAL_MAX) {
    return s;
  }
  return `${s.slice(0, COUNTERFACTUAL_MAX - 3).trimEnd()}...`;
}

function clampInsight(s: string): string {
  if (s.length <= INSIGHT_MAX) {
    return s;
  }
  return `${s.slice(0, INSIGHT_MAX - 3).trimEnd()}...`;
}

function clampHeadline(s: string): string {
  if (s.length <= HEADLINE_MAX) {
    return s;
  }
  return `${s.slice(0, HEADLINE_MAX - 3).trimEnd()}...`;
}

function buildFallbackHeadline(ctx: MorningBriefingContext, language: "en" | "de"): string {
  const net = ctx.netStructuralBalanceGwh;
  const sign = net >= 0 ? "+" : "\u2212";
  const absNet = fmt(Math.abs(net), language);
  const win = ctx.dayShape.structuralNetGwhByWindow;
  let strongestKey: StructuralWindowKey = "dayCoreGwh";
  let strongestAbs = -Infinity;
  for (const k of ["dayCoreGwh", "eveningRampGwh", "overnightBaseGwh"] satisfies StructuralWindowKey[]) {
    const a = Math.abs(win[k]);
    if (a > strongestAbs) {
      strongestAbs = a;
      strongestKey = k;
    }
  }

  if (language === "de") {
    const posture =
      net >= 0
        ? `Die ver\u00f6ffentlichten Reihen zeigen einen strukturellen Netto-\u00dcberschuss von ${sign}${absNet} GWh`
        : `Die ver\u00f6ffentlichten Reihen zeigen ein strukturelles Netto-Defizit von ${sign}${absNet} GWh`;
    let driver = "die Uhrfenster in den Signalen zeigen, wo es kippt.";
    if (strongestKey === "eveningRampGwh" && win.eveningRampGwh < 0) {
      driver = "die Abendrampe tr\u00e4gt die schwerste strukturelle L\u00fccke.";
    } else if (strongestKey === "dayCoreGwh" && win.dayCoreGwh > 0 && net > 0) {
      driver = "der Tageskern stapelt den gr\u00f6\u00dften \u00dcberschussblock.";
    } else if (strongestKey === "overnightBaseGwh") {
      driver = "Nacht- und Fr\u00fchfenster pr\u00e4gen den gr\u00f6\u00dften Schwenk.";
    } else if (strongestKey === "dayCoreGwh" && win.dayCoreGwh < 0 && net < 0) {
      driver = "der Mittagsblock zieht das Defizit am st\u00e4rksten.";
    }
    return clampHeadline(`${posture}; ${driver}`);
  }

  const posture =
    net >= 0
      ? `Published data imply a net structural surplus of ${sign}${absNet} GWh`
      : `Published data imply a net structural deficit of ${sign}${absNet} GWh`;
  let driver = "the clock windows in the signals show where it tilts.";
  if (strongestKey === "eveningRampGwh" && win.eveningRampGwh < 0) {
    driver = "the evening ramp carries the heaviest structural shortfall.";
  } else if (strongestKey === "dayCoreGwh" && win.dayCoreGwh > 0 && net > 0) {
    driver = "the midday block stacks the largest surplus mass.";
  } else if (strongestKey === "overnightBaseGwh") {
    driver = "overnight and early-morning hours dominate the swing.";
  } else if (strongestKey === "dayCoreGwh" && win.dayCoreGwh < 0 && net < 0) {
    driver = "the midday band pulls the deepest deficit.";
  }
  return clampHeadline(`${posture}; ${driver}`);
}

/**
 * Fallback bullet lines mirrored when the LLM is offline — deterministic from
 * the same briefing context JSON the model consumes.
 */
function buildDeterministicInsights(
  ctx: MorningBriefingContext,
  language: "en" | "de"
): [string, string, string] {
  const win = ctx.dayShape.structuralNetGwhByWindow;
  const netSigned = signedStructuralGwh(ctx.netStructuralBalanceGwh, language);
  let strongestKey: StructuralWindowKey = "dayCoreGwh";
  let strongestAbs = -Infinity;
  for (const k of ["dayCoreGwh", "eveningRampGwh", "overnightBaseGwh"] satisfies StructuralWindowKey[]) {
    const a = Math.abs(win[k]);
    if (a > strongestAbs) {
      strongestAbs = a;
      strongestKey = k;
    }
  }

  const bandLabel =
    strongestKey === "dayCoreGwh"
      ? language === "de"
        ? "Tageskern (10\u201316 Uhr)"
        : "Day core (10\u201316)"
      : strongestKey === "eveningRampGwh"
        ? language === "de"
          ? "Abendrampe (17\u201321 Uhr)"
          : "Evening ramp (17\u201321)"
        : language === "de"
          ? "Basis Nacht / fr\u00fch (22\u201309 Uhr)"
          : "Overnight / early base (22\u201309)";

  const wsum = signedStructuralGwh(win[strongestKey], language);

  const netSpanLabel =
    ctx.isMultiDayWindow
      ? language === "de"
        ? "Kalenderfenster-Netto"
        : "full-span net"
      : language === "de"
        ? "Tages-Netto"
        : "full-day net";

  const insightA = clampInsight(
    language === "de"
      ? `${bandLabel} nur: Summe Erzeugung minus Last ${wsum} GWh im Uhr-Band \u2014 nicht das ${netSpanLabel} (${netSigned} GWh).`
      : `${bandLabel} only: generation minus load inside this clock band sums to ${wsum} GWh \u2014 not the ${netSpanLabel} (${netSigned} GWh).`
  );

  let insightB: string;
  if (ctx.dayShape.renewableNetStructuralBalanceGwh !== null && ctx.dayShape.renewableSlotFractionOfSampled > 0) {
    const rsigned = signedStructuralGwh(ctx.dayShape.renewableNetStructuralBalanceGwh, language);
    const pct = fmt(ctx.dayShape.renewableSlotFractionOfSampled * 100, language);
    insightB =
      language === "de"
        ? clampInsight(
            `Erneuerbar minus Last nur dort, wo EE-MW vorliegt: ${rsigned} GWh; Daten in etwa ${pct} % der Slots.`
          )
        : clampInsight(
            `Renewable generation minus load, only where renewable MW exists: ${rsigned} GWh; data in ~${pct}% of slots.`
          );
  } else {
    insightB =
      language === "de"
        ? clampInsight(
            `Keine EE-Minus-Last-Summe f\u00fcr jeden Slot; Referenzflotte ${fmt(ctx.fleet.powerGw, "de")} GW / ${fmt(ctx.fleet.capacityGwh, "de")} GWh.`
          )
        : clampInsight(
            `No renewables-minus-load total across every slot; fleet context ${fmt(ctx.fleet.powerGw, "en")} GW / ${fmt(ctx.fleet.capacityGwh, "en")} GWh.`
          );
  }

  const ps = ctx.dayShape.peakSurplusHourBerlin;
  const pd = ctx.dayShape.peakDeficitHourBerlin;
  let insightC: string;
  if (ps !== null || pd !== null) {
    if (language === "de") {
      const fragments: string[] = [];
      if (ps !== null) {
        fragments.push(`\u00dcberschuss-Spitze an Berlin-Ortszeit ca. ${String(ps)} Uhr`);
      }
      if (pd !== null) {
        fragments.push(`tiefstes Defizit an Berlin-Ortszeit ca. ${String(pd)} Uhr`);
      }
      insightC = clampInsight(`${fragments.join("; ")} (nur ver\u00f6ffentlichte Viertelstunden).`);
    } else {
      const fragments: string[] = [];
      if (ps !== null) {
        fragments.push(`surplus peaks around Berlin local hour ${String(ps)}`);
      }
      if (pd !== null) {
        fragments.push(`deepest deficit around Berlin local hour ${String(pd)}`);
      }
      insightC = clampInsight(`${fragments.join("; ")} (published quarter-hours only).`);
    }
  } else {
    insightC =
      language === "de"
        ? clampInsight(
            ctx.isMultiDayWindow
              ? `${String(ctx.samplePoints)} Viertelstunden (${fmt(ctx.pointFractionOfDay * 100, "de")}% der erwarteten Fenster-Slots) ohne klare Spitzenstunden.`
              : `${String(ctx.samplePoints)} Viertelstunden (${fmt(ctx.pointFractionOfDay * 100, "de")}% des Tags) ohne klare Spitzenstunden.`
          )
        : clampInsight(
            ctx.isMultiDayWindow
              ? `${String(ctx.samplePoints)} quarter-hours (${fmt(ctx.pointFractionOfDay * 100, "en")}% of expected slots in the window) with no clear peak surplus or deficit hour.`
              : `${String(ctx.samplePoints)} quarter-hours (${fmt(ctx.pointFractionOfDay * 100, "en")}% of the day) with no clear peak surplus or deficit hour.`
          );
  }

  const ensureMin = ([a, b, c]: [string, string, string]): [string, string, string] => {
    const pad = language === "de" ? "Weitere Daten folgen automatisch von Energy-Charts." : "Energy-Charts publishes additional detail automatically.";
    return [
      a.length >= INSIGHT_MIN ? a : clampInsight(`${a} ${pad}`),
      b.length >= INSIGHT_MIN ? b : clampInsight(`${b} ${pad}`),
      c.length >= INSIGHT_MIN ? c : clampInsight(`${c} ${pad}`),
    ];
  };

  if (ctx.isMultiDayWindow) {
    const anchor = clampInsight(
      language === "de"
        ? `Fenster-Netto ${netSigned} GWh = Summe (Erzeugung \u2212 Last) \u00fcber ver\u00f6ffentlichte Viertelstunden ${ctx.rangeStartBerlin} bis ${ctx.rangeEndBerlin}. Die drei Punkte teilen die Lage auf \u2014 sie addieren sich nicht zu einem zweiten Gesamt-Netto.`
        : `Window net ${netSigned} GWh sums generation minus load across published quarter-hours from ${ctx.rangeStartBerlin} through ${ctx.rangeEndBerlin}. The three bullets decompose where stress sits \u2014 they are not three slices of a second total.`
    );
    const third = ps !== null || pd !== null ? insightC : insightB;
    return ensureMin([anchor, insightA, third]);
  }

  return ensureMin([insightA, insightB, insightC]);
}

/**
 * Deterministic numeric fallback used when the LLM call fails (network,
 * rate-limit, schema). Keeps the page useful by surfacing the raw analysis
 * the LLM would have narrated. Same response shape as the LLM contract so
 * the client renders identically.
 */
function buildNumericFallback(
  ctx: MorningBriefingContext,
  language: "en" | "de"
): z.infer<typeof dailyStorySchema> {
  const net = ctx.netStructuralBalanceGwh;
  const sign = net >= 0 ? "+" : "−";
  const absNet = Math.abs(net);
  const headline = buildFallbackHeadline(ctx, language);
  const curtailedClause =
    ctx.curtailedEnergyGwh !== null && ctx.curtailedEnergyGwh > 0
      ? language === "de"
        ? ` Zusätzliche abgeregelte Energie von ${fmt(ctx.curtailedEnergyGwh, "de")} GWh steht als getrennte Ladechance neben der veröffentlichten Netto-Spur.`
        : ` Separate curtailed renewable charge opportunity adds ${fmt(ctx.curtailedEnergyGwh, "en")} GWh beyond the published net trace.`
      : "";

  const narrative =
    language === "de"
      ? ctx.isMultiDayWindow
        ? `Fenster-Netto ${sign}${fmt(absNet, "de")} GWh summiert Erzeugung minus Last \u00fcber alle ver\u00f6ffentlichten Viertelstunden im Kalenderfenster (${(ctx.pointFractionOfDay * 100).toFixed(0)} % Abdeckung). Uhr-Band-Zeilen nutzen dieselbe Serie nur innerhalb der Tageszeiten; die EE-Zeile nur Slots mit EE-MW.${curtailedClause} Flotte ${fmt(ctx.fleet.powerGw, "de")} GW / ${fmt(ctx.fleet.capacityGwh, "de")} GWh.`
        : `Tages-Netto ${sign}${fmt(absNet, "de")} GWh ist die Summe Erzeugung minus Last \u00fcber alle ver\u00f6ffentlichten Viertelstunden (${(ctx.pointFractionOfDay * 100).toFixed(0)} % Abdeckung). Fensterzeilen summieren dieselbe Serie nur in Uhr-B\u00e4ndern; die EE-Zeile nutzt nur Slots mit EE-MW.${curtailedClause} Flotte ${fmt(ctx.fleet.powerGw, "de")} GW / ${fmt(ctx.fleet.capacityGwh, "de")} GWh.`
      : ctx.isMultiDayWindow
        ? `Window net ${sign}${fmt(absNet, "en")} GWh sums generation minus load across every published quarter-hour in the selected calendar span (${(ctx.pointFractionOfDay * 100).toFixed(0)}% coverage). Clock-band lines use the same series inside hour bands only; the renewables line only counts slots with renewable MW.${curtailedClause} Fleet ${fmt(ctx.fleet.powerGw, "en")} GW / ${fmt(ctx.fleet.capacityGwh, "en")} GWh.`
        : `Full-day net ${sign}${fmt(absNet, "en")} GWh sums generation minus load across every published quarter-hour (${(ctx.pointFractionOfDay * 100).toFixed(0)}% coverage). Window lines use the same series inside clock bands only; the renewables line only counts slots with renewable MW.${curtailedClause} Fleet ${fmt(ctx.fleet.powerGw, "en")} GW / ${fmt(ctx.fleet.capacityGwh, "en")} GWh.`;

  const cap = ctx.simulated.practicalCapacityGwh;
  const pw = ctx.simulated.balancedPowerMw / 1000;
  const grid = ctx.simulated.gridImpactReductionPct;
  const absorbed = ctx.simulated.absorbedSurplusShare;
  const served = ctx.simulated.servedDeficitShare;

  let counterfactual: string;
  if (cap <= 0) {
    counterfactual =
      language === "de"
        ? ctx.isMultiDayWindow
          ? "F\u00fcr dieses Kalenderfenster ergibt sich keine sinnvoll dimensionierbare Speichergr\u00f6\u00dfe \u2014 zu wenig nutzbare Surplus/Defizit-Asymmetrie."
          : "Heute ergab sich keine sinnvoll dimensionierbare Tages-Speicherkapazit\u00e4t \u2014 zu wenig nutzbare Surplus/Deficit-Asymmetrie."
        : ctx.isMultiDayWindow
          ? "No meaningfully sized storage for this window \u2014 too little usable surplus/deficit asymmetry."
          : "No meaningfully sized daily storage emerges today \u2014 too little usable surplus/deficit asymmetry.";
  } else if (language === "de") {
    const size = ctx.isMultiDayWindow
      ? `Ein f\u00fcrs Kalenderfenster gedimensionierter BESS (${fmt(cap, "de")} GWh / ${fmt(pw, "de")} GW)`
      : `Ein optimal dimensionierter Tages-BESS (${fmt(cap, "de")} GWh / ${fmt(pw, "de")} GW)`;
    const sent1 =
      grid !== null
        ? `${size} h\u00e4tte rund ${fmt(grid, "de")} % der Summe der Absolutbetr\u00e4ge der Viertelstunden-Nettos gegl\u00e4ttet.`
        : `${size} h\u00e4tte die strukturellen Ungleichgewichte sp\u00fcrbar gegl\u00e4ttet.`;
    let sent2 = "";
    if (absorbed !== null && served !== null) {
      sent2 = ` Im Modell k\u00f6nnten zudem rund ${fmt(absorbed * 100, "de")} % der Ladechance (Brutto-\u00dcberschuss plus ggf. abgeregelte Energie) aufgenommen und rund ${fmt(served * 100, "de")} % der Brutto-Defizitenergie aus dem Speicher gedeckt werden.`;
    } else if (absorbed !== null) {
      sent2 = ` Im Modell k\u00f6nnte zudem rund ${fmt(absorbed * 100, "de")} % der Ladechance (Brutto-\u00dcberschuss plus ggf. abgeregelte Energie) aufgenommen werden.`;
    } else if (served !== null) {
      sent2 = ` Im Modell k\u00f6nnte zudem rund ${fmt(served * 100, "de")} % der Brutto-Defizitenergie aus dem Speicher gedeckt werden.`;
    }
    counterfactual = `${sent1}${sent2}`;
  } else {
    const size = ctx.isMultiDayWindow
      ? `A right-sized BESS for this window (${fmt(cap, "en")} GWh / ${fmt(pw, "en")} GW)`
      : `A right-sized daily BESS (${fmt(cap, "en")} GWh / ${fmt(pw, "en")} GW)`;
    const sent1 =
      grid !== null
        ? `${size} would have cut summed absolute structural imbalance by ~${fmt(grid, "en")}%.`
        : `${size} would have noticeably smoothed structural imbalances.`;
    const tail: string[] = [];
    if (absorbed !== null) {
      tail.push(
        `absorb ~${fmt(absorbed * 100, "en")}% of gross charge opportunity (structural surplus plus curtailed energy when present)`
      );
    }
    if (served !== null) {
      tail.push(`meet ~${fmt(served * 100, "en")}% of gross deficit energy from storage`);
    }
    const sent2 =
      tail.length > 0
        ? ` It would also ${tail.join(" and ")}.`
        : "";
    counterfactual = `${sent1}${sent2}`;
  }

  const partial =
    ctx.pointFractionOfDay < 0.95
      ? language === "de"
        ? ctx.isMultiDayWindow
          ? `Stand: erste ${(ctx.pointFractionOfDay * 100).toFixed(0)} % der erwarteten Viertelstunden im Kalenderfenster.`
          : `Stand: erste ${(ctx.pointFractionOfDay * 100).toFixed(0)} % der heutigen Viertelstunden.`
        : ctx.isMultiDayWindow
          ? `Based on the first ${(ctx.pointFractionOfDay * 100).toFixed(0)}% of expected quarter-hours in the selected window.`
          : `Based on the first ${(ctx.pointFractionOfDay * 100).toFixed(0)}% of today's quarter-hours.`
      : undefined;

  const insightLines = buildDeterministicInsights(ctx, language);

  return {
    headline,
    insights: [...insightLines],
    narrative,
    counterfactual: clampCounterfactualCopy(counterfactual),
    dataAsOfNote: partial,
  };
}

const responseSchema = z.object({
  dateBerlin: z.string(),
  language: z.enum(["en", "de"]),
  source: z.enum(["llm", "fallback_numeric"]),
  retrievedAtIso: z.string(),
  context: z.object({
    netStructuralBalanceGwh: z.number(),
    curtailedEnergyGwh: z.number().nullable(),
    curtailmentSlotFractionOfSampled: z.number(),
    curtailmentStatus: z.enum(["loaded", "unavailable_not_configured", "unavailable_upstream"]),
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
    dayShape: z.object({
      structuralNetGwhByWindow: z.object({
        dayCoreGwh: z.number(),
        eveningRampGwh: z.number(),
        overnightBaseGwh: z.number(),
      }),
      renewableNetStructuralBalanceGwh: z.number().nullable(),
      renewableSlotFractionOfSampled: z.number(),
      peakSurplusHourBerlin: z.number().nullable(),
      peakDeficitHourBerlin: z.number().nullable(),
    }),
    isMultiDayWindow: z.boolean(),
    rangeStartBerlin: z.string(),
    rangeEndBerlin: z.string(),
  }),
  story: dailyStorySchema,
});

export type BriefingStoryResponse = z.infer<typeof responseSchema>;

const buildContextCached = unstable_cache(loadBriefingContext, ["briefing-story-context-v6"], {
  revalidate: 300,
});

/**
 * Generate (or fetch the cached) hero briefing story for a Berlin day, ISO week,
 * or calendar month window.
 */
async function generateStoryUncached(
  serializedWindow: string,
  language: "en" | "de"
): Promise<BriefingStoryResponse> {
  const context = await buildContextCached(serializedWindow);
  if (context === null) {
    throw new Error("daily story context unavailable");
  }

  const baseResponse = {
    dateBerlin: context.dateBerlin,
    language,
    retrievedAtIso: context.retrievedAtIso,
    context: {
      netStructuralBalanceGwh: context.netStructuralBalanceGwh,
      curtailedEnergyGwh: context.curtailedEnergyGwh,
      curtailmentSlotFractionOfSampled: context.curtailmentSlotFractionOfSampled,
      curtailmentStatus: context.curtailmentStatus,
      pointFractionOfDay: context.pointFractionOfDay,
      samplePoints: context.samplePoints,
      fleet: context.fleet,
      simulated: context.simulated,
      dayShape: context.dayShape,
      isMultiDayWindow: context.isMultiDayWindow,
      rangeStartBerlin: context.rangeStartBerlin,
      rangeEndBerlin: context.rangeEndBerlin,
    },
  } as const;

  try {
    const story = await generateDailyStory(context, language);
    const llmParsed = responseSchema.safeParse({
      ...baseResponse,
      source: "llm",
      story,
    });
    if (llmParsed.success) {
      return llmParsed.data;
    }
    log("LLM story rejected by response schema, using numeric fallback %o", {
      storyKey: serializedWindow,
      issues: llmParsed.error.flatten(),
    });
  } catch (error) {
    log("LLM failed, returning numeric fallback %o", {
      storyKey: serializedWindow,
      language,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const story = buildNumericFallback(context, language);
  const fbParsed = responseSchema.safeParse({
    ...baseResponse,
    source: "fallback_numeric",
    story,
  });
  if (fbParsed.success) {
    return fbParsed.data;
  }
  log("numeric fallback rejected by response schema %o", {
    storyKey: serializedWindow,
    issues: fbParsed.error.flatten(),
  });
  throw new Error("daily story schema unavailable after fallback");
}

const generateStoryCached = unstable_cache(
  async (serializedWindow: string, language: "en" | "de") =>
    generateStoryUncached(serializedWindow, language),
  ["briefing-story-llm-v6"],
  { revalidate: 900 }
);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined,
    week: url.searchParams.get("week") ?? undefined,
    month: url.searchParams.get("month") ?? undefined,
    start: url.searchParams.get("start") ?? undefined,
    end: url.searchParams.get("end") ?? undefined,
    language: url.searchParams.get("language") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid query.", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const serializedWindow = serializedStoryFromQuery(parsed.data);

  try {
    const result = await generateStoryCached(serializedWindow, parsed.data.language);
    return NextResponse.json(result, {
      headers: {
        // 15-minute SWR matches the underlying Energy-Charts cadence; stale-
        // while-revalidate gives the next visitor instant content even when
        // we re-roll the LLM in the background.
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("daily story endpoint failed %o", {
      request: { method: "GET", route: "/api/briefing/story", storyKey: serializedWindow },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      { message: `Unable to build daily story right now: ${message}` },
      { status: 502 }
    );
  }
}
