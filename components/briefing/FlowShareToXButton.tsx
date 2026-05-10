"use client";

import { Copy, Loader2, Share2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { z } from "zod";

import { Button, buttonVariants } from "@/components/ui/button";
import type { FlowShareCaptionApiResponse, FlowSharePayload } from "@/lib/flowSharePayload";
import { createLogger } from "@/lib/debug";
import { cn } from "@/lib/utils";

const log = createLogger("flow-share-to-x");

const apiResponseShape = z.object({
  source: z.enum(["llm", "fallback_numeric"]),
  postText: z.string(),
});

type FlowShareToXButtonProps = {
  language: "en" | "de";
  /** Region that includes KPIs + chart for a single shareable raster. */
  socialCaptureElementId: string;
  payload: FlowSharePayload | null;
};

const LABELS = {
  en: {
    shareBtn: "Share",
    headline: "Share snapshot",
    sub: "Suggested post copy (editable). Attach the poster PNG in X yourself.",
    postLabel: "Post text",
    copy: "Copy text",
    openX: "Open X compose",
    downloadPng: "Download poster (PNG)",
    loading: "Drafting caption…",
    close: "Close",
    clipboardOk: "Copied",
    clipboardFail: "Copy failed",
    error: "Could not generate caption. You can still download the image.",
    disabled: "No data",
    sourceLlm: "Caption: LLM draft",
    sourceFallback: "Caption: deterministic (model offline)",
  },
  de: {
    shareBtn: "Teilen",
    headline: "Snapshot teilen",
    sub: "Vorschlag fuer den Post (anpassbar). Das Poster-PNG in X manuell anhaengen.",
    postLabel: "Post-Text",
    copy: "Text kopieren",
    openX: "In X komponieren",
    downloadPng: "Poster (PNG) herunterladen",
    loading: "Text wird erstellt…",
    close: "Schliessen",
    clipboardOk: "Kopiert",
    clipboardFail: "Kopieren fehlgeschlagen",
    error: "Text konnte nicht erzeugt werden. PNG-Export bleibt moeglich.",
    disabled: "Keine Daten",
    sourceLlm: "Text: KI-Entwurf",
    sourceFallback: "Text: deterministisch (Offline)",
  },
};

export function FlowShareToXButton({ language, socialCaptureElementId, payload }: FlowShareToXButtonProps) {
  const reactId = useId();
  const titleId = `flow-share-title-${reactId}`;
  const t = LABELS[language];

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "caption" | "png">(null);
  const [postText, setPostText] = useState("");
  const [source, setSource] = useState<FlowShareCaptionApiResponse["source"] | null>(null);
  const [copyToast, setCopyToast] = useState<null | "ok" | "fail">(null);
  const [captionError, setCaptionError] = useState<string | null>(null);

  const disabled = payload === null;

  const runShareCaption = useCallback(async () => {
    if (!payload) {
      return;
    }
    setBusy("caption");
    setCaptionError(null);
    try {
      const res = await fetch("/api/briefing/flow-share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json: unknown = await res.json();
      const out: FlowShareCaptionApiResponse = apiResponseShape.parse(json);
      setPostText(out.postText);
      setSource(out.source);
    } catch (e) {
      log("caption fetch failed %o", { error: e });
      setCaptionError(t.error);
      setPostText("");
      setSource(null);
    } finally {
      setBusy(null);
    }
  }, [payload, t.error]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setOpen(false);
      }
    };
    if (open) {
      window.addEventListener("keydown", onKey);
    }
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onDownloadSocialPng = useCallback(async () => {
    const el = document.getElementById(socialCaptureElementId);
    if (!el) {
      log("social capture missing %s", socialCaptureElementId);
      return;
    }
    setBusy("png");
    try {
      const { toPng } = await import("html-to-image");
      const dateKey = payload?.dateBerlin ?? "germany";
      const dataUrl = await toPng(el, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor:
          typeof document !== "undefined" && document.documentElement.classList.contains("dark")
            ? "#0c1220"
            : "#ffffff",
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `aether-de-poster-${dateKey}.png`;
      a.click();
    } catch (error) {
      log("social png export failed %o", { error });
    } finally {
      setBusy(null);
    }
  }, [socialCaptureElementId, payload]);

  const onCopy = async () => {
    if (!postText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(postText);
      setCopyToast("ok");
      window.setTimeout(() => setCopyToast(null), 2_500);
    } catch {
      setCopyToast("fail");
      window.setTimeout(() => setCopyToast(null), 2_500);
    }
  };

  const xIntentHref =
    typeof postText === "string" && postText.length > 0
      ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(postText)}`
      : undefined;

  const copyLabel =
    copyToast === "ok" ? t.clipboardOk : copyToast === "fail" ? t.clipboardFail : t.copy;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={disabled || busy !== null}
        onClick={() => {
          setCopyToast(null);
          setCaptionError(null);
          setPostText("");
          setSource(null);
          setOpen(true);
          void runShareCaption();
        }}
        className="h-8 gap-1.5 text-[11px]"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Share2 className="size-3.5" aria-hidden />
        {disabled ? t.disabled : t.shareBtn}
      </Button>

      {open ? (
        <div
          role="presentation"
          className="fixed inset-0 z-[1450] cursor-default bg-black/45 p-3 sm:flex sm:items-center sm:justify-center"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal
            aria-labelledby={titleId}
            className="pointer-events-auto max-h-[min(92vh,720px)] w-full max-w-lg cursor-auto overflow-y-auto rounded-2xl border border-border bg-card p-4 text-left shadow-xl dark:border-slate-600 dark:bg-slate-950 sm:mx-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p id={titleId} className="text-base font-semibold text-foreground [font-family:var(--font-heading)]">
                  {t.headline}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{t.sub}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:bg-muted hover:text-foreground"
              >
                {t.close}
              </button>
            </div>

            {source !== null ? (
              <p className="mt-3 text-[10px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                {source === "llm" ? t.sourceLlm : t.sourceFallback}
              </p>
            ) : null}

            {busy === "caption" ? (
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                {t.loading}
              </div>
            ) : null}

            {captionError ? <p className="mt-3 text-xs text-amber-800 dark:text-amber-100">{captionError}</p> : null}

            <label className="mt-4 block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t.postLabel}</span>
              <textarea
                value={busy === "caption" ? `${t.loading} …` : postText}
                onChange={(ev) => setPostText(ev.target.value)}
                readOnly={busy === "caption"}
                rows={busy === "caption" ? 2 : 8}
                className="mt-1.5 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground shadow-inner outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:opacity-70 dark:border-slate-600 dark:bg-slate-900"
              />
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={busy !== null || postText.trim().length < 8}
                onClick={() => {
                  void onCopy();
                }}
                className="h-8 gap-1 text-[11px]"
              >
                <Copy className="size-3.5 shrink-0" aria-hidden />
                {copyLabel}
              </Button>

              <a
                href={xIntentHref ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  buttonVariants({ variant: "outline", size: "xs" }),
                  "inline-flex h-8 text-[11px]",
                  busy !== null || !xIntentHref ? "pointer-events-none opacity-45" : ""
                )}
              >
                {t.openX}
              </a>

              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy !== null}
                className="h-8 gap-1 text-[11px]"
                onClick={() => {
                  void onDownloadSocialPng();
                }}
              >
                {busy === "png" ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    …
                  </>
                ) : (
                  t.downloadPng
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
