import { NextResponse } from "next/server";
import { z } from "zod";

import { createLogger } from "@/lib/debug";
import { getCuratedNewsFeed } from "@/lib/newsIngestion";

const log = createLogger("api:news");

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsedQuery = querySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
  });

  if (!parsedQuery.success) {
    return NextResponse.json(
      {
        message: "Invalid query parameters",
        errors: parsedQuery.error.flatten(),
      },
      { status: 400 }
    );
  }

  try {
    const payload = await getCuratedNewsFeed(parsedQuery.data.limit);
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    log("news feed generation failed %o", {
      request: { method: "GET", route: "/api/news", query: Object.fromEntries(url.searchParams) },
      response: { status: 502 },
      error,
    });
    return NextResponse.json(
      {
        message: "Unable to generate news feed right now.",
      },
      { status: 502 }
    );
  }
}
