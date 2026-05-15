import { createHash } from "node:crypto";
import { z } from "zod";

import { createLogger } from "@/lib/debug";
import {
  curatedNewsResponseSchema,
  llmNewsOutputSchema,
  rawNewsCandidateSchema,
  type NewsCategory,
  type NewsItem,
  type RawNewsCandidate,
} from "@/lib/newsSchema";

const log = createLogger("news-ingestion");

const sourceSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});

const newsAiConfigSchema = z.object({
  AI_PROVIDER: z.string().default("xai"),
  AI_MODEL: z.string().default("grok-3-mini"),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
});

const rssSourcesSchema = z.array(sourceSchema);

const RSS_SOURCES = rssSourcesSchema.parse([
  {
    name: "Google News Germany BESS",
    url: "https://news.google.com/rss/search?q=Germany+battery+energy+storage+milestone&hl=en-US&gl=DE&ceid=DE:en",
  },
  {
    name: "Google News Tesla Megapack",
    url: "https://news.google.com/rss/search?q=Tesla+Megapack+Europe&hl=en-US&gl=DE&ceid=DE:en",
  },
  {
    name: "Google News Germany BESS regulation",
    url: "https://news.google.com/rss/search?q=Germany+battery+storage+regulation&hl=en-US&gl=DE&ceid=DE:en",
  },
  {
    name: "Tesla Newsroom",
    url: "https://www.tesla.com/news/rss.xml",
  },
]);

const RSS_FETCH_TIMEOUT_MS = 8_000;
const AI_CURATION_TIMEOUT_MS = 10_000;

const stripCdata = (value: string) => value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripHtml = (value: string) => value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const normalizeText = (value: string) =>
  stripHtml(decodeHtmlEntities(value))
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();

const extractTag = (itemXml: string, tag: string): string | null => {
  const match = itemXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripCdata(match[1].trim()) : null;
};

const parseRss = (xml: string, sourceName: string): RawNewsCandidate[] => {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  const parsed: RawNewsCandidate[] = [];
  for (const itemXml of items) {
    const title = extractTag(itemXml, "title");
    const description = extractTag(itemXml, "description") ?? "";
    const url = extractTag(itemXml, "link");
    const pubDateRaw = extractTag(itemXml, "pubDate");
    if (!title || !url) {
      continue;
    }
    const publishedAt = pubDateRaw ? new Date(pubDateRaw) : new Date();
    if (Number.isNaN(publishedAt.getTime())) {
      continue;
    }
    const candidate = rawNewsCandidateSchema.safeParse({
      title: normalizeText(title),
      description: normalizeText(description) || normalizeText(title),
      sourceName,
      url,
      publishedAtIso: publishedAt.toISOString(),
    });
    if (candidate.success) {
      parsed.push(candidate.data);
    }
  }
  return parsed;
};

const dedupeCandidates = (candidates: RawNewsCandidate[]) => {
  const byKey = new Map<string, RawNewsCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.url.toLowerCase()}|${candidate.title.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    if (new Date(candidate.publishedAtIso).getTime() > new Date(existing.publishedAtIso).getTime()) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.publishedAtIso).getTime() - new Date(a.publishedAtIso).getTime()
  );
};

const detectCategories = (title: string, description: string): NewsCategory[] => {
  const text = `${title} ${description}`.toLowerCase();
  const categories = new Set<NewsCategory>();
  if (/(germany|deutschland|berlin|hamburg|nrw|bayern|bundesnetzagentur|bmwk|eeg)/i.test(text)) {
    categories.add("germany");
  }
  if (/(tesla|megapack)/i.test(text)) {
    categories.add("tesla_megapack");
  }
  if (/(regulation|policy|law|tariff|grid code|subsid|auction|permit|compliance|legislation)/i.test(text)) {
    categories.add("regulation");
  }
  if (/(commission|launch|project|deployment|milestone|construction|capacity|commissioned)/i.test(text)) {
    categories.add("industry_milestone");
  }
  if (categories.size === 0) {
    categories.add("industry_milestone");
  }
  return [...categories];
};

