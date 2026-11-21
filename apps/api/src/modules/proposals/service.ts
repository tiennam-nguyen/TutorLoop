import { createHash, randomUUID } from "node:crypto";
import {
  idSchema, type ProposalDecisionBatchInput, type ProposalDecisionInput, type ProposalDraftItemV1,
  proposalDraftItemV1Schema, type ProposalItemType, type ProposalRunDetailDto, type StudentIssueDto, type StudentRef,
  type UpdateStudentIssueManifestationInput, type UpdateStudentIssueStateInput,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import { insertProposalEvidence } from "@tutorloop/db/repositories/evidence";
import {
  appendStudentIssueTransition, auditManifestationEdit, findCanonicalIssue, insertCanonicalIssue, insertStudentIssue,
  lockStudentIssues, type StudentIssueRow, updateStudentIssueAtVersion,
} from "@tutorloop/db/repositories/issues";
import {
  claimProposalDecisionReceipt, findProposalRun, listProposalItems, lockProposalRun, recordProposalDecision,
  updateProposalReviewStatus,
} from "@tutorloop/db/repositories/proposals";
import { findRawNote } from "@tutorloop/db/repositories/raw-notes";
import { findStudentByAlias, lockStudentsByAlias } from "@tutorloop/db/repositories/students";
import { assertIssueTransition, orderApprovedProposalItems } from "@tutorloop/domain";
import type { Kysely, Transaction } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";
import { normalizeObservedAt, toRawNoteDto } from "../raw-notes/service.ts";

type Db = Kysely<Database>;
type Tx = Transaction<Database>;
type Run = NonNullable<Awaited<ReturnType<typeof findProposalRun>>>;
type Note = NonNullable<Awaited<ReturnType<typeof findRawNote>>>;
type Item = Awaited<ReturnType<typeof listProposalItems>>[number];
type Approval = { item: Item; patch: Item["teacher_patch"]; payload: ProposalDraftItemV1; studentIssue?: EntityLink };
type EntityLink = { entityId: string } | { proposalItemId: string };
type Result = { id: string; type: "CANONICAL_ISSUE" | "STUDENT_ISSUE" | "EVIDENCE_EVENT" };

function notFound(entity: string): never {
  throw new ApiError("NOT_FOUND", `${entity} not found.`);
}

function requireId(id: string, entity: string): string {
  if (!idSchema.safeParse(id).success) notFound(entity);
  return id.toLowerCase();
}

function verifyVersion(version: number | undefined, expected: number): void {
  if (version !== expected) throw new ApiError("STALE_VERSION", "Student Issue has changed.");
}

function dependencyError(): never {
  throw new ApiError("PROPOSAL_DEPENDENCY_UNSATISFIED", "An approved explicit proposal dependency is required.");
}

function requireStorableText(value: string | null | undefined): void {
  if (typeof value === "string" && (!value.isWellFormed() || value.includes("\u0000"))) {
    throw new ApiError("VALIDATION_ERROR", "Invalid request text.");
  }
}

function hashDecisions(items: ProposalDecisionInput[]): string {
  let json: string;
  try {
    json = JSON.stringify(items, (_key, value: unknown) => {
      if (typeof value === "string") requireStorableText(value);
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1);
      for (const [key] of entries) requireStorableText(key);
      return Object.fromEntries(entries);
    });
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Invalid decision batch.");
  }
  return createHash("sha256").update(json).digest("hex");
}

function toRunDetail(run: Run, note: Note, items: Item[]): ProposalRunDetailDto {
  if (run.schema_version !== "1") throw new Error("Unexpected proposal schema version.");
  return {
    id: run.id, classId: run.class_id, rawNote: toRawNoteDto(note), status: run.status, schemaVersion: run.schema_version,
    items: items.map((item) => ({
      id: item.id, itemType: item.item_type, status: item.status,
      originalPayload: proposalDraftItemV1Schema.parse(item.original_payload), teacherPatch: item.teacher_patch,
      dependencyIds: item.dependency_ids, targetEntityType: item.target_entity_type, targetEntityId: item.target_entity_id,
      baseVersion: item.base_version, resultEntityType: item.result_entity_type, resultEntityId: item.result_entity_id,
      decidedAt: item.decided_at?.toISOString() ?? null, createdAt: item.created_at.toISOString(),
    })),
    createdAt: run.created_at.toISOString(), updatedAt: run.updated_at.toISOString(),
  };
}

