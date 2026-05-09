"use client";

import { Sparkles } from "lucide-react";

type BriefingKeyInsightsProps = {
  language: "en" | "de";
  lines: string[];
};

export function BriefingKeyInsights({ language, lines }: BriefingKeyInsightsProps) {
  if (lines.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={language === "de" ? "Kernaussagen" : "Key insights"}
      className="rounded-2xl border border-emerald-500/25 bg-gradient-to-r from-emerald-950/35 via-slate-950/40 to-amber-950/25 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] md:p-5"
    >
      <div className="flex items-center gap-2 border-b border-white/10 pb-3">
        <Sparkles className="size-4 shrink-0 text-emerald-400" aria-hidden />
        <h2 className="text-xs font-semibold tracking-[0.2em] text-slate-300 uppercase">
          {language === "de" ? "Kernaussagen" : "Key insights"}
        </h2>
      </div>
      <ul className="mt-3 list-none space-y-2.5 text-sm leading-relaxed text-slate-100">
        {lines.map((line, i) => (
          <li key={`insight-${i}`} className="flex gap-2">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-400/90" aria-hidden />
            <span className="text-slate-200">{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
