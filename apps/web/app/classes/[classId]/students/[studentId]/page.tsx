"use client";

import type { ClassDetailDto, StudentOverviewDto } from "@tutorloop/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "../../../../../components/app-shell";
import { StudentIssueList } from "../../../../../components/student-issue-list";
import { StudentTimeline } from "../../../../../components/student-timeline";
import { getClassDetail, getStudentOverview } from "../../../../../lib/api";
import { useWorkspaceError } from "../../../../../lib/session";

export default function StudentPage() {
  const { classId, studentId } = useParams<{ classId: string; studentId: string }>();
  return <AppShell><StudentView key={`${classId}/${studentId}`} classId={classId} studentId={studentId} /></AppShell>;
}

function StudentView({ classId, studentId }: { classId: string; studentId: string }) {
  const workspaceError = useWorkspaceError();
  const [data, setData] = useState<{ classroom: ClassDetailDto; overview: StudentOverviewDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getClassDetail(classId, controller.signal), getStudentOverview(classId, studentId, controller.signal)])
      .then(([classroom, overview]) => { if (!controller.signal.aborted) setData({ classroom, overview }); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) setError(workspaceError(failure)); });
    return () => controller.abort();
  }, [classId, studentId, attempt, workspaceError]);
  return <>
    <nav className="review-back" aria-label="Class navigation"><Link href={`/classes/${encodeURIComponent(classId)}`}>Back to class</Link></nav>
    <div className="page-heading"><div><h1>{data?.overview.student.displayLabel ?? "Student"}</h1>
      {data && <p className="muted">{data.classroom.name}</p>}</div></div>
    {data ? <div className="student-view">
      <StudentIssueList classId={classId} title="Active issues" issues={data.overview.activeStudentIssues} />
      <StudentTimeline overview={data.overview} timeZone={data.classroom.timezone} />
      <StudentIssueList classId={classId} title="Resolved for now" issues={data.overview.resolvedStudentIssues} />
    </div> : error ? <>
      <p role="alert">{error}</p><button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</button>
    </> : <p role="status">Loading student…</p>}
  </>;
}
