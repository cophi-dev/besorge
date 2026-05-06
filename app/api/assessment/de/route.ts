import { NextResponse } from "next/server";
import { z } from "zod";

import { getBessAssessmentFromAi } from "@/lib/aiAssessmentClient";
import { createLogger } from "@/lib/debug";
import { getGermanyAssessmentContext } from "@/lib/energyChartsApi";

const log = createLogger("api:assessment:de");

const responseSchema = z.object({
  verdict: z.enum(["beneficial_now", "not_beneficial_now", "uncertain"]),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  timeHorizon: z.enum(["now", "next_12m", "next_36m"]),
  shortTermSignal: z.string().min(1),
  structuralSignal: z.string().min(1),
  scoreBreakdown: z.object({
    volatility: z.number().min(0).max(100),
    adequacy: z.number().min(0).max(100),
    policyAndRegulation: z.number().min(0).max(100),
    marketPressure: z.number().min(0).max(100),
  }),
  confidenceDrivers: z.array(z.string().min(1)).min(1),
  confidenceLimitations: z.array(z.string().min(1)).min(1),
  keyDrivers: z.array(z.string()).min(1),
  risks: z.array(z.string()).min(1),
  recommendedNextActions: z.array(z.string()).min(1),
  horizonOutlook: z.object({
    now: z.object({
      recommendation: z.string().min(1),
      rationale: z.string().min(1),
    }),
    next12m: z.object({
      recommendation: z.string().min(1),
      rationale: z.string().min(1),
    }),
    next36m: z.object({
      recommendation: z.string().min(1),
      rationale: z.string().min(1),
    }),
  }),
  dataGapsImpact: z.string().min(1),
  asOf: z.string(),
});

export async function GET() {
  try {
    const context = await getGermanyAssessmentContext();
    const assessment = await getBessAssessmentFromAi(context);
    const parsed = responseSchema.parse(assessment);

    return NextResponse.json(parsed, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("assessment generation failed %o", {
      request: { method: "GET", route: "/api/assessment/de" },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      {
        message: `Unable to run BESS assessment right now: ${message}`,
      },
      { status: 502 }
    );
  }
}
