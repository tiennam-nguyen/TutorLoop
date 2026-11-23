"use client";

import type { CanonicalIssueDetailDto, ClassDetailDto, EvidenceDto, ReassessmentStatus } from "@tutorloop/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "../../../../../components/app-shell";
import { CanonicalIssueMaintenance } from "../../../../../components/canonical-issue-maintenance";
import { EvidenceEntry } from "../../../../../components/evidence-entry";
import { IssueActivityForm } from "../../../../../components/reassessment-form";
import { getCanonicalIssue, getClassDetail, getStudentOverview, listCanonicalIssues } from "../../../../../lib/api";
import { formatObservedTime } from "../../../../../lib/observed-time";
import { rosterLabels } from "../../../../../lib/roster-labels";
import { useWorkspaceError } from "../../../../../lib/session";

const stateLabels = { OPEN: "Open", IMPROVING: "Improving", RESOLVED_FOR_NOW: "Resolved for now" } as const;
const reassessmentLabels = {
  SCHEDULED: "Scheduled", PERFORMED_PENDING_EVIDENCE: "Needs results", COMPLETED: "Completed", CANCELLED: "Cancelled",
} satisfies Record<ReassessmentStatus, string>;

export default function ClassIssuePage() {
  const { classId, canonicalIssueId } = useParams<{ classId: string; canonicalIssueId: string }>();
  return <AppShell><ClassIssue key={`${classId}/${canonicalIssueId}`} classId={classId} issueId={canonicalIssueId} /></AppShell>;
}

async function loadIssue(classId: string, issueId: string, signal: AbortSignal) {
  const [classroom, issue, candidates] = await Promise.all([
    getClassDetail(classId, signal), getCanonicalIssue(classId, issueId, signal), listCanonicalIssues(classId, signal),
  ]);
  const studentIds = [...new Set(issue.studentIssues.map(({ studentId }) => studentId))];
  const overviews = await Promise.all(studentIds.map((studentId) => getStudentOverview(classId, studentId, signal)));
  const evidence = new Map<string, EvidenceDto>();
  for (const overview of overviews) for (const event of overview.evidence) evidence.set(event.id, event);
  return { classroom, issue, evidence, candidates };
}

function ClassIssue({ classId, issueId }: { classId: string; issueId: string }) {
  const workspaceError = useWorkspaceError();
  const [data, setData] = useState<Awaited<ReturnType<typeof loadIssue>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    loadIssue(classId, issueId, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(workspaceError(failure)); });
    return () => controller.abort();
  }, [classId, issueId, attempt, workspaceError]);
  return <>
    <nav className="review-back" aria-label="Class navigation">
      <Link href={`/classes/${encodeURIComponent(classId)}/issues`}>Back to class issues</Link>
    </nav>
    <div className="page-heading"><div><h1>{data?.issue.label ?? "Issue detail"}</h1>
      {data && <p className="muted">{data.classroom.name}</p>}</div></div>
    {data && !data.classroom.archivedAt && !data.issue.archivedAt && <CanonicalIssueMaintenance key={`${data.issue.id}/${data.issue.version}`}
      classId={classId} issue={data.issue} candidates={data.candidates} onSaved={() => setAttempt((value) => value + 1)} />}
    {data ? <IssueDetail {...data} onHistoryChange={(update) => setData((previous) =>
      previous && { ...previous, issue: update(previous.issue) })} /> : error ? <>
      <p role="alert">{error}</p><button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</button>
    </> : <p role="status">Loading issue…</p>}
  </>;
}

