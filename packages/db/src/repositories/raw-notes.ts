import { type Insertable, type Kysely, sql, type Transaction } from "kysely";
import type { Database } from "../database.ts";

type Db = Kysely<Database>;
type CaptureRow = Omit<Insertable<Database["raw_notes"]>, "observed_at" | "client_request_id"> & {
  observed_at: string;
  client_request_id: string;
};

// The pg Date parser drops sub-millisecond precision. Read the exact fraction separately.
const observedAtMicros = sql<string>`to_char(observed_at, 'US')`.as("observed_at_micros");

export function insertRawNote(db: Transaction<Database>, values: CaptureRow) {
  // ISO year 0000 is 1 BC in PostgreSQL.
  const timestamp = values.observed_at.startsWith("0000-")
    ? `0001${values.observed_at.slice(4)} BC`
    : values.observed_at;
  return db.insertInto("raw_notes").values({ ...values, observed_at: sql<Date>`${timestamp}::timestamptz` })
    .onConflict((conflict) => conflict.columns(["author_user_id", "client_request_id"])
      .where("client_request_id", "is not", null).doNothing())
    .returningAll().returning(observedAtMicros).executeTakeFirst();
}

export function findRawNoteByRequest(db: Db, classId: string, authorId: string, requestId: string) {
  return db.selectFrom("raw_notes").selectAll().select(observedAtMicros)
    .where("class_id", "=", classId)
    .where("author_user_id", "=", authorId)
    .where("client_request_id", "=", requestId)
    .executeTakeFirst();
}

export function findRawNote(db: Db, classId: string, rawNoteId: string) {
  return db.selectFrom("raw_notes").selectAll().select(observedAtMicros)
    .where("class_id", "=", classId).where("id", "=", rawNoteId).executeTakeFirst();
}

export function findCaptureReassessment(db: Db, classId: string, reassessmentId: string) {
  return db.selectFrom("reassessments").select("id")
    .where("class_id", "=", classId).where("id", "=", reassessmentId).executeTakeFirst();
}

export function markRawNoteVoided(db: Db, classId: string, rawNoteId: string, reason: string | null) {
  return db.updateTable("raw_notes").set({ voided_at: new Date(), void_reason: reason })
    .where("class_id", "=", classId).where("id", "=", rawNoteId).where("voided_at", "is", null)
    .returningAll().returning(observedAtMicros).executeTakeFirst();
}
