import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { z } from "zod";

import { createLogger } from "@/lib/debug";
import { dailyStorySchema, generateDailyStory } from "@/lib/dailyStoryLlm";
import { berlinDateKeySchema } from "@/lib/germanyEnergyFlowPeriod";
import {
  buildMorningBriefingContext,
  yesterdayBerlinDateKey,
  type MorningBriefingContext,
} from "@/lib/morningBriefingContext";

const log = createLogger("api:briefing:story");

const querySchema = z.object({
  date: berlinDateKeySchema.optional(),
  language: z.enum(["en", "de"]).default("en"),
});

const NUMBER_FORMATTER_EN = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const NUMBER_FORMATTER_DE = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

function fmt(n: number, language: "en" | "de"): string {
  return (language === "de" ? NUMBER_FORMATTER_DE : NUMBER_FORMATTER_EN).format(n);
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
  const headline =
    language === "de"
      ? `Strukturelle Bilanz ${sign}${fmt(absNet, "de")} GWh \u2014 ${net >= 0 ? "Überschuss" : "Defizit"} über die veröffentlichten Viertelstunden.`
      : `Structural balance ${sign}${fmt(absNet, "en")} GWh \u2014 ${net >= 0 ? "surplus" : "deficit"} across published quarter-hours.`;

  const narrative =
    language === "de"
      ? `Die Tagesbilanz aus inländischer Erzeugung minus Last summiert sich auf ${sign}${fmt(absNet, "de")} GWh. Bei ${(ctx.pointFractionOfDay * 100).toFixed(0)} % veröffentlichten Slots arbeitet die installierte BESS-Flotte (${fmt(ctx.fleet.powerGw, "de")} GW / ${fmt(ctx.fleet.capacityGwh, "de")} GWh) als Puffer im Hintergrund.`
      : `The day's structural balance of domestic generation minus load nets to ${sign}${fmt(absNet, "en")} GWh, with ${(ctx.pointFractionOfDay * 100).toFixed(0)}% of quarter-hours published. The installed German BESS fleet (${fmt(ctx.fleet.powerGw, "en")} GW / ${fmt(ctx.fleet.capacityGwh, "en")} GWh) is buffering this in the background.`;

  const cap = ctx.simulated.practicalCapacityGwh;
  const pw = ctx.simulated.balancedPowerMw / 1000;
  const grid = ctx.simulated.gridImpactReductionPct;
  const absorbed = ctx.simulated.absorbedSurplusShare;
  const served = ctx.simulated.servedDeficitShare;
  const counterfactual =
    cap <= 0
      ? language === "de"
        ? "Heute ergab sich keine sinnvoll dimensionierbare Tages-Speicherkapazität \u2014 zu wenig nutzbare Surplus/Deficit-Asymmetrie."
        : "No meaningfully sized daily storage emerges today \u2014 too little usable surplus/deficit asymmetry."
      : language === "de"
        ? `Ein optimal dimensionierter Tages-BESS (${fmt(cap, "de")} GWh / ${fmt(pw, "de")} GW) hätte ${grid !== null ? `~${fmt(grid, "de")} % des Netzungleichgewichts geglättet` : "das Netzungleichgewicht spürbar geglättet"}${absorbed !== null ? `, ~${fmt(absorbed * 100, "de")} % des Überschusses aufgenommen` : ""}${served !== null ? ` und ~${fmt(served * 100, "de")} % des Defizits gedeckt` : ""}.`
        : `A right-sized daily BESS (${fmt(cap, "en")} GWh / ${fmt(pw, "en")} GW) would have ${grid !== null ? `flattened ~${fmt(grid, "en")}% of the grid imbalance` : "noticeably flattened the grid imbalance"}${absorbed !== null ? `, capturing ~${fmt(absorbed * 100, "en")}% of the surplus` : ""}${served !== null ? ` and serving ~${fmt(served * 100, "en")}% of the deficit` : ""}.`;

  const partial =
    ctx.pointFractionOfDay < 0.95
      ? language === "de"
        ? `Stand: erste ${(ctx.pointFractionOfDay * 100).toFixed(0)} % der heutigen Viertelstunden.`
        : `Based on the first ${(ctx.pointFractionOfDay * 100).toFixed(0)}% of today's quarter-hours.`
      : undefined;

  return {
    headline,
    narrative,
    counterfactual,
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
  story: dailyStorySchema,
});

export type BriefingStoryResponse = z.infer<typeof responseSchema>;

const buildContextCached = unstable_cache(
  async (dateKey: string) => buildMorningBriefingContext(dateKey),
  ["briefing-story-context"],
  { revalidate: 300 }
);

/**
 * Generate (or fetch the cached) "story of the day" for a Berlin calendar
 * date. Cache is keyed by (date, language) and refreshed at most every 15
 * minutes — cheap on tokens while still tracking late-day data updates.
 */
async function generateStoryUncached(
  dateKey: string,
  language: "en" | "de"
): Promise<BriefingStoryResponse> {
  const context = await buildContextCached(dateKey);
  if (context === null) {
    throw new Error("daily story context unavailable");
  }

  const baseResponse = {
    dateBerlin: context.dateBerlin,
    language,
    retrievedAtIso: context.retrievedAtIso,
    context: {
      netStructuralBalanceGwh: context.netStructuralBalanceGwh,
      pointFractionOfDay: context.pointFractionOfDay,
      samplePoints: context.samplePoints,
      fleet: context.fleet,
      simulated: context.simulated,
    },
  } as const;

  try {
    const story = await generateDailyStory(context, language);
    return responseSchema.parse({
      ...baseResponse,
      source: "llm",
      story,
    });
  } catch (error) {
    log("LLM failed, returning numeric fallback %o", {
      date: dateKey,
      language,
      error: error instanceof Error ? error.message : String(error),
    });
    const story = buildNumericFallback(context, language);
    return responseSchema.parse({
      ...baseResponse,
      source: "fallback_numeric",
      story,
    });
  }
}

const generateStoryCached = unstable_cache(
  async (dateKey: string, language: "en" | "de") => generateStoryUncached(dateKey, language),
  ["briefing-story-llm-v1"],
  { revalidate: 900 }
);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined,
    language: url.searchParams.get("language") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid query.", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const dateKey = parsed.data.date ?? yesterdayBerlinDateKey();

  try {
    const result = await generateStoryCached(dateKey, parsed.data.language);
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
      request: { method: "GET", route: "/api/briefing/story", date: dateKey },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      { message: `Unable to build daily story right now: ${message}` },
      { status: 502 }
    );
  }
}
