import { z } from "zod";

import { createLogger } from "@/lib/debug";
import type { MorningBriefingContext } from "@/lib/morningBriefingContext";

const log = createLogger("daily-story-llm");

/**
 * Daily-Story LLM client.
 *
 * Generates a short "story of the day" for the home dashboard hero card: headline,
 * three scannable bullet insights, a concise narrative, and one counterfactual line
 * for the optimally-sized BESS model.
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
  /** Exactly three one-line factual takeaways — UI renders as bullets (no numbering in text). */
  insights: z.array(z.string().min(14).max(160)).length(3),
  /** Short closing paragraph reinforcing net posture — avoid repeating all bullet numbers. */
  narrative: z.string().min(32).max(900),
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
    'Return strict JSON only matching schema { headline, insights: string[3], narrative, counterfactual, dataAsOfNote? }.',
    "Audience: utility-scale BESS sales engineers and energy analysts. Tone: Bloomberg / Financial Times — calm, factual, no hype, no emojis, no markdown.",
    ...(context.isMultiDayWindow
      ? [
          language === "de"
            ? "Kalenderfenster: `briefing.isMultiDayWindow` ist wahr — schreibe über den zusammengefügten Zeitraum `rangeStartBerlin` … `rangeEndBerlin` (ISO-Daten), nicht als wäre es nur ein einzelner Tag. `pointFractionOfDay` ist der Fortschritt durch die erwarteten Viertelstunden in diesem Fenster."
            : "Calendar window: `briefing.isMultiDayWindow` is true — write about the stitched span `rangeStartBerlin` through `rangeEndBerlin` (ISO dates), not as if it were a single calendar day. `pointFractionOfDay` is progress through expected quarter-hours in that window.",
          language === "de"
            ? "insights (Kalenderfenster): Reihenfolge strikt (1) Fenster-Netto `netStructuralBalanceGwh` in Klartext und klarstellen, dass die folgenden zwei Punkte die Form zerlegen, nicht drei Anteile eines zweiten Totals; (2) stärkstes Uhr-Band aus `structuralNetGwhByWindow` vs. dieses Netto; (3) entweder Spitzenstunden aus `dayShape`, EE-Zeile oder — falls vorhanden — `curtailedEnergyGwh`. Nicht das Wort 'Tages-BESS' verwenden; sagen Sie 'für dieses Fenster dimensioniert' / 'window-sized'."
            : "insights (calendar window): ORDER strictly (1) state window NET `netStructuralBalanceGwh` in plain words and say the next two bullets decompose shape, not three parts of another total; (2) strongest clock band from `structuralNetGwhByWindow` vs that net; (3) either peak hours from `dayShape`, the renewables-only line, or `curtailedEnergyGwh` when present. Do NOT say 'daily BESS'; say 'BESS sized for this window' / 'window-sized model'.",
        ]
      : []),
    "headline: ONE sentence in sentence case, ~60–140 chars. Lead with posture (net surplus/deficit) plus one concrete driver from `dayShape` or coverage — not a spreadsheet-style lead like 'Net structural balance for the day is…'. `briefing.netStructuralBalanceGwh` is the summed Σ(gen−load) across the sampled span (single day or multi-day window — not gross surplus energy). Do NOT start with the date.",
    ...(context.isMultiDayWindow
      ? []
      : [
          "insights: EXACTLY 3 SHORT strings (~60–155 chars each), each ONE standalone fact. No numbering prefixes. EACH must cite ONLY fields already in `briefing`. Plain language only: spell out 'renewable generation minus load' (never '(r−L)', 'r−L', or bare Σ notation in user-facing strings). When citing a clock-window sum from `structuralNetGwhByWindow`, explicitly say it is **only inside that hour band**, not the full-day net. When citing `renewableNetStructuralBalanceGwh`, say it sums **only slots where renewable MW exists** and mention `renewableSlotFractionOfSampled` if below 1. If `curtailedEnergyGwh` is present, you may use it as the second or third bullet, but say it is extra curtailed renewable charge opportunity rather than published generation. For peaks use 'Berlin local hour' (not MESZ). Roles: (a) strongest window vs full-day net, (b) renewables-only line, curtailment line, or fleet fallback, (c) peak surplus/deficit hours from `dayShape`.",
        ]),
    context.isMultiDayWindow
      ? "narrative: 1–2 sentences (~140–380 chars preferred). Tie headline to window NET (`netStructuralBalanceGwh`) and explain how clock-band sums, the renewables-only line, and `curtailedEnergyGwh` (when present) can diverge from that total without implying they should add up to it."
      : "narrative: 1–2 sentences (~140–380 chars preferred). Tie headline to full-day NET (`netStructuralBalanceGwh`) and briefly explain how it differs from window-only sums, from the renewables-only line, and from `curtailedEnergyGwh` when present so readers are not surprised by diverging numbers.",
    context.isMultiDayWindow
      ? "counterfactual: Never call it a 'daily BESS' for a multi-day window. Say BESS / storage 'sized for this window' or 'window-sized model' using `practicalCapacityGwh` and `balancedPowerMw`, then grid impact and gross charge-opportunity / deficit shares as for single-day."
      : "counterfactual: One or two short sentences (same JSON string; max ~400 chars total). First sentence: optimal BESS size (`practicalCapacityGwh`, `balancedPowerMw`) plus grid / imbalance effect (`gridImpactReductionPct` or plain-language equivalent). Optional second sentence: `absorbedSurplusShare` and `servedDeficitShare`, where `absorbedSurplusShare` is the modeled share of gross charge opportunity (structural surplus plus `curtailedEnergyGwh` when present) and `servedDeficitShare` is the share of gross deficit energy met from storage. Do not describe either as a share of the signed net balance. If `practicalCapacityGwh` is 0 or all sim shares are null, say so plainly.",
    context.isMultiDayWindow
      ? "dataAsOfNote: include ONLY when `pointFractionOfDay` < 0.95. EN: 'Based on the first XX% of expected quarter-hours in the selected window.' DE: 'Stand: erste XX % der erwarteten Viertelstunden im Kalenderfenster.'"
      : "dataAsOfNote: include ONLY when `pointFractionOfDay` < 0.95. Format: 'Based on the first XX% of today's quarter-hours.' (EN) or 'Stand: erste XX % der heutigen Viertelstunden.' (DE).",
    "All numbers: max 1 decimal. Use the language's native decimal separator (DE = comma, EN = period). Use thousand separators only above 10000.",
    language === "de"
      ? "Schreibe ALLE Strings auf Deutsch, Sie-Form, sachlich. Keine Anglizismen wo deutsche Begriffe gleich klar sind. Keine Symbolkürzel wie (r−L) oder GRID Δ im Fließtext."
      : "Write ALL strings in English. Prefer plain words over symbols: no '(r−L)', no 'GRID Δ' in prose (say 'imbalance smoothing' or describe the grid-impact share in words).",
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
