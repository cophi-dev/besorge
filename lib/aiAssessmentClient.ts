import { z } from "zod";

import { createLogger } from "@/lib/debug";

const log = createLogger("ai-assessment");

const aiConfigSchema = z.object({
  AI_PROVIDER: z.string().default("xai"),
  AI_MODEL: z.string().default("grok-3-mini"),
  XAI_API_KEY: z.string().min(1, "Missing XAI_API_KEY"),
  AI_BASE_URL: z.string().url().optional(),
});

const requestContextSchema = z.object({
  snapshot: z.object({
    retrievedAtIso: z.string(),
    energyUsage: z.object({
      latestValueMw: z.number(),
      trailing24hAverageMw: z.number(),
    }),
    bess: z.object({
      installedCapacityGwh: z.number(),
      installedPowerGw: z.number(),
    }),
    realtimeSystem: z.object({
      loadMw: z.number(),
      domesticGenerationMw: z.number(),
      batteryStorageMw: z.number().nullable(),
      residualLoadMw: z.number().optional(),
      renewableShareOfLoadPct: z.number().optional(),
    }),
  }),
  historical: z.object({
    trailing24hAverageMw: z.number(),
    trailing7dAverageMw: z.number(),
    trailing30dAverageMw: z.number(),
    trailing7dPeakMw: z.number(),
    trailing30dPeakMw: z.number(),
  }),
  marketSignals: z.object({
    loadDelta7dVs30dMw: z.number(),
    peakDelta7dVs30dMw: z.number(),
    residualVolatility7dPct: z.number().nullable(),
    residualVolatility30dPct: z.number().nullable(),
    residualRampP95MwPer15m: z.number().nullable(),
    eveningStressPeriods7d: z.number().nullable(),
    oversupplyPeriods7d: z.number().nullable(),
  }),
  forecast: z.object({
    available: z.boolean(),
    note: z.string(),
    source: z.literal("energy-charts.ren_share_forecast"),
    horizonHours: z.number().int().positive().nullable(),
    renewableSharePctP50Next24h: z.number().nullable(),
    renewableSharePctMinNext24h: z.number().nullable(),
    renewableSharePctMaxNext24h: z.number().nullable(),
    renewableSharePctP50Next48h: z.number().nullable(),
    renewableSharePctMinNext48h: z.number().nullable(),
    renewableSharePctMaxNext48h: z.number().nullable(),
    renewableSharePctP50Day2: z.number().nullable(),
  }),
  renewablePatterns: z.object({
    recentWindowDays: z.number().int().positive(),
    recentSolarShareOfLoadPctAvg: z.number().nullable(),
    recentWindShareOfLoadPctAvg: z.number().nullable(),
    recentMiddaySolarMwAvg: z.number().nullable(),
    recentEveningResidualMwAvg: z.number().nullable(),
    recentOversupplyPeriods: z.number().int().nullable(),
    recentSolarRichDays: z.number().int().nullable(),
    inferredBatteryReadiness: z.enum(["high", "moderate", "low", "unknown"]),
    note: z.string(),
  }),
  dataQuality: z.object({
    missingSignals: z.array(z.string()),
    note: z.string(),
  }),
});

const scoreBreakdownSchema = z.object({
  volatility: z.number().min(0).max(100),
  adequacy: z.number().min(0).max(100),
  policyAndRegulation: z.number().min(0).max(100),
  marketPressure: z.number().min(0).max(100),
});

const horizonOutlookSchema = z.object({
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
});

const assessmentResponseSchema = z.object({
  verdict: z.enum(["beneficial_now", "not_beneficial_now", "uncertain"]),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  timeHorizon: z.enum(["now", "next_12m", "next_36m"]),
  shortTermSignal: z.string().min(1),
  structuralSignal: z.string().min(1),
  scoreBreakdown: scoreBreakdownSchema,
  confidenceDrivers: z.array(z.string().min(1)).min(1),
  confidenceLimitations: z.array(z.string().min(1)).min(1),
  keyDrivers: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string().min(1)).min(1),
  recommendedNextActions: z.array(z.string().min(1)).min(1),
  horizonOutlook: horizonOutlookSchema,
  dataGapsImpact: z.string().min(1),
  analystSummary: z.string().min(1),
  fullAnalysisSummary: z.string().min(1),
  asOf: z.string(),
});

