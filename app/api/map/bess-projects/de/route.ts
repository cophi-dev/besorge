import { NextResponse } from "next/server";

import { getMastrProjectsSnapshot } from "@/lib/mastrZenodoProjects";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const data = await getMastrProjectsSnapshot();

  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=43200, stale-while-revalidate=86400",
    },
  });
}
