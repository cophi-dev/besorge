import { z } from "zod";

import { createLogger } from "@/lib/debug";

const log = createLogger("germany-perspective-llm");

const llmConfigSchema = z.object({
  AI_PROVIDER: z.string().default("xai"),
  AI_MODEL: z.string().default("grok-3-mini"),
  XAI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
});

export const germanyPerspectivePayloadSchema = z.object({
  language: z.enum(["de", "en"]),
  lookbackLabel: z.string().min(3),
  recommendedEnergyGwh: z.number().positive(),
  recommendedPowerGw: z.number().positive(),
  paybackYears: z.number().positive().nullable(),
  absorbedSurplusSharePct: z.number().min(0).max(100).nullable(),
  servedDeficitSharePct: z.number().min(0).max(100).nullable(),
  annualRevenueEur: z.number().nonnegative().nullable(),
  peakSocGwh: z.number().nonnegative().nullable(),
  windowLabel: z.string().optional(),
  windowOptimizedCapacityGwh: z.number().positive().optional(),
});

export type GermanyPerspectivePayload = z.infer<typeof germanyPerspectivePayloadSchema>;

export const germanyPerspectiveSchema = z.object({
  narrative: z.string().min(80).max(1400),
});

export type GermanyPerspectiveNarrative = z.infer<typeof germanyPerspectiveSchema>;

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

function pickContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return trimmed;
}

function formatGwh(language: GermanyPerspectivePayload["language"], value: number): string {
  return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatGw(language: GermanyPerspectivePayload["language"], value: number): string {
  return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatEur(language: GermanyPerspectivePayload["language"], value: number): string {
  return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

export function buildGermanyPerspectiveFallback(payload: GermanyPerspectivePayload): string {
  const energy = formatGwh(payload.language, payload.recommendedEnergyGwh);
  const power = formatGw(payload.language, payload.recommendedPowerGw);
  const payback =
    payload.paybackYears !== null
      ? payload.language === "de"
        ? `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(payload.paybackYears)} Jahre`
        : `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(payload.paybackYears)} years`
      : null;
  const coverage =
    payload.absorbedSurplusSharePct !== null && payload.servedDeficitSharePct !== null
      ? payload.language === "de"
        ? `Im Jahresmittel deckt diese Größe rund ${Math.round(payload.absorbedSurplusSharePct)} % der modellierten Ladechance und ${Math.round(payload.servedDeficitSharePct)} % der strukturellen Defizitenergie.`
        : `On average across the year, this size covers about ${Math.round(payload.absorbedSurplusSharePct)}% of modeled charge opportunity and ${Math.round(payload.servedDeficitSharePct)}% of structural deficit energy.`
      : null;
  const revenue =
    payload.annualRevenueEur !== null
      ? payload.language === "de"
        ? `Der indikative Jahreserlös aus dem Vorverkaufsmodell liegt bei ${formatEur(payload.language, payload.annualRevenueEur)} — kein Vertrags- oder Prognosewert.`
        : `Indicative annual revenue from the pre-sales model is ${formatEur(payload.language, payload.annualRevenueEur)} — not contract or forecast revenue.`
      : null;
  const windowCompare =
    payload.windowOptimizedCapacityGwh !== undefined && payload.windowLabel
      ? payload.language === "de"
        ? `Für ${payload.windowLabel} liegt die nutzenoptimierte Fenstergröße bei ${formatGwh(payload.language, payload.windowOptimizedCapacityGwh)} GWh — sie kann vom Jahres-P90 abweichen, wenn das Fenster untypisch ist.`
        : `For ${payload.windowLabel}, the benefit-optimised window size is ${formatGwh(payload.language, payload.windowOptimizedCapacityGwh)} GWh — it may differ from the annual P90 when the window is atypical.`
      : null;

  if (payload.language === "de") {
    return [
      `Über ${payload.lookbackLabel} liegt die empfohlene Balanced-Größe bei ${energy} GWh und ${power} GW Leistung — P90 der modellierten Kalendertage, nicht die Ein-Tages-Spitze.`,
      coverage,
      revenue,
      payback ? `Bei den hinterlegten CAPEX-Annahmen ergibt sich eine vereinfachte Amortisationsgröße von etwa ${payback}.` : null,
      windowCompare,
      "Das ist ein illustratives Modell aus Energy-Charts Gen−Last und Markt-Proxies — keine Beschaffungsempfehlung.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    `Over ${payload.lookbackLabel}, the recommended balanced size is ${energy} GWh at ${power} GW — P90 across modeled calendar days, not a single-day spike.`,
    coverage,
    revenue,
    payback ? `With the embedded capex assumptions, simple payback is about ${payback}.` : null,
    windowCompare,
    "This is an illustrative model from Energy-Charts gen−load and market proxies — not procurement advice.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function callChat(
  cfg: z.infer<typeof llmConfigSchema>,
  model: string,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const provider = cfg.AI_PROVIDER.toLowerCase();
  if (provider === "openai") {
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
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI-compatible chat failed: ${res.status}`);
    }
    const raw = openaiShape.parse(await res.json());
    const content = raw.choices[0]?.message.content;
    if (typeof content !== "string") {
      throw new Error("Empty OpenAI response");
    }
    return content;
  }

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
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    log("germany perspective xai failed %s", (await res.text()).slice(0, 500));
    throw new Error(`xAI chat failed: ${res.status}`);
  }
  const raw = xaiShape.parse(await res.json());
  const content = raw.choices[0]?.message.content;
  if (content === undefined) {
    throw new Error("Empty xAI response");
  }
  return pickContent(content);
}

export async function generateGermanyPerspectiveNarrative(
  payload: GermanyPerspectivePayload
): Promise<GermanyPerspectiveNarrative> {
  const cfg = llmConfigSchema.parse({
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    XAI_API_KEY: process.env.XAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
  });
  const model = process.env.GERMANY_PERSPECTIVE_AI_MODEL?.trim() || cfg.AI_MODEL;

  const systemPrompt =
    payload.language === "de"
      ? "Du bist ein sachlicher Energie-Analyst. Antworte nur als JSON {\"narrative\": \"…\"}. Schreibe 2–4 flüssige Sätze auf Deutsch (Sie-Form). Erkläre die 12-Monats-Balanced-Empfehlung verständlich: Größe, typische Abdeckung, indikativer Erlös/Amortisation wenn vorhanden, Abgrenzung zum Fenster darüber. Keine Überschriften, keine Bullet-Listen. Keine Beschaffungsempfehlung — immer illustratives Modell betonen."
      : "You are a factual energy analyst. Reply with JSON only {\"narrative\": \"…\"}. Write 2–4 flowing English sentences explaining the 12-month balanced recommendation: size, typical coverage, indicative revenue/payback when present, and how it differs from the window above. No headings or bullets. Stress illustrative model, not procurement advice.";

  const userContent = JSON.stringify(payload);
  const raw = stripJsonFence(await callChat(cfg, model, systemPrompt, userContent));
  const parsed = germanyPerspectiveSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error("Germany perspective LLM JSON schema rejected");
  }
  return parsed.data;
}
