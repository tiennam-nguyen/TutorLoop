import { randomUUID } from "node:crypto";
import { type Insertable, type Kysely, type Selectable, type Transaction, type Updateable, sql } from "kysely";
import type { Database } from "../database.ts";

export type StudentIssueRow = Selectable<Database["student_issues"]>;

export function findCanonicalIssue(db: Kysely<Database>, classId: string, id: string) {
  return db.selectFrom("canonical_issues").select("id").where("class_id", "=", classId).where("id", "=", id)
    .executeTakeFirst();
}

export function insertCanonicalIssue(db: Transaction<Database>, values: Insertable<Database["canonical_issues"]>) {
  return db.insertInto("canonical_issues").values(values).returning("id").executeTakeFirstOrThrow();
}

export function insertStudentIssue(db: Transaction<Database>, values: Insertable<Database["student_issues"]>) {
  return db.insertInto("student_issues").values(values)
    .onConflict((conflict) => conflict.columns(["student_id", "canonical_issue_id"]).doNothing())
    .returningAll().executeTakeFirst();
}

export function lockStudentIssues(db: Transaction<Database>, classId: string, ids: string[]) {
  if (!ids.length) return Promise.resolve([]);
  return db.selectFrom("student_issues").selectAll().where("class_id", "=", classId).where("id", "in", ids)
    .orderBy("id").forNoKeyUpdate().execute();
}

type IssueChanges = Pick<Updateable<Database["student_issues"]>, "manifestation" | "state">;

export function updateStudentIssueAtVersion(db: Transaction<Database>, issue: StudentIssueRow, changes: IssueChanges, now: Date) {
  return db.updateTable("student_issues")
    .set((eb) => ({ ...changes, updated_at: now, version: eb("version", "+", 1) }))
    .where("class_id", "=", issue.class_id).where("id", "=", issue.id)
    .where("version", "=", sql<number>`${issue.version}::bigint`).returningAll().executeTakeFirstOrThrow();
}

export async function appendStudentIssueTransition(
  db: Transaction<Database>, values: Omit<Insertable<Database["student_issue_transitions"]>, "id">,
): Promise<void> {
  await db.insertInto("student_issue_transitions").values({ id: randomUUID(), ...values }).executeTakeFirst();
}

export async function auditManifestationEdit(db: Transaction<Database>, issue: StudentIssueRow, actor: string, now: Date) {
  await db.insertInto("audit_log").values({
    id: randomUUID(), class_id: issue.class_id, entity_type: "STUDENT_ISSUE", entity_id: issue.id,
    actor_user_id: actor, action: "UPDATE_MANIFESTATION", created_at: now,
  }).executeTakeFirst();
}