async function sourceNote(db: Db, run: Run): Promise<Note> {
  const note = await findRawNote(db, run.class_id, run.raw_note_id);
  if (!note) throw new Error("Missing proposal source note.");
  return note;
}

export function getProposalRun(db: Db, principal: AuthPrincipal, classId: string, proposalRunId: string) {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const run = await findProposalRun(trx, classroom.id, requireId(proposalRunId, "Proposal Run"));
    if (!run) notFound("Proposal Run");
    return toRunDetail(run, await sourceNote(trx, run), await listProposalItems(trx, run.class_id, run.id));
  });
}

function indexDecisions(items: Item[], input: ProposalDecisionInput[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const submitted = new Map<string, ProposalDecisionInput>();
  for (const decision of input) {
    const id = decision.proposalItemId.toLowerCase();
    const row = byId.get(id);
    if (!row) notFound("Proposal Item");
    if (submitted.has(id)) throw new ApiError("VALIDATION_ERROR", "A Proposal Item can occur only once per batch.");
    if (row.status !== "PENDING") {
      throw new ApiError("PROPOSAL_ITEM_ALREADY_DECIDED", "The Proposal Item has already been decided.");
    }
    submitted.set(id, decision);
  }
  return { byId, submitted };
}

function orderedApprovals(items: Item[], submitted: Map<string, ProposalDecisionInput>) {
  try {
    return orderApprovedProposalItems(items.map((item) => ({
      id: item.id, status: item.status, dependencyIds: item.dependency_ids, decision: submitted.get(item.id)?.decision,
    })));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "PROPOSAL_DEPENDENCY_UNSATISFIED") dependencyError();
    throw error;
  }
}

function resolvedPayload(item: Item, patch: Item["teacher_patch"]): ProposalDraftItemV1 {
  const parsed = proposalDraftItemV1Schema.safeParse({ ...item.original_payload, ...patch });
  if (!parsed.success || parsed.data.type !== item.item_type || parsed.data.type !== item.original_payload.type ||
    parsed.data.key !== item.original_payload.key) {
    throw new ApiError("VALIDATION_ERROR", "Invalid resolved Proposal Item.");
  }
  return parsed.data;
}

function proposedEntity(
  item: Item, byKey: Map<unknown, Item>, key: string, itemType: ProposalItemType, entityType: Result["type"],
): EntityLink {
  const prerequisite = byKey.get(key);
  if (prerequisite?.item_type !== itemType || !item.dependency_ids.includes(prerequisite.id)) dependencyError();
  if (prerequisite.status !== "APPROVED") return { proposalItemId: prerequisite.id };
  if (prerequisite.result_entity_type !== entityType || !prerequisite.result_entity_id) dependencyError();
  return { entityId: prerequisite.result_entity_id };
}

function referencedEntity(link: EntityLink, results: Map<string, Result>): string {
  if ("entityId" in link) return link.entityId;
  const result = results.get(link.proposalItemId);
  if (!result) dependencyError();
  return result.id;
}

function prepareApproval(item: Item, decision: ProposalDecisionInput, byKey: Map<unknown, Item>): Approval {
  const patch = decision.decision === "EDIT_AND_APPROVE" ? decision.patch : null;
  const payload = resolvedPayload(item, patch);
  const ref = "studentIssueRef" in payload ? payload.studentIssueRef : null;
  if (!ref) return { item, patch, payload };
  const studentIssue = ref.kind === "EXISTING"
    ? { entityId: requireId(ref.studentIssueId, "Student Issue") }
    : proposedEntity(item, byKey, ref.proposalKey, "CREATE_STUDENT_ISSUE", "STUDENT_ISSUE");
  return { item, patch, payload, studentIssue };
}

