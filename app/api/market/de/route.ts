import { NextResponse } from "next/server";

import { createLogger } from "@/lib/debug";
import { getGermanyMarketSnapshot } from "@/lib/energyChartsApi";

const log = createLogger("api:market:de");

export async function GET() {
  try {
    const snapshot = await getGermanyMarketSnapshot();
    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store",
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
