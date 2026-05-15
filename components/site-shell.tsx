"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Monitor, Moon, Sparkles, Sun } from "lucide-react";
import BessAiChatOverlay from "@/components/BessAiChatOverlay";
import { SpeicherPilotLogo } from "@/components/SpeicherPilotLogo";
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
  const stored =
    window.localStorage.getItem("speicherpilot-theme") ?? window.localStorage.getItem("bessforge-theme");
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
  const pathname = usePathname();
  const onHome = pathname === "/";
  const onNews = pathname?.startsWith("/news") ?? false;
  /** Always use path + hash so Next.js `Link` and cross-route jumps behave consistently. */
  const sectionHref = (id: string) => `/#${id}`;
  const [routeHash, setRouteHash] = useState("");

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
    window.localStorage.setItem("speicherpilot-theme", themePref);
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
    window.localStorage.setItem("speicherpilot-language", language);
  }, [language]);

  useEffect(() => {
    const syncFromLocation = () => {
      queueMicrotask(() => {
        setRouteHash(window.location.hash);
      });
    };
    syncFromLocation();
    window.addEventListener("hashchange", syncFromLocation);
    return () => window.removeEventListener("hashchange", syncFromLocation);
  }, [pathname]);

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
    window.addEventListener("speicherpilot:open-ai-chat", handleOpen);
    return () => {
      window.removeEventListener("hashchange", openFromHash);
      window.removeEventListener("speicherpilot:open-ai-chat", handleOpen);
    };
  }, []);

  const resolved = mounted ? resolveTheme(themePref) : "dark";

  const briefingActive =
    onHome &&
    (routeHash === "" ||
      routeHash === "#speicherpilot-briefing-root" ||
      routeHash === "#bessforge-briefing-root" ||
      routeHash === "#overview");
  const flowActive = onHome && routeHash === "#germany-day-energy-flow";

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      <div className="relative min-h-screen overflow-x-hidden bg-background dark:bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,rgba(16,185,129,0.14),transparent_52%),radial-gradient(ellipse_100%_60%_at_50%_120%,rgba(244,63,94,0.08),transparent_48%),var(--background)]">
        {/*
          Header — premium glass surface.
          - Ultra-thin border + soft shadow + 1px inset highlight create separation
            from the canvas without any hard line.
          - Tight, single-row balance: brand · primary nav · controls.
        */}
        <header
          className="fixed inset-x-0 top-0 z-[1200] border-b border-border/45 bg-background/85 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/65 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_10px_30px_-18px_rgba(2,6,23,0.55)] dark:border-white/[0.06] dark:bg-[rgba(7,11,20,0.72)] dark:supports-[backdrop-filter]:bg-[rgba(7,11,20,0.55)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_14px_36px_-20px_rgba(0,0,0,0.85)]"
        >
          <nav className="relative mx-auto grid h-16 w-full max-w-7xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-5 lg:h-[68px] lg:gap-6 lg:px-12">
            {/* Brand — logo + wordmark + tagline, baseline-aligned */}
            <Link
              href="/"
              className="group flex min-w-0 items-center gap-2 sm:gap-3"
              aria-label="SpeicherPilot home"
            >
              <SpeicherPilotLogo
                size={34}
                className="shrink-0 transition-transform duration-300 ease-out group-hover:scale-[1.04] shadow-[0_10px_28px_-8px_rgba(16,185,129,0.45)]"
              />
              <div className="flex min-w-0 items-baseline gap-2.5">
                <span className="truncate text-[17px] font-medium leading-none tracking-[0.18em] text-foreground [font-family:var(--font-heading)]">
                  SpeicherPilot
                </span>
                <span
                  className="hidden h-3.5 w-px bg-border/70 dark:bg-white/10 sm:inline-block"
                  aria-hidden
                />
                <span className="hidden truncate text-[10.5px] font-medium leading-none tracking-[0.22em] text-muted-foreground/80 uppercase sm:inline">
                  {language === "de" ? "BESS Planning & Dispatch Simulator" : "BESS Planning & Dispatch Simulator"}
                </span>
              </div>
            </Link>

            {/* Primary nav — centered column; scrolls on very narrow viewports */}
            <div className="col-start-2 flex max-w-[min(100%,52vw)] items-center justify-center gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] sm:max-w-none lg:gap-1 [&::-webkit-scrollbar]:hidden">
              <NavItem
                href={sectionHref("speicherpilot-briefing-root")}
                active={briefingActive}
                label={language === "de" ? "Briefing" : "Briefing"}
              />
              <NavItem
                href={sectionHref("germany-day-energy-flow")}
                active={flowActive}
                label={language === "de" ? "Tagesprofil" : "Day profile"}
              />
              <NavItem href="/news" active={onNews} label="News" />
              <button
                type="button"
                onClick={() => setChatOpen(true)}
                className="ml-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-gradient-to-b from-emerald-500/[0.10] to-emerald-500/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-emerald-900 shadow-[0_1px_0_0_rgba(255,255,255,0.5)_inset,0_6px_18px_-8px_rgba(16,185,129,0.55)] transition-all duration-200 hover:-translate-y-px hover:border-emerald-500/60 hover:from-emerald-500/[0.16] hover:to-emerald-500/[0.08] active:translate-y-0 sm:ml-1 sm:gap-1.5 sm:px-3.5 sm:text-[12.5px] dark:border-emerald-400/35 dark:text-emerald-100 dark:shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset,0_8px_22px_-10px_rgba(16,185,129,0.6)] dark:hover:border-emerald-400/55"
              >
                <Sparkles className="size-3 -translate-y-px text-emerald-600 sm:size-3.5 dark:text-emerald-300" aria-hidden />
                <span className="hidden sm:inline">{language === "de" ? "Analyst-KI" : "Analyst AI"}</span>
                <span className="sm:hidden">AI</span>
              </button>
            </div>

            {/* Right cluster — language + theme, balanced and quiet */}
            <div className="flex items-center justify-end gap-1.5 sm:gap-2">
              <div
                className="inline-flex items-center rounded-full border border-border/60 bg-card/40 p-0.5 dark:border-white/[0.08] dark:bg-white/[0.03]"
                role="group"
                aria-label={language === "de" ? "Sprache" : "Language"}
              >
                {(["en", "de"] as const).map((code) => {
                  const active = language === code;
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => setLanguage(code)}
                      className={`rounded-full px-2.5 py-1 text-[10.5px] font-semibold tracking-[0.08em] uppercase transition-colors ${
                        active
                          ? "bg-foreground text-background shadow-[0_1px_0_0_rgba(255,255,255,0.35)_inset]"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      aria-label={
                        code === "en"
                          ? "Switch website language to English"
                          : "Switch website language to German"
                      }
                      aria-pressed={active}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>

              <span
                className="hidden h-5 w-px bg-border/60 dark:bg-white/[0.08] md:inline-block"
                aria-hidden
              />

              <div
                className="inline-flex items-center rounded-full border border-border/60 bg-card/40 p-0.5 dark:border-white/[0.08] dark:bg-white/[0.03]"
                role="group"
                aria-label={language === "de" ? "Farbschema" : "Color theme"}
              >
                {(
                  [
                    { key: "system" as const, icon: Monitor, label: language === "de" ? "System" : "System" },
                    { key: "light" as const, icon: Sun, label: language === "de" ? "Hell" : "Light" },
                    { key: "dark" as const, icon: Moon, label: language === "de" ? "Dunkel" : "Dark" },
                  ] as const
                ).map(({ key, icon: Icon, label }) => {
                  const active = themePref === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setThemePref(key)}
                      className={`inline-flex size-7 items-center justify-center rounded-full transition-colors ${
                        active
                          ? "bg-foreground/[0.08] text-foreground dark:bg-white/[0.08] dark:text-white"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      title={label}
                      aria-pressed={active}
                    >
                      <Icon className="size-3.5" aria-hidden />
                      <span className="sr-only">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </nav>
        </header>

        <main className="pt-16 lg:pt-[68px]">{children}</main>
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

        <footer className="border-t border-border/40 bg-card/40 backdrop-blur-sm">
          <div className="mx-auto grid max-w-7xl gap-6 px-5 py-8 text-sm text-muted-foreground md:grid-cols-3 md:gap-8 md:px-8 lg:px-12">
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-foreground uppercase">
                {language === "de" ? "Quellen" : "Sources"}
              </p>
              <ul className="mt-2 space-y-1.5">
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
                <li>
                  <a
                    href={language === "de" ? "https://www.netztransparenz.de/de-de/WebAPI" : "https://www.netztransparenz.de/en/WebAPI"}
                    className="hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Netztransparenz.de
                  </a>{" "}
                  {language === "de" ? "(Abregelung / Redispatch)" : "(Curtailment / redispatch)"}
                </li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-foreground uppercase">
                {language === "de" ? "Hinweis" : "Notice"}
              </p>
              <p className="mt-2 leading-relaxed">
                {language === "de"
                  ? "Illustrative Modelle — keine Beschaffungs- oder Anlagenberatung."
                  : "Illustrative models — not procurement or plant advice."}
              </p>
            </div>
            <div className="md:text-right">
              <p className="text-xs font-semibold tracking-[0.2em] text-foreground uppercase">SpeicherPilot</p>
              <p className="mt-2">
                {language === "de"
                  ? "BESS Planning & Dispatch Simulator"
                  : "BESS Planning & Dispatch Simulator"}
              </p>
              {process.env.NEXT_PUBLIC_X_SITE_HANDLE ? (
                <a
                  href={`https://x.com/${process.env.NEXT_PUBLIC_X_SITE_HANDLE.replace(/^@/, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center justify-end gap-2 text-sm font-medium text-foreground/90 transition hover:text-emerald-400"
                >
                  <XLogo className="size-4" />
                  {language === "de" ? "SpeicherPilot auf X" : "SpeicherPilot on X"}
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

type NavItemProps = {
  href: string;
  label: string;
  active: boolean;
};

/**
 * Premium top-nav item.
 * - Quiet hover state (subtle emerald wash).
 * - Active state is unmistakable: tinted background + emerald text + a tiny
 *   accent dot underneath, recalling Bloomberg-style "current section" cues.
 */
function NavItem({ href, label, active }: NavItemProps) {
  const className = `relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-1.5 text-[11px] font-medium transition-colors duration-200 sm:px-3 sm:text-[12.5px] ${
    active
      ? "bg-emerald-500/[0.10] text-emerald-700 dark:bg-emerald-400/[0.12] dark:text-emerald-100"
      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground dark:hover:bg-white/[0.04]"
  }`;
  const content = (
    <>
      {label}
      {active ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.85)] dark:bg-emerald-400"
        />
      ) : null}
    </>
  );

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return (
      <a href={href} className={className} aria-current={active ? "page" : undefined}>
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={className} aria-current={active ? "page" : undefined} scroll={!href.includes("#")}>
      {content}
    </Link>
  );
}
