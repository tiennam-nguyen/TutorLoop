"use client";

import type { ClassDto, CreateRawNoteResponse, ReassessmentDueQueueDto, ReassessmentTargetStatus, StudentDto } from "@tutorloop/contracts";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { getClassDetail, getReassessmentDueQueue, markReassessmentPerformed, skipReassessmentTarget } from "../lib/api";
import { formatObservedTime } from "../lib/observed-time";
import { rosterLabels } from "../lib/roster-labels";
import { useWorkspaceError } from "../lib/session";
import { OutcomeNoteForm } from "./outcome-note-form";
import { ProductViewEvent } from "./product-view-event";

type QueueEntry = ReassessmentDueQueueDto["due"][number] | ReassessmentDueQueueDto["needsResults"][number];
type QueueTarget = QueueEntry["targets"][number];
const refreshIntervalMs = 30_000;

const targetStatus = {
  PENDING: "Awaiting evidence", EVIDENCED: "Evidence recorded", SKIPPED: "Skipped",
} satisfies Record<ReassessmentTargetStatus, string>;

function affectedStudents(targets: QueueTarget[], names: ReadonlyMap<string, string>) {
  const byStudent = new Map<string, QueueTarget[]>();
  for (const target of targets) {
    const group = byStudent.get(target.student.id) ?? [];
    group.push(target);
    byStudent.set(target.student.id, group);
  }
  return [...byStudent].map(([id, group]) => ({
    id, label: names.get(id) ?? group[0].student.displayLabel,
    archived: group[0].student.archivedAt !== null, targets: group,
  })).sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
}

export function DueQueue({ classroom, onSaved }: {
  classroom: ClassDto;
  onSaved: (capture: CreateRawNoteResponse) => void;
}) {
  const workspaceError = useWorkspaceError();
  const [queue, setQueue] = useState<ReassessmentDueQueueDto | null>(null);
  const [roster, setRoster] = useState<StudentDto[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [skippingKey, setSkippingKey] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const revalidation = useRef<AbortController | null>(null);
  const { id: classId, timezone } = classroom;
  const busy = openId !== null || markingId !== null || skippingKey !== null;
  const error = actionError ?? refreshError;
  const names = rosterLabels(roster, queue
    ? [...queue.due, ...queue.needsResults].flatMap(({ targets }) => targets.map(({ student }) => student))
    : []);

  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    revalidation.current = controller;
    let timer: number | undefined;
    let loadingRoster = false;

    function refreshRoster() {
      if (loadingRoster) return;
      loadingRoster = true;
      void getClassDetail(classId, controller.signal).then(({ students }) => {
        if (!controller.signal.aborted) setRoster(students);
      }).catch(() => {
        // Existing roster labels and queue target identities remain available.
      }).finally(() => { loadingRoster = false; });
    }

    async function refresh() {
      if (controller.signal.aborted) return;
      if (document.visibilityState === "visible") {
        try {
          const next = await getReassessmentDueQueue(classId, controller.signal);
          if (controller.signal.aborted) return;
          setQueue(next);
          setRefreshError(null);
          if (next.due.length || next.needsResults.length) refreshRoster();
        } catch (failure) {
          if (!controller.signal.aborted) setRefreshError(workspaceError(failure));
        }
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void refresh(), refreshIntervalMs);
    }
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [attempt, busy, classId, workspaceError]);

  async function recordOutcome(entry: QueueEntry) {
    if (busy) return;
    revalidation.current?.abort();
    setActionError(null);
    if (entry.status === "PERFORMED_PENDING_EVIDENCE") {
      setOpenId(entry.id);
      return;
    }

    setMarkingId(entry.id);
    try {
      const marked = await markReassessmentPerformed(classId, entry.id, entry.version);
      if (marked.status !== "PERFORMED_PENDING_EVIDENCE") throw new Error("Unexpected reassessment status");
      const targets = new Map(marked.targets.map((target) => [target.studentIssueId, target]));
      const pending = {
        ...entry, ...marked, status: marked.status,
        targets: entry.targets.map((target) => ({ ...target, ...targets.get(target.studentIssueId) })),
      };
      setQueue((previous) => previous && {
        due: previous.due.filter(({ id }) => id !== entry.id),
        needsResults: [...previous.needsResults, pending],
      });
      setOpenId(entry.id);
    } catch (failure) {
      // Read authoritative state in case the mark succeeded but its response was lost.
      const refreshed = await getReassessmentDueQueue(classId).catch(() => null);
      if (refreshed) {
        setQueue(refreshed);
        setRefreshError(null);
      }
      if (refreshed?.needsResults.some(({ id }) => id === entry.id)) setOpenId(entry.id);
      else setActionError(workspaceError(failure));
    } finally {
      setMarkingId(null);
    }
  }

  async function skipArchivedTarget(entry: QueueEntry, target: QueueTarget) {
    if (busy) return;
    revalidation.current?.abort();
    setActionError(null);
    const key = `${entry.id}:${target.studentIssueId}`;
    setSkippingKey(key);
    try {
      await skipReassessmentTarget(classId, entry.id, target.studentIssueId, entry.version, "Student archived");
      const refreshed = await getReassessmentDueQueue(classId);
      setQueue(refreshed);
      setRefreshError(null);
    } catch (failure) {
      const refreshed = await getReassessmentDueQueue(classId).catch(() => null);
      if (refreshed) {
        setQueue(refreshed);
        setRefreshError(null);
      }
      setActionError(workspaceError(failure));
    } finally {
      setSkippingKey(null);
    }
  }

  function item(entry: QueueEntry) {
    const opened = openId === entry.id;
    const students = affectedStudents(entry.targets, names);
    return <li key={entry.id} className="reassessment-row">
      <QueueCard entry={entry} timeZone={timezone} students={students} busy={busy} skippingKey={skippingKey}
        onSkipTarget={(target) => void skipArchivedTarget(entry, target)}>
        {opened ? <OutcomeNoteForm classId={classId} reassessmentId={entry.id} timeZone={timezone}
          performedAt={entry.performedAt}
          students={students.filter(({ targets }) => targets.some((target) => target.targetStatus === "PENDING"))
            .map(({ label }) => label)}
          onCancel={() => setOpenId(null)} onSaved={(capture) => { onSaved(capture); setOpenId(null); }} /> :
          <button type="button" className="primary" disabled={busy}
            onClick={() => void recordOutcome(entry)}>
            {markingId === entry.id ? "Marking performed…" : "Record outcome"}
          </button>}
      </QueueCard>
    </li>;
  }

  return <>
    {queue && <ProductViewEvent eventName="reassessment_due_opened" classId={classId} />}
    {error && <div className="panel">
      <p role="alert">{error}</p>
      <button type="button" disabled={busy} onClick={() => {
        setRefreshError(null);
        setActionError(null);
        setAttempt((value) => value + 1);
      }}>Refresh reassessments</button>
    </div>}
    <section className="panel" aria-labelledby="due-heading">
      <h2 id="due-heading">Due</h2>
      {queue ? queue.due.length ? <ul className="rows">{queue.due.map(item)}</ul> :
        <p className="muted">No reassessments are due.</p> :
        !error && <p role="status">Loading reassessments…</p>}
    </section>
    <section className="panel" aria-labelledby="needs-results-heading">
      <h2 id="needs-results-heading">Needs results</h2>
      {queue && (queue.needsResults.length ? <ul className="rows">{queue.needsResults.map(item)}</ul> :
        <p className="muted">No reassessments need results.</p>)}
    </section>
  </>;
}

