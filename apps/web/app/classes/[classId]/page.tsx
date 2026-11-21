"use client";

import type { ClassDetailDto } from "@tutorloop/contracts";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import { StudentRoster } from "../../../components/student-roster";
import { archiveClass, getClassDetail } from "../../../lib/api";
import { useWorkspaceError } from "../../../lib/session";

export default function ClassPage() {
  const { classId } = useParams<{ classId: string }>();
  return <AppShell><ClassWorkspace key={classId} classId={classId} /></AppShell>;
}

function ClassWorkspace({ classId }: { classId: string }) {
  const router = useRouter();
  const workspaceError = useWorkspaceError();
  const [classroom, setClassroom] = useState<ClassDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getClassDetail(classId, controller.signal).then((data) => {
      if (!controller.signal.aborted) setClassroom(data);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(workspaceError(failure));
    });
    return () => controller.abort();
  }, [attempt, classId, workspaceError]);

  async function archive() {
    if (!classroom || !window.confirm(`Archive ${classroom.name}? Its history will be kept.`)) return;
    setArchiving(true);
    setError(null);
    try {
      await archiveClass(classroom.id, classroom.version);
      router.replace("/classes");
    } catch (failure) {
      setError(workspaceError(failure));
      setArchiving(false);
    }
  }

  if (!classroom) {
    if (!error) return <p role="status">Loading class…</p>;
    return (
      <>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => {
          setError(null);
          setAttempt((previous) => previous + 1);
        }}>Try again</button>
      </>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{classroom.name}</h1>
          <p className="muted">{classroom.timezone}</p>
        </div>
        {classroom.archivedAt ? <p className="muted">Archived class</p> : (
          <button className="danger" type="button" onClick={archive} disabled={archiving}>
            {archiving ? "Archiving…" : "Archive class"}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <StudentRoster classroom={classroom} archivingClass={archiving} />
    </>
  );
}
