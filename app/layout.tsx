import type { Metadata } from "next";
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

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: {
    default: "AETHER | Daily Energy Briefing",
    template: "%s | AETHER",
  },
  description:
    "Germany day-ahead energy briefing: Energy-Charts quarter-hours, BESS heuristics, fleet signals — Fraunhofer ISE data.",
  openGraph: {
    title: "AETHER | Daily Energy Briefing",
    description: "Energy-Charts-powered Germany daily profile, BESS simulation, and market snapshot.",
    type: "website",
    url: siteOrigin,
    siteName: "AETHER",
  },
  twitter: {
    card: "summary_large_image",
    title: "AETHER | Daily Energy Briefing",
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
      lang="en"
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
