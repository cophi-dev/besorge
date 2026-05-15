import { NextResponse } from "next/server";
import { z } from "zod";

import { formatBerlinDateKeyFromUtcDate } from "@/lib/berlinCalendar";
import { createLogger } from "@/lib/debug";
import { simulateDispatch } from "@/lib/dispatchSimulation";
import { getGermanyTodaysDispatchSlots } from "@/lib/energyChartsApi";
import {
  getRedispatchReferenceForBerlinDateKey,
  getSmardSpotPriceMapForTimestamps,
} from "@/lib/germanyRevenueModel";

const log = createLogger("api:dispatch:de");

const requestSchema = z.object({
  powerMw: z.number().positive().max(10_000),
  capacityMwh: z.number().positive().max(50_000),
  rteEfficiencyPct: z.number().gt(0).lte(100),
  strategy: z.literal("auto_policy_v1"),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    log("invalid JSON body %o", { error });
    return NextResponse.json(
      { message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    log("invalid request payload %o", { errors: parsed.error.flatten() });
    return NextResponse.json(
      {
        message: "Invalid simulator inputs.",
        issues: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  try {
    const dataset = await getGermanyTodaysDispatchSlots();
    const spotPriceMap = await getSmardSpotPriceMapForTimestamps(
      dataset.slots.map((slot) => slot.timestampIso)
    );
    const dateKey =
      dataset.slots[0]?.timestampIso !== undefined
        ? formatBerlinDateKeyFromUtcDate(new Date(dataset.slots[0].timestampIso))
        : dataset.dateBerlin;
    const redispatchReference = getRedispatchReferenceForBerlinDateKey(dateKey);
    const simulation = simulateDispatch(
      dataset.slots.map((slot) => ({
        ...slot,
        spotPriceEurPerMwh: spotPriceMap.get(slot.timestampIso) ?? null,
      })),
      parsed.data,
      {
        positiveRedispatchCostEurPerMwh: redispatchReference.positiveCostEurPerMwh,
      }
    );

    return NextResponse.json(
      {
        dataset: {
          dateBerlin: dataset.dateBerlin,
          samplePoints: dataset.samplePoints,
          pointFractionOfDay: dataset.pointFractionOfDay,
          source: dataset.source,
        },
        market: {
          priceSource: simulation.diagnostics.priceSource,
          positiveRedispatchCostEurPerMwh: redispatchReference.positiveCostEurPerMwh,
          negativeRedispatchCostEurPerMwh: redispatchReference.negativeCostEurPerMwh,
          redispatchSourceLabel: `Netztransparenz calculated redispatch prices (${redispatchReference.validFrom} to ${redispatchReference.validTo})`,
        },
        ...simulation,
      },
      {
        headers: {
          // Cache briefly: the underlying 15-min data updates every 15 min.
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("dispatch simulation failed %o", {
      request: { method: "POST", route: "/api/dispatch/de" },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      { message: `Unable to run dispatch simulation right now: ${message}` },
      { status: 502 }
    );
  }
}
