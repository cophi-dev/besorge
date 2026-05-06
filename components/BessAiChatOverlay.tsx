"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type BessAiChatOverlayProps = {
  open: boolean;
  onClose: () => void;
};

const starterMessage: ChatMessage = {
  role: "assistant",
  content:
    "I am your BESS assistant. Ask me anything about sizing, Germany market signals, risk, or decision trade-offs from your assessment.",
};

export default function BessAiChatOverlay({ open, onClose }: BessAiChatOverlayProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([starterMessage]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

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
    if (!open || !viewportRef.current) {
      return;
    }
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [messages, open]);

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
      setError(caught instanceof Error ? caught.message : "Unknown error");
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950/75 backdrop-blur-sm">
      <div className="flex h-full w-full flex-col bg-white dark:bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-300/60 px-5 py-4 dark:border-slate-500/35">
          <div>
            <p className="text-xs tracking-[0.18em] text-blue-600 uppercase dark:text-blue-300">
              BESSForge AI chat
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
              Let&apos;s talk about your BESS decision
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300/70 text-slate-700 transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-500/40 dark:text-slate-200 dark:hover:border-blue-300 dark:hover:text-blue-200"
            aria-label="Close BESS chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div ref={viewportRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5 md:px-8">
          {messages.map((message, idx) => (
            <div
              key={`${message.role}-${idx}`}
              className={`max-w-4xl rounded-2xl border px-4 py-3 text-sm ${
                message.role === "assistant"
                  ? "border-slate-300/60 bg-slate-100/70 text-slate-800 dark:border-slate-600/50 dark:bg-slate-900/75 dark:text-slate-100"
                  : "ml-auto border-blue-400/55 bg-blue-500/10 text-slate-900 dark:text-blue-100"
              }`}
            >
              <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
            </div>
          ))}
          {sending ? (
            <p className="text-sm text-slate-500 dark:text-slate-300">AI is thinking...</p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-red-400/45 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
              {error}
            </p>
          ) : null}
        </div>

        <form onSubmit={onSubmit} className="border-t border-slate-300/60 p-4 dark:border-slate-500/35 md:px-8">
          <label htmlFor="bess-chat-input" className="sr-only">
            Ask a BESS question
          </label>
          <div className="flex gap-3">
            <input
              id="bess-chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask about sizing, drivers, risks, or next actions..."
              className="flex-1 rounded-xl border border-slate-300/70 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-blue-400 dark:border-slate-500/50 dark:bg-slate-900 dark:text-slate-100"
            />
            <button
              type="submit"
              disabled={sending || input.trim().length === 0}
              className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