function IssueDetail({ classroom, issue, evidence, onHistoryChange }: {
  classroom: ClassDetailDto; issue: CanonicalIssueDetailDto; evidence: Map<string, EvidenceDto>;
  onHistoryChange: (update: (issue: CanonicalIssueDetailDto) => CanonicalIssueDetailDto) => void;
}) {
  const editable = !classroom.archivedAt && !issue.archivedAt && !issue.mergedIntoId && issue.studentIssues.length > 0;
  const studentNames = rosterLabels(classroom.students, issue.studentIssues.map(({ student }) => student));
  return <div className="capture-stack">
    <div className="table-scroll panel">
    <table className="issue-table" aria-label="Students with this issue">
      <thead><tr><th scope="col">Student</th><th scope="col">State</th><th scope="col">Manifestation</th><th scope="col">Evidence</th></tr></thead>
      <tbody>{issue.studentIssues.map((studentIssue) => <tr key={studentIssue.id}>
        <td><Link href={`/classes/${encodeURIComponent(classroom.id)}/students/${encodeURIComponent(studentIssue.studentId)}`}>
          {studentNames.get(studentIssue.studentId) ?? studentIssue.student.displayLabel}</Link></td>
        <td>{stateLabels[studentIssue.state]}</td>
        <td>{studentIssue.manifestation ?? "—"}</td>
        <td>{studentIssue.evidenceIds.length ? <ul className="evidence-list">{studentIssue.evidenceIds.map((id) => {
          const event = evidence.get(id);
          return <li key={id}>{event ? <EvidenceEntry evidence={event} timeZone={classroom.timezone} /> : "Evidence unavailable"}</li>;
        })}</ul> : "—"}</td>
      </tr>)}</tbody>
    </table>
    {!issue.studentIssues.length && <p className="muted">No active students with this issue.</p>}
    </div>
    {editable && <div className="classes-grid">
      <IssueActivityForm classroom={classroom} issue={issue} studentNames={studentNames} activity={{
        kind: "intervention",
        onSaved: (intervention) => onHistoryChange((previous) => ({
          ...previous, interventions: [...previous.interventions.filter(({ id }) => id !== intervention.id), intervention],
        })),
      }} />
      <IssueActivityForm classroom={classroom} issue={issue} studentNames={studentNames} activity={{
        kind: "reassessment",
        onSaved: (reassessment) => onHistoryChange((previous) => ({
          ...previous, reassessments: [...previous.reassessments.filter(({ id }) => id !== reassessment.id), reassessment],
        })),
      }} />
    </div>}
    <IssueHistory classroom={classroom} issue={issue} studentNames={studentNames} />
  </div>;
}

function IssueHistory({ classroom, issue, studentNames }: {
  classroom: ClassDetailDto;
  issue: CanonicalIssueDetailDto;
  studentNames: ReadonlyMap<string, string>;
}) {
  const students = new Map(issue.studentIssues.map(({ id, student }) => [id, studentNames.get(student.id) ?? student.displayLabel]));
  const targetNames = (ids: string[]) => {
    const names = ids.flatMap((id) => students.get(id) ?? []);
    const unavailable = ids.length - names.length;
    if (unavailable) names.push(`${unavailable} other ${unavailable === 1 ? "target" : "targets"}`);
    return names.join(", ");
  };
  const time = (at: string) => <time dateTime={at}>{formatObservedTime(at, classroom.timezone)}</time>;

  return <>
    <section className="panel" aria-labelledby="intervention-history">
      <h2 id="intervention-history">Interventions</h2>
      {issue.interventions.length ? <ul className="rows">
        {issue.interventions.map((intervention) => <li className="reassessment-row" key={intervention.id}>
          <p className="note-text">{intervention.description}</p>
          <p className="muted">Occurred {time(intervention.occurredAt)} · {targetNames(intervention.studentIssueIds)}</p>
        </li>)}
      </ul> : <p className="muted">No interventions recorded.</p>}
    </section>
    <section className="panel" aria-labelledby="reassessment-history">
      <h2 id="reassessment-history">Reassessments</h2>
      {issue.reassessments.length ? <ul className="rows">
        {issue.reassessments.map((reassessment) => <li className="reassessment-row" key={reassessment.id}>
          <p><strong>{reassessment.title || "Reassessment"}</strong> · {reassessmentLabels[reassessment.status]}</p>
          <p className="muted">Due {time(reassessment.dueAt)}{reassessment.performedAt &&
            <> · Performed {time(reassessment.performedAt)}</>}</p>
          <p>{targetNames(reassessment.targets.map(({ studentIssueId }) => studentIssueId))}</p>
          {reassessment.notes && <p className="note-text">{reassessment.notes}</p>}
        </li>)}
      </ul> : <p className="muted">No reassessments scheduled.</p>}
    </section>
  </>;
}