const toHeuristicItems = (candidates: RawNewsCandidate[], limit: number): NewsItem[] =>
  candidates.slice(0, limit).map((candidate) => {
    const categories = detectCategories(candidate.title, candidate.description);
    const relevanceScore = Math.min(100, 40 + categories.length * 15 + (categories.includes("germany") ? 10 : 0));
    return {
      id: createHash("sha1").update(`${candidate.url}-${candidate.publishedAtIso}`).digest("hex").slice(0, 16),
      title: candidate.title,
      summary: candidate.description.slice(0, 320),
      sourceName: candidate.sourceName,
      url: candidate.url,
      publishedAtIso: candidate.publishedAtIso,
      categories,
      relevanceScore,
    };
  });

const parseJsonText = (raw: string) => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return trimmed;
};

const getAssistantText = (content: string | Array<{ type: string; text?: string }>) => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((chunk) => chunk.type === "text" && typeof chunk.text === "string")
    .map((chunk) => chunk.text)
    .join("\n");
};

const llmResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
      }),
    })
  ),
});

const getNewsCurationFromAi = async (candidates: RawNewsCandidate[], limit: number): Promise<NewsItem[]> => {
  const config = newsAiConfigSchema.parse({
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
  });
  const apiKey = config.AI_API_KEY ?? config.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing AI API key (set AI_API_KEY or XAI_API_KEY)");
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
          "You are a BESS market analyst. Curate only items relevant to battery energy storage, especially Germany, Tesla Megapack, and regulation. Return strict JSON only.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Curate a concise BESS newsfeed for SpeicherPilot.",
          requirements: [
            "Keep only relevant entries.",
            "Use neutral factual summaries (max 2 sentences).",
            "Set relevanceScore 0..100.",
            "Always include at least one category.",
            "Prefer Germany, Tesla Megapack, and regulation content.",
            `Return at most ${limit} items.`,
          ],
          items: candidates,
        }),
      },
    ],
  };
  const aiRequest = fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const response = await Promise.race([
    aiRequest,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`AI curation timed out after ${AI_CURATION_TIMEOUT_MS}ms`)), AI_CURATION_TIMEOUT_MS);
    }),
  ]);
  if (!response.ok) {
    const responseBody = await response.text();
    log("news curation request failed %o", {
      request: { method: "POST", url, provider: config.AI_PROVIDER, model: config.AI_MODEL },
      response: { status: response.status, statusText: response.statusText, body: responseBody.slice(0, 1000) },
    });
    throw new Error(`News curation failed with status ${response.status}`);
  }
  const payload = await response.json();
  const parsedPayload = llmResponseSchema.safeParse(payload);
  if (!parsedPayload.success || parsedPayload.data.choices.length === 0) {
    throw new Error("News curation response malformed");
  }
  const content = getAssistantText(parsedPayload.data.choices[0].message.content);
  const normalized = parseJsonText(content);
  const parsed = llmNewsOutputSchema.safeParse(JSON.parse(normalized));
  if (!parsed.success) {
    throw new Error("News curation output did not match schema");
  }
  return parsed.data.items.slice(0, limit).map((item) => ({
    ...item,
    id: createHash("sha1").update(`${item.url}-${item.publishedAtIso}`).digest("hex").slice(0, 16),
  }));
};

export async function getCuratedNewsFeed(limit = 20) {
  const sourceResults = await Promise.allSettled(
    RSS_SOURCES.map(async (source) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(source.url, {
          headers: { Accept: "application/rss+xml, application/xml, text/xml" },
          next: { revalidate: 60 * 60 * 24 },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new Error(`RSS fetch failed (${source.name}) with status ${response.status}`);
      }
      return parseRss(await response.text(), source.name);
    })
  );

  const candidates = sourceResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const merged = dedupeCandidates(candidates);
  if (merged.length === 0) {
    return curatedNewsResponseSchema.parse({
      asOfIso: new Date().toISOString(),
      itemCount: 0,
      items: [],
    });
  }

  let items: NewsItem[];
  try {
    items = await getNewsCurationFromAi(merged.slice(0, 30), limit);
  } catch (error) {
    log("falling back to heuristic curation %o", {
      request: { method: "GET", route: "getCuratedNewsFeed" },
      error,
    });
    items = toHeuristicItems(merged, limit);
  }

  return curatedNewsResponseSchema.parse({
    asOfIso: new Date().toISOString(),
    itemCount: items.length,
    items,
  });
}
