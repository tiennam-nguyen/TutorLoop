"use client";

import type { CanonicalIssueDetailDto, ClassDetailDto, EvidenceDto } from "@tutorloop/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "../../../../../components/app-shell";
import { EvidenceEntry } from "../../../../../components/evidence-entry";
import { getCanonicalIssue, getClassDetail, getStudentOverview } from "../../../../../lib/api";
import { useWorkspaceError } from "../../../../../lib/session";

const stateLabels = { OPEN: "Open", IMPROVING: "Improving", RESOLVED_FOR_NOW: "Resolved for now" } as const;

export default function ClassIssuePage() {
  const { classId, canonicalIssueId } = useParams<{ classId: string; canonicalIssueId: string }>();
  return <AppShell><ClassIssue key={`${classId}/${canonicalIssueId}`} classId={classId} issueId={canonicalIssueId} /></AppShell>;
}

async function loadIssue(classId: string, issueId: string, signal: AbortSignal) {
  const [classroom, issue] = await Promise.all([
    getClassDetail(classId, signal), getCanonicalIssue(classId, issueId, signal),
  ]);
  const studentIds = [...new Set(issue.studentIssues.map(({ studentId }) => studentId))];
  const overviews = await Promise.all(studentIds.map((studentId) => getStudentOverview(classId, studentId, signal)));
  const evidence = new Map<string, EvidenceDto>();
  for (const overview of overviews) for (const event of overview.evidence) evidence.set(event.id, event);
  return { classroom, issue, evidence };
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
    {data ? <IssueDetail {...data} /> : error ? <>
      <p role="alert">{error}</p><button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</button>
    </> : <p role="status">Loading issue…</p>}
  </>;
}

function IssueDetail({ classroom, issue, evidence }: {
  classroom: ClassDetailDto; issue: CanonicalIssueDetailDto; evidence: Map<string, EvidenceDto>;
}) {
  return <div className="table-scroll panel">
    <table className="issue-table" aria-label="Students with this issue">
      <thead><tr><th scope="col">Student</th><th scope="col">State</th><th scope="col">Manifestation</th><th scope="col">Evidence</th></tr></thead>
      <tbody>{issue.studentIssues.map((studentIssue) => <tr key={studentIssue.id}>
        <td><Link href={`/classes/${encodeURIComponent(classroom.id)}/students/${encodeURIComponent(studentIssue.studentId)}`}>
          {studentIssue.student.displayLabel}</Link></td>
        <td>{stateLabels[studentIssue.state]}</td>
        <td>{studentIssue.manifestation ?? "—"}</td>
        <td>{studentIssue.evidenceIds.length ? <ul className="evidence-list">{studentIssue.evidenceIds.map((id) => {
          const event = evidence.get(id);
          return <li key={id}>{event ? <EvidenceEntry evidence={event} timeZone={classroom.timezone} /> : "Evidence unavailable"}</li>;
        })}</ul> : "—"}</td>
      </tr>)}</tbody>
    </table>
    {!issue.studentIssues.length && <p className="muted">No active students with this issue.</p>}
  </div>;
}
