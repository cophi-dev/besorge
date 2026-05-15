import Script from "next/script";

const SCRIPT = `
(() => {
  try {
    const STORAGE = "speicherpilot-theme";
    const LEGACY = "bessforge-theme";
    const root = document.documentElement;
    const stored = localStorage.getItem(STORAGE) ?? localStorage.getItem(LEGACY);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved =
      stored === "light" || stored === "dark"
        ? stored
        : stored === "system" || stored === null
          ? prefersDark
            ? "dark"
            : "light"
          : prefersDark
            ? "dark"
            : "light";
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved === "dark" ? "dark" : "light";
  } catch {
    /* ignore */
  }
})();`;

export function ThemeInitScript() {
  return <Script id="speicherpilot-theme-init" strategy="afterInteractive" dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