function QueueCard({ entry, timeZone, students, busy, skippingKey, onSkipTarget, children }: {
  entry: QueueEntry;
  timeZone: string;
  students: ReturnType<typeof affectedStudents>;
  busy: boolean;
  skippingKey: string | null;
  onSkipTarget: (target: QueueTarget) => void;
  children: ReactNode;
}) {
  const headingId = useId();
  const classPath = `/classes/${encodeURIComponent(entry.classId)}`;
  const issues = new Map(entry.targets.map(({ canonicalIssue }) => [canonicalIssue.id, canonicalIssue.label]));
  const interventions = new Map(entry.targets.flatMap(({ intervention }) => intervention ? [[intervention.id, intervention]] : []));
  const showResults = entry.status === "PERFORMED_PENDING_EVIDENCE";

  return <article className="stack" aria-labelledby={headingId}>
    <h3 id={headingId}>{entry.title || issues.values().next().value || "Reassessment"}</h3>
    <ul className="reassessment-issues" aria-label="Issue history">
      {[...issues].map(([id, label]) => <li key={id}>
        <Link href={`${classPath}/issues/${encodeURIComponent(id)}`}>{label}</Link>
      </li>)}
    </ul>
    <p>Due <time dateTime={entry.dueAt}>{formatObservedTime(entry.dueAt, timeZone)}</time> · {timeZone}</p>
    {entry.performedAt && <p className="muted">
      Performed <time dateTime={entry.performedAt}>{formatObservedTime(entry.performedAt, timeZone)}</time>
    </p>}
    {entry.notes && <p className="note-text">{entry.notes}</p>}
    <ul className="reassessment-targets" aria-label="Affected students">
      {students.map(({ id, label, archived, targets }) => <li key={id}>
        <Link href={`${classPath}/students/${encodeURIComponent(id)}#timeline`}>{label}</Link>
        {archived && " · Archived"}
        {targets.length === 1 ? (
          <TargetResult target={targets[0]} showStatus={showResults} busy={busy}
            skipping={skippingKey === `${entry.id}:${targets[0].studentIssueId}`}
            onSkip={() => onSkipTarget(targets[0])} />
        ) : (
          <ul>{targets.map((target) => <li key={target.studentIssueId}>
            {target.canonicalIssue.label}
            <TargetResult target={target} showStatus={showResults} busy={busy}
              skipping={skippingKey === `${entry.id}:${target.studentIssueId}`}
              onSkip={() => onSkipTarget(target)} />
          </li>)}</ul>
        )}
      </li>)}
    </ul>
    {interventions.size > 0 && <div className="stack">
      <strong>Prior intervention</strong>
      {[...interventions.values()].map((intervention) => <p className="note-text" key={intervention.id}>
        <span>{intervention.description}</span>
        {" · "}<time dateTime={intervention.occurredAt}>{formatObservedTime(intervention.occurredAt, timeZone)}</time>
      </p>)}
    </div>}
    {children}
  </article>;
}

function TargetResult({ target, showStatus, busy, skipping, onSkip }: {
  target: QueueTarget;
  showStatus: boolean;
  busy: boolean;
  skipping: boolean;
  onSkip: () => void;
}) {
  const canSkip = target.student.archivedAt !== null && target.targetStatus === "PENDING";
  return <>
    {(showStatus || target.targetStatus !== "PENDING") && ` · ${targetStatus[target.targetStatus]}`}
    {canSkip && <>{" "}<button type="button" disabled={busy} onClick={onSkip}>
      {skipping ? "Skipping…" : "Skip target"}
    </button></>}
    {target.skipReason && <p className="note-text">{target.skipReason}</p>}
  </>;
}
