import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import "./globals.css";
import { SiteShell } from "@/components/site-shell";
import { ThemeInitScript } from "@/components/ThemeInitScript";
import { getPublicSiteOrigin } from "@/lib/publicSiteUrl";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
});

const siteOrigin = getPublicSiteOrigin();
const xSiteHandle = process.env.NEXT_PUBLIC_X_SITE_HANDLE?.replace(/^@/, "").trim();
const xCreatorHandle =
  process.env.NEXT_PUBLIC_X_CREATOR_HANDLE?.replace(/^@/, "").trim() ?? xSiteHandle;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: {
    default: "SpeicherPilot — Batteriespeicher live verstehen",
    template: "%s | SpeicherPilot",
  },
  description:
    "Live-Daten aus Energy-Charts: Tägliches Stromprofil für Deutschland, Speicher-Simulation und Marktüberblick — Fraunhofer-ISE-Daten.",
  openGraph: {
    title: "SpeicherPilot — Batteriespeicher live verstehen",
    description: "Live-Stromprofil für Deutschland, Speicher-Simulation und Marktüberblick — Energy-Charts-Daten.",
    type: "website",
    url: siteOrigin,
    siteName: "SpeicherPilot",
  },
  twitter: {
    card: "summary_large_image",
    title: "SpeicherPilot — Batteriespeicher live verstehen",
    description: "Energiewende-Signale für Deutschland — täglich aktuell.",
    ...(xSiteHandle ? { site: `@${xSiteHandle}` as const } : {}),
    ...(xCreatorHandle ? { creator: `@${xCreatorHandle}` as const } : {}),
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="de"
      suppressHydrationWarning
      className={`${inter.variable} ${playfair.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <ThemeInitScript />
        <SiteShell>{children}</SiteShell>
      </body>
    </html>
  );
}
