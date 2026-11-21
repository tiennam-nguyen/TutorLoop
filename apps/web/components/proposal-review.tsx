"use client";

import {
  proposalDecisionBatchInputSchema, proposalDraftItemV1Schema,
  type CanonicalIssueDetailDto, type CanonicalIssueSummaryDto, type ClassDetailDto,
  type ProposalDecisionInput, type ProposalDraftItemV1, type ProposalItemDto, type ProposalRunDetailDto, type StudentDto,
} from "@tutorloop/contracts";
import { useRef, useState, type FormEvent } from "react";
import { applyProposalDecisions } from "../lib/api";
import { formatObservedTime } from "../lib/observed-time";
import { useWorkspaceError } from "../lib/session";
import {
  ProposalCard, proposalHeading, proposalPayload, type Choice, type ReviewContext, type ReviewDraft, type ReviewPatch,
} from "./proposal-card";

const reviewOrder = {
  CREATE_CANONICAL_ISSUE: 0, CREATE_STUDENT_ISSUE: 1, CREATE_EVIDENCE: 2, UPDATE_MANIFESTATION: 3, TRANSITION_STUDENT_ISSUE: 4,
} satisfies Record<ProposalDraftItemV1["type"], number>;

function isApproval(choice: Choice | undefined) {
  return choice === "approve" || choice === "edit";
}

function hasResolvedPayload(item: ProposalItemDto, draft: ReviewDraft | undefined) {
  const payload = proposalPayload(item, draft?.patch);
  return (!("studentRef" in payload) || payload.studentRef.kind === "RESOLVED") &&
    (!("canonicalIssueRef" in payload) || payload.canonicalIssueRef.kind !== "AMBIGUOUS") &&
    proposalDraftItemV1Schema.safeParse(payload).success &&
    Object.values(draft?.patch ?? {}).every((value) => typeof value !== "string" || (value.isWellFormed() && !value.includes("\u0000")));
}

function clearDependentApprovals(id: string, items: ProposalItemDto[], next: Record<string, ReviewDraft>) {
  const affected = new Set([id]);
  for (const prerequisite of affected) {
    for (const item of items) {
      if (affected.has(item.id) || !item.dependencyIds.includes(prerequisite)) continue;
      affected.add(item.id);
      if (isApproval(next[item.id]?.choice)) next[item.id] = { ...next[item.id], choice: undefined };
    }
  }
}

type Props = {
  classroom: ClassDetailDto;
  run: ProposalRunDetailDto;
  issues: CanonicalIssueSummaryDto[];
  issueDetails: CanonicalIssueDetailDto[];
  onApplied: (run: ProposalRunDetailDto) => void;
};