type AssessmentResponse = z.infer<typeof assessmentResponseSchema>;
type RequestContext = z.infer<typeof requestContextSchema>;
const bessChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

const bessChatRequestSchema = z.object({
  messages: z.array(bessChatMessageSchema).min(1),
});

const bessChatResponseSchema = z.object({
  reply: z.string().min(1),
  asOf: z.string(),
});

type BessChatMessage = z.infer<typeof bessChatMessageSchema>;
const assessmentOutputContract = {
  verdict: "beneficial_now | not_beneficial_now | uncertain",
  score: "number 0-100",
  confidence: "number 0-100",
  timeHorizon: "now | next_12m | next_36m",
  shortTermSignal: "string",
  structuralSignal: "string",
  scoreBreakdown: {
    volatility: "number 0-100",
    adequacy: "number 0-100",
    policyAndRegulation: "number 0-100",
    marketPressure: "number 0-100",
  },
  confidenceDrivers: "string[]",
  confidenceLimitations: "string[]",
  keyDrivers: "string[]",
  risks: "string[]",
  recommendedNextActions: "string[]",
  horizonOutlook: {
    now: { recommendation: "string", rationale: "string" },
    next12m: { recommendation: "string", rationale: "string" },
    next36m: { recommendation: "string", rationale: "string" },
  },
  dataGapsImpact: "string",
  analystSummary: "string",
  fullAnalysisSummary: "string",
  asOf: "ISO timestamp string",
};

const xaiChatResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
      }),
    })
  ),
});

const parseJsonText = (raw: string) => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return trimmed;
};

const getAssistantText = (content: string | Array<{ type: string; text?: string }>): string => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((chunk) => chunk.type === "text" && typeof chunk.text === "string")
    .map((chunk) => chunk.text)
    .join("\n");
};

