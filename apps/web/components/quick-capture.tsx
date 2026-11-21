"use client";

import {
  createRawNoteInputSchema, idSchema, type ClassDetailDto, type CreateRawNoteResponse,
} from "@tutorloop/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRawNote } from "../lib/api";
import { classLocalTime, resolveClassLocalTime } from "../lib/observed-time";
import { useWorkspaceError } from "../lib/session";
import { RecentCaptures, type RecentCapture } from "./recent-captures";

const recentLimit = 12;

export function ClassCaptures({ classroom, archiving }: { classroom: ClassDetailDto; archiving: boolean }) {
  const [captures, setCaptures] = useState<RecentCapture[]>([]);
  const storageKey = `tutorloop.recent-captures.${classroom.id}`;
  const archived = classroom.archivedAt !== null;

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
      if (Array.isArray(saved)) {
        const validIds = new Set(saved.filter((id): id is string => idSchema.safeParse(id).success));
        setCaptures([...validIds].slice(0, recentLimit).map((id) => ({ id })));
      }
    } catch {
      // Capture remains available when tab storage is disabled or invalid.
    }
  }, [storageKey]);

  function showSaved(snapshot: CreateRawNoteResponse) {
    const id = snapshot.rawNote.id;
    const next = [{ id, initial: snapshot }, ...captures.filter((capture) => capture.id !== id)].slice(0, recentLimit);
    setCaptures(next);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next.map((capture) => capture.id)));
    } catch {
      // The newly saved note is still visible in this view.
    }
  }

  return (
    <div className="capture-stack">
      {!archived && <QuickCapture classId={classroom.id} timeZone={classroom.timezone} disabled={archiving} onSaved={showSaved} />}
      <RecentCaptures captures={captures} classId={classroom.id} timeZone={classroom.timezone} readOnly={archived || archiving} />
    </div>
  );
}

function QuickCapture({ classId, timeZone, disabled, onSaved }: {
  classId: string;
  timeZone: string;
  disabled: boolean;
  onSaved: (capture: CreateRawNoteResponse) => void;
}) {
  const workspaceError = useWorkspaceError();
  const [note, setNote] = useState("");
  const [defaultTime, setDefaultTime] = useState(() => new Date());
  const [editedTime, setEditedTime] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const busy = disabled || saving;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const observedAt = editedTime === null ? defaultTime.toISOString() : resolveClassLocalTime(editedTime, timeZone);
    if (!observedAt) {
      setError(`Enter an observed time that exists in ${timeZone}.`);
      return;
    }
    if (!note.trim() || note.includes("\u0000") || !note.isWellFormed()) {
      setError("Enter a note before saving.");
      return;
    }
    const input = createRawNoteInputSchema.safeParse({
      body: note, observedAt, noteType: "OBSERVATION", clientRequestId: requestId.current ??= crypto.randomUUID(),
    });
    if (!input.success) {
      setError("Check the observed time and note text.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await createRawNote(classId, input.data));
      requestId.current = null;
      setNote("");
      setDefaultTime(new Date());
      setEditedTime(null);
    } catch (failure) {
      setError(workspaceError(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="capture-heading">
      <h2 id="capture-heading">Quick capture</h2>
      <form className="stack" onSubmit={save}>
        <label>
          What did you notice?
          <textarea rows={4} required value={note} disabled={busy} onChange={(event) => {
            setNote(event.target.value);
            requestId.current = null;
          }} />
        </label>
        <div className="row capture-form-footer">
          <label>
            Observed at <span className="muted">Time in {timeZone}</span>
            <input type="datetime-local" step="1" required value={editedTime ?? classLocalTime(defaultTime, timeZone)}
              disabled={busy} onChange={(event) => {
                setEditedTime(event.target.value);
                requestId.current = null;
              }} />
          </label>
          <button className="primary" type="submit" disabled={busy}>{saving ? "Saving…" : "Save note"}</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
