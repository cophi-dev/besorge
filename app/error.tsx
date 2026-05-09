"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createLogger } from "@/lib/debug";

const log = createLogger("app-error");

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    log("route error %o", { message: error.message, digest: error.digest, stack: error.stack });
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[50vh] w-full max-w-lg flex-col items-center justify-center gap-4 px-6 py-20 text-center">
      <AlertTriangle className="size-10 text-amber-500" aria-hidden />
      <h1 className="text-xl font-semibold tracking-tight text-foreground">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        The briefing could not render. Check your connection and try again — Energy-Charts may be unavailable.
      </p>
      <Button type="button" variant="default" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
