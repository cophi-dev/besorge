"use client";

import { ImageIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { createLogger } from "@/lib/debug";

const log = createLogger("sim-flow-png");

type SimulatedFlowPngButtonProps = {
  language: "en" | "de";
  captureElementId: string;
  dateBerlin: string;
  disabled?: boolean;
};

export function SimulatedFlowPngButton({
  language,
  captureElementId,
  dateBerlin,
  disabled = false,
}: SimulatedFlowPngButtonProps) {
  const [busy, setBusy] = useState(false);
  const label = language === "de" ? "PNG" : "PNG";
  const aria =
    language === "de"
      ? "Simulierten Graphen mit Zusammenfassung als PNG herunterladen"
      : "Download simulated chart and summary as PNG";

  const onPng = useCallback(async () => {
    const el = document.getElementById(captureElementId);
    if (!el) {
      log("capture element missing %s", captureElementId);
      return;
    }
    setBusy(true);
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(el, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor:
          typeof document !== "undefined" && document.documentElement.classList.contains("dark")
            ? "#0c1220"
            : "#ffffff",
        filter: (node) => {
          if (!(node instanceof HTMLElement)) {
            return true;
          }
          return !node.closest("[data-export-ignore]");
        },
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `speicherpilot-de-sim-${dateBerlin}.png`;
      a.click();
    } catch (error) {
      log("png export failed %o", { error });
    } finally {
      setBusy(false);
    }
  }, [captureElementId, dateBerlin]);

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="h-8 shrink-0 gap-1.5 rounded-lg border-border/70 bg-background/80 px-2.5 text-[11px] font-semibold shadow-sm dark:bg-slate-950/60"
      aria-label={aria}
      disabled={disabled || busy}
      data-export-ignore
      onClick={() => {
        void onPng();
      }}
    >
      <ImageIcon className="size-3.5" aria-hidden />
      {label}
      {busy ? "…" : ""}
    </Button>
  );
}
