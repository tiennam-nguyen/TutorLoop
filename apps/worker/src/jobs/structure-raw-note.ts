import { randomUUID } from "node:crypto";
import { prepareDraftForPersistence, type NoteStructurer, type StructureNoteInput } from "@tutorloop/ai/contract";
import { AIProcessingError, type NoteRouter } from "@tutorloop/ai/router";
import { idSchema, proposalDraftV1Schema } from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import { insertAIRun } from "@tutorloop/db/repositories/ai-runs";
import { listRecentIssueEvidence } from "@tutorloop/db/repositories/evidence";
import {
  lockCurrentStructureClaim, markJobSucceeded, type StructureJobClaim,
} from "@tutorloop/db/repositories/jobs";
import {
  findProposalRunBySourceJob, insertProcessingRun, insertProposalItemDependency, insertProposalItems,
  isPersistedProposalRun, markProcessingRunReady,
} from "@tutorloop/db/repositories/proposals";
import { findRawNote } from "@tutorloop/db/repositories/raw-notes";
import { listActiveStudents } from "@tutorloop/db/repositories/students";
import { type Kysely, sql, type Transaction } from "kysely";

export type StructureJobDeps = {
  db: Kysely<Database>;
  now: () => Date;
} & ({ structurer: NoteStructurer; route?: never } | { route: NoteRouter; structurer?: never });

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
  const outcome = note.note_type === "REASSESSMENT_OUTCOME";
  const reassessmentId = outcome ? note.reassessment_id : null;
  if (outcome && reassessmentId === null) throw new StructureJobError("INVALID_JOB_PAYLOAD");

  const classIssues = db.selectFrom("student_issues")
    .innerJoin("students", (join) => join.onRef("students.id", "=", "student_issues.student_id")
      .onRef("students.class_id", "=", "student_issues.class_id"))
    .select(["student_issues.id", "student_issues.student_id", "student_issues.canonical_issue_id",
      "student_issues.manifestation", "student_issues.state", "student_issues.version"])
    .where("student_issues.class_id", "=", classId).where("students.archived_at", "is", null)
    .orderBy("student_issues.id");
  const candidateQuery = reassessmentId === null ? classIssues : classIssues.where((eb) => eb.exists(
    eb.selectFrom("reassessment_targets").select("student_issue_id")
      .where("class_id", "=", classId).where("reassessment_id", "=", reassessmentId)
      .whereRef("student_issue_id", "=", "student_issues.id"),
  ));
  const [students, studentIssues] = await Promise.all([
    listActiveStudents(db, classId),
    candidateQuery.execute(),
  ]);
  const canonicalIds = [...new Set(studentIssues.map(({ canonical_issue_id }) => canonical_issue_id))];
  const [canonicalIssues, history] = await Promise.all([
    db.selectFrom("canonical_issues").select(["id", "label", "description"])
      .where("class_id", "=", classId)
      .$if(outcome, (query) => query.where("id", "=", sql<string>`any(${canonicalIds}::uuid[])`))
      .orderBy("id").execute(),
    outcome ? listRecentIssueEvidence(db, classId, studentIssues.map(({ id }) => id)) : undefined,
  ]);
  return {
    task: outcome ? "RECONCILE_REASSESSMENT_OUTCOME" : "STRUCTURE_OBSERVATION_NOTE",
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
    ...(history?.length ? { evidenceHistory: history.map((event) => ({
      studentIssueId: event.student_issue_id, observationText: event.observation_text, learningContext: event.learning_context,
    })) } : {}),
  };
}

async function loadPrivateLabels(db: Kysely<Database>, classId: string) {
  const [classroom, archived] = await Promise.all([
    db.selectFrom("classes").select("name").where("id", "=", classId).executeTakeFirstOrThrow(),
    db.selectFrom("students").select("display_label").where("class_id", "=", classId)
      .where("archived_at", "is not", null).execute(),
  ]);
  return [classroom.name, ...archived.map(({ display_label }) => display_label)];
}

async function generateDraft(
  job: StructureJobClaim, deps: StructureJobDeps, input: StructureNoteInput, run: { id: string; class_id: string },
  privateLabels: string[] | undefined,
) {
  if (!deps.route) {
    try {
      return await deps.structurer.structureNote(input);
    } catch {
      throw new StructureJobError("AI_PROCESSING_FAILED");
    }
  }

  try {
    const { draft } = await deps.route(input, { privateLabels, onAttempt: async (attempt) => {
      const recorded = await withCurrentStructureClaim(job, deps, async (trx, now) => {
        await insertAIRun(trx, {
          class_id: run.class_id, proposal_run_id: run.id, task_type: input.task,
          provider: attempt.provider, model: attempt.model, prompt_version: attempt.promptVersion,
          schema_version: attempt.schemaVersion, redaction_version: attempt.redactionVersion,
          input_hash: attempt.inputHash, latency_ms: attempt.latencyMs, status: attempt.status,
          error_code: attempt.errorCode, usage_json: null, created_at: now,
        });
        return true;
      });
      if (!recorded) throw new StructureJobError("AI_PROCESSING_FAILED");
    } });
    return draft;
  } catch (error) {
    if (error instanceof AIProcessingError) throw new StructureJobError("AI_PROCESSING_FAILED");
    throw error;
  }
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
    // Read the roster, private labels and history cutoff from one snapshot before calling the provider.
    const [input, privateLabels] = await deps.db.transaction().setIsolationLevel("repeatable read").setAccessMode("read only")
      .execute((trx) => Promise.all([
        loadContext(trx, note),
        deps.route ? loadPrivateLabels(trx, note.class_id) : undefined,
      ]));
    const output = await generateDraft(job, deps, input, run, privateLabels);
    const draft = proposalDraftV1Schema.safeParse(output);
    const items = draft.success ? prepareDraftForPersistence(draft.data, input) : undefined;
    if (!items) throw new StructureJobError("INVALID_PROPOSAL_DRAFT");
    const ids = new Map(items.map(({ item }) => [item.key, randomUUID()]));

    const persisted = await withCurrentStructureClaim(job, deps, async (trx, now) => {
      await insertProposalItems(trx, items.map(({ item, baseVersion, targetId }) => ({
        id: ids.get(item.key)!, class_id: run.class_id, proposal_run_id: run.id, item_type: item.type, original_payload: item,
        status: "PENDING", target_entity_type: targetId ? "STUDENT_ISSUE" : null, target_entity_id: targetId,
        base_version: baseVersion, created_at: now,
      })));
      for (const { item, dependencyKey } of items) {
        if (dependencyKey !== null) await insertProposalItemDependency(trx, ids.get(item.key)!, ids.get(dependencyKey)!);
      }
      await markProcessingRunReady(trx, run.id, now);
      return true;
    });
    if (!persisted) return;
  }

  // A crash after the items transaction leaves the READY run available to the next worker.
  await withCurrentStructureClaim(job, deps, (trx, now) => markJobSucceeded(trx, job.id, now));
}
