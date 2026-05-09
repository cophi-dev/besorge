import { NextResponse } from "next/server";

import { unstable_cache } from "next/cache";

import { createLogger } from "@/lib/debug";
import {
  getGermanyBessRecommendationTrailingWindow,
  getGermanyEnergyFlowForBerlinRange,
  getGermanyEnergyFlowForPeriod,
} from "@/lib/energyChartsApi";
import {
  berlinDateKeySchema,
  berlinIsoWeekKeySchema,
  berlinMonthKeySchema,
  GERMANY_ENERGY_FLOW_PERIODS,
  germanyEnergyFlowPeriodSchema,
  resolveGermanyEnergyFlowBerlinRangeForDate,
  resolveGermanyEnergyFlowBerlinRangeForMonth,
  resolveGermanyEnergyFlowBerlinRangeForWeek,
} from "@/lib/germanyEnergyFlowPeriod";

const log = createLogger("api:market:de:energy-flow");

type EnergyFlowPayload = Awaited<ReturnType<typeof getGermanyEnergyFlowForPeriod>>;

const getEnergyFlowCached = GERMANY_ENERGY_FLOW_PERIODS.reduce(
  (acc, period) => {
    acc[period] = unstable_cache(
      async () => getGermanyEnergyFlowForPeriod(period),
      ["energy-charts-germany-energy-flow", period],
      { revalidate: 60 }
    );
    return acc;
  },
  {} as Record<(typeof GERMANY_ENERGY_FLOW_PERIODS)[number], () => Promise<EnergyFlowPayload>>
);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const now = new Date();
  const recommendationQuery = url.searchParams.get("recommendation");
  const dateQuery = url.searchParams.get("date");
  const weekQuery = url.searchParams.get("week");
  const monthQuery = url.searchParams.get("month");
  const customSelectors = [dateQuery, weekQuery, monthQuery].filter((entry) => entry !== null);

  if (recommendationQuery !== null) {
    if (recommendationQuery !== "trailing_12m") {
      return NextResponse.json(
        { message: "Invalid recommendation query. Use trailing_12m." },
        { status: 400 }
      );
    }
    try {
      const recommendation = await getGermanyBessRecommendationTrailingWindow(365, now);
      return NextResponse.json(recommendation, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      log("failed to load Germany BESS recommendation %o", {
        request: { method: "GET", route: "/api/market/de/energy-flow", recommendation: recommendationQuery },
        response: { status: 502 },
        error,
      });
      return NextResponse.json(
        {
          message: "Unable to load Germany BESS recommendation right now.",
        },
        { status: 502 }
      );
    }
  }

  if (customSelectors.length > 1) {
    return NextResponse.json(
      { message: "Use only one custom selector: date, week, or month." },
      { status: 400 }
    );
  }

  if (dateQuery !== null) {
    const parsedDate = berlinDateKeySchema.safeParse(dateQuery);
    if (!parsedDate.success) {
      return NextResponse.json(
        { message: "Invalid date query. Use Berlin date format YYYY-MM-DD." },
        { status: 400 }
      );
    }
    const range = resolveGermanyEnergyFlowBerlinRangeForDate(parsedDate.data, now);
    try {
      const flow = await getGermanyEnergyFlowForBerlinRange(range, now);
      if (!flow) {
        return NextResponse.json(
          { message: "Not enough usable Energy-Charts quarter-hours for this date yet." },
          { status: 404 }
        );
      }
      return NextResponse.json(flow, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      log("failed to load Germany energy flow by date %o", {
        request: { method: "GET", route: "/api/market/de/energy-flow", date: parsedDate.data },
        response: { status: 502 },
        error,
      });
      return NextResponse.json(
        {
          message: "Unable to load Germany energy flow right now.",
        },
        { status: 502 }
      );
    }
  }

  if (weekQuery !== null) {
    const parsedWeek = berlinIsoWeekKeySchema.safeParse(weekQuery);
    if (!parsedWeek.success) {
      return NextResponse.json(
        { message: "Invalid week query. Use ISO week format YYYY-Www." },
        { status: 400 }
      );
    }
    const range = resolveGermanyEnergyFlowBerlinRangeForWeek(parsedWeek.data, now);
    try {
      const flow = await getGermanyEnergyFlowForBerlinRange(range, now);
      if (!flow) {
        return NextResponse.json(
          { message: "Not enough usable Energy-Charts quarter-hours for this week yet." },
          { status: 404 }
        );
      }
      return NextResponse.json(flow, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      log("failed to load Germany energy flow by week %o", {
        request: { method: "GET", route: "/api/market/de/energy-flow", week: parsedWeek.data },
        response: { status: 502 },
        error,
      });
      return NextResponse.json(
        {
          message: "Unable to load Germany energy flow right now.",
        },
        { status: 502 }
      );
    }
  }

  if (monthQuery !== null) {
    const parsedMonth = berlinMonthKeySchema.safeParse(monthQuery);
    if (!parsedMonth.success) {
      return NextResponse.json(
        { message: "Invalid month query. Use month format YYYY-MM." },
        { status: 400 }
      );
    }
    const range = resolveGermanyEnergyFlowBerlinRangeForMonth(parsedMonth.data, now);
    try {
      const flow = await getGermanyEnergyFlowForBerlinRange(range, now);
      if (!flow) {
        return NextResponse.json(
          { message: "Not enough usable Energy-Charts quarter-hours for this month yet." },
          { status: 404 }
        );
      }
      return NextResponse.json(flow, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      log("failed to load Germany energy flow by month %o", {
        request: { method: "GET", route: "/api/market/de/energy-flow", month: parsedMonth.data },
        response: { status: 502 },
        error,
      });
      return NextResponse.json(
        {
          message: "Unable to load Germany energy flow right now.",
        },
        { status: 502 }
      );
    }
  }

  const raw = url.searchParams.get("period") ?? "today";
  const parsed = germanyEnergyFlowPeriodSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid period query. Use today, yesterday, this_week, this_month, or last_month." },
      { status: 400 }
    );
  }
  const period = parsed.data;

  try {
    const flow = await getEnergyFlowCached[period]();
    if (!flow) {
      return NextResponse.json(
        { message: "Not enough usable Energy-Charts quarter-hours for this period yet." },
        { status: 404 }
      );
    }
    return NextResponse.json(flow, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    log("failed to load Germany energy flow %o", {
      request: { method: "GET", route: "/api/market/de/energy-flow", period },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      {
        message: "Unable to load Germany energy flow right now.",
      },
      { status: 502 }
    );
  }
}
