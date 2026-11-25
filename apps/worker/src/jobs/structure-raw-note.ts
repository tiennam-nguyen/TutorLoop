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
import { listClassCanonicalIssues } from "@tutorloop/db/repositories/issues";
import { listActiveStudents } from "@tutorloop/db/repositories/students";
import { type Expression, type ExpressionBuilder, type Kysely, sql, type Transaction } from "kysely";

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

function targetedByReassessment(
  eb: ExpressionBuilder<Database, "students">,
  classId: string,
  reassessmentId: string,
) {
  return eb.exists(
    eb.selectFrom("reassessment_targets as target")
      .innerJoin("student_issues as issue", (join) => join
        .onRef("issue.id", "=", "target.student_issue_id")
        .onRef("issue.class_id", "=", "target.class_id"))
      .select("issue.student_id")
      .where("target.class_id", "=", classId)
      .where("target.reassessment_id", "=", reassessmentId)
      .whereRef("issue.student_id", "=", "students.id"),
  );
}

async function loadContext(
  db: Kysely<Database>, note: NonNullable<Awaited<ReturnType<typeof findRawNote>>>,
  cutoff?: Expression<Date>,
): Promise<StructureNoteInput> {
  const classId = note.class_id;
  const outcome = note.note_type === "REASSESSMENT_OUTCOME";
  const reassessmentId = outcome ? note.reassessment_id : null;
  if (outcome && reassessmentId === null) throw new StructureJobError("INVALID_JOB_PAYLOAD");

  const baseIssues = db.selectFrom("student_issues")
    .innerJoin("students", (join) => join.onRef("students.id", "=", "student_issues.student_id")
      .onRef("students.class_id", "=", "student_issues.class_id"))
    .select(["student_issues.id", "student_issues.student_id", "student_issues.canonical_issue_id",
      "student_issues.manifestation", "student_issues.state", "student_issues.version"])
    .where("student_issues.class_id", "=", classId)
    .orderBy("student_issues.id");
  const candidateQuery = reassessmentId === null
    ? baseIssues.where("students.archived_at", "is", null)
    : baseIssues.where((eb) => eb.exists(
      eb.selectFrom("reassessment_targets").select("student_issue_id")
        .where("class_id", "=", classId).where("reassessment_id", "=", reassessmentId)
        .whereRef("student_issue_id", "=", "student_issues.id"),
    ));
  const studentsQuery = reassessmentId === null
    ? listActiveStudents(db, classId)
    : db.selectFrom("students").selectAll().where("class_id", "=", classId)
      .where((eb) => eb.or([
        eb("archived_at", "is", null),
        targetedByReassessment(eb, classId, reassessmentId),
      ]))
      .orderBy("created_at").orderBy("id").execute();
  const [students, studentIssues, allCanonical, olderIssueText] = await Promise.all([
    studentsQuery,
    candidateQuery.select(afterLabelEdit("student_issues.created_at", cutoff)).execute(),
    listClassCanonicalIssues(db, classId),
    cutoff ? listOlderIssueTextSources(db, classId, cutoff) : [],
  ]);
  const olderCanonical = new Set(olderIssueText.filter(({ item_type }) => item_type === "CREATE_CANONICAL_ISSUE")
    .map(({ result_entity_id }) => result_entity_id));
  const olderManifestations = new Set(olderIssueText.filter(({ item_type }) => item_type !== "CREATE_CANONICAL_ISSUE")
    .map(({ result_entity_id }) => result_entity_id));
  const byId = new Map(allCanonical.map((issue) => [issue.id, issue]));
  function rootId(id: string) {
    const visited = new Set<string>();
    for (let hops = 0; hops <= allCanonical.length; hops++) {
      if (visited.has(id)) throw new StructureJobError("INVALID_JOB_PAYLOAD");
      visited.add(id);
      const issue = byId.get(id);
      if (!issue) throw new StructureJobError("INVALID_JOB_PAYLOAD");
      if (!issue.merged_into_id) return id;
      id = issue.merged_into_id;
    }
    throw new StructureJobError("INVALID_JOB_PAYLOAD");
  }
  const canonicalIds = [...new Set(studentIssues.map(({ canonical_issue_id }) => rootId(canonical_issue_id)))];
  const [canonicalIssues, history] = await Promise.all([
    db.selectFrom("canonical_issues").select(["id", "label", "description", "version"])
      .select(afterLabelEdit("canonical_issues.created_at", cutoff))
      .where("class_id", "=", classId).where("merged_into_id", "is", null).where("archived_at", "is", null)
      .$if(outcome, (query) => query.where("id", "=", sql<string>`any(${canonicalIds}::uuid[])`))
      .orderBy("id").execute(),
    outcome ? listRecentIssueEvidence(db, classId, studentIssues.map(({ id }) => id), cutoff) : undefined,
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
    canonicalIssues: canonicalIssues.map((issue) => {
      const sendText = issue.created_after_label_edit && !olderCanonical.has(issue.id);
      return {
        canonicalIssueId: issue.id, label: sendText ? issue.label : "[PRIVATE]",
        description: sendText ? issue.description : null, version: issue.version,
      };
    }),
    studentIssues: studentIssues.map((issue) => ({
      studentIssueId: issue.id, studentId: issue.student_id, canonicalIssueId: rootId(issue.canonical_issue_id),
      manifestation: issue.created_after_label_edit && !olderManifestations.has(issue.id) ? issue.manifestation : null,
      state: issue.state, version: issue.version,
    })),
    ...(history?.length ? { evidenceHistory: history.map((event) => ({
      studentIssueId: event.student_issue_id, observationText: event.observation_text, learningContext: event.learning_context,
    })) } : {}),
  };
}

function afterLabelEdit(column: "student_issues.created_at" | "canonical_issues.created_at", cutoff?: Expression<Date>) {
  return (cutoff ? sql<boolean>`${sql.ref(column)} > ${cutoff}` : sql<boolean>`true`).as("created_after_label_edit");
}

function listOlderIssueTextSources(db: Kysely<Database>, classId: string, cutoff: Expression<Date>) {
  // Approval can write text long after its source was captured. State changes and merges carry no issue text.
  return db.selectFrom("proposal_items as item")
    .innerJoin("proposal_runs as run", (join) => join
      .onRef("run.id", "=", "item.proposal_run_id").onRef("run.class_id", "=", "item.class_id"))
    .innerJoin("raw_notes as source", (join) => join
      .onRef("source.id", "=", "run.raw_note_id").onRef("source.class_id", "=", "run.class_id"))
    .select(["item.item_type", "item.result_entity_id"])
    .where("item.class_id", "=", classId).where("item.status", "=", "APPROVED")
    .where("item.item_type", "in", ["CREATE_CANONICAL_ISSUE", "CREATE_STUDENT_ISSUE", "UPDATE_MANIFESTATION"])
    .where("item.result_entity_id", "is not", null).where("source.created_at", "<=", cutoff)
    .execute();
}

async function loadProviderPrivacy(
  db: Kysely<Database>, classId: string, note: NonNullable<Awaited<ReturnType<typeof findRawNote>>>,
) {
  // Versions signal possible name edits. Include archived Students and keep microseconds out of JS Dates.
  const source = await db.with("private_label_edit", (cte) => cte.selectFrom("classes").select("name")
    .where("id", "=", classId)
    .select(sql<Date | null>`greatest(
      case when classes.version > 1 then classes.updated_at end,
      (select max(students.updated_at) from students where students.class_id = classes.id and students.version > 1)
    )`.as("cutoff")),
  ).selectFrom("private_label_edit").crossJoin("raw_notes")
    .select("name").select(sql<string | null>`private_label_edit.cutoff::text`.as("cutoff"))
    .select(sql<boolean>`coalesce(raw_notes.created_at > private_label_edit.cutoff, true)`.as("can_route"))
    .where("raw_notes.class_id", "=", classId).where("raw_notes.id", "=", note.id)
    .executeTakeFirstOrThrow();
  if (!source.can_route) throw new StructureJobError("AI_PROCESSING_FAILED");

  const reassessmentId = note.note_type === "REASSESSMENT_OUTCOME" ? note.reassessment_id : null;
  let archivedQuery = db.selectFrom("students").select("display_label")
    .where("class_id", "=", classId).where("archived_at", "is not", null);
  if (reassessmentId !== null) {
    archivedQuery = archivedQuery.where((eb) => eb.not(targetedByReassessment(eb, classId, reassessmentId)));
  }
  const archived = await archivedQuery.execute();
  return {
    privateLabels: [source.name, ...archived.map(({ display_label }) => display_label)],
    cutoff: source.cutoff === null ? undefined : sql<Date>`${source.cutoff}::timestamptz`,
  };
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
    // Read the roster, private labels and eligible context from one snapshot before calling the provider.
    const { input, privateLabels } = await deps.db.transaction().setIsolationLevel("repeatable read").setAccessMode("read only")
      .execute(async (trx) => {
        const privacy = deps.route ? await loadProviderPrivacy(trx, note.class_id, note) : undefined;
        return { input: await loadContext(trx, note, privacy?.cutoff), privateLabels: privacy?.privateLabels };
      });
    const output = await generateDraft(job, deps, input, run, privateLabels);
    const draft = proposalDraftV1Schema.safeParse(output);
    const items = draft.success ? prepareDraftForPersistence(draft.data, input) : undefined;
    if (!items) throw new StructureJobError("INVALID_PROPOSAL_DRAFT");
    const ids = new Map(items.map(({ item }) => [item.key, randomUUID()]));

    const persisted = await withCurrentStructureClaim(job, deps, async (trx, now) => {
      await insertProposalItems(trx, items.map(({ item, baseVersion, targetId }) => ({
        id: ids.get(item.key)!, class_id: run.class_id, proposal_run_id: run.id, item_type: item.type, original_payload: item,
        status: "PENDING", target_entity_type: targetId ? (item.type === "MERGE_CANONICAL_ISSUE" ? "CANONICAL_ISSUE" : "STUDENT_ISSUE") : null, target_entity_id: targetId,
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
