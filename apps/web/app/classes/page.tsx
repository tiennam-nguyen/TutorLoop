"use client";

import type { ClassDto } from "@tutorloop/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { ClassForm } from "../../components/class-form";
import { listClasses } from "../../lib/api";
import { useWorkspaceError } from "../../lib/session";

export default function ClassesPage() {
  return <AppShell><Classes /></AppShell>;
}

function Classes() {
  const workspaceError = useWorkspaceError();
  const [classes, setClasses] = useState<ClassDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    listClasses(controller.signal).then((data) => {
      if (!controller.signal.aborted) setClasses(data);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(workspaceError(failure));
    });
    return () => controller.abort();
  }, [attempt, workspaceError]);

  function onCreated(classroom: ClassDto) {
    setClasses((previous) => {
      const others = (previous ?? []).filter(({ id }) => id !== classroom.id);
      return classroom.archivedAt ? others : [...others, classroom];
    });
  }

  return (
    <>
      <h1>Classes</h1>
      {error && (
        <>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => {
            setError(null);
            setAttempt((previous) => previous + 1);
          }}>Try again</button>
        </>
      )}
      {!error && classes === null && <p role="status">Loading classes…</p>}
      {classes !== null && (
        <div className="classes-grid">
          <section className="panel" aria-labelledby="active-classes">
            <h2 id="active-classes">Active classes</h2>
            {classes.length ? (
              <ul className="rows">
                {classes.map((classroom) => (
                  <li className="row" key={classroom.id}>
                    <Link href={`/classes/${classroom.id}`}>{classroom.name}</Link>
                    <span className="muted">{classroom.timezone}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No classes yet.</p>}
          </section>
          <ClassForm onCreated={onCreated} />
        </div>
      )}
    </>
  );
}
