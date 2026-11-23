"use client";

import type { ClassDto } from "@tutorloop/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "../components/app-shell";
import { DueQueue } from "../components/due-queue";
import { ClassCaptures } from "../components/quick-capture";
import { listClasses } from "../lib/api";
import { useWorkspaceError } from "../lib/session";

const classContextKey = "tutorloop.home-class";

export default function HomePage() {
  return <AppShell><HomeWorkspace /></AppShell>;
}

function HomeWorkspace() {
  const workspaceError = useWorkspaceError();
  const [classes, setClasses] = useState<ClassDto[] | null>(null);
  const [classId, setClassId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    listClasses(controller.signal).then((available) => {
      if (controller.signal.aborted) return;
      let previous: string | null = null;
      try {
        previous = sessionStorage.getItem(classContextKey);
      } catch {
        // Selecting a class still works when tab storage is unavailable.
      }
      setClassId(available.find(({ id }) => id === previous)?.id ?? available[0]?.id ?? "");
      setClasses(available);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(workspaceError(failure));
    });
    return () => controller.abort();
  }, [attempt, workspaceError]);

  function selectClass(id: string) {
    setClassId(id);
    try {
      sessionStorage.setItem(classContextKey, id);
    } catch {
      // The current Home view still reflects the selection.
    }
  }

  const classroom = classes?.find(({ id }) => id === classId);
  return <>
    <div className="page-heading">
      <h1>Home</h1>
      {classroom && <label className="class-selector">Class
        <select value={classId} onChange={(event) => selectClass(event.target.value)}>
          {classes?.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>}
    </div>
    {error && <>
      <p role="alert">{error}</p>
      <button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Try again</button>
    </>}
    {!classes && !error && <p role="status">Loading classes…</p>}
    {classes?.length === 0 && <div className="panel stack">
      <p>Create a class to capture notes and see due reassessments.</p>
      <Link href="/classes">Go to classes</Link>
    </div>}
    {classroom && <ClassCaptures key={classroom.id} classroom={classroom} archiving={false}>
      {(onSaved) => <DueQueue classroom={classroom} onSaved={onSaved} />}
    </ClassCaptures>}
  </>;
}
