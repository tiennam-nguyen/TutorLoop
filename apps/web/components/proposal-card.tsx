"use client";

import {
  addStudentInputSchema, proposalDraftItemV1Schema, studentIssueStateSchema,
  type CanonicalIssueDetailDto, type CanonicalIssueRef, type CanonicalIssueSummaryDto, type ProposalDraftItemV1,
  type ProposalItemDto, type StudentDto, type StudentIssueRef, type StudentIssueState, type StudentRef,
} from "@tutorloop/contracts";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { addStudent } from "../lib/api";
import { useWorkspaceError } from "../lib/session";

export type Choice = "approve" | "edit" | "reject";

export type ReviewPatch = Partial<{
  label: string;
  description: string | null;
  studentRef: StudentRef;
  canonicalIssueRef: CanonicalIssueRef;
  manifestation: string | null;
  observationText: string;
  learningContext: string | null;
  toState: StudentIssueState;
  reason: string | null;
}>;

export type ReviewDraft = { choice?: Choice; patch?: ReviewPatch };

export type ReviewContext = {
  students: StudentDto[];
  issues: CanonicalIssueSummaryDto[];
  issueDetails: CanonicalIssueDetailDto[];
  items: ProposalItemDto[];
  drafts: Record<string, ReviewDraft>;
};

const kinds = {
  CREATE_CANONICAL_ISSUE: { title: "Canonical Issue", theme: "issue" },
  CREATE_STUDENT_ISSUE: { title: "Student Issue", theme: "issue" },
  CREATE_EVIDENCE: { title: "Evidence", theme: "evidence" },
  UPDATE_MANIFESTATION: { title: "Manifestation", theme: "manifestation" },
  TRANSITION_STUDENT_ISSUE: { title: "State transition", theme: "transition" },
} satisfies Record<ProposalDraftItemV1["type"], { title: string; theme: string }>;

const states: Record<StudentIssueState, string> = {
  OPEN: "Open", IMPROVING: "Improving", RESOLVED_FOR_NOW: "Resolved for now",
};

const decisions: { id: Choice; label: string }[] = [
  { id: "approve", label: "Approve" }, { id: "edit", label: "Edit" }, { id: "reject", label: "Reject" },
];

export function proposalPayload(item: ProposalItemDto, patch?: ReviewPatch): ProposalDraftItemV1 {
  const applied = proposalDraftItemV1Schema.safeParse({ ...item.originalPayload, ...item.teacherPatch });
  return { ...(applied.success ? applied.data : item.originalPayload), ...patch };
}

function studentName(ref: StudentRef, students: StudentDto[]) {
  if (ref.kind !== "RESOLVED") return ref.token;
  return students.find(({ aiAlias }) => aiAlias === ref.studentAlias)?.displayLabel ?? ref.studentAlias;
}

export function proposalHeading(item: ProposalItemDto, context: ReviewContext): string {
  const payload = item.originalPayload;
  const title = kinds[payload.type].title;
  return "studentRef" in payload ? `${title} · ${studentName(payload.studentRef, context.students)}` : title;
}

function canonicalLabel(ref: CanonicalIssueRef, { items, issues, drafts }: ReviewContext): string {
  if (ref.kind === "AMBIGUOUS") return "Selection required";
  if (ref.kind === "EXISTING") return issues.find(({ id }) => id === ref.canonicalIssueId.toLowerCase())?.label ?? "Existing Canonical Issue";
  const original = items.find(({ originalPayload }) => originalPayload.key === ref.proposalKey);
  const payload = original && proposalPayload(original, drafts[original.id]?.patch);
  return payload?.type === "CREATE_CANONICAL_ISSUE" ? payload.label : "Proposed Canonical Issue";
}