async function loadLockedIssues(trx: Tx, classId: string, approvals: Approval[]) {
  const ids = new Set<string>();
  for (const { item, studentIssue } of approvals) {
    if (item.target_entity_id) ids.add(item.target_entity_id);
    if (studentIssue && "entityId" in studentIssue) ids.add(studentIssue.entityId);
  }
  const rows = await lockStudentIssues(trx, classId, [...ids]);
  if (rows.length !== ids.size) notFound("Student Issue");
  return {
    current: new Map(rows.map((row) => [row.id, row])),
    baseVersions: new Map(rows.map((row) => [row.id, row.version])),
  };
}

function resolvedStudentAlias(ref: StudentRef): string {
  if (ref.kind !== "RESOLVED") {
    throw new ApiError("VALIDATION_ERROR", "Resolve the student identity before approval.");
  }
  return ref.studentAlias;
}

async function lockCreationStudents(trx: Tx, classId: string, approvals: Approval[]) {
  const aliases = new Set<string>();
  for (const { payload } of approvals) {
    if (payload.type === "CREATE_STUDENT_ISSUE") aliases.add(resolvedStudentAlias(payload.studentRef));
  }
  const students = await lockStudentsByAlias(trx, classId, [...aliases]);
  if (students.length !== aliases.size) notFound("Student");
  return new Map(students.map((student) => [student.ai_alias, student.id]));
}

type BatchContext = {
  trx: Tx; note: Note; actor: string; now: Date; byKey: Map<unknown, Item>; results: Map<string, Result>;
  creationStudents: Map<string, string>;
  issues: Awaited<ReturnType<typeof loadLockedIssues>>;
};

async function resolveStudent(ref: StudentRef, { trx, note, creationStudents }: BatchContext): Promise<string> {
  const alias = resolvedStudentAlias(ref);
  const id = creationStudents.get(alias) ?? (await findStudentByAlias(trx, note.class_id, alias))?.id;
  if (!id) notFound("Student");
  return id;
}

function resolveStudentIssue(link: EntityLink, context: BatchContext): StudentIssueRow {
  const issue = context.issues.current.get(referencedEntity(link, context.results));
  if (!issue) notFound("Student Issue");
  return issue;
}

