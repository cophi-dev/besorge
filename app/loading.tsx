import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 px-5 pt-8 md:px-8 lg:px-12">
      <Skeleton className="h-20 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={`sk-kpi-${i}`} className="h-28 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[min(420px,55vh)] w-full rounded-3xl" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-36 rounded-2xl" />
      </div>
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  );
}
