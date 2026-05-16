import {
  berlinDateKeySchema,
  berlinIsoWeekKeySchema,
  berlinMonthKeySchema,
  normalizeBerlinCustomDateRange,
} from "@/lib/germanyEnergyFlowPeriod";
import { z } from "zod";

/**
 * Which Germany-flow window the hero story should narrate — must stay aligned
 * with {@link GermanyDayEnergyFlow} selector (day / week / month / custom).
 */
export type BriefingStoryWindow =
  | { type: "day"; date: string }
  | { type: "week"; weekKey: string }
  | { type: "month"; monthKey: string }
  | { type: "custom"; start: string; end: string };

export const briefingStoryWindowSchema = z.union([
  z.object({ type: z.literal("day"), date: berlinDateKeySchema }),
  z.object({ type: z.literal("week"), weekKey: berlinIsoWeekKeySchema }),
  z.object({ type: z.literal("month"), monthKey: berlinMonthKeySchema }),
  z.object({
    type: z.literal("custom"),
    start: berlinDateKeySchema,
    end: berlinDateKeySchema,
  }),
]);

export function serializeBriefingStoryWindow(w: BriefingStoryWindow): string {
  if (w.type === "day") {
    return `d:${w.date}`;
  }
  if (w.type === "week") {
    return `w:${w.weekKey}`;
  }
  if (w.type === "month") {
    return `m:${w.monthKey}`;
  }
  const { startKey, endKey } = normalizeBerlinCustomDateRange(w.start, w.end);
  return `r:${startKey}:${endKey}`;
}
