import { z } from "zod";

import { createLogger } from "@/lib/debug";
import type { MorningBriefingContext } from "@/lib/morningBriefingContext";

const log = createLogger("morning-briefing-llm");

const llmConfigSchema = z.object({
  AI_PROVIDER: z.string().default("xai"),
  AI_MODEL: z.string().default("grok-3-mini"),
  XAI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
});

const responseSchema = z.object({
  tweet: z.string().min(1).max(400),
  /** Optional longer recap for logs / Discord — not posted to X by default. */
  recap: z.string().min(1).max(2000).optional(),
});

const xaiShape = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
      }),
    })
  ),
});

const pickContent = (content: string | Array<{ type: string; text?: string }>): string => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
};

const stripJsonFence = (raw: string) => {
  const t = raw.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return t;
};

export type MorningLlmResult = z.infer<typeof responseSchema>;

/**
 * One concise post body for X + optional recap. Uses the same provider envs as the rest of the app (`AI_PROVIDER`, `AI_MODEL`, `XAI_API_KEY` or `OPENAI_API_KEY`).
 */
export async function generateMorningBriefingCopy(
  context: MorningBriefingContext,
  language: "en" | "de"
): Promise<MorningLlmResult> {
  const cfg = llmConfigSchema.parse({
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    XAI_API_KEY: process.env.XAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
  });

  const model = process.env.MORNING_BRIEFING_AI_MODEL?.trim() || cfg.AI_MODEL;
  const provider = cfg.AI_PROVIDER.toLowerCase();

  const userPayload = {
    language,
    briefing: context,
    instructions: [
      "Return strict JSON only matching schema { tweet: string, recap?: string }.",
      "tweet: ONE post for X (max ~260 characters). Lead with the Berlin date. Mention structural balance sign/magnitude if meaningful, then ONE sentence on modeled optimal-BESS effect (grid proxy % or coverage) if available.",
      "Professional, factual, no hashtags spam, no investment advice. End with a short CTA to open the briefing link (the script appends the URL separately in the composer).",
      "recap: 2-4 sentences in the requested language with methodology caveat (heuristic, Energy-Charts).",
    ],
  };

  let assistantText: string;

  if (provider === "xai") {
    if (!cfg.XAI_API_KEY) {
      throw new Error("XAI_API_KEY is required when AI_PROVIDER=xai");
    }
    const baseUrl = (cfg.AI_BASE_URL ?? "https://api.x.ai/v1").replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.XAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You write sharp energy-transition briefing copy for professionals. JSON only. No markdown fences.",
          },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      log("xai morning brief failed %s %s", res.status, errText);
      throw new Error(`xAI chat failed: ${res.status}`);
    }
    const raw = xaiShape.parse(await res.json());
    const content = raw.choices[0]?.message.content;
    if (content === undefined) {
      throw new Error("Empty xAI response");
    }
    assistantText = pickContent(content);
  } else if (provider === "openai" || provider === "openai_compatible") {
    const key = cfg.OPENAI_API_KEY;
    if (!key) {
      throw new Error("OPENAI_API_KEY is required for openai provider");
    }
    const baseUrl = (cfg.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You write sharp energy briefing copy. Reply with JSON object only with keys tweet (string) and optional recap (string).",
          },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });
    if (!res.ok) {
      log("openai morning brief failed %s", await res.text());
      throw new Error(`OpenAI-compatible chat failed: ${res.status}`);
    }
    const json: unknown = await res.json();
    const content = (json as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message
      ?.content;
    if (typeof content !== "string") {
      throw new Error("Empty OpenAI response");
    }
    assistantText = content;
  } else {
    throw new Error(`Unsupported AI_PROVIDER "${cfg.AI_PROVIDER}" for morning briefing`);
  }

  const parsedJson = JSON.parse(stripJsonFence(assistantText)) as unknown;
  const out = responseSchema.safeParse(parsedJson);
  if (!out.success) {
    log("morning LLM schema fail %o", out.error.flatten());
    throw new Error("Morning briefing LLM returned invalid JSON shape");
  }
  return out.data;
}
