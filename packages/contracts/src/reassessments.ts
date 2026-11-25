import { z } from "zod";
import {
  classParamsSchema, idSchema, nonblankTextSchema, timestampSchema, versionSchema, versionedInputSchema,
} from "./common.ts";
import { createRawNoteInputSchema } from "./raw-notes.ts";
import { interventionDtoSchema } from "./interventions.ts";

export const reassessmentParamsSchema = classParamsSchema.extend({ reassessmentId: idSchema });
export const reassessmentTargetParamsSchema = reassessmentParamsSchema.extend({ studentIssueId: idSchema });

export const reassessmentStatusSchema = z.enum([
  "SCHEDULED", "PERFORMED_PENDING_EVIDENCE", "COMPLETED", "CANCELLED",
]);
export type ReassessmentStatus = z.infer<typeof reassessmentStatusSchema>;

export const reassessmentTargetStatusSchema = z.enum(["PENDING", "EVIDENCED", "SKIPPED"]);
export type ReassessmentTargetStatus = z.infer<typeof reassessmentTargetStatusSchema>;

export const createReassessmentInputSchema = z.strictObject({
  title: z.string().nullish(),
  notes: z.string().nullish(),
  dueAt: timestampSchema,
  studentIssueIds: z.array(idSchema).min(1),
  interventionIdByStudentIssueId: z.record(idSchema, idSchema).optional(),
  clientRequestId: idSchema,
});
export type CreateReassessmentInput = z.infer<typeof createReassessmentInputSchema>;

export const skipReassessmentTargetInputSchema = versionedInputSchema.extend({
  skipReason: nonblankTextSchema,
});
export type SkipReassessmentTargetInput = z.infer<typeof skipReassessmentTargetInputSchema>;

export const createReassessmentOutcomeNoteInputSchema = createRawNoteInputSchema.pick({
  body: true, observedAt: true, clientRequestId: true,
});
export type CreateReassessmentOutcomeNoteInput = z.infer<typeof createReassessmentOutcomeNoteInputSchema>;

export const reassessmentTargetDtoSchema = z.object({
  studentIssueId: idSchema,
  interventionId: idSchema.nullable(),
  targetStatus: reassessmentTargetStatusSchema,
  skipReason: z.string().nullable(),
});
export type ReassessmentTargetDto = z.infer<typeof reassessmentTargetDtoSchema>;

export const reassessmentDtoSchema = z.object({
  id: idSchema,
  classId: idSchema,
  title: z.string().nullable(),
  notes: z.string().nullable(),
  dueAt: timestampSchema,
  status: reassessmentStatusSchema,
  performedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  version: versionSchema,
  createdAt: timestampSchema,
  targets: z.array(reassessmentTargetDtoSchema),
});
export type ReassessmentDto = z.infer<typeof reassessmentDtoSchema>;

const namedClassSchema = z.object({ id: idSchema, name: nonblankTextSchema });
const namedCanonicalIssueSchema = z.object({ id: idSchema, label: nonblankTextSchema });
const namedStudentSchema = z.object({
  id: idSchema, displayLabel: nonblankTextSchema, archivedAt: timestampSchema.nullable(),
});

const dueReassessmentTargetSchema = reassessmentTargetDtoSchema.extend({
  canonicalIssue: namedCanonicalIssueSchema,
  student: namedStudentSchema,
  intervention: interventionDtoSchema.nullable(),
});

const dueReassessmentSchema = reassessmentDtoSchema.extend({
  class: namedClassSchema,
  targets: z.array(dueReassessmentTargetSchema),
});

export const reassessmentDueQueueDtoSchema = z.object({
  due: z.array(dueReassessmentSchema.extend({ status: z.literal("SCHEDULED") })),
  needsResults: z.array(dueReassessmentSchema.extend({ status: z.literal("PERFORMED_PENDING_EVIDENCE") })),
});
export type ReassessmentDueQueueDto = z.infer<typeof reassessmentDueQueueDtoSchema>;
