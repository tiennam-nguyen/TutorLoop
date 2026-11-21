"use client";

import type { RawNoteDetailDto, RawNoteProcessingSummary } from "@tutorloop/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, getRawNote, reprocessRawNote } from "../lib/api";
import { formatObservedTime } from "../lib/observed-time";
import { useWorkspaceError } from "../lib/session";

export type RecentCapture = { id: string; initial?: RawNoteDetailDto };

const statusText = {
  QUEUED: "Saved · Waiting to structure",
  PROCESSING: "Saved · Structuring…",
  READY: "Proposal ready",
  FAILED: "Structuring failed",
} satisfies Record<RawNoteProcessingSummary["status"], string>;

function isProcessing(status: RawNoteProcessingSummary["status"] | undefined) {
  return status === "QUEUED" || status === "PROCESSING";
}

export function RecentCaptures({ captures, classId, timeZone, readOnly }: {
  captures: RecentCapture[];
  classId: string;
  timeZone: string;
  readOnly: boolean;
}) {
  return (
    <section className="panel" aria-labelledby="recent-captures-heading">
      <h2 id="recent-captures-heading">Recent captures</h2>
      {captures.length ? (
        <ul className="rows capture-rows">
          {captures.map((capture) => (
            <CaptureRow key={capture.id} capture={capture} classId={classId} timeZone={timeZone} readOnly={readOnly} />
          ))}
        </ul>
      ) : <p className="muted">No recent captures in this tab.</p>}
    </section>
  );
}

function CaptureRow({ capture, classId, timeZone, readOnly }: {
  capture: RecentCapture;
  classId: string;
  timeZone: string;
  readOnly: boolean;
}) {
  const workspaceError = useWorkspaceError();
  const [snapshot, setSnapshot] = useState(capture.initial ?? null);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryRequestId = useRef<string | null>(null);
  const { id } = capture;
  const needsInitialFetch = snapshot === null;
  const watching = !unavailable && (needsInitialFetch || isProcessing(snapshot?.processing.status));

  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    let timer: number | undefined;
    function schedule() {
      timer = window.setTimeout(() => void refresh(), 2_000);
    }
    async function refresh() {
      try {
        const current = await getRawNote(classId, id, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(current);
        setRefreshError(null);
        if (isProcessing(current.processing.status)) schedule();
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          setUnavailable(true);
          setRefreshError(workspaceError(failure));
        } else {
          setRefreshError("Couldn't refresh the structuring status. Retrying…");
          schedule();
        }
      }
    }
    if (needsInitialFetch) void refresh();
    else schedule();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [classId, id, needsInitialFetch, watching, workspaceError]);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const queued = await reprocessRawNote(classId, id, { clientRequestId: retryRequestId.current ??= crypto.randomUUID() });
      retryRequestId.current = null;
      setSnapshot(queued);
    } catch (failure) {
      setRetryError(workspaceError(failure));
    } finally {
      setRetrying(false);
    }
  }

  const processing = snapshot?.processing;
  return (
    <li className="capture-row">
      {snapshot && <>
        <p className="note-text capture-preview">{snapshot.rawNote.body}</p>
        <p className="muted"><time dateTime={snapshot.rawNote.observedAt}>
          {formatObservedTime(snapshot.rawNote.observedAt, timeZone)}
        </time></p>
      </>}
      {refreshError && <p role={unavailable ? "alert" : "status"}>{refreshError}</p>}
      {!unavailable && (
        <div className="row capture-status">
          <p role="status">{processing ? statusText[processing.status] : "Loading saved note…"}</p>
          {processing?.status === "READY" && (
            <Link href={`/classes/${encodeURIComponent(classId)}/proposal-runs/${encodeURIComponent(processing.proposalRunId)}`}>
              Review proposal
            </Link>
          )}
          {processing?.status === "FAILED" && !readOnly && (
            <button type="button" disabled={retrying} onClick={retry}>{retrying ? "Retrying…" : "Retry structuring"}</button>
          )}
        </div>
      )}
      {retryError && <p role="alert">{retryError}</p>}
    </li>
  );
}
