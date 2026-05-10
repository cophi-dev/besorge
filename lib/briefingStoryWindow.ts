import { berlinDateKeySchema, berlinIsoWeekKeySchema, berlinMonthKeySchema } from "@/lib/germanyEnergyFlowPeriod";
import { z } from "zod";

/**
 * Which Germany-flow window the hero story should narrate — must stay aligned
 * with {@link GermanyDayEnergyFlow} selector (day / week / month).
 */
export type BriefingStoryWindow =
  | { type: "day"; date: string }
  | { type: "week"; weekKey: string }
  | { type: "month"; monthKey: string };

export const briefingStoryWindowSchema = z.union([
  z.object({ type: z.literal("day"), date: berlinDateKeySchema }),
  z.object({ type: z.literal("week"), weekKey: berlinIsoWeekKeySchema }),
  z.object({ type: z.literal("month"), monthKey: berlinMonthKeySchema }),
]);

export function serializeBriefingStoryWindow(w: BriefingStoryWindow): string {
  if (w.type === "day") {
    return `d:${w.date}`;
  }
  if (w.type === "week") {
    return `w:${w.weekKey}`;
  }
  return `m:${w.monthKey}`;
}
