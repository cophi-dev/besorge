"use client";

import { Link2, RefreshCw } from "lucide-react";

import { XLogo } from "@/components/XLogo";
import { Button } from "@/components/ui/button";

type BriefingLiveBarProps = {
  language: "en" | "de";
  lastUpdatedIso: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onShare: () => void;
  onPostToX: () => void;
  shareBusy?: boolean;
};

export function BriefingLiveBar({
  language,
  lastUpdatedIso,
  isRefreshing,
  onRefresh,
  onShare,
  onPostToX,
  shareBusy = false,
}: BriefingLiveBarProps) {
  const formatted =
    lastUpdatedIso !== null
      ? new Date(lastUpdatedIso).toLocaleString(language === "de" ? "de-DE" : "en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "—";

  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-3">
        <span className="relative flex items-center gap-2">
          <span
            className="relative flex h-2.5 w-2.5"
            title={language === "de" ? "Live-Datenpipeline" : "Live data pipeline"}
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60 opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500 shadow-[0_0_12px_rgba(52,211,153,0.7)]" />
          </span>
          <span className="text-xs font-medium tracking-wide text-slate-500 dark:text-slate-400">
            {language === "de" ? "Stand" : "Updated"}
            <span className="ml-2 tabular-nums text-slate-700 dark:text-slate-200">{formatted}</span>
          </span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-border/80 bg-card/60 text-xs"
          disabled={isRefreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden />
          {language === "de" ? "Aktualisieren" : "Refresh"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={shareBusy}
          onClick={onShare}
        >
          <Link2 className="size-3.5" aria-hidden />
          {language === "de" ? "Link kopieren" : "Copy link"}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-8 gap-1.5 bg-foreground text-background hover:bg-foreground/90"
          onClick={onPostToX}
          title={language === "de" ? "Beitrag auf X" : "Post on X"}
        >
          <XLogo className="size-3.5" />
          {language === "de" ? "Post auf X" : "Post on X"}
        </Button>
      </div>
    </div>
  );
}
