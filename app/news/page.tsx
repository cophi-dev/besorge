"use client";

import Link from "next/link";

import NewsPreviewSection from "@/components/NewsPreviewSection";
import { useLanguage } from "@/components/language-context";

export default function NewsPage() {
  const { language } = useLanguage();

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-8 pb-24 pt-16 lg:px-12">
      <section className="space-y-3">
        <p className="text-xs tracking-[0.12em] text-slate-500 uppercase dark:text-slate-300">
          {language === "de" ? "SpeicherPilot-Newsfeed" : "SpeicherPilot Newsfeed"}
        </p>
        <h1 className="text-4xl text-slate-900 dark:text-white md:text-5xl [font-family:var(--font-heading)]">
          {language === "de" ? "BESS-Marktupdates" : "BESS Market Updates"}
        </h1>
        <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-300">
          {language === "de"
            ? "Kuratiertes Live-Briefing mit Fokus auf Branchen-Meilensteine, Deutschland, Tesla Megapacks und regulatorische Entwicklungen."
            : "Curated live briefing focused on industry milestones, Germany, Tesla Megapacks, and regulatory developments."}
        </p>
        <Link href="/" className="inline-block text-sm font-semibold text-primary hover:underline dark:text-emerald-200">
          {language === "de" ? "Zurück zum Briefing" : "Back to briefing"}
        </Link>
      </section>
      <NewsPreviewSection limit={20} showHeaderLink={false} />
    </div>
  );
}
