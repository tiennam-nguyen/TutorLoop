"use client";

import type { ProductViewEventName } from "@tutorloop/contracts";
import { useEffect, useRef } from "react";
import { recordProductView } from "../lib/api";

// Mount only with successfully loaded view data. Revalidation is not another opening.
export function ProductViewEvent({ eventName, classId, entityId, hash }: {
  eventName: ProductViewEventName; classId: string; entityId?: string; hash?: "#timeline";
}) {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    const key = `${eventName}/${classId}/${entityId ?? ""}`;
    const opened = () => {
      if (hash && window.location.hash !== hash) { sent.current = null; return; }
      if (sent.current === key) return;
      sent.current = key;
      recordProductView({ eventName, classId, ...(entityId ? { entityId } : {}) });
    };
    opened();
    if (hash) window.addEventListener("hashchange", opened);
    return () => { if (hash) window.removeEventListener("hashchange", opened); };
  }, [eventName, classId, entityId, hash]);
  return null;
}
