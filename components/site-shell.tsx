"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";
import BessAiChatOverlay from "@/components/BessAiChatOverlay";

type SiteShellProps = {
  children: React.ReactNode;
};

export function SiteShell({ children }: SiteShellProps) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [chatOpen, setChatOpen] = useState(false);

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
    const openFromHash = () => {
      if (window.location.hash === "#ai-chat") {
        setChatOpen(true);
      }
    };
    const handleOpen = () => setChatOpen(true);
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
    <div className="relative min-h-screen overflow-x-hidden">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-slate-300/45 bg-[#f8f7f4]/92 backdrop-blur-lg dark:border-slate-500/35 dark:bg-slate-950/55">
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-8 py-5 lg:px-12">
          <Link href="/" className="group flex items-center gap-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-primary/40 text-primary">
              <span className="h-3 w-3 rounded-full border border-current" />
            </span>
            <div>
              <p className="text-lg text-slate-900 [font-family:var(--font-heading)] dark:text-white">AETHER</p>
              <p className="text-[10px] tracking-[0.14em] text-slate-600 uppercase dark:text-slate-300">
                Clarity for Germany&apos;s energy transition
              </p>
            </div>
          </Link>
          <div className="hidden items-center gap-2 text-xs md:flex">
            <a href="#overview" className="rounded-full px-3 py-1.5 text-slate-600 transition hover:bg-primary/10 hover:text-primary dark:text-slate-300 dark:hover:text-emerald-200">
              Briefing
            </a>
            <a href="#bess-value" className="rounded-full px-3 py-1.5 text-slate-600 transition hover:bg-primary/10 hover:text-primary dark:text-slate-300 dark:hover:text-emerald-200">
              Insights
            </a>
            <a href="#ai-assessment" className="rounded-full px-3 py-1.5 text-slate-600 transition hover:bg-primary/10 hover:text-primary dark:text-slate-300 dark:hover:text-emerald-200">
              Analyst AI
            </a>
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="rounded-full bg-primary/10 px-3 py-1.5 text-primary transition hover:bg-primary/15 dark:text-emerald-100"
            >
              Open Briefing Assistant
            </button>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-slate-600 dark:text-slate-300 sm:inline">Premium market intelligence</span>
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300/70 bg-white/90 text-slate-700 transition hover:text-primary dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:text-emerald-200"
              aria-label="Toggle color theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-slate-300/70 bg-white/90 px-4 py-2 text-slate-700 transition hover:text-primary dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:text-emerald-200"
            >
              GitHub
            </a>
          </div>
        </nav>
      </header>

      <main className="pt-[88px]">
        {children}
      </main>
      <BessAiChatOverlay open={chatOpen} onClose={() => setChatOpen(false)} />

      <footer className="border-t border-slate-300/45 bg-[#f8f7f4] dark:border-slate-500/30 dark:bg-slate-950/45">
        <div className="mx-auto max-w-7xl px-8 py-8 text-center text-sm text-slate-600 dark:text-slate-300 lg:px-12">
          AETHER daily briefing for informed BESS decisions
        </div>
      </footer>
    </div>
  );
}
