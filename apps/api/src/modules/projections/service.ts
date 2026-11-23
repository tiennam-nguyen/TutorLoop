import {
  type CanonicalIssueDetailDto, type CanonicalIssueDto, type CanonicalIssueSummaryDto, type ClassOverviewDto,
  type EvidenceDto, idSchema, type StudentIssueDto, type StudentIssueTransitionDto, type StudentOverviewDto,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import { listClassCanonicalIssues } from "@tutorloop/db/repositories/issues";
import { resolveCanonicalRoot } from "../issues/service.ts";
import type { StudentIssueRow } from "@tutorloop/db/repositories/issues";
import {
  findCanonicalIssueSummary, listActiveClassIssueEvidence, listActiveClassStudentIssues, listCanonicalIssueInterventions,
  listCanonicalIssueReassessments, listCanonicalIssueSummaries, listStudentEvidence, listStudentInterventions,
  listStudentIssuesWithCanonicalIssue, listStudentIssueTransitions, listStudentReassessments,
} from "@tutorloop/db/repositories/projections";
import { findStudent } from "@tutorloop/db/repositories/students";
import type { Kysely, Selectable } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";
import { getClassDetail, toStudentDto } from "../classes/service.ts";
import { toInterventionDto } from "../interventions/service.ts";
import { toReassessmentDto } from "../reassessments/service.ts";

type Db = Kysely<Database>;
type CanonicalIssueRow = Selectable<Database["canonical_issues"]>;
type SummaryRow = Awaited<ReturnType<typeof listCanonicalIssueSummaries>>[number];
type EvidenceRow = Awaited<ReturnType<typeof listStudentEvidence>>[number];
type TransitionRow = Awaited<ReturnType<typeof listStudentIssueTransitions>>[number];

function toCanonicalIssueDto(row: CanonicalIssueRow): CanonicalIssueDto {
  return {
    id: row.id, classId: row.class_id, label: row.label, description: row.description, mergedIntoId: row.merged_into_id,
    archivedAt: row.archived_at?.toISOString() ?? null, version: row.version,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function toSummaryDto(row: SummaryRow): CanonicalIssueSummaryDto {
  return {
    ...toCanonicalIssueDto(row),
    countsByState: {
      OPEN: Number(row.open_count ?? 0),
      IMPROVING: Number(row.improving_count ?? 0),
      RESOLVED_FOR_NOW: Number(row.resolved_count ?? 0),
    },
    affectedStudents: Number(row.affected_students ?? 0),
    dueCount: Number(row.due_count ?? 0),
  };
}

function toStudentIssueDto(row: StudentIssueRow): StudentIssueDto {
  return {
    id: row.id, classId: row.class_id, studentId: row.student_id, canonicalIssueId: row.canonical_issue_id,
    state: row.state, manifestation: row.manifestation, version: row.version,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function formatTimestamp(timestamp: Date, micros: string): string {
  const fraction = micros.replace(/0{1,3}$/, "");
  return timestamp.toISOString().replace(/\.\d+Z$/, `.${fraction}Z`);
}

function toEvidenceDto(row: EvidenceRow): EvidenceDto {
  return {
    id: row.id, classId: row.class_id, studentId: row.student_id, rawNoteId: row.raw_note_id,
    studentIssueId: row.student_issue_id, reassessmentId: row.reassessment_id, observationText: row.observation_text,
    learningContext: row.learning_context, provenance: row.provenance, proposalItemId: row.proposal_item_id,
    observedAt: row.observed_at_utc.replace(/(\.\d{3}\d*?)0+Z$/, "$1Z"),
    createdAt: formatTimestamp(row.created_at, row.created_at_micros),
  };
}

function toTransitionDto(row: TransitionRow): StudentIssueTransitionDto {
  return {
    id: row.id, studentIssueId: row.student_issue_id, fromState: row.from_state, toState: row.to_state,
    evidenceEventId: row.evidence_event_id, proposalItemId: row.proposal_item_id, reason: row.reason,
    createdAt: formatTimestamp(row.created_at, row.created_at_micros),
  };
}

export function getClassOverview(db: Db, principal: AuthPrincipal, classId: string, now: Date): Promise<ClassOverviewDto> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const classroom = await getClassDetail(trx, principal, classId);
    const issues = await listCanonicalIssueSummaries(trx, classroom.id, now);
    return { ...classroom, issues: issues.map(toSummaryDto) };
  });
}

export function getStudentOverview(db: Db, principal: AuthPrincipal, classId: string, studentId: string): Promise<StudentOverviewDto> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const student = idSchema.safeParse(studentId).success ? await findStudent(trx, classroom.id, studentId) : undefined;
    if (!student) throw new ApiError("NOT_FOUND", "Student not found.");
    const issues = await listStudentIssuesWithCanonicalIssue(trx, classroom.id, student.id);
    const evidence = await listStudentEvidence(trx, classroom.id, student.id);
    const transitions = await listStudentIssueTransitions(trx, classroom.id, student.id);
    const interventions = await listStudentInterventions(trx, classroom.id, student.id);
    const reassessments = await listStudentReassessments(trx, classroom.id, student.id);
    const studentIssues = issues.map((row) => ({
      ...toStudentIssueDto(row),
      canonicalIssue: toCanonicalIssueDto({
        id: row.resolved_canonical_id, class_id: row.class_id, label: row.label, description: row.description,
        merged_into_id: row.merged_into_id, archived_at: row.archived_at, version: row.canonical_version,
        created_at: row.canonical_created_at, updated_at: row.canonical_updated_at,
      }),
    }));
    return {
      student: toStudentDto(student),
      activeStudentIssues: studentIssues.filter((issue) => issue.state !== "RESOLVED_FOR_NOW"),
      resolvedStudentIssues: studentIssues.filter((issue) => issue.state === "RESOLVED_FOR_NOW"),
      evidence: evidence.map(toEvidenceDto), transitions: transitions.map(toTransitionDto),
      interventions: interventions.map(toInterventionDto), reassessments: reassessments.map(toReassessmentDto),
    };
  });
}

