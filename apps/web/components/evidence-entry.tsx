"use client";

import type { EvidenceDto } from "@tutorloop/contracts";
import { useState } from "react";
import { getRawNote, recordProductView } from "../lib/api";
import { formatObservedTime } from "../lib/observed-time";
import { useWorkspaceError } from "../lib/session";

export function EvidenceEntry({ evidence, timeZone }: { evidence: EvidenceDto; timeZone: string }) {
  const workspaceError = useWorkspaceError();
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function reveal() {
    if (source !== null) { setSource(null); return; }
    setLoading(true);
    setError(null);
    try {
      const detail = await getRawNote(evidence.classId, evidence.rawNoteId);
      setSource(detail.rawNote.body);
      recordProductView({ eventName: "history_opened", classId: evidence.classId, entityId: evidence.id });
    } catch (failure) {
      setError(workspaceError(failure));
    } finally {
      setLoading(false);
    }
  }

  return <>
    <time dateTime={evidence.observedAt}>{formatObservedTime(evidence.observedAt, timeZone)}</time>
    {" · Evidence: "}{evidence.observationText}{" "}
    <button type="button" onClick={reveal} disabled={loading}>{source === null ? "Show source note" : "Hide source note"}</button>
    {source !== null && <p className="source-note note-text">Raw Note: {source}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}