export function ProposalReview({ classroom, run, issues, issueDetails, onApplied }: Props) {
  const workspaceError = useWorkspaceError();
  const [students, setStudents] = useState(classroom.students);
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [saving, setSaving] = useState(false);
  const [addingStudent, setAddingStudent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const requestId = useRef<string | null>(null);
  const context: ReviewContext = { students, issues, issueDetails, items: run.items, drafts };
  const byId = new Map(run.items.map((item) => [item.id, item]));
  const readOnly = classroom.archivedAt !== null || !["READY", "PARTIALLY_REVIEWED"].includes(run.status);
  const busy = saving || addingStudent;

  function dependencySatisfied(id: string, ancestors: ReadonlySet<string>): boolean {
    if (ancestors.has(id)) return false;
    const item = byId.get(id);
    if (!item) return false;
    if (item.status === "APPROVED") return true;
    if (item.status !== "PENDING" || !isApproval(drafts[id]?.choice) || !hasResolvedPayload(item, drafts[id])) return false;
    return item.dependencyIds.every((dependency) => dependencySatisfied(dependency, new Set([...ancestors, id])));
  }

  const blockedBy = new Map(run.items.flatMap((item) => {
    const dependency = item.dependencyIds.find((id) => !dependencySatisfied(id, new Set([item.id])));
    return dependency ? [[item.id, dependency] as const] : [];
  }));

  const decisions: ProposalDecisionInput[] = [];
  let invalidSelection = false;
  for (const item of run.items) {
    const draft = drafts[item.id];
    if (item.status !== "PENDING" || !draft?.choice) continue;
    if (draft.choice === "reject") {
      decisions.push({ proposalItemId: item.id, decision: "REJECT" });
    } else if (blockedBy.has(item.id) || !hasResolvedPayload(item, draft)) {
      invalidSelection = true;
    } else if (draft.choice === "edit" || Object.keys(draft.patch ?? {}).length) {
      decisions.push({ proposalItemId: item.id, decision: "EDIT_AND_APPROVE", patch: draft.patch ?? {} });
    } else {
      decisions.push({ proposalItemId: item.id, decision: "APPROVE" });
    }
  }
  const canApply = !readOnly && !busy && decisions.length > 0 && !invalidSelection;
  const reviewItems = run.items.toSorted((left, right) => (
    reviewOrder[left.originalPayload.type] - reviewOrder[right.originalPayload.type] ||
    proposalHeading(left, context).localeCompare(proposalHeading(right, context))
  ));

  function changed() {
    requestId.current = null;
    setError(null);
    setApplied(false);
  }

  function selectChoice(id: string, choice: Choice) {
    changed();
    setDrafts((previous) => {
      const current = previous[id];
      const nextChoice = current?.choice === choice ? undefined : choice;
      const next = { ...previous, [id]: { ...current, choice: nextChoice } };
      if (!isApproval(nextChoice)) clearDependentApprovals(id, run.items, next);
      return next;
    });
  }

  function editItem(id: string, patch: ReviewPatch) {
    changed();
    setDrafts((previous) => ({ ...previous, [id]: { ...previous[id], patch: { ...previous[id]?.patch, ...patch } } }));
  }

  function studentAdded(itemId: string, student: StudentDto) {
    setStudents((previous) => previous.some(({ id }) => id === student.id) ? previous : [...previous, student]);
    editItem(itemId, { studentRef: { kind: "RESOLVED", studentAlias: student.aiAlias } });
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canApply) return;
    const input = proposalDecisionBatchInputSchema.safeParse({
      clientRequestId: requestId.current ??= crypto.randomUUID(), items: decisions,
    });
    if (!input.success) {
      setError("Check the selected decisions and try again.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onApplied(await applyProposalDecisions(classroom.id, run.id, input.data));
      requestId.current = null;
      setDrafts({});
      setApplied(true);
    } catch (failure) {
      setError(workspaceError(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="review-grid">
        <section className="panel review-source" aria-labelledby="source-note-heading">
          <h2 id="source-note-heading">Source note</h2>
          <p className="note-text">{run.rawNote.body}</p>
          <p className="muted source-time">Observed at <time dateTime={run.rawNote.observedAt}>
            {formatObservedTime(run.rawNote.observedAt, classroom.timezone)}
          </time> · {classroom.timezone}</p>
        </section>
        <section aria-labelledby="proposed-structure-heading">
          <h2 id="proposed-structure-heading">Proposed changes</h2>
          {run.items.length === 0 && <p className="muted">No proposed changes.</p>}
          {run.status === "PROCESSING" && <p role="status">Still structuring this note.</p>}
          {run.status === "FAILED" && <p role="status">Structuring failed. Return to the class to retry.</p>}
          <div className="review-cards">
            {reviewItems.map((item) => {
              const dependency = byId.get(blockedBy.get(item.id) ?? "");
              const blocked = blockedBy.has(item.id);
              return (
                <ProposalCard key={item.id} item={item} context={context} draft={drafts[item.id]}
                  classId={classroom.id} readOnly={readOnly || item.status !== "PENDING"} busy={busy}
                  approvalAllowed={!blocked && hasResolvedPayload(item, drafts[item.id])}
                  dependencyLabel={blocked ? (dependency ? proposalHeading(dependency, context) : "required proposal") : undefined}
                  onChoice={(choice) => selectChoice(item.id, choice)} onPatch={(patch) => editItem(item.id, patch)}
                  onAddingStudent={setAddingStudent} onStudentAdded={(student) => studentAdded(item.id, student)} />
              );
            })}
          </div>
        </section>
      </div>
      <form className="review-submit" onSubmit={apply}>
        {error && <p role="alert">{error}</p>}
        {applied && <p role="status" aria-label="Review result">Reviewed changes applied.</p>}
        {invalidSelection && <p className="muted">Resolve the selected changes before applying them.</p>}
        {!readOnly && run.items.length > 0 && (
          <button className="primary" type="submit" disabled={!canApply}>{saving ? "Applying…" : "Apply reviewed changes"}</button>
        )}
      </form>
    </>
  );
}
