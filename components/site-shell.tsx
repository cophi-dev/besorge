"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";
import BessAiChatOverlay from "@/components/BessAiChatOverlay";

type SiteShellProps = {
  children: React.ReactNode;
};

export function SiteShell({ children }: SiteShellProps) {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark");
    if (theme === "dark") {
      root.classList.add("dark");
    }
    root.style.colorScheme = theme;
    window.localStorage.setItem("bessforge-theme", theme);
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
    window.addEventListener("bessforge:open-ai-chat", handleOpen);
    return () => {
      window.removeEventListener("hashchange", openFromHash);
      window.removeEventListener("bessforge:open-ai-chat", handleOpen);
    };
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-slate-300/60 bg-white/65 backdrop-blur-xl dark:border-slate-500/30 dark:bg-slate-950/55">
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4 lg:px-10">
          <Link href="/" className="group flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
            <span className="text-base font-semibold tracking-[0.18em] text-slate-900 dark:text-white">
              BESSForge
            </span>
          </Link>
          <div className="hidden items-center gap-2 text-xs md:flex">
            <a href="#bess-data" className="rounded-full px-3 py-1.5 text-slate-600 transition hover:bg-blue-500/10 hover:text-blue-600 dark:text-slate-300 dark:hover:text-blue-200">
              BESS data
            </a>
            <a href="#market-data" className="rounded-full px-3 py-1.5 text-slate-600 transition hover:bg-blue-500/10 hover:text-blue-600 dark:text-slate-300 dark:hover:text-blue-200">
              Energy
            </a>
            <a href="#ai-assessment" className="rounded-full px-3 py-1.5 text-slate-600 transition hover:bg-blue-500/10 hover:text-blue-600 dark:text-slate-300 dark:hover:text-blue-200">
              AI
            </a>
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="rounded-full border border-blue-400/60 bg-blue-500/10 px-3 py-1.5 text-blue-700 transition hover:border-blue-500 hover:bg-blue-500/15 dark:border-blue-300/50 dark:text-blue-100"
            >
              AI chat
            </button>
            <a href="#planning" className="rounded-full px-3 py-1.5 text-slate-600 transition hover:bg-blue-500/10 hover:text-blue-600 dark:text-slate-300 dark:hover:text-blue-200">
              Plan
            </a>
            <a href="#export" className="rounded-full px-3 py-1.5 text-slate-600 transition hover:bg-blue-500/10 hover:text-blue-600 dark:text-slate-300 dark:hover:text-blue-200">
              Export
            </a>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-slate-600 dark:text-slate-300 sm:inline">Tesla Energy tools</span>
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300/70 bg-white/70 text-slate-700 transition hover:border-blue-400 hover:text-blue-500 dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-blue-300 dark:hover:text-blue-200"
              aria-label="Toggle color theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-slate-300/70 bg-white/70 px-4 py-2 text-slate-700 transition hover:border-blue-400 hover:text-blue-600 dark:border-slate-500/40 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-blue-300 dark:hover:text-blue-200"
            >
              GitHub
            </a>
          </div>
        </nav>
      </header>

      <main className="pt-[76px]">
        {children}
      </main>
      <BessAiChatOverlay open={chatOpen} onClose={() => setChatOpen(false)} />

      <footer className="border-t border-slate-300/60 bg-white/45 dark:border-slate-500/30 dark:bg-slate-950/45">
        <div className="mx-auto max-w-7xl px-6 py-6 text-center text-sm text-slate-600 dark:text-slate-300 lg:px-10">
          Built to support Tesla BESS project planning
        </div>
      </footer>
    </div>
  );
}
