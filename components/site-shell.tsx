"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Monitor, Moon, Sun } from "lucide-react";
import BessAiChatOverlay from "@/components/BessAiChatOverlay";
import { AetherLogo } from "@/components/AetherLogo";
import { XLogo } from "@/components/XLogo";
import { AppLanguage, LanguageContext } from "@/components/language-context";

type SiteShellProps = {
  children: React.ReactNode;
};

type ThemePreference = "light" | "dark" | "system";

function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    if (typeof window === "undefined") {
      return "dark";
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

function readThemePreferenceFromStorage(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }
  const stored = window.localStorage.getItem("aether-theme");
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

export function SiteShell({ children }: SiteShellProps) {
  /** Must stay `system` on server + first client paint to avoid hydration mismatch; sync from storage after mount. */
  const [themePref, setThemePref] = useState<ThemePreference>("system");
  const [mounted, setMounted] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeedPrompt, setChatSeedPrompt] = useState<string | null>(null);
  const [language, setLanguage] = useState<AppLanguage>("en");

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setThemePref(readThemePreferenceFromStorage());
      setMounted(true);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const resolved = resolveTheme(themePref);
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved === "dark" ? "dark" : "light";
    window.localStorage.setItem("aether-theme", themePref);
  }, [themePref]);

  useEffect(() => {
    if (themePref !== "system") {
      return undefined;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const root = document.documentElement;
      const r = mq.matches ? "dark" : "light";
      root.classList.toggle("dark", r === "dark");
      root.style.colorScheme = r;
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [themePref]);

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

  const resolved = mounted ? resolveTheme(themePref) : "dark";

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      <div className="relative min-h-screen overflow-x-hidden bg-[radial-gradient(ellipse_at_top,_rgba(16,185,129,0.08),_transparent_55%),radial-gradient(ellipse_at_bottom,_rgba(244,63,94,0.05),_transparent_50%)] dark:bg-[radial-gradient(ellipse_at_top,_rgba(16,185,129,0.12),_transparent_50%),radial-gradient(ellipse_at_bottom,_rgba(244,63,94,0.07),_transparent_45%),var(--background)]">
        <header className="fixed inset-x-0 top-0 z-[1200] border-b border-border/60 bg-background/85 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
          <nav className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-5 py-3.5 lg:px-12">
            <Link href="/" className="group flex min-w-0 items-center gap-3">
              <AetherLogo size={36} className="shrink-0 shadow-[0_12px_28px_rgba(16,185,129,0.18)]" />
              <div className="min-w-0">
                <p className="truncate text-lg tracking-[0.04em] text-foreground [font-family:var(--font-heading)]">
                  AETHER
                </p>
                <p className="truncate text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                  {language === "de"
                    ? "Tagesbriefing · Deutschland"
                    : "Daily briefing · Germany"}
                </p>
              </div>
            </Link>
            <div className="hidden items-center gap-1 text-xs md:flex">
              <a
                href="#overview"
                className="rounded-full px-3 py-2 text-muted-foreground transition hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-200"
              >
                {language === "de" ? "Briefing" : "Briefing"}
              </a>
              <a
                href="#germany-day-energy-flow"
                className="rounded-full px-3 py-2 text-muted-foreground transition hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-200"
              >
                {language === "de" ? "Profil" : "Profile"}
              </a>
              <Link
                href="/news"
                className="rounded-full px-3 py-2 text-muted-foreground transition hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-200"
              >
                {language === "de" ? "News" : "News"}
              </Link>
              <button
                type="button"
                onClick={() => setChatOpen(true)}
                className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 font-medium text-emerald-800 shadow-sm transition hover:-translate-y-px hover:bg-emerald-500/15 dark:border-emerald-400/25 dark:text-emerald-100"
              >
                {language === "de" ? "Analyst-KI" : "Analyst AI"}
              </button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <div className="inline-flex items-center rounded-full border border-border/80 bg-card/80 p-1 shadow-inner">
                <button
                  type="button"
                  onClick={() => setLanguage("en")}
                  className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase transition ${
                    language === "en"
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  aria-label="Switch website language to English"
                  aria-pressed={language === "en"}
                >
                  EN
                </button>
                <button
                  type="button"
                  onClick={() => setLanguage("de")}
                  className={`rounded-full px-2.5 py-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase transition ${
                    language === "de"
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  aria-label="Switch website language to German"
                  aria-pressed={language === "de"}
                >
                  DE
                </button>
              </div>
              <div
                className="flex items-center rounded-full border border-border/80 bg-card/80 p-1 shadow-inner"
                role="group"
                aria-label={language === "de" ? "Farbschema" : "Color theme"}
              >
                {(
                  [
                    { key: "system" as const, icon: Monitor, label: "Auto" },
                    { key: "light" as const, icon: Sun, label: "" },
                    { key: "dark" as const, icon: Moon, label: "" },
                  ] as const
                ).map(({ key, icon: Icon, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setThemePref(key)}
                    className={`inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground ${
                      themePref === key ? "bg-foreground/10 text-foreground shadow-inner" : ""
                    }`}
                    title={
                      key === "system"
                        ? language === "de"
                          ? "System"
                          : "System"
                        : key === "light"
                          ? "Light"
                          : "Dark"
                    }
                    aria-pressed={themePref === key}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {label ? <span className="sr-only">{label}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          </nav>
        </header>

        <main className="pt-[76px] md:pt-[84px]">{children}</main>
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

        <footer className="border-t border-border/50 bg-card/30 backdrop-blur-sm">
          <div className="mx-auto grid max-w-7xl gap-8 px-6 py-10 text-sm text-muted-foreground md:grid-cols-3 md:gap-10 lg:px-12">
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-foreground uppercase">
                {language === "de" ? "Quellen" : "Sources"}
              </p>
              <ul className="mt-3 space-y-2">
                <li>
                  <a
                    href="https://energy-charts.info/"
                    className="font-medium text-emerald-700 hover:underline dark:text-emerald-300"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Energy-Charts.info
                  </a>{" "}
                  (API)
                </li>
                <li>
                  <a
                    href="https://www.ise.fraunhofer.de/"
                    className="hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Fraunhofer ISE
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-foreground uppercase">
                {language === "de" ? "Hinweis" : "Notice"}
              </p>
              <p className="mt-3 leading-relaxed">
                {language === "de"
                  ? "Illustrative Modelle — keine Beschaffungs- oder Anlagenberatung."
                  : "Illustrative models — not procurement or plant advice."}
              </p>
            </div>
            <div className="md:text-right">
              <p className="text-xs font-semibold tracking-[0.2em] text-foreground uppercase">AETHER</p>
              <p className="mt-3">
                {language === "de" ? "Portfolio-Demo · BESS Sales Engineering" : "Portfolio demo · BESS sales engineering"}
              </p>
              {process.env.NEXT_PUBLIC_X_SITE_HANDLE ? (
                <a
                  href={`https://x.com/${process.env.NEXT_PUBLIC_X_SITE_HANDLE.replace(/^@/, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center justify-end gap-2 text-sm font-medium text-foreground/90 transition hover:text-emerald-400"
                >
                  <XLogo className="size-4" />
                  {language === "de" ? "AETHER auf X" : "AETHER on X"}
                </a>
              ) : null}
              <p className="mt-4 text-xs opacity-80">
                {mounted
                  ? language === "de"
                    ? `Erscheinungsbild: ${resolved === "dark" ? "Dunkel" : "Hell"}`
                    : `Theme: ${resolved}`
                  : ""}
              </p>
            </div>
          </div>
        </footer>
      </div>
    </LanguageContext.Provider>
  );
}
