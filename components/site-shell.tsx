"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";

type SiteShellProps = {
  children: React.ReactNode;
};

export function SiteShell({ children }: SiteShellProps) {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") {
      return "dark";
    }
    const stored = window.localStorage.getItem("bessforge-theme");
    if (stored === "light" || stored === "dark") {
      return stored;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark");
    if (theme === "dark") {
      root.classList.add("dark");
    }
    root.style.colorScheme = theme;
    window.localStorage.setItem("bessforge-theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <header className="sticky top-0 z-40 border-b border-slate-300/60 bg-white/65 backdrop-blur-xl dark:border-slate-500/30 dark:bg-slate-950/55">
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4 lg:px-10">
          <Link href="/" className="group flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
            <span className="text-base font-semibold tracking-[0.18em] text-slate-900 dark:text-white">
              BESSForge
            </span>
          </Link>
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

      <main>
        {children}
      </main>

      <footer className="border-t border-slate-300/60 bg-white/45 dark:border-slate-500/30 dark:bg-slate-950/45">
        <div className="mx-auto max-w-7xl px-6 py-6 text-center text-sm text-slate-600 dark:text-slate-300 lg:px-10">
          Built to support Tesla BESS project planning
        </div>
      </footer>
    </div>
  );
}
