import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import "./globals.css";
import { SiteShell } from "@/components/site-shell";
import { ThemeInitScript } from "@/components/ThemeInitScript";
import { getPublicSiteOrigin } from "@/lib/publicSiteUrl";
import { Analytics } from "@vercel/analytics/next";

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
    default: "SpeicherPilot - BESS Planning & Dispatch Simulator",
    template: "%s | SpeicherPilot",
  },
  description:
    "Germany day-ahead energy briefing: Energy-Charts quarter-hours, BESS heuristics, fleet signals — Fraunhofer ISE data.",
  openGraph: {
    title: "SpeicherPilot - BESS Planning & Dispatch Simulator",
    description: "Energy-Charts-powered Germany daily profile, BESS simulation, and market snapshot.",
    type: "website",
    url: siteOrigin,
    siteName: "SpeicherPilot",
  },
  twitter: {
    card: "summary_large_image",
    title: "SpeicherPilot - BESS Planning & Dispatch Simulator",
    description: "Germany energy transition signals — daily.",
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
        <Analytics />
      </body>
    </html>
  );
}
