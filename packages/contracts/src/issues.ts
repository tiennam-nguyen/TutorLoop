import { z } from "zod";
import {
  classParamsSchema, idSchema, nonblankTextSchema, timestampSchema, versionSchema, versionedInputSchema,
} from "./common.ts";
import { classDetailDtoSchema } from "./classes.ts";
import { interventionDtoSchema } from "./interventions.ts";
import { reassessmentDtoSchema } from "./reassessments.ts";
import { studentDtoSchema } from "./students.ts";

export const studentIssueParamsSchema = classParamsSchema.extend({ studentIssueId: idSchema });
export const canonicalIssueParamsSchema = classParamsSchema.extend({ canonicalIssueId: idSchema });

export const studentIssueStateSchema = z.enum(["OPEN", "IMPROVING", "RESOLVED_FOR_NOW"]);
export type StudentIssueState = z.infer<typeof studentIssueStateSchema>;

export const updateStudentIssueStateInputSchema = versionedInputSchema.extend({
  toState: studentIssueStateSchema,
  reason: z.string().optional(),
});
export type UpdateStudentIssueStateInput = z.infer<typeof updateStudentIssueStateInputSchema>;

export const updateStudentIssueManifestationInputSchema = versionedInputSchema.extend({
  manifestation: z.string().nullable(),
});
export type UpdateStudentIssueManifestationInput = z.infer<typeof updateStudentIssueManifestationInputSchema>;

export const updateCanonicalIssueInputSchema = versionedInputSchema.extend({
  label: nonblankTextSchema.optional(),
  description: z.string().nullish(),
});
export type UpdateCanonicalIssueInput = z.infer<typeof updateCanonicalIssueInputSchema>;

export const mergeCanonicalIssueInputSchema = z.strictObject({
  targetCanonicalIssueId: idSchema,
  expectedSourceVersion: versionSchema,
  expectedTargetVersion: versionSchema,
});
export type MergeCanonicalIssueInput = z.infer<typeof mergeCanonicalIssueInputSchema>;

export const studentIssueDtoSchema = z.object({
  id: idSchema,
  classId: idSchema,
  studentId: idSchema,
  canonicalIssueId: idSchema,
  state: studentIssueStateSchema,
  manifestation: z.string().nullable(),
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type StudentIssueDto = z.infer<typeof studentIssueDtoSchema>;

export const canonicalIssueDtoSchema = z.object({
  id: idSchema,
  classId: idSchema,
  label: nonblankTextSchema,
  description: z.string().nullable(),
  mergedIntoId: idSchema.nullable(),
  archivedAt: timestampSchema.nullable(),
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type CanonicalIssueDto = z.infer<typeof canonicalIssueDtoSchema>;

export const evidenceDtoSchema = z.object({
  id: idSchema,
  classId: idSchema,
  studentId: idSchema,
  rawNoteId: idSchema,
  studentIssueId: idSchema.nullable(),
  reassessmentId: idSchema.nullable(),
  observationText: nonblankTextSchema,
  learningContext: z.string().nullable(),
  observedAt: timestampSchema,
  provenance: z.enum(["TEACHER_DIRECT", "AI_PROPOSED_TEACHER_APPROVED"]),
  proposalItemId: idSchema.nullable(),
  createdAt: timestampSchema,
});
export type EvidenceDto = z.infer<typeof evidenceDtoSchema>;

export const studentIssueTransitionDtoSchema = z.object({
  id: idSchema,
  studentIssueId: idSchema,
  fromState: studentIssueStateSchema.nullable(),
  toState: studentIssueStateSchema,
  evidenceEventId: idSchema.nullable(),
  proposalItemId: idSchema.nullable(),
  reason: z.string().nullable(),
  createdAt: timestampSchema,
});
export type StudentIssueTransitionDto = z.infer<typeof studentIssueTransitionDtoSchema>;

const studentIssueWithCanonicalIssueSchema = studentIssueDtoSchema.extend({
  canonicalIssue: canonicalIssueDtoSchema,
});

export const studentOverviewDtoSchema = z.object({
  student: studentDtoSchema,
  activeStudentIssues: z.array(studentIssueWithCanonicalIssueSchema),
  resolvedStudentIssues: z.array(studentIssueWithCanonicalIssueSchema),
  evidence: z.array(evidenceDtoSchema),
  transitions: z.array(studentIssueTransitionDtoSchema),
  interventions: z.array(interventionDtoSchema),
  reassessments: z.array(reassessmentDtoSchema),
});
export type StudentOverviewDto = z.infer<typeof studentOverviewDtoSchema>;

const countSchema = z.int().nonnegative();
export const canonicalIssueSummaryDtoSchema = canonicalIssueDtoSchema.extend({
  countsByState: z.record(studentIssueStateSchema, countSchema),
  affectedStudents: countSchema,
  dueCount: countSchema,
});
export type CanonicalIssueSummaryDto = z.infer<typeof canonicalIssueSummaryDtoSchema>;

export const canonicalIssueListDtoSchema = z.array(canonicalIssueSummaryDtoSchema);
export type CanonicalIssueListDto = z.infer<typeof canonicalIssueListDtoSchema>;

export const classOverviewDtoSchema = classDetailDtoSchema.extend({ issues: canonicalIssueListDtoSchema });
export type ClassOverviewDto = z.infer<typeof classOverviewDtoSchema>;

export const canonicalIssueDetailDtoSchema = canonicalIssueSummaryDtoSchema.extend({
  studentIssues: z.array(studentIssueDtoSchema.extend({
    student: studentDtoSchema,
    evidenceIds: z.array(idSchema),
  })),
  interventions: z.array(interventionDtoSchema),
  reassessments: z.array(reassessmentDtoSchema),
});
export type CanonicalIssueDetailDto = z.infer<typeof canonicalIssueDetailDtoSchema>;
