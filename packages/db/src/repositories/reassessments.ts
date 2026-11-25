import { type Insertable, type Kysely, sql, type Transaction, type Updateable } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import type { Database } from "../database.ts";
import { exactTimestamptz, formatUtcTimestamp } from "./raw-notes.ts";

type Db = Kysely<Database>;
type Trx = Transaction<Database>;
type NewReassessment = Omit<Insertable<Database["reassessments"]>, "due_at" | "client_request_id"> & {
  due_at: string;
  client_request_id: string;
};
type Target = Pick<Database["reassessment_targets"], "student_issue_id" | "intervention_id">;
type Changes = Pick<Updateable<Database["reassessments"]>, "status" | "performed_at" | "completed_at">;

function reassessmentRows(db: Db, classId: string) {
  return db.selectFrom("reassessments").where("reassessments.class_id", "=", classId);
}

export function insertReassessment(db: Trx, values: NewReassessment) {
  return db.insertInto("reassessments").values({ ...values, due_at: exactTimestamptz(values.due_at) })
    .onConflict((conflict) => conflict.columns(["created_by_user_id", "client_request_id"]).doNothing())
    .returning("id").executeTakeFirst();
}

export function lockLinkedInterventionTargets(db: Trx, classId: string, issueIds: string[], interventionIds: string[]) {
  return db.selectFrom("intervention_targets").select(["student_issue_id", "intervention_id"])
    .where("class_id", "=", classId)
    .where("student_issue_id", "=", sql<string>`any(${issueIds}::uuid[])`)
    .where("intervention_id", "=", sql<string>`any(${interventionIds}::uuid[])`)
    .orderBy("intervention_id").orderBy("student_issue_id").forKeyShare().execute();
}

export async function insertReassessmentTargets(db: Trx, classId: string, reassessmentId: string, targets: Target[]) {
  const issueIds = targets.map((target) => target.student_issue_id);
  const interventionIds = targets.map((target) => target.intervention_id);
  await db.insertInto("reassessment_targets")
    .columns(["class_id", "reassessment_id", "student_issue_id", "intervention_id", "target_status", "skip_reason"])
    .expression(sql<Database["reassessment_targets"]>`
      select ${classId}::uuid, ${reassessmentId}::uuid, student_issue_id, intervention_id,
        'PENDING'::reassessment_target_status, null
      from unnest(${issueIds}::uuid[], ${interventionIds}::uuid[]) as target(student_issue_id, intervention_id)
    `)
    .execute();
}

export function reassessmentsWithTargets(db: Db, classId: string) {
  return reassessmentRows(db, classId).selectAll("reassessments")
    .select(formatUtcTimestamp(sql.ref("reassessments.due_at")).as("due_at_utc"))
    .select((eb) => jsonArrayFrom(
      eb.selectFrom("reassessment_targets as target")
        .select(["target.student_issue_id", "target.intervention_id", "target.target_status", "target.skip_reason"])
        .whereRef("target.class_id", "=", "reassessments.class_id")
        .whereRef("target.reassessment_id", "=", "reassessments.id")
        .orderBy("target.student_issue_id"),
    ).as("targets"));
}

export function findReassessment(db: Db, classId: string, reassessmentId: string) {
  return reassessmentsWithTargets(db, classId).where("reassessments.id", "=", reassessmentId).executeTakeFirst();
}

export function findReassessmentByRequest(db: Db, classId: string, creatorId: string, requestId: string) {
  return reassessmentsWithTargets(db, classId).where("reassessments.created_by_user_id", "=", creatorId)
    .where("reassessments.client_request_id", "=", requestId).executeTakeFirst();
}

export function listDueReassessments(db: Db, classId: string, now: Date) {
  return reassessmentsWithTargets(db, classId).where((eb) => eb.or([
    eb.and([eb("reassessments.status", "=", "SCHEDULED"), eb("reassessments.due_at", "<=", now)]),
    eb("reassessments.status", "=", "PERFORMED_PENDING_EVIDENCE"),
  ])).orderBy("reassessments.due_at").orderBy("reassessments.id").execute();
}

export function listReassessmentTargetDisplay(db: Db, classId: string, issueIds: string[]) {
  // Propagate each root to its merged predecessors without rewriting historical Student Issues.
  return db.withRecursive("canonical_roots", (cte) =>
    cte.selectFrom("canonical_issues as root").select(["root.id as issue_id", "root.id as root_id", "root.label"])
      .where("root.class_id", "=", classId).where("root.merged_into_id", "is", null)
      .unionAll(cte.selectFrom("canonical_issues as source")
        .innerJoin("canonical_roots as root", "root.issue_id", "source.merged_into_id")
        .select(["source.id as issue_id", "root.root_id", "root.label"]).where("source.class_id", "=", classId)),
  ).selectFrom("student_issues as issue")
    .innerJoin("students as student", (join) => join
      .onRef("student.id", "=", "issue.student_id").onRef("student.class_id", "=", "issue.class_id"))
    .innerJoin("canonical_issues as canonical", (join) => join
      .onRef("canonical.id", "=", "issue.canonical_issue_id").onRef("canonical.class_id", "=", "issue.class_id"))
    .leftJoin("canonical_roots as root", "root.issue_id", "canonical.id")
    .select((eb) => [
      "issue.id as issue_id", "student.id as student_id", "student.display_label", "student.archived_at",
      eb.fn.coalesce("root.root_id", "canonical.id").as("canonical_id"),
      eb.fn.coalesce("root.label", "canonical.label").as("canonical_label"),
    ])
    .where("issue.class_id", "=", classId).where("issue.id", "=", sql<string>`any(${issueIds}::uuid[])`).execute();
}

export function lockReassessment(db: Trx, classId: string, reassessmentId: string) {
  return reassessmentRows(db, classId).where("reassessments.id", "=", reassessmentId)
    .select(["id", "class_id", "status", "version", "performed_at"]).forUpdate().executeTakeFirst();
}

export function updateReassessmentAtVersion(
  db: Trx, row: NonNullable<Awaited<ReturnType<typeof lockReassessment>>>, changes: Changes, now: Date,
) {
  return db.updateTable("reassessments")
    .set({ ...changes, version: row.version + 1, updated_at: now })
    .where("class_id", "=", row.class_id).where("id", "=", row.id).where("version", "=", row.version)
    .returning("id").executeTakeFirstOrThrow();
}

export function skipPendingReassessmentTarget(db: Trx, classId: string, id: string, issueId: string, skipReason: string) {
  return db.updateTable("reassessment_targets").set({ target_status: "SKIPPED", skip_reason: skipReason })
    .where("class_id", "=", classId).where("reassessment_id", "=", id).where("student_issue_id", "=", issueId)
    .where("target_status", "=", "PENDING").returning("student_issue_id").executeTakeFirstOrThrow();
}

export function markPendingReassessmentTargetsEvidenced(db: Trx, classId: string, id: string, issueIds: string[]) {
  return db.updateTable("reassessment_targets").set({ target_status: "EVIDENCED" })
    .where("class_id", "=", classId).where("reassessment_id", "=", id)
    .where("student_issue_id", "=", sql<string>`any(${issueIds}::uuid[])`)
    .where("target_status", "=", "PENDING").returning("student_issue_id").execute();
}

export function listReassessmentTargetStatuses(db: Trx, classId: string, id: string) {
  return db.selectFrom("reassessment_targets").where("class_id", "=", classId).where("reassessment_id", "=", id)
    .select(["student_issue_id", "target_status"]).execute();
}
