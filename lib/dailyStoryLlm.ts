import { z } from "zod";

import { createLogger } from "@/lib/debug";
import type { MorningBriefingContext } from "@/lib/morningBriefingContext";

const log = createLogger("daily-story-llm");

/**
 * Daily-Story LLM client.
 *
 * Generates a short, premium "story of the day" for the home dashboard hero
 * card: a Bloomberg-style factual headline, a 2–3 sentence narrative, and a
 * one-sentence counterfactual that quantifies what an *optimal* BESS sized
 * for that specific day would have done to the structural imbalance.
 *
 * Rationale for splitting from `morningBriefingLlm.ts`:
 *  - Different prompt + response schema (no tweet length limits, includes
 *    a counterfactual line with concrete numbers).
 *  - Different cache lifetime (per Berlin date, refreshed 4×/day).
 *  - Different model ergonomics (we want slightly more creativity in
 *    headline phrasing while staying factual).
 *
 * Provider is configurable via env (`AI_PROVIDER`, `AI_MODEL`,
 * `XAI_API_KEY` / `OPENAI_API_KEY`, `AI_BASE_URL`) so swapping to Gemini /
 * GPT / xAI is a single env var flip per the project's LLM convention.
 *
 * `DAILY_STORY_AI_MODEL` overrides only this surface (e.g. use a cheaper
 * model for the hero card while keeping the assistant on a stronger one).
 */

const llmConfigSchema = z.object({
  AI_PROVIDER: z.string().default("xai"),
  AI_MODEL: z.string().default("grok-3-mini"),
  XAI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
});

export const dailyStorySchema = z.object({
  /** Sentence-case factual headline. ~60–140 chars. */
  headline: z.string().min(8).max(180),
  /** 2–3 sentence factual narrative explaining the day's structural story. */
  narrative: z.string().min(40).max(900),
  /**
   * One sentence that quantifies the BESS counterfactual using concrete
   * numbers from `simulated.*`. Must reference at least one of:
   * `practicalCapacityGwh`, `gridImpactReductionPct`,
   * `absorbedSurplusShare`, `servedDeficitShare`.
   */
  counterfactual: z.string().min(20).max(400),
  /**
   * Optional caveat — only present when the day is partial
   * (`pointFractionOfDay < 0.95`) so the UI can render an honest "based on
   * X% of today's quarter-hours" footnote.
   */
  dataAsOfNote: z.string().min(4).max(220).optional(),
});

export type DailyStory = z.infer<typeof dailyStorySchema>;

const xaiShape = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([
          z.string(),
          z.array(z.object({ type: z.string(), text: z.string().optional() })),
        ]),
      }),
    })
  ),
});

const openaiShape = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([z.string(), z.null()]),
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

const stripJsonFence = (raw: string): string => {
  const t = raw.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return t;
};

const buildUserPayload = (context: MorningBriefingContext, language: "en" | "de") => ({
  language,
  briefing: context,
  instructions: [
    "Return strict JSON only matching schema { headline, narrative, counterfactual, dataAsOfNote? }.",
    "Audience: utility-scale BESS sales engineers and energy analysts. Tone: Bloomberg / Financial Times — calm, factual, no hype, no emojis, no markdown.",
    "headline: ONE sentence in sentence case, ~60–140 chars. Lead with the day's structural posture (surplus/deficit/balanced) and the most striking driver (e.g. midday solar, evening ramp). Do NOT start with the date.",
    "narrative: 2–3 sentences (~250–500 chars total). Explain the SHAPE of the day (when surplus/deficit hit, who carried the system at what hours), not just totals. Use ONLY numbers present in `briefing` (or trivially derived). NO speculation about prices, weather, or next-day forecasts.",
    "counterfactual: ONE sentence that quantifies what an optimally-sized BESS for this day would have changed. Use `simulated.practicalCapacityGwh`, `simulated.balancedPowerMw`, and at least one of `simulated.gridImpactReductionPct`, `simulated.absorbedSurplusShare`, `simulated.servedDeficitShare`. Format example (EN): 'A right-sized 18.4 GWh / 9.2 GW BESS would have flattened ~31% of the grid imbalance, capturing ~47% of the surplus and serving ~22% of the deficit.' If `simulated.practicalCapacityGwh` is 0 or all sim shares are null, say so plainly instead of inventing numbers.",
    "dataAsOfNote: include ONLY when `pointFractionOfDay` < 0.95. Format: 'Based on the first XX% of today's quarter-hours.' (EN) or 'Stand: erste XX % der heutigen Viertelstunden.' (DE).",
    "All numbers: max 1 decimal. Use the language's native decimal separator (DE = comma, EN = period). Use thousand separators only above 10000.",
    language === "de"
      ? "Schreibe ALLE Strings auf Deutsch, Sie-Form, sachlich. Keine Anglizismen wo deutsche Begriffe gleich klar sind."
      : "Write ALL strings in English. Avoid jargon when a plain word works.",
  ],
});