async function applyApproval(approval: Approval, context: BatchContext): Promise<Result> {
  const { trx, note, actor, now, byKey, results, issues } = context;
  const { item, patch, payload, studentIssue } = approval;
  const classId = note.class_id;
  switch (payload.type) {
    case "CREATE_CANONICAL_ISSUE": {
      const row = await insertCanonicalIssue(trx, {
        id: randomUUID(), class_id: classId, label: payload.label, description: payload.description ?? null,
        created_at: now, updated_at: now,
      });
      return { id: row.id, type: "CANONICAL_ISSUE" };
    }
    case "CREATE_STUDENT_ISSUE": {
      const studentId = await resolveStudent(payload.studentRef, context);
      const ref = payload.canonicalIssueRef;
      if (ref.kind === "AMBIGUOUS") {
        throw new ApiError("VALIDATION_ERROR", "Resolve the Canonical Issue before approval.");
      }
      const canonicalId = ref.kind === "EXISTING" ? requireId(ref.canonicalIssueId, "Canonical Issue")
        : referencedEntity(proposedEntity(item, byKey, ref.proposalKey, "CREATE_CANONICAL_ISSUE", "CANONICAL_ISSUE"), results);
      if (!await findCanonicalIssue(trx, classId, canonicalId)) notFound("Canonical Issue");
      const row = await insertStudentIssue(trx, {
        id: randomUUID(), class_id: classId, student_id: studentId, canonical_issue_id: canonicalId,
        state: "OPEN", manifestation: payload.manifestation ?? null, created_at: now, updated_at: now,
      });
      if (!row) throw new ApiError("VALIDATION_ERROR", "The Student already has this Canonical Issue.");
      issues.current.set(row.id, row);
      issues.baseVersions.set(row.id, row.version);
      return { id: row.id, type: "STUDENT_ISSUE" };
    }
    case "CREATE_EVIDENCE": {
      const studentId = await resolveStudent(payload.studentRef, context);
      const linkedIssue = studentIssue ? resolveStudentIssue(studentIssue, context) : null;
      if (linkedIssue && linkedIssue.student_id !== studentId) notFound("Student Issue");
      const patchTimestamp = patch && Object.hasOwn(patch, "observedAt") && payload.observedAt !== undefined
        ? normalizeObservedAt(payload.observedAt) : undefined;
      const row = await insertProposalEvidence(trx, {
        id: randomUUID(), class_id: classId, student_id: studentId, student_issue_id: linkedIssue?.id ?? null,
        raw_note_id: note.id, reassessment_id: note.reassessment_id, observation_text: payload.observationText,
        learning_context: payload.learningContext ?? null, proposal_item_id: item.id,
        approved_by_user_id: actor, created_at: now,
      }, patchTimestamp);
      return { id: row.id, type: "EVIDENCE_EVENT" };
    }
    case "UPDATE_MANIFESTATION":
    case "TRANSITION_STUDENT_ISSUE": {
      if (!studentIssue) throw new Error("Missing versioned Student Issue target.");
      const issue = resolveStudentIssue(studentIssue, context);
      // Compare proposals with the locked starting version and writes with the latest version in this transaction.
      verifyVersion(issues.baseVersions.get(issue.id), payload.expectedVersion);
      if (item.base_version !== null) {
        verifyVersion(issues.baseVersions.get(item.target_entity_id ?? issue.id), item.base_version);
      }
      const changed = payload.type === "UPDATE_MANIFESTATION"
        ? await changeManifestation(trx, issue, payload.manifestation, actor, now)
        : await changeIssueState(trx, issue, payload, actor, now, item.id);
      issues.current.set(issue.id, changed);
      return { id: issue.id, type: "STUDENT_ISSUE" };
    }
  }
}

export function applyProposalDecisions(
  db: Db, principal: AuthPrincipal, classId: string, proposalRunId: string, input: ProposalDecisionBatchInput,
): Promise<ProposalRunDetailDto> {
  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const run = await lockProposalRun(trx, classroom.id, requireId(proposalRunId, "Proposal Run"));
    if (!run) notFound("Proposal Run");
    const inputHash = hashDecisions(input.items);
    const claim = await claimProposalDecisionReceipt(trx, {
      actor_user_id: principal.userId, client_request_id: input.clientRequestId, class_id: run.class_id,
      proposal_run_id: run.id, input_hash: inputHash,
    });
    const items = await listProposalItems(trx, run.class_id, run.id);
    const note = await sourceNote(trx, run);
    if (!claim.inserted) {
      if (claim.receipt.class_id !== run.class_id || claim.receipt.proposal_run_id !== run.id ||
        claim.receipt.input_hash !== inputHash) {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "The request ID was already used with different input.");
      }
      return toRunDetail(run, note, items);
    }

    const { byId, submitted } = indexDecisions(items, input.items);
    if (run.status !== "READY" && run.status !== "PARTIALLY_REVIEWED") {
      throw new ApiError("VALIDATION_ERROR", "The Proposal Run is unavailable for review.");
    }
    const byKey = new Map(items.map((item) => [item.original_payload.key, item]));
    const approvals = orderedApprovals(items, submitted).map((id) => prepareApproval(byId.get(id)!, submitted.get(id)!, byKey));
    // Lock the owning Students before issue rows so overlapping batches serialize even when their issue pairs are absent.
    const creationStudents = await lockCreationStudents(trx, run.class_id, approvals);
    const issues = await loadLockedIssues(trx, run.class_id, approvals);
    const now = new Date();
    const context: BatchContext = { trx, note, actor: principal.userId, now, byKey, results: new Map(), creationStudents, issues };
    for (const approval of approvals) {
      const result = await applyApproval(approval, context);
      context.results.set(approval.item.id, result);
    }
    for (const [id, decision] of submitted) {
      const result = context.results.get(id);
      await recordProposalDecision(trx, run.class_id, run.id, id, {
        status: decision.decision === "REJECT" ? "REJECTED" : "APPROVED",
        teacher_patch: decision.decision === "EDIT_AND_APPROVE" ? decision.patch : null,
        decided_by_user_id: principal.userId, decided_at: now, result_entity_type: result?.type ?? null,
        result_entity_id: result?.id ?? null,
      });
    }
    const updated = await updateProposalReviewStatus(trx, run.class_id, run.id, now);
    return toRunDetail(updated, note, await listProposalItems(trx, run.class_id, run.id));
  });
}

