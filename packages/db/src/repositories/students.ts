import { type Insertable, type Kysely, sql, type Updateable } from "kysely";
import type { Database } from "../database.ts";

type StudentInsert = Insertable<Database["students"]> & { client_request_id: string; create_input_hash: string };
type StudentChanges = Pick<Updateable<Database["students"]>, "display_label" | "archived_at">;

export async function insertStudent(db: Kysely<Database>, values: StudentInsert) {
  const inserted = await db.insertInto("students").values(values)
    .onConflict((conflict) => conflict.columns(["class_id", "client_request_id"]).doNothing())
    .returningAll().executeTakeFirst();
  if (inserted) return inserted;

  return db.selectFrom("students").selectAll()
    .where("class_id", "=", values.class_id)
    .where("client_request_id", "=", values.client_request_id)
    .executeTakeFirstOrThrow();
}

export function listActiveStudents(db: Kysely<Database>, classId: string) {
  return db.selectFrom("students").selectAll()
    .where("class_id", "=", classId)
    .where("archived_at", "is", null)
    .orderBy("created_at").orderBy("id")
    .execute();
}

// History and projection callers can still resolve archived students by ID.
export function findStudent(db: Kysely<Database>, classId: string, studentId: string) {
  return db.selectFrom("students").selectAll()
    .where("class_id", "=", classId)
    .where("id", "=", studentId)
    .executeTakeFirst();
}

export function updateStudentAtVersion(
  db: Kysely<Database>, classId: string, studentId: string, expectedVersion: number, changes: StudentChanges,
) {
  return db.updateTable("students")
    .set((eb) => ({ ...changes, updated_at: new Date(), version: eb("version", "+", 1) }))
    .where("class_id", "=", classId)
    .where("id", "=", studentId)
    .where("version", "=", sql<number>`${expectedVersion}::bigint`)
    .returningAll().executeTakeFirst();
}
