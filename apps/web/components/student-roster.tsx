"use client";

import { addStudentInputSchema, updateStudentInputSchema, type ClassDetailDto, type StudentDto } from "@tutorloop/contracts";
import { useRef, useState, type FormEvent } from "react";
import { addStudent, archiveStudent, renameStudent } from "../lib/api";
import { useWorkspaceError } from "../lib/session";

export function StudentRoster({ classroom, archivingClass }: { classroom: ClassDetailDto; archivingClass: boolean }) {
  const workspaceError = useWorkspaceError();
  const [students, setStudents] = useState(classroom.students);
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const archived = classroom.archivedAt !== null;

  function updateStudent(student: StudentDto) {
    setStudents((previous) => {
      if (student.archivedAt) return previous.filter(({ id }) => id !== student.id);
      if (previous.some(({ id }) => id === student.id)) {
        return previous.map((current) => current.id === student.id ? student : current);
      }
      return [...previous, student];
    });
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = addStudentInputSchema.safeParse({
      displayLabel: label.trim(),
      clientRequestId: requestId.current ??= crypto.randomUUID(),
    });
    if (!input.success) {
      setError("Enter a student name.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      updateStudent(await addStudent(classroom.id, input.data));
      requestId.current = null;
      setLabel("");
    } catch (failure) {
      setError(workspaceError(failure));
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="students-heading">
      <h2 id="students-heading">Students</h2>
      {!archived && (
        <form className="inline-form" onSubmit={add}>
          <label>
            Student name
            <input required value={label} disabled={adding || archivingClass} onChange={(event) => {
              setLabel(event.target.value);
              requestId.current = null;
            }} />
          </label>
          <button className="primary" type="submit" disabled={adding || archivingClass}>
            {adding ? "Adding…" : "Add student"}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {students.length ? (
        <ul className="rows" aria-label="Active students">
          {students.map((student) => (
            <StudentRow
              key={student.id}
              student={student}
              archivedClass={archived}
              archivingClass={archivingClass}
              onUpdated={updateStudent}
              onArchived={() => setStudents((previous) => previous.filter(({ id }) => id !== student.id))}
            />
          ))}
        </ul>
      ) : <p className="muted">No active students.</p>}
    </section>
  );
}

function StudentRow({ student, archivedClass, archivingClass, onUpdated, onArchived }: {
  student: StudentDto;
  archivedClass: boolean;
  archivingClass: boolean;
  onUpdated: (student: StudentDto) => void;
  onArchived: () => void;
}) {
  const workspaceError = useWorkspaceError();
  const [name, setName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = updateStudentInputSchema.safeParse({
      displayLabel: name?.trim(),
      expectedVersion: student.version,
    });
    if (!input.success) {
      setError("Enter a student name.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      onUpdated(await renameStudent(student.classId, student.id, input.data));
      setName(null);
    } catch (failure) {
      setError(workspaceError(failure));
    } finally {
      setPending(false);
    }
  }

  async function archive() {
    setPending(true);
    setError(null);
    try {
      await archiveStudent(student.classId, student.id, student.version);
      onArchived();
    } catch (failure) {
      setError(workspaceError(failure));
      setPending(false);
    }
  }

  const disabled = pending || archivingClass;
  return (
    <li className="student-row">
      <div className="row">
        <span>{student.displayLabel}</span>
        {!archivedClass && name === null && (
          <div className="actions">
            <button type="button" disabled={disabled} onClick={() => {
              setName(student.displayLabel);
              setError(null);
            }}>Rename</button>
            <button className="danger" type="button" disabled={disabled} onClick={archive}>
              {pending ? "Archiving…" : "Archive"}
            </button>
          </div>
        )}
      </div>
      {name !== null && (
        <form className="inline-form" onSubmit={rename}>
          <label>
            New name
            <input required autoFocus value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} />
          </label>
          <button className="primary" type="submit" disabled={disabled}>
            {pending ? "Saving…" : "Save name"}
          </button>
          <button type="button" disabled={disabled} onClick={() => {
            setName(null);
            setError(null);
          }}>Cancel</button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}
