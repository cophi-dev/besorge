"use client";

import { Download, ImageIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import type { GermanyDispatchSlotsResponse } from "@/lib/energyChartsApi";
import { createLogger } from "@/lib/debug";

const log = createLogger("flow-export");

type FlowExportButtonsProps = {
  language: "en" | "de";
  flow: GermanyDispatchSlotsResponse | null;
  /** DOM id of the region to rasterise (PNG). */
  captureElementId: string;
};

function slotsToCsv(flow: GermanyDispatchSlotsResponse): string {
  const header =
    "timestamp_iso,hour_berlin,load_mw,total_generation_mw,renewable_generation_mw,cross_border_trading_mw,net_balance_mw";
  const lines = flow.slots.map((s) => {
    const net = s.totalGenerationMw - s.loadMw;
    const ren = s.renewableGenerationMw;
    const crossBorder =
      s.crossBorderElectricityTradingMw !== null &&
      s.crossBorderElectricityTradingMw !== undefined
        ? String(s.crossBorderElectricityTradingMw)
        : "";
    return [
      s.timestampIso,
      String(s.hourBerlin),
      String(s.loadMw),
      String(s.totalGenerationMw),
      ren === null ? "" : String(ren),
      crossBorder,
      String(net),
    ].join(",");
  });
  return [header, ...lines].join("\n");
}

export function FlowExportButtons({ language, flow, captureElementId }: FlowExportButtonsProps) {
  const [busy, setBusy] = useState<null | "png" | "csv">(null);

  const onCsv = useCallback(() => {
    if (!flow?.slots.length) {
      return;
    }
    try {
      const blob = new Blob([slotsToCsv(flow)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `speicherpilot-germany-energy-${flow.dateBerlin}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      log("csv export failed %o", { error });
    }
  }, [flow]);

  const onPng = useCallback(async () => {
    const el = document.getElementById(captureElementId);
    if (!el) {
      log("png capture element missing %s", captureElementId);
      return;
    }
    setBusy("png");
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(el, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: typeof document !== "undefined" && document.documentElement.classList.contains("dark")
          ? "#0c1220"
          : "#ffffff",
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = flow
        ? `speicherpilot-germany-briefing-${flow.dateBerlin}.png`
        : "speicherpilot-germany-briefing.png";
      a.click();
    } catch (error) {
      log("png export failed %o", { error });
    } finally {
      setBusy(null);
    }
  }, [captureElementId, flow]);

  const csvLabel = language === "de" ? "CSV" : "CSV";
  const pngLabel = language === "de" ? "PNG" : "PNG";
  const disabled = !flow?.slots.length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={disabled || busy !== null}
        onClick={onCsv}
        className="h-8 gap-1.5 text-[11px]"
      >
        <Download className="size-3.5" aria-hidden />
        {csvLabel}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={disabled || busy !== null}
        onClick={() => {
          void onPng();
        }}
        className="h-8 gap-1.5 text-[11px]"
      >
        <ImageIcon className="size-3.5" aria-hidden />
        {pngLabel}
        {busy === "png" ? "…" : ""}
      </Button>
    </div>
  );
}
