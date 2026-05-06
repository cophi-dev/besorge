"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";
import BessAiChatOverlay from "@/components/BessAiChatOverlay";
import { AppLanguage, LanguageContext } from "@/components/language-context";

type SiteShellProps = {
  children: React.ReactNode;
};

export function SiteShell({ children }: SiteShellProps) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeedPrompt, setChatSeedPrompt] = useState<string | null>(null);
  const [language, setLanguage] = useState<AppLanguage>("en");

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark");
    if (theme === "dark") {
      root.classList.add("dark");
    }
    root.style.colorScheme = theme;
    window.localStorage.setItem("aether-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
    window.localStorage.setItem("aether-language", language);
  }, [language]);

  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === "#ai-chat") {
        setChatOpen(true);
      }
    };
    const handleOpen = (event: Event) => {
      const customEvent = event as CustomEvent<{ prompt?: string }>;
      if (customEvent.detail?.prompt) {
        setChatSeedPrompt(customEvent.detail.prompt);
      }
      setChatOpen(true);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    window.addEventListener("aether:open-ai-chat", handleOpen);
    return () => {
      window.removeEventListener("hashchange", openFromHash);
      window.removeEventListener("aether:open-ai-chat", handleOpen);
    };
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      <div className="relative min-h-screen overflow-x-hidden">
      <header className="fixed inset-x-0 top-0 z-[1200] border-b border-slate-300/45 bg-[#f8f7f4]/95 backdrop-blur-xl dark:border-slate-500/35 dark:bg-slate-950/60">
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4 lg:px-12">
          <Link href="/" className="group flex items-center gap-3">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-primary/35 text-primary shadow-[0_6px_14px_rgba(15,118,110,0.12)]">
              <span className="h-3 w-3 rounded-full border border-current" />
            </span>
            <div>
              <p className="text-lg tracking-[0.02em] text-slate-900 [font-family:var(--font-heading)] dark:text-white">AETHER</p>
              <p className="text-[10px] tracking-[0.16em] text-slate-600 uppercase dark:text-slate-300">
                {language === "de"
                  ? "Klarheit für Deutschlands Energiewende"
                  : "Clarity for Germany&apos;s energy transition"}
              </p>
            </div>
          </Link>
          <div className="hidden items-center gap-1.5 text-xs md:flex">
            <a href="#overview" className="rounded-full px-3.5 py-2 text-slate-600 transition hover:bg-primary/10 hover:text-primary dark:text-slate-300 dark:hover:text-emerald-200">
              {language === "de" ? "Briefing" : "Briefing"}
            </a>
            <a href="#bess-value" className="rounded-full px-3.5 py-2 text-slate-600 transition hover:bg-primary/10 hover:text-primary dark:text-slate-300 dark:hover:text-emerald-200">
              {language === "de" ? "Signale" : "Insights"}
            </a>
            <a href="#ai-assessment" className="rounded-full px-3.5 py-2 text-slate-600 transition hover:bg-primary/10 hover:text-primary dark:text-slate-300 dark:hover:text-emerald-200">
              {language === "de" ? "Analysten-KI" : "Analyst AI"}
            </a>
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="rounded-full border border-primary/35 bg-primary/10 px-4 py-2 font-medium text-primary shadow-[0_6px_16px_rgba(15,118,110,0.16)] transition hover:-translate-y-0.5 hover:bg-primary/15 dark:border-emerald-200/25 dark:text-emerald-100"
            >
              {language === "de" ? "Chat öffnen" : "Open chat"}
            </button>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-slate-600 dark:text-slate-300 sm:inline">
              {language === "de" ? "Premium-Marktintelligenz" : "Premium market intelligence"}
            </span>
            <div className="inline-flex items-center rounded-full border border-slate-300/75 bg-white/95 p-1 shadow-[0_5px_14px_rgba(15,23,42,0.08)] dark:border-slate-500/45 dark:bg-slate-900/70">
              <button
                type="button"
                onClick={() => setLanguage("en")}
                className={`rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase transition ${
                  language === "en"
                    ? "bg-slate-900 text-white shadow-[0_4px_10px_rgba(15,23,42,0.2)] dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                }`}
                aria-label="Switch website language to English"
                aria-pressed={language === "en"}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => setLanguage("de")}
                className={`rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase transition ${
                  language === "de"
                    ? "bg-slate-900 text-white shadow-[0_4px_10px_rgba(15,23,42,0.2)] dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                }`}
                aria-label="Switch website language to German"
                aria-pressed={language === "de"}
              >
                DE
              </button>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300/75 bg-white/95 text-slate-700 shadow-[0_5px_14px_rgba(15,23,42,0.08)] transition hover:text-primary dark:border-slate-500/45 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:text-emerald-200"
              aria-label={language === "de" ? "Farbmodus wechseln" : "Toggle color theme"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-slate-300/75 bg-white/95 px-4 py-2 text-slate-700 shadow-[0_5px_14px_rgba(15,23,42,0.08)] transition hover:text-primary dark:border-slate-500/45 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:text-emerald-200"
            >
              GitHub
            </a>
          </div>
        </nav>
      </header>

      <main className="pt-[88px]">
        {children}
      </main>
      <BessAiChatOverlay
        open={chatOpen}
        onClose={() => {
          setChatOpen(false);
          setChatSeedPrompt(null);
          if (window.location.hash === "#ai-chat") {
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
          }
        }}
        seedPrompt={chatSeedPrompt}
      />

      <footer className="border-t border-slate-300/45 bg-[#f8f7f4] dark:border-slate-500/30 dark:bg-slate-950/45">
        <div className="mx-auto max-w-7xl px-8 py-8 text-center text-sm text-slate-600 dark:text-slate-300 lg:px-12">
          {language === "de"
            ? "AETHER Tagesbriefing für fundierte BESS-Entscheidungen"
            : "AETHER daily briefing for informed BESS decisions"}
        </div>
      </footer>
      </div>
    </LanguageContext.Provider>
  );
}
