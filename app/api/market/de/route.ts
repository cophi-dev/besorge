import { NextResponse } from "next/server";

import { unstable_cache } from "next/cache";

import { createLogger } from "@/lib/debug";
import { getGermanyMarketSnapshot } from "@/lib/energyChartsApi";

const log = createLogger("api:market:de");

const getGermanyMarketSnapshotCached = unstable_cache(
  async () => getGermanyMarketSnapshot(),
  ["energy-charts-germany-market-snapshot"],
  { revalidate: 120 }
);

export async function GET() {
  try {
    const snapshot = await getGermanyMarketSnapshotCached();
    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    log("failed to build Germany market snapshot %o", {
      request: { method: "GET", route: "/api/market/de" },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      {
        message: "Unable to load Germany market data right now.",
      },
      { status: 502 }
    );
  }
}
