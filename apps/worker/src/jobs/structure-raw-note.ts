import { randomUUID } from "node:crypto";
import type { NoteStructurer, StructureNoteInput } from "@tutorloop/ai/contract";
import { idSchema, proposalDraftV1Schema, type ProposalDraftItemV1 } from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import {
  lockCurrentStructureClaim, markJobSucceeded, type StructureJobClaim,
} from "@tutorloop/db/repositories/jobs";
import {
  findProposalRunBySourceJob, insertProcessingRun, insertProposalItemDependency, insertProposalItems,
  isPersistedProposalRun, markProcessingRunReady,
} from "@tutorloop/db/repositories/proposals";
import { findRawNote } from "@tutorloop/db/repositories/raw-notes";
import { listActiveStudents } from "@tutorloop/db/repositories/students";
import type { Kysely, Transaction } from "kysely";

export type StructureJobDeps = {
  db: Kysely<Database>;
  structurer: NoteStructurer;
  now: () => Date;
};

export const JOB_LOCK_MS = 5 * 60_000;

export class StructureJobError extends Error {
  readonly code: "AI_PROCESSING_FAILED" | "INVALID_PROPOSAL_DRAFT" | "INVALID_JOB_PAYLOAD";

  constructor(code: StructureJobError["code"]) {
    super(code);
    this.code = code;
  }
}

export function withCurrentStructureClaim<T>(
  job: StructureJobClaim, { db, now }: StructureJobDeps, work: (trx: Transaction<Database>, time: Date) => Promise<T>,
): Promise<T | undefined> {
  return db.transaction().execute(async (trx) => {
    const time = now();
    const active = await lockCurrentStructureClaim(trx, job, new Date(time.getTime() - JOB_LOCK_MS));
    if (active) return work(trx, time);
  });
}

async function loadContext(
  db: Kysely<Database>, note: NonNullable<Awaited<ReturnType<typeof findRawNote>>>,
): Promise<StructureNoteInput> {
  const classId = note.class_id;
  const [students, canonicalIssues, studentIssues] = await Promise.all([
    listActiveStudents(db, classId),
    db.selectFrom("canonical_issues").select(["id", "label", "description"])
      .where("class_id", "=", classId).orderBy("id").execute(),
    db.selectFrom("student_issues")
      .innerJoin("students", (join) => join.onRef("students.id", "=", "student_issues.student_id")
        .onRef("students.class_id", "=", "student_issues.class_id"))
      .select(["student_issues.id", "student_issues.student_id", "student_issues.canonical_issue_id",
        "student_issues.manifestation", "student_issues.state", "student_issues.version"])
      .where("student_issues.class_id", "=", classId).where("students.archived_at", "is", null)
      .orderBy("student_issues.id").execute(),
  ]);
  return {
    task: note.note_type === "OBSERVATION" ? "STRUCTURE_OBSERVATION_NOTE" : "RECONCILE_REASSESSMENT_OUTCOME",
    classId,
    rawNoteId: note.id,
    body: note.body,
    observedAt: note.observed_at_utc,
    students: students.map((student) => ({
      studentId: student.id, displayLabel: student.display_label, aiAlias: student.ai_alias,
    })),
    canonicalIssues: canonicalIssues.map((issue) => ({
      canonicalIssueId: issue.id, label: issue.label, description: issue.description,
    })),
    studentIssues: studentIssues.map((issue) => ({
      studentIssueId: issue.id, studentId: issue.student_id, canonicalIssueId: issue.canonical_issue_id,
      manifestation: issue.manifestation, state: issue.state, version: issue.version,
    })),
  };
}

function canStoreJsonText(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed() && !value.includes("\u0000");
  if (value && typeof value === "object") return Object.values(value).every(canStoreJsonText);
  return true;
}

function invalidDraft(): never {
  throw new StructureJobError("INVALID_PROPOSAL_DRAFT");
}

