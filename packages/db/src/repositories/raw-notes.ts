import { type Expression, type Insertable, type Kysely, sql, type Transaction } from "kysely";
import type { Database } from "../database.ts";

type Db = Kysely<Database>;
type CaptureRow = Omit<Insertable<Database["raw_notes"]>, "observed_at" | "client_request_id" | "created_at"> & {
  observed_at: string;
  client_request_id: string;
  created_at?: Date;
};

// Format in PostgreSQL to preserve microseconds and calendar fields, including ISO year 0000 (1 BC).
export function formatUtcTimestamp(column: Expression<Date>) {
  return sql<string>`
    CASE WHEN extract(year FROM ${column} AT TIME ZONE 'UTC') = -1 THEN '0000'
      ELSE to_char(${column} AT TIME ZONE 'UTC', 'YYYY') END ||
    to_char(${column} AT TIME ZONE 'UTC', '-MM-DD"T"HH24:MI:SS.US"Z"')
  `;
}

export const observedAtUtc = formatUtcTimestamp(sql.ref("observed_at")).as("observed_at_utc");

export function exactTimestamptz(observedAt: string) {
  // ISO year 0000 is 1 BC in PostgreSQL.
  const timestamp = observedAt.startsWith("0000-") ? `0001${observedAt.slice(4)} BC` : observedAt;
  return sql<Date>`${timestamp}::timestamptz`;
}

export function insertRawNote(db: Transaction<Database>, values: CaptureRow) {
  return db.insertInto("raw_notes").values({
    ...values, observed_at: exactTimestamptz(values.observed_at),
    created_at: values.created_at ?? sql<Date>`clock_timestamp()`,
  })
    .onConflict((conflict) => conflict.columns(["author_user_id", "client_request_id"])
      .where("client_request_id", "is not", null).doNothing())
    .returningAll().returning(observedAtUtc).executeTakeFirst();
}

export function findRawNoteByRequest(db: Db, classId: string, authorId: string, requestId: string) {
  return db.selectFrom("raw_notes").selectAll().select(observedAtUtc)
    .where("class_id", "=", classId)
    .where("author_user_id", "=", authorId)
    .where("client_request_id", "=", requestId)
    .executeTakeFirst();
}

export function findRawNote(db: Db, classId: string, rawNoteId: string) {
  return db.selectFrom("raw_notes").selectAll().select(observedAtUtc)
    .where("class_id", "=", classId).where("id", "=", rawNoteId).executeTakeFirst();
}

export function lockRawNote(db: Transaction<Database>, classId: string, rawNoteId: string) {
  return db.selectFrom("raw_notes").selectAll().select(observedAtUtc)
    .where("class_id", "=", classId).where("id", "=", rawNoteId).forUpdate().executeTakeFirst();
}

export function lockCaptureReassessment(db: Transaction<Database>, classId: string, reassessmentId: string) {
  return db.selectFrom("reassessments").select(["id", "class_id", "status", "version", "performed_at"])
    .where("class_id", "=", classId).where("id", "=", reassessmentId).forUpdate().executeTakeFirst();
}

export function markRawNoteVoided(db: Db, classId: string, rawNoteId: string, reason: string | null) {
  return db.updateTable("raw_notes").set({ voided_at: new Date(), void_reason: reason })
    .where("class_id", "=", classId).where("id", "=", rawNoteId).where("voided_at", "is", null)
    .returningAll().returning(observedAtUtc).executeTakeFirst();
}
