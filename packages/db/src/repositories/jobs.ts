import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../database.ts";

function initialStructureKey(rawNoteId: string): string {
  return `structure-raw-note:${rawNoteId}:initial`;
}

export function insertInitialStructureJob(db: Transaction<Database>, rawNoteId: string, classId: string) {
  const now = new Date();
  return db.insertInto("jobs").values({
    id: randomUUID(),
    kind: "STRUCTURE_RAW_NOTE",
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
