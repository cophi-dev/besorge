import "server-only";

import { addBerlinCalendarDays, formatBerlinDateKeyFromUtcDate } from "@/lib/berlinCalendar";
import {
  getGermanyEnergyFlowForBerlinRange,
  getGermanyMarketSnapshot,
  type GermanyDispatchSlotsResponse,
  type GermanyMarketSnapshot,
} from "@/lib/energyChartsApi";
import { createLogger } from "@/lib/debug";
import { resolveGermanyEnergyFlowBerlinRangeForDate } from "@/lib/germanyEnergyFlowPeriod";

const log = createLogger("home-briefing-data");

export type HomeBriefingInitialData = {
  /** Default Berlin day the homepage chart should anchor to on first paint. */
  defaultBerlinDateKey: string;
  market: GermanyMarketSnapshot | null;
  /** Initial chart data for `defaultBerlinDateKey` (today, or yesterday before today's first slots publish). */
  initialEnergyFlow: GermanyDispatchSlotsResponse | null;
};

async function loadInitialEnergyFlow(now: Date): Promise<{
  defaultBerlinDateKey: string;
  initialEnergyFlow: GermanyDispatchSlotsResponse | null;
}> {
  const todayKey = formatBerlinDateKeyFromUtcDate(now);
  const todayRange = resolveGermanyEnergyFlowBerlinRangeForDate(todayKey, now);
  const todayFlow = await getGermanyEnergyFlowForBerlinRange(todayRange, now);
  if (todayFlow !== null) {
    return {
      defaultBerlinDateKey: todayKey,
      initialEnergyFlow: todayFlow,
    };
  }

  const yesterdayKey = addBerlinCalendarDays(todayKey, -1);
  const yesterdayRange = resolveGermanyEnergyFlowBerlinRangeForDate(yesterdayKey, now);
  const yesterdayFlow = await getGermanyEnergyFlowForBerlinRange(yesterdayRange, now);
  if (yesterdayFlow !== null) {
    return {
      defaultBerlinDateKey: yesterdayKey,
      initialEnergyFlow: yesterdayFlow,
    };
  }

  return {
    defaultBerlinDateKey: todayKey,
    initialEnergyFlow: null,
  };
}

/**
 * Fetches live market data and the initial Energy-Charts quarter-hour series on the server so the
 * first paint can render KPIs and a usable default day profile without waiting for a client round-trip.
 */
export async function loadHomeBriefingInitialData(
  now: Date = new Date()
): Promise<HomeBriefingInitialData> {
  const berlinDateKey = formatBerlinDateKeyFromUtcDate(now);

  try {
    const [market, energyFlowSeed] = await Promise.all([
      getGermanyMarketSnapshot(),
      loadInitialEnergyFlow(now),
    ]);
    return {
      defaultBerlinDateKey: energyFlowSeed.defaultBerlinDateKey,
      market,
      initialEnergyFlow: energyFlowSeed.initialEnergyFlow,
    };
  } catch (error) {
    log("initial briefing load failed %o", { error, berlinDateKey });
    return {
      defaultBerlinDateKey: berlinDateKey,
      market: null,
      initialEnergyFlow: null,
    };
  }
}