function prepareItems(items: ProposalDraftItemV1[], input: StructureNoteInput) {
  const aliases = new Set(input.students.map(({ aiAlias }) => aiAlias));
  const canonicalIds = new Set(input.canonicalIssues.map(({ canonicalIssueId }) => canonicalIssueId));
  const studentIssueIds = new Set(input.studentIssues.map(({ studentIssueId }) => studentIssueId));
  const entries = items.map((item) => ({ id: randomUUID(), item }));
  const byKey = new Map(entries.map((entry) => [entry.item.key, entry]));

  return entries.map(({ id, item }) => {
    if ("studentRef" in item && item.studentRef.kind === "RESOLVED" &&
      !aliases.has(item.studentRef.studentAlias)) invalidDraft();

    let dependencyId: string | null = null;
    if ("canonicalIssueRef" in item) {
      const ref = item.canonicalIssueRef;
      if (ref.kind === "PROPOSED") {
        const dependency = byKey.get(ref.proposalKey);
        if (dependency?.item.type !== "CREATE_CANONICAL_ISSUE") invalidDraft();
        dependencyId = dependency.id;
      } else if (ref.kind === "EXISTING" && !canonicalIds.has(ref.canonicalIssueId.toLowerCase())) {
        invalidDraft();
      }
    }
    const issueRef = "studentIssueRef" in item ? item.studentIssueRef : null;
    if (issueRef?.kind === "PROPOSED") {
      const dependency = byKey.get(issueRef.proposalKey);
      if (dependency?.item.type !== "CREATE_STUDENT_ISSUE") invalidDraft();
      dependencyId = dependency.id;
    } else if (issueRef?.kind === "EXISTING" && !studentIssueIds.has(issueRef.studentIssueId.toLowerCase())) {
      invalidDraft();
    }

    const baseVersion = "expectedVersion" in item ? item.expectedVersion : null;
    if (baseVersion !== null && baseVersion > 2_147_483_647) invalidDraft();
    return {
      id, item, dependencyId, baseVersion,
      targetId: baseVersion !== null && issueRef?.kind === "EXISTING" ? issueRef.studentIssueId : null,
    };
  });
}

export async function processStructureRawNoteJob(job: StructureJobClaim, deps: StructureJobDeps): Promise<void> {
  const preparation = await withCurrentStructureClaim(job, deps, async (trx, now) => {
    const run = await findProposalRunBySourceJob(trx, job.id);
    if (run && isPersistedProposalRun(run.status)) return { kind: "persisted" } as const;

    const { classId, rawNoteId } = job.payload;
    if (typeof classId !== "string" || !idSchema.safeParse(classId).success ||
      typeof rawNoteId !== "string" || !idSchema.safeParse(rawNoteId).success) {
      throw new StructureJobError("INVALID_JOB_PAYLOAD");
    }
    const note = await findRawNote(trx, classId, rawNoteId);
    if (!note || (run && (run.status !== "PROCESSING" || run.class_id !== note.class_id ||
      run.raw_note_id !== note.id))) {
      throw new StructureJobError("INVALID_JOB_PAYLOAD");
    }
    const processingRun = run ?? await insertProcessingRun(trx, note.class_id, note.id, job.id, now);
    return { kind: "processing", note, run: processingRun } as const;
  });
  if (!preparation) return;

  if (preparation.kind === "processing") {
    const { note, run } = preparation;
    const input = await loadContext(deps.db, note);
    let output: unknown;
    try {
      output = await deps.structurer.structureNote(input);
    } catch {
      throw new StructureJobError("AI_PROCESSING_FAILED");
    }
    const draft = proposalDraftV1Schema.safeParse(output);
    if (!draft.success || !canStoreJsonText(draft.data)) invalidDraft();
    const items = prepareItems(draft.data.items, input);

    const persisted = await withCurrentStructureClaim(job, deps, async (trx, now) => {
      await insertProposalItems(trx, items.map(({ id, item, baseVersion, targetId }) => ({
        id, class_id: run.class_id, proposal_run_id: run.id, item_type: item.type, original_payload: item,
        status: "PENDING", target_entity_type: targetId ? "STUDENT_ISSUE" : null, target_entity_id: targetId,
        base_version: baseVersion, created_at: now,
      })));
      for (const { id, dependencyId } of items) {
        if (dependencyId) await insertProposalItemDependency(trx, id, dependencyId);
      }
      await markProcessingRunReady(trx, run.id, now);
      return true;
    });
    if (!persisted) return;
  }

  // A crash after the items transaction leaves the READY run available to the next worker.
  await withCurrentStructureClaim(job, deps, (trx, now) => markJobSucceeded(trx, job.id, now));
}
