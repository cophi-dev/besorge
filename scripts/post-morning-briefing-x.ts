/**
 * Morning automation: screenshot yesterday's Germany energy-flow chart (observed + simulated overlay),
 * generate concise copy via the app's LLM helper, post to X with image.
 *
 * Requires a reachable deployed or local site (`MORNING_BRIEFING_BASE_URL`), Playwright Chromium,
 * AI keys (`AI_PROVIDER` / `XAI_API_KEY` or `OPENAI_API_KEY`), and X OAuth 1.0a write tokens
 * (`TWITTER_*` or `X_*`).
 *
 * Example (manual): `pnpm morning:x`
 * Cron (Berlin 07:00): `0 7 * * * TZ=Europe/Berlin cd /path/to/bessforge && pnpm morning:x >> /tmp/aether-morning-x.log 2>&1`
 *
 * First-time Playwright: `pnpm exec playwright install chromium`
 */

import { existsSync, readFileSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";

import { chromium } from "playwright";

import { createLogger } from "@/lib/debug";
import { generateMorningBriefingCopy } from "@/lib/morningBriefingLlm";
import {
  buildMorningBriefingContext,
  yesterdayBerlinDateKey,
} from "@/lib/morningBriefingContext";
import { berlinDateKeySchema } from "@/lib/germanyEnergyFlowPeriod";
import { postTweetPng } from "@/lib/postMorningBriefingX";

const log = createLogger("script-morning-x");

function tryLoadEnvFromFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/** Leave room for newline + URL inside X's classic limit. */
function composeTweetBody(tweet: string, link: string, maxLen = 275): string {
  const suffix = link.trim() ? `\n\n${link.trim()}` : "";
  const budget = maxLen - suffix.length;
  if (budget <= 0) {
    return link.trim().slice(0, maxLen);
  }
  const head = tweet.trim();
  if (head.length <= budget) {
    return `${head}${suffix}`;
  }
  return `${head.slice(0, Math.max(0, budget - 1))}…${suffix}`;
}

function parseArgs(argv: string[]): { dryRun: boolean; dateBerlin: string | null } {
  let dryRun = false;
  let dateBerlin: string | null = null;
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") {
      dryRun = true;
    }
    if (a.startsWith("--date=")) {
      dateBerlin = a.slice("--date=".length).trim() || null;
    }
  }
  return { dryRun, dateBerlin };
}

const main = async () => {
  tryLoadEnvFromFile(path.join(process.cwd(), ".env.local"));
  tryLoadEnvFromFile(path.join(process.cwd(), ".env"));

  const { dryRun, dateBerlin: dateOverride } = parseArgs(process.argv.slice(2));
  const baseUrlRaw = process.env.MORNING_BRIEFING_BASE_URL?.replace(/\/$/, "").trim();
  if (!baseUrlRaw) {
    throw new Error("Set MORNING_BRIEFING_BASE_URL (e.g. https://your-site.example or http://127.0.0.1:3000)");
  }

  const languageEnv = process.env.MORNING_BRIEFING_LANGUAGE?.trim().toLowerCase();
  const language = languageEnv === "de" ? "de" : "en";

  let berlinDate: string;
  if (dateOverride) {
    const parsed = berlinDateKeySchema.safeParse(dateOverride);
    if (!parsed.success) {
      throw new Error(`Invalid --date=${dateOverride} (expect YYYY-MM-DD Berlin calendar)`);
    }
    berlinDate = parsed.data;
  } else {
    berlinDate = yesterdayBerlinDateKey(new Date());
  }
  const briefingUrl = `${baseUrlRaw}/?date=${encodeURIComponent(berlinDate)}&sim=1`;

  log("building context for Berlin day %s", berlinDate);
  const context = await buildMorningBriefingContext(berlinDate);
  if (context === null) {
    throw new Error(`No energy-flow data for ${berlinDate} — Energy-Charts may be unavailable or the day has no slots.`);
  }

  log("generating LLM copy (%s)", language);
  const llm = await generateMorningBriefingCopy(context, language);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aether-morning-"));
  const pngPath = path.join(tmpDir, `briefing-${berlinDate}.png`);

  log("screenshot %s", briefingUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    await page.goto(briefingUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForSelector("#aether-germany-flow-capture", { state: "visible", timeout: 90_000 });
    await page.waitForSelector("#aether-germany-flow-capture svg", { state: "visible", timeout: 90_000 });
    const settleMs = Math.min(
      10_000,
      Math.max(0, Number(process.env.MORNING_CHART_SETTLE_MS ?? "1500") || 1500)
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, settleMs);
    });
    await page.locator("#aether-germany-flow-capture").scrollIntoViewIfNeeded();
    await page.locator("#aether-germany-flow-capture").screenshot({ path: pngPath, type: "png" });
  } finally {
    await browser.close();
  }

  const text = composeTweetBody(llm.tweet, briefingUrl);
  if (llm.recap) {
    log("recap (not posted): %s", llm.recap);
  }

  if (dryRun) {
    const outCopy = path.join(tmpDir, `tweet-${berlinDate}.txt`);
    await writeFile(outCopy, `${text}\n`, "utf8");
    log("dry-run: tweet body written to %s; PNG at %s", outCopy, pngPath);
    return;
  }

  const result = await postTweetPng({ text, imagePath: pngPath });
  log("posted id=%s", result.id);

  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
};

void main().catch((error) => {
  log("%o", error);
  console.error(error);
  process.exitCode = 1;
});
