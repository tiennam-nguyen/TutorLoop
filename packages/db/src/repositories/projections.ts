import { type Kysely, sql } from "kysely";
import type { Database } from "../database.ts";
import { interventionsWithTargets } from "./interventions.ts";
import { observedAtUtc } from "./raw-notes.ts";

type Db = Kysely<Database>;

function activeStudentIssues(db: Db, classId: string) {
  return db.selectFrom("student_issues as issue")
    .innerJoin("students as student", (join) => join
      .onRef("student.id", "=", "issue.student_id").onRef("student.class_id", "=", "issue.class_id"))
    .where("issue.class_id", "=", classId)
    .where("student.archived_at", "is", null);
}

function canonicalIssueSummaries(db: Db, classId: string, canonicalIssueId?: string) {
  const active = activeStudentIssues(db, classId);
  const scoped = canonicalIssueId === undefined ? active : active.where("issue.canonical_issue_id", "=", canonicalIssueId);
  const counts = scoped
    .select(({ fn }) => [
      "issue.canonical_issue_id",
      fn.count("issue.id").filterWhere("issue.state", "=", "OPEN").as("open_count"),
      fn.count("issue.id").filterWhere("issue.state", "=", "IMPROVING").as("improving_count"),
      fn.count("issue.id").filterWhere("issue.state", "=", "RESOLVED_FOR_NOW").as("resolved_count"),
      fn.count("issue.student_id").distinct().as("affected_students"),
    ]).groupBy("issue.canonical_issue_id").as("counts");

  return db.selectFrom("canonical_issues as canonical")
    .leftJoin(counts, "counts.canonical_issue_id", "canonical.id")
    .selectAll("canonical")
    .select(["counts.open_count", "counts.improving_count", "counts.resolved_count", "counts.affected_students"])
    .where("canonical.class_id", "=", classId);
}

export function listCanonicalIssueSummaries(db: Db, classId: string) {
  return canonicalIssueSummaries(db, classId).orderBy("canonical.created_at").orderBy("canonical.id").execute();
}

export function findCanonicalIssueSummary(db: Db, classId: string, canonicalIssueId: string) {
  return canonicalIssueSummaries(db, classId, canonicalIssueId).where("canonical.id", "=", canonicalIssueId).executeTakeFirst();
}

export function listActiveClassStudentIssues(db: Db, classId: string, canonicalIssueId: string) {
  return activeStudentIssues(db, classId).selectAll("issue").select([
    "student.display_label", "student.ai_alias", "student.archived_at as student_archived_at",
    "student.version as student_version", "student.created_at as student_created_at", "student.updated_at as student_updated_at",
  ]).where("issue.canonical_issue_id", "=", canonicalIssueId).orderBy("issue.created_at").orderBy("issue.id").execute();
}

export function listActiveClassIssueEvidence(db: Db, classId: string, canonicalIssueId: string) {
  return activeStudentIssues(db, classId)
    .innerJoin("evidence_events as evidence", (join) => join
      .onRef("evidence.student_issue_id", "=", "issue.id")
      .onRef("evidence.student_id", "=", "issue.student_id")
      .onRef("evidence.class_id", "=", "issue.class_id"))
    .select(["issue.id as student_issue_id", "evidence.id"])
    .where("issue.canonical_issue_id", "=", canonicalIssueId)
    .orderBy("evidence.observed_at").orderBy("evidence.created_at").orderBy("evidence.id").execute();
}

export function listStudentIssuesWithCanonicalIssue(db: Db, classId: string, studentId: string) {
  return db.selectFrom("student_issues as issue")
    .innerJoin("canonical_issues as canonical", (join) => join
      .onRef("canonical.id", "=", "issue.canonical_issue_id").onRef("canonical.class_id", "=", "issue.class_id"))
    .selectAll("issue")
    .select([
      "canonical.label", "canonical.description", "canonical.merged_into_id", "canonical.archived_at",
      "canonical.version as canonical_version", "canonical.created_at as canonical_created_at",
      "canonical.updated_at as canonical_updated_at",
    ]).where("issue.class_id", "=", classId).where("issue.student_id", "=", studentId)
    .orderBy("issue.created_at").orderBy("issue.id").execute();
}

export function listStudentEvidence(db: Db, classId: string, studentId: string) {
  // PostgreSQL orders the original timestamps while pg's JS Date parser retains only milliseconds.
  return db.selectFrom("evidence_events").selectAll()
    .select([
      observedAtUtc,
      sql<string>`to_char(created_at, 'US')`.as("created_at_micros"),
    ])
    .where("class_id", "=", classId).where("student_id", "=", studentId)
    .orderBy("observed_at").orderBy("created_at").orderBy("id").execute();
}

export function listStudentIssueTransitions(db: Db, classId: string, studentId: string) {
  return db.selectFrom("student_issue_transitions as transition")
    .innerJoin("student_issues as issue", (join) => join
      .onRef("issue.id", "=", "transition.student_issue_id").onRef("issue.class_id", "=", "transition.class_id"))
    .selectAll("transition").select(sql<string>`to_char(transition.created_at, 'US')`.as("created_at_micros"))
    .where("transition.class_id", "=", classId).where("issue.student_id", "=", studentId)
    .orderBy("transition.created_at").orderBy("transition.insertion_order").orderBy("transition.id").execute();
}

function listInterventionHistory(db: Db, classId: string, match: "student_id" | "canonical_issue_id", id: string) {
  return interventionsWithTargets(db, classId).where((eb) => eb.exists(
    eb.selectFrom("intervention_targets as target")
      .innerJoin("student_issues as issue", (join) => join
        .onRef("target.student_issue_id", "=", "issue.id").onRef("target.class_id", "=", "issue.class_id"))
      .select("target.intervention_id")
      .whereRef("target.intervention_id", "=", "interventions.id")
      .whereRef("target.class_id", "=", "interventions.class_id")
      .where(`issue.${match}`, "=", id),
  )).orderBy("interventions.occurred_at").orderBy("interventions.created_at").orderBy("interventions.id").execute();
}

export function listStudentInterventions(db: Db, classId: string, studentId: string) {
  return listInterventionHistory(db, classId, "student_id", studentId);
}

export function listCanonicalIssueInterventions(db: Db, classId: string, canonicalIssueId: string) {
  return listInterventionHistory(db, classId, "canonical_issue_id", canonicalIssueId);
}
