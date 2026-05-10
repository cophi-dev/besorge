import { NextResponse } from "next/server";
import { z } from "zod";

import { createLogger } from "@/lib/debug";
import type { FlowShareCaptionApiResponse } from "@/lib/flowSharePayload";
import { flowSharePayloadSchema } from "@/lib/flowSharePayload";
import {
  buildFlowShareFallback,
  flowShareCaptionSchema,
  generateFlowShareCaption,
} from "@/lib/flowShareCaptionLlm";

const log = createLogger("api:briefing:flow-share");

const okResponseSchema = z.object({
  source: z.enum(["llm", "fallback_numeric"]),
  postText: flowShareCaptionSchema.shape.postText,
});

function coerceOkResponse(parsed: FlowShareCaptionApiResponse): FlowShareCaptionApiResponse {
  return okResponseSchema.parse(parsed);
}

export async function POST(req: Request) {
  let jsonBody: unknown;
  try {
    jsonBody = await req.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = flowSharePayloadSchema.safeParse(jsonBody);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const caption = await generateFlowShareCaption(parsed.data);
    const body = coerceOkResponse({ source: "llm", postText: caption.postText });
    return NextResponse.json(body);
  } catch (err) {
    log("flow share caption LLM path failed %s", String(err).slice(0, 280));
    const fallback = buildFlowShareFallback(parsed.data);
    let postText = fallback;

    let validated = flowShareCaptionSchema.safeParse({ postText });
    if (!validated.success) {
      postText =
        parsed.data.language === "de"
          ? "DE strukturelle Strombilanz aus Energy-Charts (heuristisch modelliert, illustrativ)."
          : "Germany structural power balance · Energy-Charts heuristic model (illustrative).";
      validated = flowShareCaptionSchema.safeParse({ postText });
    }

    const body = coerceOkResponse({
      source: "fallback_numeric",
      postText: validated.success ? validated.data.postText : postText,
    });
    return NextResponse.json(body);
  }
}
