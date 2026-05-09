"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { useLanguage } from "@/components/language-context";
import { Skeleton } from "@/components/ui/skeleton";

const newsItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  sourceName: z.string(),
  url: z.string().url(),
  publishedAtIso: z.string(),
  categories: z.array(z.string()),
  relevanceScore: z.number(),
});

const responseSchema = z.object({
  asOfIso: z.string(),
  itemCount: z.number(),
  items: z.array(newsItemSchema),
});

type NewsPreviewSectionProps = {
  limit?: number;
  compact?: boolean;
  showHeaderLink?: boolean;
};

const categoryLabels: Record<string, { en: string; de: string }> = {
  industry_milestone: { en: "Milestone", de: "Meilenstein" },
  germany: { en: "Germany", de: "Deutschland" },
  tesla_megapack: { en: "Tesla Megapack", de: "Tesla Megapack" },
  regulation: { en: "Regulation", de: "Regulierung" },
};

export default function NewsPreviewSection({
  limit = 4,
  compact = false,
  showHeaderLink = true,
}: NewsPreviewSectionProps) {
  const { language } = useLanguage();
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    items: z.infer<typeof newsItemSchema>[];
  }>({ status: "loading", items: [] });

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/news?limit=${limit}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const payload = responseSchema.parse(await response.json());
        if (active) {
          setState({ status: "ready", items: payload.items });
        }
      } catch {
        if (active) {
          setState({ status: "error", items: [] });
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [limit]);

  const title = language === "de" ? "BESS-Newsfeed" : "BESS Newsfeed";
  const subtitle =
    language === "de"
      ? "Meilensteine · DE · Megapacks · Regulierung."
      : "Milestones · DE · Megapacks · regulation.";

  const renderedItems = useMemo(() => state.items.slice(0, limit), [state.items, limit]);

  return (
    <section className="rounded-2xl border border-slate-300/45 bg-white/70 p-5 md:p-6 dark:border-slate-500/35 dark:bg-slate-900/55">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs tracking-[0.14em] text-slate-500 uppercase dark:text-slate-300">{title}</p>
        {showHeaderLink ? (
          <Link
            href="/news"
            className="text-xs font-semibold text-primary hover:underline dark:text-emerald-200"
          >
            {language === "de" ? "Alle News" : "View all"}
          </Link>
        ) : null}
      </div>
      {!compact ? <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{subtitle}</p> : null}

      {state.status === "loading" ? (
        <div className="mt-4 grid gap-3">
          {Array.from({ length: compact ? 2 : 3 }).map((_, index) => (
            <article
              key={`news-skeleton-${index}`}
              className="rounded-xl border border-slate-200/70 bg-white/85 p-4 dark:border-slate-500/40 dark:bg-slate-900/55"
            >
              <div className="flex gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="mt-3 h-6 w-3/4" />
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-5/6" />
              <Skeleton className="mt-3 h-3 w-1/2" />
            </article>
          ))}
        </div>
      ) : null}
      {state.status === "error" ? (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          {language === "de" ? "Newsfeed ist gerade nicht erreichbar." : "Newsfeed is currently unavailable."}
        </p>
      ) : null}
      {state.status === "ready" && renderedItems.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          {language === "de" ? "Derzeit keine relevanten Updates gefunden." : "No relevant updates found right now."}
        </p>
      ) : null}

      {state.status === "ready" && renderedItems.length > 0 ? (
        <div className="mt-4 grid gap-3">
          {renderedItems.map((item) => (
            <article
              key={item.id}
              className="rounded-xl border border-slate-200/70 bg-white/85 p-4 dark:border-slate-500/40 dark:bg-slate-900/55"
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px] tracking-[0.08em] text-slate-500 uppercase dark:text-slate-300">
                {item.categories.map((category) => (
                  <span key={category} className="rounded-full border border-slate-300/65 px-2 py-0.5 dark:border-slate-500/50">
                    {(categoryLabels[category]?.[language] ?? category).replaceAll("_", " ")}
                  </span>
                ))}
              </div>
              <h3 className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                  {item.title}
                </a>
              </h3>
              {!compact ? (
                <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">{item.summary}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-300">
                <p>
                  {item.sourceName} •{" "}
                  {new Date(item.publishedAtIso).toLocaleString(language === "de" ? "de-DE" : "en-GB")}
                </p>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-primary hover:underline dark:text-emerald-200"
                >
                  {language === "de" ? "Artikel lesen" : "Read article"}
                </a>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
