import "server-only";

import { formatBerlinDateKeyFromUtcDate } from "@/lib/berlinCalendar";
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
  berlinDateKey: string;
  market: GermanyMarketSnapshot | null;
  todayEnergyFlow: GermanyDispatchSlotsResponse | null;
};

/**
 * Fetches live market data and today’s Energy-Charts quarter-hour series on the server so the
 * first paint can render KPIs and the day profile without waiting for a client round-trip.
 */
export async function loadHomeBriefingInitialData(): Promise<HomeBriefingInitialData> {
  const now = new Date();
  const berlinDateKey = formatBerlinDateKeyFromUtcDate(now);
  const range = resolveGermanyEnergyFlowBerlinRangeForDate(berlinDateKey, now);

  try {
    const [market, todayEnergyFlow] = await Promise.all([
      getGermanyMarketSnapshot(),
      getGermanyEnergyFlowForBerlinRange(range, now),
    ]);
    return {
      berlinDateKey,
      market,
      todayEnergyFlow,
    };
  } catch (error) {
    log("initial briefing load failed %o", { error, berlinDateKey });
    return {
      berlinDateKey,
      market: null,
      todayEnergyFlow: null,
    };
  }
}