async function changeIssueState(
  trx: Tx, issue: StudentIssueRow, input: { toState: StudentIssueRow["state"]; reason?: string | null },
  actor: string, now: Date, proposalItemId: string | null = null,
) {
  try {
    assertIssueTransition(issue.state, input.toState);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "INVALID_ISSUE_TRANSITION") {
      throw new ApiError("INVALID_ISSUE_TRANSITION", error.message);
    }
    throw error;
  }
  const updated = await updateStudentIssueAtVersion(trx, issue, { state: input.toState }, now);
  await appendStudentIssueTransition(trx, {
    class_id: issue.class_id, student_issue_id: issue.id, from_state: issue.state, to_state: input.toState,
    proposal_item_id: proposalItemId, evidence_event_id: null, actor_user_id: actor, reason: input.reason ?? null,
    created_at: now,
  });
  return updated;
}

async function changeManifestation(trx: Tx, issue: StudentIssueRow, manifestation: string | null, actor: string, now: Date) {
  const updated = await updateStudentIssueAtVersion(trx, issue, { manifestation }, now);
  await auditManifestationEdit(trx, issue, actor, now);
  return updated;
}

function changeOwnedIssue(
  db: Db, principal: AuthPrincipal, classId: string, id: string, expectedVersion: number,
  change: (trx: Tx, issue: StudentIssueRow, now: Date) => Promise<StudentIssueRow>,
): Promise<StudentIssueDto> {
  return db.transaction().execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const [issue] = await lockStudentIssues(trx, classroom.id, [requireId(id, "Student Issue")]);
    if (!issue) notFound("Student Issue");
    verifyVersion(issue.version, expectedVersion);
    const updated = await change(trx, issue, new Date());
    return {
      id: updated.id, classId: updated.class_id, studentId: updated.student_id, canonicalIssueId: updated.canonical_issue_id,
      state: updated.state, manifestation: updated.manifestation, version: updated.version,
      createdAt: updated.created_at.toISOString(), updatedAt: updated.updated_at.toISOString(),
    };
  });
}

export function updateStudentIssueState(
  db: Db, principal: AuthPrincipal, classId: string, id: string, input: UpdateStudentIssueStateInput,
) {
  requireStorableText(input.reason);
  return changeOwnedIssue(db, principal, classId, id, input.expectedVersion,
    (trx, issue, now) => changeIssueState(trx, issue, input, principal.userId, now));
}

export function updateStudentIssueManifestation(
  db: Db, principal: AuthPrincipal, classId: string, id: string, input: UpdateStudentIssueManifestationInput,
) {
  requireStorableText(input.manifestation);
  return changeOwnedIssue(db, principal, classId, id, input.expectedVersion,
    (trx, issue, now) => changeManifestation(trx, issue, input.manifestation, principal.userId, now));
}
