"use client";

import type { CanonicalIssueListDto, ClassDetailDto } from "@tutorloop/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "../../../../components/app-shell";
import { IssueTable } from "../../../../components/issue-table";
import { getClassDetail, listCanonicalIssues } from "../../../../lib/api";
import { useWorkspaceError } from "../../../../lib/session";

export default function ClassIssuesPage() {
  const { classId } = useParams<{ classId: string }>();
  return <AppShell><ClassIssues key={classId} classId={classId} /></AppShell>;
}

function ClassIssues({ classId }: { classId: string }) {
  const workspaceError = useWorkspaceError();
  const [data, setData] = useState<{ classroom: ClassDetailDto; issues: CanonicalIssueListDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getClassDetail(classId, controller.signal), listCanonicalIssues(classId, controller.signal)])
      .then(([classroom, issues]) => { if (!controller.signal.aborted) setData({ classroom, issues }); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(workspaceError(failure)); });
    return () => controller.abort();
  }, [classId, attempt, workspaceError]);
  return <>
    <nav className="review-back" aria-label="Class navigation"><Link href={`/classes/${encodeURIComponent(classId)}`}>Back to class</Link></nav>
    <div className="page-heading"><div><h1>Class issues</h1>{data && <p className="muted">{data.classroom.name}</p>}</div></div>
    {data ? <IssueTable classId={classId} issues={data.issues} /> : error ? <>
      <p role="alert">{error}</p><button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</button>
    </> : <p role="status">Loading issues…</p>}
  </>;
}
