"use client";

import { ExternalLink } from "lucide-react";

type DataAttributionBannerProps = {
  language: "en" | "de";
};

export function DataAttributionBanner({ language }: DataAttributionBannerProps) {
  const copy =
    language === "de"
      ? "Marktdaten aus Energy-Charts (Fraunhofer ISE API) · Viertelstunden, ohne Interpolation."
      : "Market data via Energy-Charts (Fraunhofer ISE API) · quarter-hour series, no interpolation.";
  return (
    <aside className="rounded-2xl border border-emerald-500/25 bg-emerald-950/25 px-4 py-3 shadow-inner md:px-5 md:py-4">
      <p className="text-xs leading-relaxed text-emerald-100/95 md:text-sm">{copy}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold">
        <a
          href="https://energy-charts.info/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-emerald-300 underline-offset-4 hover:text-white hover:underline"
        >
          energy-charts.info
          <ExternalLink className="size-3" aria-hidden />
        </a>
        <a
          href="https://www.ise.fraunhofer.de/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-slate-300 underline-offset-4 hover:text-white hover:underline"
        >
          Fraunhofer ISE
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    </aside>
  );
}
