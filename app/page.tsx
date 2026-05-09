import { Suspense } from "react";

import { HomeBriefingClient } from "@/components/home/HomeBriefingClient";
import { Skeleton } from "@/components/ui/skeleton";
import { loadHomeBriefingInitialData } from "@/lib/homeBriefingData";

function BriefingFallback() {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 px-5 pt-8 md:px-8 lg:px-12">
      <Skeleton className="h-24 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={`kpi-${i}`} className="h-28 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[420px] w-full rounded-3xl" />
    </div>
  );
}

export default async function Home() {
  const initial = await loadHomeBriefingInitialData();
  return (
    <Suspense fallback={<BriefingFallback />}>
      <HomeBriefingClient initial={initial} />
    </Suspense>
  );
}
