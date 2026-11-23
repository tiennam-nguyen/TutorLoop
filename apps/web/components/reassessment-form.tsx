"use client";

import {
  createInterventionInputSchema, createReassessmentInputSchema,
  type CanonicalIssueDetailDto, type ClassDto, type InterventionDto, type ReassessmentDto,
} from "@tutorloop/contracts";
import { useId, useRef, useState, type FormEvent } from "react";
import { recordIntervention, scheduleReassessment } from "../lib/api";
import { classLocalTime, formatObservedTime, resolveClassLocalTime } from "../lib/observed-time";
import { useWorkspaceError } from "../lib/session";

type Activity =
  | { kind: "intervention"; onSaved: (intervention: InterventionDto) => void }
  | { kind: "reassessment"; onSaved: (reassessment: ReassessmentDto) => void };

export function IssueActivityForm({ classroom, issue, activity, studentNames }: {
  classroom: ClassDto;
  issue: CanonicalIssueDetailDto;
  activity: Activity;
  studentNames: ReadonlyMap<string, string>;
}) {
  const titleId = useId();
  const workspaceError = useWorkspaceError();
  const scheduling = activity.kind === "reassessment";
  const [defaultTime, setDefaultTime] = useState(() => new Date());
  const [editedTime, setEditedTime] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [priorIntervention, setPriorIntervention] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const timeZone = classroom.timezone;
  const timeLabel = scheduling ? "Due at" : "Occurred at";
  const candidates = selected.length ? issue.interventions.filter((prior) =>
    selected.every((id) => prior.studentIssueIds.includes(id))) : [];

  function targetLabel(target: CanonicalIssueDetailDto["studentIssues"][number]) {
    const name = studentNames.get(target.studentId) ?? target.student.displayLabel;
    const branches = issue.studentIssues.filter(({ studentId }) => studentId === target.studentId);
    if (branches.length === 1) return name;
    const manifestation = target.manifestation?.trim() || "No manifestation";
    const matching = branches.filter((branch) => (branch.manifestation?.trim() || "No manifestation") === manifestation)
      .toSorted((left, right) => left.id.localeCompare(right.id));
    const suffix = matching.length > 1 ? ` · Branch ${matching.findIndex(({ id }) => id === target.id) + 1}` : "";
    return `${name} · ${manifestation}${suffix}`;
  }

  function edit() {
    requestId.current = null;
    setError(null);
    setSaved(false);
  }

  function select(id: string, checked: boolean) {
    const next = checked ? [...selected, id] : selected.filter((value) => value !== id);
    setSelected(next);
    if (priorIntervention && (!next.length || !issue.interventions.some((prior) =>
      prior.id === priorIntervention && next.every((value) => prior.studentIssueIds.includes(value))))) {
      setPriorIntervention("");
    }
    edit();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const at = editedTime === null && !scheduling ? defaultTime.toISOString() : resolveClassLocalTime(editedTime ?? "", timeZone);
    if (!at) {
      setError(`Enter a time that exists in ${timeZone}.`);
      return;
    }
    if (!selected.length) {
      setError("Select at least one student.");
      return;
    }
    if ([text, title].some((value) => !value.isWellFormed() || value.includes("\u0000"))) {
      setError("Check the text before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    const targetInput = { studentIssueIds: selected, clientRequestId: requestId.current ??= crypto.randomUUID() };
    try {
      if (activity.kind === "reassessment") {
        const input = createReassessmentInputSchema.parse({
          ...targetInput, dueAt: at, title: title.trim() || null, notes: text.trim() ? text : null,
          interventionIdByStudentIssueId: priorIntervention ?
            Object.fromEntries(selected.map((id) => [id, priorIntervention])) : undefined,
        });
        activity.onSaved(await scheduleReassessment(classroom.id, input));
      } else {
        const input = createInterventionInputSchema.safeParse({ ...targetInput, description: text, occurredAt: at });
        if (!input.success) {
          setError("Describe the intervention before saving.");
          return;
        }
        activity.onSaved(await recordIntervention(classroom.id, input.data));
      }
      requestId.current = null;
      setDefaultTime(new Date());
      setEditedTime(null);
      setText("");
      setTitle("");
      setSelected([]);
      setPriorIntervention("");
      setSaved(true);
    } catch (failure) {
      setError(workspaceError(failure));
    } finally {
      setSaving(false);
    }
  }

  return <section className="panel" aria-labelledby={titleId}>
    <h2 id={titleId}>{scheduling ? "Schedule reassessment" : "Record intervention"}</h2>
    <form className="stack" onSubmit={save}>
      {scheduling && <label>
        Title <span className="muted">Optional</span>
        <input value={title} disabled={saving} onChange={(event) => { setTitle(event.target.value); edit(); }} />
      </label>}
      <label>
        {scheduling ? "Notes (optional)" : "What did you try?"}
        <textarea rows={3} value={text} required={!scheduling} disabled={saving}
          onChange={(event) => { setText(event.target.value); edit(); }} />
      </label>
      <fieldset className="target-options" disabled={saving}>
        <legend>Students</legend>
        {issue.studentIssues.map((target) => <label key={target.id}>
          <input type="checkbox" checked={selected.includes(target.id)} onChange={(event) => select(target.id, event.target.checked)} />
          {targetLabel(target)}
        </label>)}
      </fieldset>
      {scheduling && issue.interventions.length > 0 && <label>
        Prior intervention
        <select value={priorIntervention} disabled={saving || !candidates.length}
          onChange={(event) => { setPriorIntervention(event.target.value); edit(); }}>
          <option value="">No linked intervention</option>
          {candidates.map(({ id, occurredAt, description }) => <option key={id} value={id}>
            {description} · {formatObservedTime(occurredAt, timeZone)}
          </option>)}
        </select>
      </label>}
      <div className="row capture-form-footer">
        <label>
          {timeLabel} <span className="muted">Time in {timeZone}</span>
          <input type="datetime-local" step="1" required disabled={saving}
            value={editedTime ?? (scheduling ? "" : classLocalTime(defaultTime, timeZone))}
            onChange={(event) => { setEditedTime(event.target.value); edit(); }} />
        </label>
        <button className="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : scheduling ? "Schedule reassessment" : "Save intervention"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">{scheduling ? "Reassessment scheduled." : "Intervention saved."}</p>}
    </form>
  </section>;
}