function targetIssue(ref: StudentIssueRef, context: ReviewContext) {
  if (ref.kind === "PROPOSED") {
    const item = context.items.find(({ originalPayload }) => originalPayload.key === ref.proposalKey);
    return { label: item ? proposalHeading(item, context) : "Proposed Student Issue" };
  }
  for (const canonical of context.issueDetails) {
    const issue = canonical.studentIssues.find(({ id }) => id === ref.studentIssueId.toLowerCase());
    if (issue) return { label: `${issue.student.displayLabel} · ${canonical.label}`, issue };
  }
  return { label: "Existing Student Issue" };
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function ProposalDetails({ payload, context, pending }: { payload: ProposalDraftItemV1; context: ReviewContext; pending: boolean }) {
  switch (payload.type) {
    case "CREATE_CANONICAL_ISSUE":
      return <dl className="proposal-details">
        <Detail label="New issue">{payload.label}</Detail>
        {payload.description && <Detail label="Description">{payload.description}</Detail>}
      </dl>;
    case "CREATE_STUDENT_ISSUE":
      return <dl className="proposal-details">
        <Detail label="Student">{studentName(payload.studentRef, context.students)}</Detail>
        <Detail label="Canonical Issue">{canonicalLabel(payload.canonicalIssueRef, context)}</Detail>
        {payload.manifestation && <Detail label="Manifestation">{payload.manifestation}</Detail>}
      </dl>;
    case "CREATE_EVIDENCE":
      return <dl className="proposal-details">
        <Detail label="Observation">{payload.observationText}</Detail>
        <Detail label="Student">{studentName(payload.studentRef, context.students)}</Detail>
        {payload.studentIssueRef && <Detail label="Student Issue">{targetIssue(payload.studentIssueRef, context).label}</Detail>}
        {payload.learningContext && <Detail label="Learning context">{payload.learningContext}</Detail>}
      </dl>;
    case "UPDATE_MANIFESTATION":
    case "TRANSITION_STUDENT_ISSUE": {
      const target = targetIssue(payload.studentIssueRef, context);
      return <dl className="proposal-details">
        <Detail label="Student Issue">{target.label}</Detail>
        {payload.type === "UPDATE_MANIFESTATION" ? (
          <Detail label="Proposed manifestation">{payload.manifestation ?? "Remove manifestation"}</Detail>
        ) : <>
          {pending && target.issue && <Detail label="Current state">{states[target.issue.state]}</Detail>}
          <Detail label="Proposed state">{states[payload.toState]}</Detail>
          {payload.reason && <Detail label="Reason">{payload.reason}</Detail>}
        </>}
      </dl>;
    }
  }
}

function EditText({ label, value, multiline, onChange }: {
  label: string; value: string | null | undefined; multiline?: boolean; onChange: (value: string) => void;
}) {
  return <label>
    {label}
    {multiline ? <textarea rows={2} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
      : <input value={value ?? ""} onChange={(event) => onChange(event.target.value)} />}
  </label>;
}

function EditableFields({ payload, onPatch }: { payload: ProposalDraftItemV1; onPatch: (patch: ReviewPatch) => void }) {
  switch (payload.type) {
    case "CREATE_CANONICAL_ISSUE":
      return <>
        <EditText label="Issue label" value={payload.label} onChange={(label) => onPatch({ label })} />
        <EditText label="Description" value={payload.description} multiline onChange={(description) => onPatch({ description: description || null })} />
      </>;
    case "CREATE_STUDENT_ISSUE":
    case "UPDATE_MANIFESTATION":
      return <EditText label="Manifestation" value={payload.manifestation} multiline onChange={(manifestation) => onPatch({ manifestation: manifestation || null })} />;
    case "CREATE_EVIDENCE":
      return <>
        <EditText label="Observation" value={payload.observationText} multiline onChange={(observationText) => onPatch({ observationText })} />
        <EditText label="Learning context" value={payload.learningContext} onChange={(learningContext) => onPatch({ learningContext: learningContext || null })} />
      </>;
    case "TRANSITION_STUDENT_ISSUE":
      return <>
        <label>Proposed state
          <select value={payload.toState} onChange={(event) => onPatch({ toState: studentIssueStateSchema.parse(event.target.value) })}>
            {studentIssueStateSchema.options.map((state) => <option key={state} value={state}>{states[state]}</option>)}
          </select>
        </label>
        <EditText label="Reason" value={payload.reason} multiline onChange={(reason) => onPatch({ reason: reason || null })} />
      </>;
  }
}

function StudentSelector({ original, resolved, students, onPatch }: {
  original: StudentRef; resolved: StudentRef; students: StudentDto[]; onPatch: (patch: ReviewPatch) => void;
}) {
  const labelCounts = new Map<string, number>();
  const roster = students.map((student, index) => {
    labelCounts.set(student.displayLabel, (labelCounts.get(student.displayLabel) ?? 0) + 1);
    return { ...student, rosterPosition: index + 1 };
  });
  const candidates = original.kind === "AMBIGUOUS"
    ? roster.filter(({ aiAlias }) => original.candidateAliases.includes(aiAlias)) : roster;
  return (
    <label>
      {original.kind === "UNKNOWN" ? "Choose existing student" : "Choose student"}
      <select value={resolved.kind === "RESOLVED" ? resolved.studentAlias : ""} onChange={(event) => {
        const studentAlias = event.target.value;
        onPatch({ studentRef: studentAlias ? { kind: "RESOLVED", studentAlias } : original });
      }}>
        <option value="">Select a student</option>
        {candidates.map(({ id, aiAlias, displayLabel, rosterPosition }) => (
          <option key={id} value={aiAlias}>
            {labelCounts.get(displayLabel) === 1 ? displayLabel : `${displayLabel} (roster #${rosterPosition})`}
          </option>
        ))}
      </select>
    </label>
  );
}

function CanonicalIssueSelector({ original, resolved, issues, onPatch }: {
  original: CanonicalIssueRef; resolved: CanonicalIssueRef; issues: CanonicalIssueSummaryDto[]; onPatch: (patch: ReviewPatch) => void;
}) {
  const candidateIds = original.kind === "AMBIGUOUS" ? new Set(original.candidateIds.map((id) => id.toLowerCase())) : null;
  const candidates = issues.filter((issue) => !candidateIds || candidateIds.has(issue.id));
  return (
    <label>
      Choose Canonical Issue
      <select value={resolved.kind === "EXISTING" ? resolved.canonicalIssueId.toLowerCase() : ""} onChange={(event) => {
        const canonicalIssueId = event.target.value;
        onPatch({ canonicalIssueRef: canonicalIssueId ? { kind: "EXISTING", canonicalIssueId } : original });
      }}>
        <option value="">Select an issue</option>
        {candidates.map(({ id, label, description }) => (
          <option key={id} value={id}>
            {candidates.some((other) => other.id !== id && other.label === label) ? `${label} · ${description ?? id.slice(0, 8)}` : label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AddStudentFromProposal({ classId, token, busy, onAdding, onAdded }: {
  classId: string;
  token: string;
  busy: boolean;
  onAdding: (adding: boolean) => void;
  onAdded: (student: StudentDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(token);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const workspaceError = useWorkspaceError();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const input = addStudentInputSchema.safeParse({ displayLabel: name.trim(), clientRequestId: requestId.current ??= crypto.randomUUID() });
    if (!input.success) {
      setError("Enter a student name.");
      return;
    }
    setError(null);
    setAdding(true);
    onAdding(true);
    try {
      onAdded(await addStudent(classId, input.data));
      requestId.current = null;
      setOpen(false);
    } catch (failure) {
      setError(workspaceError(failure));
    } finally {
      setAdding(false);
      onAdding(false);
    }
  }

  return open ? (
    <form className="stack add-proposal-student" onSubmit={submit}>
      <label>Student name
        <input required autoFocus disabled={busy} value={name} onChange={(event) => {
          setName(event.target.value);
          requestId.current = null;
        }} />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy}>{adding ? "Adding…" : "Add student"}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  ) : <button type="button" disabled={busy} onClick={() => setOpen(true)}>Add student to class</button>;
}

type Props = {
  item: ProposalItemDto;
  context: ReviewContext;
  draft: ReviewDraft | undefined;
  classId: string;
  readOnly: boolean;
  busy: boolean;
  approvalAllowed: boolean;
  dependencyLabel: string | undefined;
  onChoice: (choice: Choice) => void;
  onPatch: (patch: ReviewPatch) => void;
  onAddingStudent: (adding: boolean) => void;
  onStudentAdded: (student: StudentDto) => void;
};

export function ProposalCard({ item, context, draft, classId, readOnly, busy, approvalAllowed, dependencyLabel,
  onChoice, onPatch, onAddingStudent, onStudentAdded }: Props) {
  const original = item.originalPayload;
  const payload = proposalPayload(item, draft?.patch);
  const editing = draft?.choice === "edit";
  const showStudent = "studentRef" in original && (original.studentRef.kind !== "RESOLVED" || editing);
  const showIssue = original.type === "CREATE_STUDENT_ISSUE" && (original.canonicalIssueRef.kind === "AMBIGUOUS" ||
    (editing && original.canonicalIssueRef.kind === "EXISTING"));
  const titleId = `proposal-${item.id}`;

  return (
    <article className={`panel proposal-card proposal-${kinds[original.type].theme}`} aria-labelledby={titleId}>
      <h3 id={titleId}>{proposalHeading(item, context)}</h3>
      <ProposalDetails payload={payload} context={context} pending={item.status === "PENDING"} />
      {readOnly ? <p className="muted proposal-status">{({
        APPROVED: "Approved", REJECTED: "Rejected", SUPERSEDED: "Superseded", PENDING: "Awaiting review",
      })[item.status]}</p> : (
        <div className="proposal-controls">
          <fieldset className="stack" disabled={busy}>
            {showStudent && "studentRef" in payload && (
              <StudentSelector original={original.studentRef} resolved={payload.studentRef} students={context.students} onPatch={onPatch} />
            )}
            {showIssue && payload.type === "CREATE_STUDENT_ISSUE" && (
              <CanonicalIssueSelector original={original.canonicalIssueRef} resolved={payload.canonicalIssueRef} issues={context.issues} onPatch={onPatch} />
            )}
            {editing && <EditableFields payload={payload} onPatch={onPatch} />}
          </fieldset>
          {"studentRef" in original && original.studentRef.kind === "UNKNOWN" &&
            "studentRef" in payload && payload.studentRef.kind !== "RESOLVED" && (
            <AddStudentFromProposal classId={classId} token={original.studentRef.token} busy={busy}
              onAdding={onAddingStudent} onAdded={onStudentAdded} />
          )}
          {dependencyLabel && <p className="muted">Requires approval of {dependencyLabel}.</p>}
          <div className="actions">
            {decisions.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={draft?.choice === id}
                disabled={busy || (id === "approve" && !approvalAllowed) || (id === "edit" && dependencyLabel !== undefined)}
                onClick={() => onChoice(id)}>{label}</button>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}
