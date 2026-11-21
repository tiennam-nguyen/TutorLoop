import { type Insertable, type Kysely, sql, type Updateable } from "kysely";
import type { Database } from "../database.ts";

type ClassInsert = Insertable<Database["classes"]> & { client_request_id: string; create_input_hash: string };
type ClassChanges = Pick<Updateable<Database["classes"]>, "name" | "timezone" | "archived_at">;

export async function insertClass(db: Kysely<Database>, values: ClassInsert) {
  const inserted = await db.insertInto("classes").values(values)
    .onConflict((conflict) => conflict.columns(["owner_user_id", "client_request_id"]).doNothing())
    .returningAll().executeTakeFirst();
  if (inserted) return inserted;

  // After a concurrent insert wins, this fresh statement can see the committed receipt.
  return db.selectFrom("classes").selectAll()
    .where("owner_user_id", "=", values.owner_user_id)
    .where("client_request_id", "=", values.client_request_id)
    .executeTakeFirstOrThrow();
}

export function listActiveClasses(db: Kysely<Database>, ownerUserId: string) {
  return db.selectFrom("classes").selectAll()
    .where("owner_user_id", "=", ownerUserId)
    .where("archived_at", "is", null)
    .orderBy("created_at").orderBy("id")
    .execute();
}

export function updateClassAtVersion(
  db: Kysely<Database>, ownerUserId: string, classId: string, expectedVersion: number, changes: ClassChanges,
) {
  return db.updateTable("classes")
    .set((eb) => ({ ...changes, updated_at: new Date(), version: eb("version", "+", 1) }))
    .where("id", "=", classId)
    .where("owner_user_id", "=", ownerUserId)
    .where("version", "=", sql<number>`${expectedVersion}::bigint`)
    .returningAll().executeTakeFirst();
}
