"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Link2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

type BriefingLiveStripProps = {
  language: "en" | "de";
  lastUpdatedIso: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onShare: () => void;
  shareBusy?: boolean;
};

/**
 * Compact "live strip" — replaces the previous separate `DataAttributionBanner`
 * + `BriefingLiveBar`. One single row at md+ that carries:
 *  - a live pulse + last-updated timestamp
 *  - source attribution (Energy-Charts) as a slim inline chip
 *  - Refresh + Copy link actions on the right
 *
 * Result: ~150px less vertical space above the fold while preserving every
 * action and source link the previous two-card stack had.
 */
export function BriefingLiveStrip({
  language,
  lastUpdatedIso,
  isRefreshing,
  onRefresh,
  onShare,
  shareBusy = false,
}: BriefingLiveStripProps) {
  /**
   * `toLocaleString` differs between Node (server) and the browser, so we
   * defer the formatted string until after mount to avoid hydration drift.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const formatted =
    mounted && lastUpdatedIso !== null
      ? new Date(lastUpdatedIso).toLocaleString(
          language === "de" ? "de-DE" : "en-GB",
          {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }
        )
      : "—";

  const updatedLabel = language === "de" ? "Stand" : "Updated";
  const sourceLabel = language === "de" ? "Quelle" : "Source";

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border/55 bg-card/45 px-3.5 py-2 text-xs backdrop-blur-sm md:flex-row md:items-center md:justify-between md:gap-4 md:px-4 dark:border-white/[0.06] dark:bg-white/[0.025]"
      aria-label={language === "de" ? "Live-Datenleiste" : "Live data strip"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-2">
          <span
            className="relative inline-flex h-2 w-2"
            title={language === "de" ? "Live-Datenpipeline" : "Live data pipeline"}
            aria-hidden
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/55 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.7)]" />
          </span>
          <span className="font-medium tracking-wide text-slate-500 dark:text-slate-400">
            {updatedLabel}
            <span
              className="ml-1.5 tabular-nums text-slate-700 dark:text-slate-200"
              suppressHydrationWarning
            >
              {formatted}
            </span>
          </span>
        </span>
        <span
          className="hidden h-3 w-px bg-border/70 md:inline-block dark:bg-white/[0.08]"
          aria-hidden
        />
        <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/90">
          <span className="text-muted-foreground/70">{sourceLabel}:</span>
          <a
            href="https://energy-charts.info/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline dark:text-emerald-300"
          >
            Energy-Charts
            <ExternalLink className="size-3" aria-hidden />
          </a>
          <span className="text-muted-foreground/70">·</span>
          <a
            href="https://www.ise.fraunhofer.de/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline dark:hover:text-white"
          >
            Fraunhofer ISE
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </span>
      </div>

      <div
        className="inline-flex items-stretch self-start rounded-lg border border-border/60 bg-background/40 p-0.5 md:self-auto dark:border-white/[0.06]"
        role="group"
        aria-label={language === "de" ? "Briefing-Aktionen" : "Briefing actions"}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 rounded-md px-2.5 text-[11px] font-medium hover:bg-muted/70 dark:hover:bg-white/[0.05]"
          disabled={isRefreshing}
          onClick={onRefresh}
        >
          <RefreshCw
            className={`size-3 ${isRefreshing ? "animate-spin" : ""}`}
            aria-hidden
          />
          {language === "de" ? "Aktualisieren" : "Refresh"}
        </Button>
        <span
          className="my-1 w-px shrink-0 bg-border/70 dark:bg-white/[0.06]"
          aria-hidden
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 rounded-md px-2.5 text-[11px] font-medium hover:bg-muted/70 dark:hover:bg-white/[0.05]"
          disabled={shareBusy}
          onClick={onShare}
        >
          <Link2 className="size-3" aria-hidden />
          {language === "de" ? "Link kopieren" : "Copy link"}
        </Button>
      </div>
    </div>
  );
}
