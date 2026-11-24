import { type Expression, type Insertable, type Kysely, sql, type Transaction } from "kysely";
import type { Database } from "../database.ts";
import { exactTimestamptz } from "./raw-notes.ts";

type ProposalEvidence = Omit<Insertable<Database["evidence_events"]>, "observed_at" | "provenance">;

export function insertProposalEvidence(db: Transaction<Database>, values: ProposalEvidence, observedAt?: string) {
  // Copy the original timestamptz in PostgreSQL to retain its full precision.
  const observed = observedAt === undefined
    ? db.selectFrom("raw_notes").select("observed_at")
      .where("id", "=", values.raw_note_id).where("class_id", "=", values.class_id)
    : exactTimestamptz(observedAt);
  return db.insertInto("evidence_events")
    .values({ ...values, observed_at: observed, provenance: "AI_PROPOSED_TEACHER_APPROVED" })
    .returning("id").executeTakeFirstOrThrow();
}

export function listRecentIssueEvidence(
  db: Kysely<Database>, classId: string, issueIds: string[], cutoff?: Expression<Date>,
) {
  return db.with("ranked_evidence", (cte) => cte.selectFrom("evidence_events as evidence")
    .innerJoin("student_issues as issue", (join) => join
      .onRef("issue.id", "=", "evidence.student_issue_id").onRef("issue.class_id", "=", "evidence.class_id")
      .onRef("issue.student_id", "=", "evidence.student_id"))
    .innerJoin("raw_notes as source", (join) => join
      .onRef("source.id", "=", "evidence.raw_note_id").onRef("source.class_id", "=", "evidence.class_id"))
    .where("evidence.class_id", "=", classId).where("issue.id", "=", sql<string>`any(${issueIds}::uuid[])`)
    .where((eb) => cutoff ? eb("source.created_at", ">", cutoff) : eb.not(eb.exists(
      // Keep the original Student-only history scope for local structurers.
      eb.selectFrom("students as roster_edit").select("roster_edit.id")
        .where("roster_edit.class_id", "=", classId).where("roster_edit.version", ">", 1)
        .whereRef("roster_edit.updated_at", ">=", "source.created_at"),
    )))
    .select(["issue.id as student_issue_id", "evidence.observation_text", "evidence.learning_context"])
    .select(sql<number>`row_number() over (partition by issue.id
      order by evidence.observed_at desc, evidence.created_at desc, evidence.id desc)`.as("recency")),
  ).selectFrom("ranked_evidence")
    .select(["student_issue_id", "observation_text", "learning_context"])
    .where("recency", "<=", 3).orderBy("student_issue_id").orderBy("recency")
    .execute();
}