async function callXai(
  cfg: z.infer<typeof llmConfigSchema>,
  model: string,
  systemPrompt: string,
  userPayload: unknown
): Promise<string> {
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
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    log("xai daily-story failed %s %s", res.status, errText.slice(0, 500));
    throw new Error(`xAI chat failed: ${res.status}`);
  }
  const raw = xaiShape.parse(await res.json());
  const content = raw.choices[0]?.message.content;
  if (content === undefined) {
    throw new Error("Empty xAI response");
  }
  return pickContent(content);
}

async function callOpenAi(
  cfg: z.infer<typeof llmConfigSchema>,
  model: string,
  systemPrompt: string,
  userPayload: unknown
): Promise<string> {
  if (!cfg.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
  }
  const baseUrl = (cfg.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    }),
  });
  if (!res.ok) {
    log("openai daily-story failed %s", (await res.text()).slice(0, 500));
    throw new Error(`OpenAI-compatible chat failed: ${res.status}`);
  }
  const raw = openaiShape.parse(await res.json());
  const content = raw.choices[0]?.message.content;
  if (typeof content !== "string") {
    throw new Error("Empty OpenAI response");
  }
  return content;
}

/**
 * Generate a "story of the day" for the home hero card.
 *
 * Throws on transport / parse / schema failure — callers should catch and
 * fall back to a deterministic numeric summary so the page never breaks.
 */
export async function generateDailyStory(
  context: MorningBriefingContext,
  language: "en" | "de"
): Promise<DailyStory> {
  const cfg = llmConfigSchema.parse({
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    XAI_API_KEY: process.env.XAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
  });

  const model = process.env.DAILY_STORY_AI_MODEL?.trim() || cfg.AI_MODEL;
  const provider = cfg.AI_PROVIDER.toLowerCase();
  const systemPrompt =
    "You are an energy markets analyst writing for a BESS sales-engineering dashboard. Reply with strict JSON only — no markdown fences, no commentary outside the JSON. Be factual and concise. Cite only numbers present in the provided briefing context.";
  const userPayload = buildUserPayload(context, language);

  let assistantText: string;
  if (provider === "xai") {
    assistantText = await callXai(cfg, model, systemPrompt, userPayload);
  } else if (provider === "openai" || provider === "openai_compatible") {
    assistantText = await callOpenAi(cfg, model, systemPrompt, userPayload);
  } else {
    throw new Error(`Unsupported AI_PROVIDER "${cfg.AI_PROVIDER}" for daily story`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripJsonFence(assistantText));
  } catch (err) {
    log("daily-story JSON parse failed: %s", String(err).slice(0, 200));
    throw new Error("Daily story LLM returned non-JSON text");
  }

  const out = dailyStorySchema.safeParse(parsedJson);
  if (!out.success) {
    log("daily-story schema fail %o", out.error.flatten());
    throw new Error("Daily story LLM returned invalid JSON shape");
  }
  return out.data;
}

export const __DAILY_STORY_TESTING__ = {
  buildUserPayload,
  stripJsonFence,
};
