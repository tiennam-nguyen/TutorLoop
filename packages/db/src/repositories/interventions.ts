import { type Insertable, type Kysely, sql, type Transaction } from "kysely";
import type { Database } from "../database.ts";
import { exactTimestamptz, formatUtcTimestamp } from "./raw-notes.ts";

type Db = Kysely<Database>;
type NewIntervention = Omit<Insertable<Database["interventions"]>, "occurred_at" | "client_request_id"> & {
  occurred_at: string;
  client_request_id: string;
};

const occurredAtUtc = formatUtcTimestamp(sql.ref("interventions.occurred_at")).as("occurred_at_utc");

export function insertIntervention(db: Transaction<Database>, values: NewIntervention) {
  return db.insertInto("interventions").values({ ...values, occurred_at: exactTimestamptz(values.occurred_at) })
    .onConflict((conflict) => conflict.columns(["created_by_user_id", "client_request_id"]).doNothing())
    .returningAll().returning(occurredAtUtc).executeTakeFirst();
}

function requestedIssues(db: Transaction<Database>, classId: string, ids: readonly string[]) {
  return db.selectFrom("student_issues").where("class_id", "=", classId)
    .where("id", "=", sql<string>`any(${ids}::uuid[])`);
}

export async function insertInterventionTargets(
  db: Transaction<Database>, classId: string, interventionId: string, ids: readonly string[],
): Promise<void> {
  await db.insertInto("intervention_targets").columns(["class_id", "intervention_id", "student_issue_id"])
    .expression(requestedIssues(db, classId, ids).select(["class_id", sql<string>`${interventionId}::uuid`.as("intervention_id"), "id"]))
    .execute();
}

export function interventionsWithTargets(db: Db, classId: string) {
  return db.selectFrom("interventions").selectAll("interventions").select(occurredAtUtc)
    .select((eb) => {
      const targets = eb.selectFrom("intervention_targets as target").select("target.student_issue_id")
        .whereRef("target.intervention_id", "=", "interventions.id")
        .whereRef("target.class_id", "=", "interventions.class_id")
        .orderBy("target.student_issue_id");
      return sql<string[]>`array(${targets})`.as("student_issue_ids");
    })
    .where("interventions.class_id", "=", classId);
}

export function findIntervention(db: Db, classId: string, id: string) {
  return interventionsWithTargets(db, classId).where("interventions.id", "=", id).executeTakeFirst();
}

export function findInterventionByRequest(db: Db, classId: string, creatorId: string, requestId: string) {
  return interventionsWithTargets(db, classId)
    .where("interventions.created_by_user_id", "=", creatorId)
    .where("interventions.client_request_id", "=", requestId).executeTakeFirst();
}
