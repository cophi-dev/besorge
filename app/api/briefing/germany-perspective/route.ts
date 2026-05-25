import { NextResponse } from "next/server";
import { z } from "zod";

import { createLogger } from "@/lib/debug";
import {
  buildGermanyPerspectiveFallback,
  generateGermanyPerspectiveNarrative,
  germanyPerspectivePayloadSchema,
  germanyPerspectiveSchema,
} from "@/lib/germanyPerspectiveLlm";

const log = createLogger("api:briefing:germany-perspective");

const okResponseSchema = z.object({
  source: z.enum(["llm", "fallback_numeric"]),
  narrative: germanyPerspectiveSchema.shape.narrative,
});

export async function POST(req: Request) {
  let jsonBody: unknown;
  try {
    jsonBody = await req.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = germanyPerspectivePayloadSchema.safeParse(jsonBody);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const narrative = await generateGermanyPerspectiveNarrative(parsed.data);
    return NextResponse.json(
      okResponseSchema.parse({ source: "llm", narrative: narrative.narrative })
    );
  } catch (err) {
    log("germany perspective LLM failed %s", String(err).slice(0, 280));
    const fallback = buildGermanyPerspectiveFallback(parsed.data);
    const validated = germanyPerspectiveSchema.safeParse({ narrative: fallback });
    return NextResponse.json(
      okResponseSchema.parse({
        source: "fallback_numeric",
        narrative: validated.success ? validated.data.narrative : fallback,
      })
    );
  }
}
