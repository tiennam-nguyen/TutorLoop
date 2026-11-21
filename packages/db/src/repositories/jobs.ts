import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import type { Database } from "../database.ts";

const STRUCTURE_RAW_NOTE = "STRUCTURE_RAW_NOTE";
export type JobRow = Selectable<Database["jobs"]>;
export type StructureJobClaim = JobRow & { locked_by: string };

function initialStructureKey(rawNoteId: string): string {
  return `structure-raw-note:${rawNoteId}:initial`;
}

function reprocessStructureKey(rawNoteId: string, requestId: string): string {
  return `structure-raw-note:${rawNoteId}:reprocess:${requestId}`;
}

export function insertInitialStructureJob(db: Transaction<Database>, rawNoteId: string, classId: string) {
  const now = new Date();
  return db.insertInto("jobs").values({
    id: randomUUID(),
    kind: STRUCTURE_RAW_NOTE,
    dedupe_key: initialStructureKey(rawNoteId),
    payload: { rawNoteId, classId },
    status: "QUEUED",
    run_after: now,
    created_at: now,
    updated_at: now,
  }).returning("id").executeTakeFirstOrThrow();
}

export function findInitialStructureJob(db: Kysely<Database>, rawNoteId: string) {
  return db.selectFrom("jobs").select("id").where("dedupe_key", "=", initialStructureKey(rawNoteId))
    .executeTakeFirstOrThrow();
}

export function findReprocessStructureJob(db: Transaction<Database>, rawNoteId: string, requestId: string) {
  return db.selectFrom("jobs").select("id")
    .where("dedupe_key", "=", reprocessStructureKey(rawNoteId, requestId)).executeTakeFirst();
}

export function insertReprocessStructureJob(
  db: Transaction<Database>, rawNoteId: string, classId: string, requestId: string, previousJobId: string,
) {
  const now = new Date();
  return db.insertInto("jobs").values({
    id: randomUUID(),
    kind: STRUCTURE_RAW_NOTE,
    dedupe_key: reprocessStructureKey(rawNoteId, requestId),
    payload: { rawNoteId, classId },
    status: "QUEUED",
    run_after: now,
    // The Raw Note lock serializes enqueue. Preserve that order even if the clock repeats or moves backward.
    created_at: sql<Date>`greatest(clock_timestamp(), (
      select created_at + interval '1 microsecond' from jobs where id = ${previousJobId}
    ))`,
    updated_at: now,
  }).returning("id").executeTakeFirstOrThrow();
}

export function findLatestStructureAttempt(db: Kysely<Database>, classId: string, rawNoteId: string) {
  return db.selectFrom("jobs")
    .leftJoin("proposal_runs", (join) => join.onRef("proposal_runs.source_job_id", "=", "jobs.id")
      .on("proposal_runs.class_id", "=", classId).on("proposal_runs.raw_note_id", "=", rawNoteId))
    .select(["jobs.id as jobId", "jobs.status as jobStatus",
      "proposal_runs.id as proposalRunId", "proposal_runs.status as runStatus"])
    .where("jobs.kind", "=", STRUCTURE_RAW_NOTE)
    .where(sql<string>`jobs.payload ->> 'rawNoteId'`, "=", rawNoteId)
    .where(sql<string>`jobs.payload ->> 'classId'`, "=", classId)
    .orderBy("jobs.created_at", "desc").orderBy("jobs.id", "desc").limit(1).executeTakeFirst();
}

export function lockNextStructureJob(db: Transaction<Database>, now: Date, staleAt: Date, maxAttempts: number) {
  return db.selectFrom("jobs").selectAll().where("kind", "=", STRUCTURE_RAW_NOTE)
    .where((eb) => eb.or([
      eb.and([eb("status", "in", ["QUEUED", "FAILED"]), eb("run_after", "<=", now),
        eb("attempts", "<", maxAttempts)]),
      eb.and([eb("status", "=", "RUNNING"), eb.or([eb("locked_at", "<=", staleAt), eb("locked_at", "is", null)])]),
    ]))
    .orderBy("run_after").orderBy("id").limit(1).forUpdate().skipLocked().executeTakeFirst();
}

export async function startStructureJob(
  db: Transaction<Database>, job: JobRow, now: Date,
): Promise<StructureJobClaim> {
  const claim = randomUUID();
  const row = await db.updateTable("jobs").set({
    status: "RUNNING", attempts: job.attempts + 1, locked_at: now, locked_by: claim, updated_at: now,
  }).where("id", "=", job.id).returningAll().executeTakeFirstOrThrow();
  return { ...row, locked_by: claim };
}

export function lockCurrentStructureClaim(db: Transaction<Database>, job: StructureJobClaim, staleAt: Date) {
  return db.selectFrom("jobs").select("id").where("id", "=", job.id)
    .where("status", "=", "RUNNING").where("locked_by", "=", job.locked_by).where("locked_at", ">", staleAt)
    .forUpdate().executeTakeFirst();
}

export async function markJobSucceeded(db: Transaction<Database>, jobId: string, now: Date): Promise<void> {
  await db.updateTable("jobs").set({
    status: "SUCCEEDED", locked_at: null, locked_by: null, last_error_code: null, updated_at: now,
  }).where("id", "=", jobId).executeTakeFirstOrThrow();
}

export async function markJobFailure(
  db: Transaction<Database>, jobId: string, errorCode: string, now: Date, retryAt: Date | null,
): Promise<void> {
  await db.updateTable("jobs").set({
    status: retryAt ? "FAILED" : "DEAD", run_after: retryAt ?? now, locked_at: null, locked_by: null,
    last_error_code: errorCode, updated_at: now,
  }).where("id", "=", jobId).executeTakeFirstOrThrow();
}
