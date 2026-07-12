"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const refreshIntervalMs = 8_000;

export function SharedWorkspaceRefresh() {
  const router = useRouter();
  const versionRef = useRef<string | null>(null);
  const checkingRef = useRef(false);

  useEffect(() => {
    const checkForChanges = async () => {
      if (document.visibilityState !== "visible" || checkingRef.current) return;
      checkingRef.current = true;
      try {
        const response = await fetch("/api/workspace-version", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { version?: unknown };
        if (typeof result.version !== "string") return;
        if (versionRef.current === null) {
          versionRef.current = result.version;
        } else if (versionRef.current !== result.version) {
          versionRef.current = result.version;
          router.refresh();
        }
      } catch {
        // The next poll retries while the current workspace stays usable.
      } finally {
        checkingRef.current = false;
      }
    };
    void checkForChanges();
    const interval = window.setInterval(checkForChanges, refreshIntervalMs);
    window.addEventListener("focus", checkForChanges);
    document.addEventListener("visibilitychange", checkForChanges);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkForChanges);
      document.removeEventListener("visibilitychange", checkForChanges);
    };
  }, [router]);

  return null;
}