export async function getBessAssessmentFromAi(context: RequestContext): Promise<AssessmentResponse> {
  const parsedContext = requestContextSchema.parse(context);
  const config = aiConfigSchema.parse({
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    XAI_API_KEY: process.env.XAI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
  });

  if (config.AI_PROVIDER !== "xai") {
    throw new Error(`Unsupported AI_PROVIDER "${config.AI_PROVIDER}"`);
  }

  const baseUrl = config.AI_BASE_URL ?? "https://api.x.ai/v1";
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: config.AI_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an expert BESS market analyst. Return strict JSON only. No markdown. Provide balanced decision support, not investment guarantees. Separate immediate (now) signals from structural (12-36 month) signals and explain uncertainty clearly.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Assess whether additional BESS storage is beneficial right now in Germany.",
          requirements: [
            "Clearly separate shortTermSignal (immediate) and structuralSignal (1-3 year context).",
            "Provide scoreBreakdown with four numeric dimensions.",
            "Provide confidenceDrivers and confidenceLimitations based only on provided context.",
            "Provide horizonOutlook for now, next12m, and next36m.",
            "Use renewablePatterns and forecast jointly: reason over the last 3 days plus the next 24-48h to infer likely BESS charge readiness and near-term arbitrage setup.",
            "If recent solar-rich days and forward renewable support are both strong, explain why evening residual peaks can be more monetizable because recharge risk is lower.",
            "Write analystSummary as premium concise copy for the homepage gauge card (2-3 sentences, calm and specific, avoid hype).",
            "Write fullAnalysisSummary as a slightly deeper analyst note (3-5 sentences) expanding on weather-pattern context, likely battery state, and short-term BESS value.",
            "If context has missingSignals, explain impact in dataGapsImpact instead of overconfident extrapolation.",
          ],
          required_output_schema: assessmentOutputContract,
          context: parsedContext,
        }),
      },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.XAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    log("ai request failed %o", {
      request: { url, method: "POST", model: config.AI_MODEL, provider: config.AI_PROVIDER },
      response: {
        status: response.status,
        statusText: response.statusText,
        body: responseBody.slice(0, 1_000),
      },
    });
    throw new Error(`AI request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const parsedPayload = xaiChatResponseSchema.safeParse(payload);
  if (!parsedPayload.success || parsedPayload.data.choices.length === 0) {
    log("ai response shape invalid %o", {
      request: { url, method: "POST", model: config.AI_MODEL, provider: config.AI_PROVIDER },
      response: { payload },
    });
    throw new Error("AI response was empty or malformed");
  }

  const content = getAssistantText(parsedPayload.data.choices[0].message.content);
  const normalized = parseJsonText(content);

  let json: unknown;
  try {
    json = JSON.parse(normalized);
  } catch (error) {
    log("ai response json parse failed %o", {
      request: { url, method: "POST", model: config.AI_MODEL, provider: config.AI_PROVIDER },
      response: { content: normalized.slice(0, 1_000) },
      error,
    });
    throw new Error("AI response was not valid JSON");
  }

  const parsedAssessment = assessmentResponseSchema.safeParse(json);
  if (!parsedAssessment.success) {
    log("ai assessment schema parse failed %o", {
      request: { url, method: "POST", model: config.AI_MODEL, provider: config.AI_PROVIDER },
      response: { errors: parsedAssessment.error.flatten(), raw: json },
    });
    throw new Error("AI response did not match assessment schema");
  }

  return parsedAssessment.data;
}

export async function getBessChatReplyFromAi(
  payload: z.infer<typeof bessChatRequestSchema>,
  options?: { liveContext?: string }
): Promise<z.infer<typeof bessChatResponseSchema>> {
  const parsedPayload = bessChatRequestSchema.parse(payload);
  const config = aiConfigSchema.parse({
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    XAI_API_KEY: process.env.XAI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
  });

  if (config.AI_PROVIDER !== "xai") {
    throw new Error(`Unsupported AI_PROVIDER "${config.AI_PROVIDER}"`);
  }

  const baseUrl = config.AI_BASE_URL ?? "https://api.x.ai/v1";
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const messages = [
    {
      role: "system",
      content:
          "You are BESSForge Assistant. You only discuss BESS-related topics (technical sizing, market interpretation, risks, project planning, and decision support). If asked unrelated questions, politely redirect to BESS context. Keep responses practical and concise. Use short paragraphs and plain bullets. Do not use markdown headings, bold syntax, or code fences.",
    },
    ...(options?.liveContext
      ? [
          {
            role: "system",
            content: options.liveContext,
          },
        ]
      : []),
    ...parsedPayload.messages,
  ];

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.AI_MODEL,
      temperature: 0.3,
      messages,
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    log("ai chat request failed %o", {
      request: {
        url,
        method: "POST",
        model: config.AI_MODEL,
        provider: config.AI_PROVIDER,
        messages: parsedPayload.messages,
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        body: responseBody.slice(0, 1_000),
      },
    });
    throw new Error(`AI chat request failed with status ${response.status}`);
  }

  const raw = await response.json();
  const parsed = xaiChatResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.choices.length === 0) {
    log("ai chat response shape invalid %o", {
      request: { url, method: "POST", model: config.AI_MODEL, provider: config.AI_PROVIDER },
      response: { payload: raw },
    });
    throw new Error("AI chat response was empty or malformed");
  }

  const reply = getAssistantText(parsed.data.choices[0].message.content).trim();
  if (!reply) {
    throw new Error("AI chat response was empty");
  }

  return bessChatResponseSchema.parse({
    reply,
    asOf: new Date().toISOString(),
  });
}

export type { AssessmentResponse, RequestContext, BessChatMessage };