export function getClassIssueList(db: Db, principal: AuthPrincipal, classId: string, now: Date): Promise<CanonicalIssueSummaryDto[]> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    return (await listCanonicalIssueSummaries(trx, classroom.id, now)).map(toSummaryDto);
  });
}

export function getClassIssueDetail(
  db: Db, principal: AuthPrincipal, classId: string, canonicalIssueId: string, now: Date,
): Promise<CanonicalIssueDetailDto> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const canonical = idSchema.safeParse(canonicalIssueId).success
      ? await findCanonicalIssueSummary(trx, classroom.id, resolveCanonicalRoot(await listClassCanonicalIssues(trx, classroom.id), canonicalIssueId).id, now) : undefined;
    if (!canonical) throw new ApiError("NOT_FOUND", "Canonical Issue not found.");

    const issues = await listActiveClassStudentIssues(trx, classroom.id, canonical.id);
    const evidence = await listActiveClassIssueEvidence(trx, classroom.id, canonical.id);
    const interventions = await listCanonicalIssueInterventions(trx, classroom.id, canonical.id);
    const reassessments = await listCanonicalIssueReassessments(trx, classroom.id, canonical.id);
    const evidenceByIssue = new Map<string, string[]>();
    for (const event of evidence) {
      const ids = evidenceByIssue.get(event.student_issue_id) ?? [];
      ids.push(event.id);
      evidenceByIssue.set(event.student_issue_id, ids);
    }
    return {
      ...toSummaryDto(canonical),
      studentIssues: issues.map((row) => ({
        ...toStudentIssueDto(row),
        student: toStudentDto({
          id: row.student_id, class_id: row.class_id, display_label: row.display_label, ai_alias: row.ai_alias,
          archived_at: row.student_archived_at, version: row.student_version, created_at: row.student_created_at,
          updated_at: row.student_updated_at,
        }),
        evidenceIds: evidenceByIssue.get(row.id) ?? [],
      })),
      interventions: interventions.map(toInterventionDto), reassessments: reassessments.map(toReassessmentDto),
    };
  });
}
