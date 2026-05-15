"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Sparkles, X } from "lucide-react";
import { useLanguage } from "@/components/language-context";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type BessAiChatOverlayProps = {
  open: boolean;
  onClose: () => void;
  seedPrompt?: string | null;
};

export default function BessAiChatOverlay({
  open,
  onClose,
  seedPrompt,
}: BessAiChatOverlayProps) {
  const { language } = useLanguage();
  const starterMessageContent =
    language === "de"
      ? "Ich bin Ihr BESS-Assistent. Fragen Sie mich zu Auslegung, deutschen Marktsignalen, Risiken oder Entscheidungs-Trade-offs aus Ihrem Assessment."
      : "I am your BESS assistant. Ask me anything about sizing, Germany market signals, risk, or decision trade-offs from your assessment.";
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: starterMessageContent,
    },
  ]);
  const [input, setInput] = useState(seedPrompt ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestions =
    language === "de"
      ? [
          "Wie wirkt sich die Restlast heute auf BESS aus?",
          "Sollte ich heute neue Kapazität planen?",
          "Welche Risiken sind für den heutigen Dispatch am wichtigsten?",
          "Welche nächste Maßnahme hat aktuell den größten Hebel?",
        ]
      : [
          "How does today's residual load impact BESS value?",
          "Should I plan new capacity today?",
          "Which risks matter most for today's dispatch?",
          "What next action has the biggest impact now?",
        ];

  const scrollToBottom = () => {
    if (!viewportRef.current) {
      return;
    }
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPosition = body.style.position;
    const previousWidth = body.style.width;
    const previousTop = body.style.top;
    const scrollY = window.scrollY;

    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.width = "100%";
    body.style.top = `-${scrollY}px`;

    return () => {
      body.style.overflow = previousOverflow;
      body.style.position = previousPosition;
      body.style.width = previousWidth;
      body.style.top = previousTop;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !viewportRef.current) {
      return;
    }
    scrollToBottom();
  }, [messages, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    const onViewportChange = () => {
      requestAnimationFrame(scrollToBottom);
    };
    viewport.addEventListener("resize", onViewportChange);
    viewport.addEventListener("scroll", onViewportChange);
    return () => {
      viewport.removeEventListener("resize", onViewportChange);
      viewport.removeEventListener("scroll", onViewportChange);
    };
  }, [open]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = input.trim();
    if (!next || sending) {
      return;
    }

    const userMessage: ChatMessage = { role: "user", content: next };
    const optimisticMessages = [...messages, userMessage];
    setMessages(optimisticMessages);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const response = await fetch("/api/assessment/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: optimisticMessages.slice(1),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payload?.message ?? `Request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as { reply: string };
      setMessages((current) => current.concat({ role: "assistant", content: payload.reply }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : language === "de" ? "Unbekannter Fehler" : "Unknown error");
    } finally {
      setSending(false);
    }
  };

  const applySuggestion = (value: string) => {
    setInput(value);
    setError(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      scrollToBottom();
    });
  };

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[1300] overscroll-none bg-slate-950/45 backdrop-blur-md">
      <div className="flex h-full w-full touch-pan-y items-center justify-center p-3 sm:p-6">
        <div className="flex h-[min(860px,100%)] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-300/65 bg-[#f9f8f6] shadow-[0_30px_80px_rgba(15,23,42,0.24)] dark:border-slate-500/35 dark:bg-slate-950">
        <div className="flex items-start justify-between border-b border-slate-300/60 bg-white/80 px-5 py-4 dark:border-slate-500/35 dark:bg-slate-900/65 sm:px-7 sm:py-5">
          <div>
            <p className="inline-flex items-center gap-2 text-xs tracking-[0.16em] text-primary uppercase dark:text-emerald-200">
              <Sparkles className="h-3.5 w-3.5" />
              SpeicherPilot Chat
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">
              {language === "de" ? "BESS-Entscheidungen mit mehr Klarheit" : "BESS decisions with more clarity"}
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {language === "de"
                ? "Fragen Sie zu Auslegung, Marktsignalen, Risiken und konkreten nächsten Schritten."
                : "Ask about sizing, market signals, risks, and concrete next steps."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300/70 bg-white/90 text-slate-700 transition hover:border-primary/45 hover:text-primary dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-emerald-200/50 dark:hover:text-emerald-200"
            aria-label={language === "de" ? "BESS-Chat schließen" : "Close BESS chat"}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-slate-300/50 bg-white/70 px-5 py-4 dark:border-slate-500/35 dark:bg-slate-900/45 sm:px-7">
          <div className="flex flex-wrap gap-2.5">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => applySuggestion(suggestion)}
                className="rounded-full border border-slate-300/70 bg-white px-3.5 py-2 text-xs text-slate-700 transition hover:border-primary/50 hover:text-primary dark:border-slate-500/50 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-emerald-200/50 dark:hover:text-emerald-100"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        <div ref={viewportRef} className="flex-1 space-y-5 overflow-y-auto overscroll-contain bg-transparent px-5 py-6 sm:px-7 sm:py-7">
          {messages.map((message, idx) => (
            <div
              key={`${message.role}-${idx}`}
              className={`max-w-3xl rounded-2xl border px-4 py-3 text-sm shadow-[0_8px_18px_rgba(15,23,42,0.06)] ${
                message.role === "assistant"
                  ? "border-slate-300/60 bg-white/95 text-slate-800 dark:border-slate-600/50 dark:bg-slate-900/80 dark:text-slate-100"
                  : "ml-auto border-primary/45 bg-primary/95 text-white dark:border-emerald-200/50 dark:bg-emerald-700/85"
              }`}
            >
              <p className="mb-1 text-[11px] tracking-[0.1em] uppercase opacity-75">
                {message.role === "assistant" ? "SpeicherPilot" : language === "de" ? "Sie" : "You"}
              </p>
              <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
            </div>
          ))}
          {sending ? (
            <p className="text-sm text-slate-500 dark:text-slate-300">{language === "de" ? "KI denkt nach..." : "AI is thinking..."}</p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-red-400/45 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
              {error}
            </p>
          ) : null}
        </div>

        <form
          onSubmit={onSubmit}
          className="border-t border-slate-300/60 bg-white/85 px-4 pt-4 pb-[max(0.8rem,env(safe-area-inset-bottom))] dark:border-slate-500/35 dark:bg-slate-900/70 md:px-7 md:pt-5 md:pb-5"
        >
          <label htmlFor="bess-chat-input" className="sr-only">
            {language === "de" ? "BESS-Frage stellen" : "Ask a BESS question"}
          </label>
          <div className="flex items-end gap-3">
            <input
              ref={inputRef}
              id="bess-chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onFocus={() => {
                requestAnimationFrame(scrollToBottom);
              }}
              placeholder={
                language === "de"
                  ? "Stellen Sie eine Frage zu Auslegung, Risiken, Vermarktung oder zur nächsten besten Entscheidung..."
                  : "Ask about sizing, risks, market timing, or the next best decision..."
              }
              className="flex-1 rounded-2xl border border-slate-300/70 bg-white px-5 py-4 text-base text-slate-900 outline-none transition placeholder:text-slate-500 focus:border-primary/50 focus:shadow-[0_0_0_4px_rgba(13,148,136,0.11)] dark:border-slate-500/50 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-400"
            />
            <button
              type="submit"
              disabled={sending || input.trim().length === 0}
              className="inline-flex h-14 items-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(15,118,110,0.35)] transition hover:-translate-y-0.5 hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {language === "de" ? "Senden" : "Send"}
              <ArrowUpRight className="h-4 w-4" />
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  );
}
