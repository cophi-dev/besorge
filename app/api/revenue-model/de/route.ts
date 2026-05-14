import { NextResponse } from "next/server";

import { createLogger } from "@/lib/debug";
import { getGermanyMarketRevenueReference } from "@/lib/germanyRevenueModel";

const log = createLogger("api:revenue-model:de");

export async function GET() {
  try {
    const payload = await getGermanyMarketRevenueReference();
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
      },
    });
  } catch (error) {
    log("revenue model route failed %o", {
      request: { method: "GET", route: "/api/revenue-model/de" },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      { message: "Unable to load the Germany revenue model right now." },
      { status: 502 }
    );
  }
}
