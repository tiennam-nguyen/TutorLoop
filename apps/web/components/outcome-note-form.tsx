"use client";

import type { CreateRawNoteResponse } from "@tutorloop/contracts";
import { createReassessmentOutcomeNote } from "../lib/api";
import { CaptureNoteForm } from "./quick-capture";

export function OutcomeNoteForm({ classId, reassessmentId, timeZone, performedAt, students, onSaved, onCancel }: {
  classId: string;
  reassessmentId: string;
  timeZone: string;
  performedAt: string | null;
  students: string[];
  onSaved: (capture: CreateRawNoteResponse) => void;
  onCancel: () => void;
}) {
  return <section className="outcome-form" aria-label="Outcome note">
    <p>Include each student’s name and what you observed in one note.</p>
    {students.length > 0 && <p className="muted">Awaiting evidence for {students.join(", ")}.</p>}
    <CaptureNoteForm timeZone={timeZone} initialTime={performedAt ?? undefined}
      prompt="What happened during the reassessment?" submitLabel="Save outcome note" onCancel={onCancel}
      onSaved={onSaved} saveNote={(input) => createReassessmentOutcomeNote(classId, reassessmentId, input)} />
  </section>;
}
