import { type Kysely, sql } from "kysely";
import type { Database } from "../database.ts";
import { interventionsWithTargets } from "./interventions.ts";
import { observedAtUtc } from "./raw-notes.ts";
import { reassessmentsWithTargets } from "./reassessments.ts";

type Db = Kysely<Database>;

function canonicalRoots(db: Db, classId: string) {
  return db.withRecursive("canonical_roots", (cte) => cte
    .selectFrom("canonical_issues as canonical").select(["canonical.id as issue_id", "canonical.id as root_id"])
    .where("canonical.class_id", "=", classId).where("canonical.merged_into_id", "is", null)
    .union(cte.selectFrom("canonical_issues as source").innerJoin("canonical_roots as root", "root.issue_id", "source.merged_into_id")
      .select(["source.id as issue_id", "root.root_id"]).where("source.class_id", "=", classId)));
}

function activeStudentIssues(db: Db, classId: string) {
  return canonicalRoots(db, classId).selectFrom("student_issues as issue")
    .innerJoin("canonical_roots as root", "root.issue_id", "issue.canonical_issue_id")
    .innerJoin("students as student", (join) => join
      .onRef("student.id", "=", "issue.student_id").onRef("student.class_id", "=", "issue.class_id"))
    .where("issue.class_id", "=", classId)
    .where("student.archived_at", "is", null);
}

function canonicalIssueSummaries(db: Db, classId: string, now: Date, canonicalIssueId?: string) {
  const active = activeStudentIssues(db, classId);
  const scoped = canonicalIssueId === undefined ? active : active.where("root.root_id", "=", canonicalIssueId);
  const counts = scoped
    .select(({ fn, exists, selectFrom }) => [
      "root.root_id as canonical_issue_id",
      fn.count("issue.student_id").distinct().filterWhere("issue.state", "=", "OPEN").as("open_count"),
      fn.count("issue.student_id").distinct().filterWhere("issue.state", "=", "IMPROVING").as("improving_count"),
      fn.count("issue.student_id").distinct().filterWhere("issue.state", "=", "RESOLVED_FOR_NOW").as("resolved_count"),
      fn.count("issue.student_id").distinct().as("affected_students"),
      fn.count("issue.student_id").distinct().filterWhere(exists(
        selectFrom("reassessment_targets as target")
          .innerJoin("reassessments as reassessment", (join) => join
            .onRef("reassessment.id", "=", "target.reassessment_id").onRef("reassessment.class_id", "=", "target.class_id"))
          .select("target.reassessment_id").whereRef("target.class_id", "=", "issue.class_id")
          .whereRef("target.student_issue_id", "=", "issue.id")
          .where("reassessment.status", "=", "SCHEDULED").where("reassessment.due_at", "<=", now),
      )).as("due_count"),
    ]).groupBy("root.root_id").as("counts");

  return db.selectFrom("canonical_issues as canonical")
    .leftJoin(counts, "counts.canonical_issue_id", "canonical.id")
    .selectAll("canonical")
    .select(["counts.open_count", "counts.improving_count", "counts.resolved_count", "counts.affected_students", "counts.due_count"])
    .where("canonical.class_id", "=", classId).where("canonical.merged_into_id", "is", null);
}

export function listCanonicalIssueSummaries(db: Db, classId: string, now: Date) {
  return canonicalIssueSummaries(db, classId, now).orderBy("canonical.created_at").orderBy("canonical.id").execute();
}

export function findCanonicalIssueSummary(db: Db, classId: string, canonicalIssueId: string, now: Date) {
  return canonicalIssueSummaries(db, classId, now, canonicalIssueId).where("canonical.id", "=", canonicalIssueId).executeTakeFirst();
}

export function listActiveClassStudentIssues(db: Db, classId: string, canonicalIssueId: string) {
  return activeStudentIssues(db, classId).selectAll("issue").select([
    "student.display_label", "student.ai_alias", "student.archived_at as student_archived_at",
    "student.version as student_version", "student.created_at as student_created_at", "student.updated_at as student_updated_at",
  ]).where("root.root_id", "=", canonicalIssueId).orderBy("issue.created_at").orderBy("issue.id").execute();
}

export function listActiveClassIssueEvidence(db: Db, classId: string, canonicalIssueId: string) {
  return activeStudentIssues(db, classId)
    .innerJoin("evidence_events as evidence", (join) => join
      .onRef("evidence.student_issue_id", "=", "issue.id")
      .onRef("evidence.student_id", "=", "issue.student_id")
      .onRef("evidence.class_id", "=", "issue.class_id"))
    .select(["issue.id as student_issue_id", "evidence.id"])
    .where("root.root_id", "=", canonicalIssueId)
    .orderBy("evidence.observed_at").orderBy("evidence.created_at").orderBy("evidence.id").execute();
}

export function listStudentIssuesWithCanonicalIssue(db: Db, classId: string, studentId: string) {
  return canonicalRoots(db, classId).selectFrom("student_issues as issue")
    .innerJoin("canonical_roots as root", "root.issue_id", "issue.canonical_issue_id")
    .innerJoin("canonical_issues as canonical", (join) => join
      .onRef("canonical.id", "=", "root.root_id").onRef("canonical.class_id", "=", "issue.class_id"))
    .selectAll("issue")
    .select([
      "canonical.id as resolved_canonical_id", "canonical.label", "canonical.description", "canonical.merged_into_id", "canonical.archived_at",
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
      .where((scope) => match === "student_id" ? scope("issue.student_id", "=", id) : scope("issue.canonical_issue_id", "in",
        canonicalRoots(db, classId).selectFrom("canonical_roots").select("issue_id").where("root_id", "=", id))),
  )).orderBy("interventions.occurred_at").orderBy("interventions.created_at").orderBy("interventions.id").execute();
}

export function listStudentInterventions(db: Db, classId: string, studentId: string) {
  return listInterventionHistory(db, classId, "student_id", studentId);
}

export function listCanonicalIssueInterventions(db: Db, classId: string, canonicalIssueId: string) {
  return listInterventionHistory(db, classId, "canonical_issue_id", canonicalIssueId);
}

function listReassessmentHistory(db: Db, classId: string, match: "student_id" | "canonical_issue_id", id: string) {
  return reassessmentsWithTargets(db, classId).where((eb) => eb.exists(
    eb.selectFrom("reassessment_targets as target")
      .innerJoin("student_issues as issue", (join) => join
        .onRef("target.student_issue_id", "=", "issue.id").onRef("target.class_id", "=", "issue.class_id"))
      .select("target.reassessment_id")
      .whereRef("target.reassessment_id", "=", "reassessments.id")
      .whereRef("target.class_id", "=", "reassessments.class_id")
      .where((scope) => match === "student_id" ? scope("issue.student_id", "=", id) : scope("issue.canonical_issue_id", "in",
        canonicalRoots(db, classId).selectFrom("canonical_roots").select("issue_id").where("root_id", "=", id))),
  )).orderBy(sql<Date>`coalesce(reassessments.performed_at, reassessments.due_at)`).orderBy("reassessments.id").execute();
}

export function listStudentReassessments(db: Db, classId: string, studentId: string) {
  return listReassessmentHistory(db, classId, "student_id", studentId);
}

export function listCanonicalIssueReassessments(db: Db, classId: string, canonicalIssueId: string) {
  return listReassessmentHistory(db, classId, "canonical_issue_id", canonicalIssueId);
}
