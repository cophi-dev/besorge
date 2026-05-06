import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getBessChatReplyFromAi } from "@/lib/aiAssessmentClient";
import { createLogger } from "@/lib/debug";
import { getGermanyAssessmentContext } from "@/lib/energyChartsApi";

const log = createLogger("api:assessment:chat");

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      })
    )
    .min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as unknown;
    const parsed = requestSchema.parse(body);
    const context = await getGermanyAssessmentContext();
    const liveContext = JSON.stringify(
      {
        instruction:
          "Use this latest Germany BESS context to ground your answer. If data is missing, say so explicitly.",
        context,
      },
      null,
      2
    );
    const response = await getBessChatReplyFromAi(parsed, { liveContext });
    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("chat generation failed %o", {
      request: { method: "POST", route: "/api/assessment/chat" },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      {
        message: `Unable to get BESS chat response right now: ${message}`,
      },
      { status: 502 }
    );
  }
}
