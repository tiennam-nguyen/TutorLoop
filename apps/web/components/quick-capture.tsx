"use client";

import {
  createReassessmentOutcomeNoteInputSchema, idSchema, type ClassDto,
  type CreateRawNoteResponse, type CreateReassessmentOutcomeNoteInput,
} from "@tutorloop/contracts";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRawNote } from "../lib/api";
import { classLocalTime, resolveClassLocalTime } from "../lib/observed-time";
import { useWorkspaceError } from "../lib/session";
import { RecentCaptures, type RecentCapture } from "./recent-captures";

const recentLimit = 12;

function savedCaptureIds(storageKey: string): string[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(saved)) {
      return [...new Set(saved.filter((id): id is string => idSchema.safeParse(id).success))].slice(0, recentLimit);
    }
  } catch {
    // Capture remains available when tab storage is disabled or invalid.
  }
  return [];
}

export function ClassCaptures({ classroom, archiving, children }: {
  classroom: ClassDto;
  archiving: boolean;
  children?: (onSaved: (snapshot: CreateRawNoteResponse) => void) => ReactNode;
}) {
  const [captures, setCaptures] = useState<RecentCapture[]>([]);
  const storageKey = `tutorloop.recent-captures.${classroom.id}`;
  const archived = classroom.archivedAt !== null;

  useEffect(() => {
    setCaptures(savedCaptureIds(storageKey).map((id) => ({ id })));
  }, [storageKey]);

  function showSaved(snapshot: CreateRawNoteResponse) {
    const id = snapshot.rawNote.id;
    const savedIds = [id, ...savedCaptureIds(storageKey).filter((savedId) => savedId !== id)].slice(0, recentLimit);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(savedIds));
    } catch {
      // The newly saved note is still visible in this view.
    }
    setCaptures((previous) => {
      const known = new Map(previous.map((capture) => [capture.id, capture]));
      known.set(id, { id, initial: snapshot });
      const recent = new Set([...savedIds, ...known.keys()]);
      return [...recent].slice(0, recentLimit).map((recentId) => known.get(recentId) ?? { id: recentId });
    });
  }

  return (
    <div className="capture-stack">
      {!archived && <section className="panel" aria-labelledby="capture-heading">
        <h2 id="capture-heading">Quick capture</h2>
        <CaptureNoteForm timeZone={classroom.timezone} disabled={archiving}
          prompt="What did you notice?" submitLabel="Save note" onSaved={showSaved}
          saveNote={(input) => createRawNote(classroom.id, { ...input, noteType: "OBSERVATION" })} />
      </section>}
      {children?.(showSaved)}
      <RecentCaptures captures={captures} classId={classroom.id} timeZone={classroom.timezone} readOnly={archived || archiving} />
    </div>
  );
}

export function CaptureNoteForm({ timeZone, disabled, prompt, submitLabel, initialTime, onCancel, saveNote, onSaved }: {
  timeZone: string;
  disabled?: boolean;
  prompt: string;
  submitLabel: string;
  initialTime?: string;
  onCancel?: () => void;
  saveNote: (input: CreateReassessmentOutcomeNoteInput) => Promise<CreateRawNoteResponse>;
  onSaved: (capture: CreateRawNoteResponse) => void;
}) {
  const workspaceError = useWorkspaceError();
  const [note, setNote] = useState("");
  const [defaultTime, setDefaultTime] = useState(() => initialTime ? new Date(initialTime) : new Date());
  const [editedTime, setEditedTime] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const busy = disabled || saving;

  useEffect(() => {
    if (initialTime) noteField.current?.focus();
  }, [initialTime]);

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
    const input = createReassessmentOutcomeNoteInputSchema.safeParse({
      body: note, observedAt, clientRequestId: requestId.current ??= crypto.randomUUID(),
    });
    if (!input.success) {
      setError("Check the observed time and note text.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveNote(input.data));
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
    <form className="stack" onSubmit={save}>
      <label>
        {prompt}
        <textarea ref={noteField} rows={4} required value={note} disabled={busy} onChange={(event) => {
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
        <div className="actions">
          {onCancel && <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
          <button className="primary" type="submit" disabled={busy}>{saving ? "Saving…" : submitLabel}</button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
