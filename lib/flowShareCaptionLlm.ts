import { z } from "zod";

import { createLogger } from "@/lib/debug";
import type { FlowSharePayload } from "@/lib/flowSharePayload";

const log = createLogger("flow-share-caption-llm");

const llmConfigSchema = z.object({
  AI_PROVIDER: z.string().default("xai"),
  AI_MODEL: z.string().default("grok-3-mini"),
  XAI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
});

export const flowShareCaptionSchema = z.object({
  /** Plain text suitable for twitter.com/intent/tweet — no hashtags required. */
  postText: z.string().min(12).max(260),
});

export type FlowShareCaption = z.infer<typeof flowShareCaptionSchema>;

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

function stripJsonFence(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return t;
}

/** Round for tweet-friendly numerals (avoid long decimals). */
function r1(n: number): string {
  if (!Number.isFinite(n)) {
    return "—";
  }
  const s = Math.abs(n).toFixed(1);
  return (n < 0 ? "−" : "") + (s.startsWith("−") ? s.slice(1) : s);
}

function pctFromShare(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const pct = value > 0 && value <= 1 ? value * 100 : value;
  return `${Math.round(pct)}%`;
}

function clipPost(s: string): string {
  const maxLen = 260;
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, Math.max(0, maxLen - 1))}\u2026`;
}

/**
 * Deterministic caption when the LLM is unavailable; keeps wording aligned
 * with dashboard KPI meanings (net window balance vs gross buckets).
 */
export function buildFlowShareFallback(payload: FlowSharePayload): string {
  const en = payload.language === "en";
  const cov = `${Math.round(payload.dataCoveragePct)}%`;
  const net = `${payload.netBalanceGwhWindow >= 0 ? "+" : "−"}${r1(Math.abs(payload.netBalanceGwhWindow))}`;
  const titleShort =
    payload.chartHeading.length > 64 ? `${payload.chartHeading.slice(0, 61)}…` : payload.chartHeading;

  if (payload.presentationMode === "simulated") {
    const cap =
      payload.optimalBessEnergyGwh !== undefined && Number.isFinite(payload.optimalBessEnergyGwh)
        ? r1(payload.optimalBessEnergyGwh)
        : "?";
    const gw =
      payload.optimalBessPowerGw !== undefined && Number.isFinite(payload.optimalBessPowerGw)
        ? r1(payload.optimalBessPowerGw)
        : "?";
    const damp =
      payload.imbalanceDampingPct !== undefined && Number.isFinite(payload.imbalanceDampingPct)
        ? `${Math.round(payload.imbalanceDampingPct)}%`
        : "—";

    const line = en
      ? `Germany · ${payload.windowLabel} (${cov} qh coverage). Net structural ${net} GWh vs modeled ~${cap} GWh/${gw} GW BESS — Σ|slot| damping ~${damp}, surplus captured ${pctFromShare(payload.absorbedSurplusPct)}, deficit covered ${pctFromShare(payload.servedDeficitPct)}. ${titleShort}. Energy-Charts heuristics.`
      : `DE · ${payload.windowLabel} (${cov} VH). Netto strukturell ${net} GWh mit ~${cap} GWh/${gw} GW BESS — Dämpfung ~${damp}, Aufnahme ${pctFromShare(payload.absorbedSurplusPct)}, Defizit ${pctFromShare(payload.servedDeficitPct)}. ${titleShort}. Energy-Charts-Heuristik.`;
    return clipPost(line);
  }

  const grossGwh =
    payload.grossSurplusGwh !== undefined && Number.isFinite(payload.grossSurplusGwh)
      ? r1(payload.grossSurplusGwh)
      : null;
  const grossPart = grossGwh
    ? en
      ? `${grossGwh} GWh gross surplus in window`
      : `${grossGwh} GWh Brutto-Überschuss`
    : en
      ? "gross surplus n/a"
      : "Brutto-Überschuss n/a";
  const baseLineRounded =
    payload.baselineSelfConsumptionPct !== undefined &&
    Number.isFinite(payload.baselineSelfConsumptionPct)
      ? `${Math.round(payload.baselineSelfConsumptionPct)}%`
      : "—";

  const line = en
    ? `Germany · ${payload.windowLabel} (${cov} qh). Net structural ${net} GWh; ${grossPart}; baseline gen/load pairing ~${baseLineRounded}. ${titleShort}. Illustrative Energy-Charts.`
    : `DE · ${payload.windowLabel} (${cov} VH). Netto strukturell ${net} GWh; ${grossPart}; Direktdeckung ~${baseLineRounded}. ${titleShort}. Illustrativ.`;
  return clipPost(line);
}

async function callXai(
  cfg: z.infer<typeof llmConfigSchema>,
  model: string,
  systemPrompt: string,
  userContent: string
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
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    log("flow-share xai failed %s %s", res.status, errText.slice(0, 500));
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
  userContent: string
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
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    log("flow-share openai failed %s", (await res.text()).slice(0, 500));
    throw new Error(`OpenAI-compatible chat failed: ${res.status}`);
  }
  const raw = openaiShape.parse(await res.json());
  const content = raw.choices[0]?.message.content;
  if (typeof content !== "string") {
    throw new Error("Empty OpenAI response");
  }
  return content;
}

function buildInstructions(payload: FlowSharePayload): string[] {
  const base = [
    "Return strict JSON only: {\"postText\": \"…\"}.",
    "postText: ONE standalone post for X (Twitter).",
    `Hard max ${flowShareCaptionSchema.shape.postText.maxLength} UTF-16 code units.`,
    "`netBalanceGwhWindow` is the signed sum Σ(gen−load)×¼h for the plotted QUARTER-HOURS in this window—not gross surplus energy.",
    "For simulated mode, imbalanceDampingPct is reduction in summed absolute quarter-hour structural net after greedy BESS vs raw; absorbed/served shares reference gross surplus/deficit energy buckets.",
    "Use only numbers supplied in metrics; max one decimal unless integer is clearer.",
    payload.language === "de"
      ? "Write ENTIRELY in German, Sie-form, factual, calm. No hashtags unless clearly useful (prefer none)."
      : "Write in English only. Prefer no hashtags.",
    `metrics: ${JSON.stringify(payload)}`,
  ];
  return base;
}

/**
 * Produce a concise social caption + deterministic fallback when the API errors.
 */
export async function generateFlowShareCaption(payload: FlowSharePayload): Promise<FlowShareCaption> {
  const cfg = llmConfigSchema.parse({
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    XAI_API_KEY: process.env.XAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
  });

  const model = process.env.FLOW_SHARE_AI_MODEL?.trim() || cfg.AI_MODEL;
  const provider = cfg.AI_PROVIDER.toLowerCase();
  const systemPrompt =
    "You write factual energy-system micro-posts. Reply strict JSON {\"postText\"} only — no fences, no extra keys.";
  const userContent = buildInstructions(payload).join("\n");

  let assistantText: string;
  if (provider === "xai") {
    assistantText = await callXai(cfg, model, systemPrompt, userContent);
  } else if (provider === "openai" || provider === "openai_compatible") {
    assistantText = await callOpenAi(cfg, model, systemPrompt, userContent);
  } else {
    throw new Error(`Unsupported AI_PROVIDER "${cfg.AI_PROVIDER}" for flow share caption`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripJsonFence(assistantText));
  } catch (err) {
    log("flow-share JSON parse failed: %s", String(err).slice(0, 200));
    throw new Error("Flow share LLM returned non-JSON");
  }

  const out = flowShareCaptionSchema.safeParse(parsedJson);
  if (!out.success) {
    log("flow-share schema fail %o", out.error.flatten());
    throw new Error("Flow share LLM returned invalid JSON shape");
  }
  return out.data;
}

export const __FLOW_SHARE_CAPTION_TESTING__ = {
  buildFlowShareFallback,
  buildInstructions,
};
