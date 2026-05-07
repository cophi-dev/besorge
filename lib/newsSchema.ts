import { z } from "zod";

export const newsCategorySchema = z.enum([
  "industry_milestone",
  "germany",
  "tesla_megapack",
  "regulation",
]);

export const newsItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  sourceName: z.string().min(1),
  url: z.string().url(),
  publishedAtIso: z.string().datetime(),
  categories: z.array(newsCategorySchema).min(1),
  relevanceScore: z.number().min(0).max(100),
});

export const curatedNewsResponseSchema = z.object({
  asOfIso: z.string().datetime(),
  itemCount: z.number().int().min(0),
  items: z.array(newsItemSchema),
});

export const rawNewsCandidateSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  sourceName: z.string().min(1),
  url: z.string().url(),
  publishedAtIso: z.string().datetime(),
});

export const llmNewsOutputSchema = z.object({
  items: z.array(
    z.object({
      title: z.string().min(1),
      summary: z.string().min(1),
      sourceName: z.string().min(1),
      url: z.string().url(),
      publishedAtIso: z.string().datetime(),
      categories: z.array(newsCategorySchema).min(1),
      relevanceScore: z.number().min(0).max(100),
    })
  ),
});

export type NewsCategory = z.infer<typeof newsCategorySchema>;
export type NewsItem = z.infer<typeof newsItemSchema>;
export type CuratedNewsResponse = z.infer<typeof curatedNewsResponseSchema>;
export type RawNewsCandidate = z.infer<typeof rawNewsCandidateSchema>;
