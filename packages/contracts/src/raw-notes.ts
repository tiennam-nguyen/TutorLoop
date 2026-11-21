import { z } from "zod";
import { classParamsSchema, idSchema, nonblankTextSchema, timestampSchema } from "./common.ts";

export const rawNoteParamsSchema = classParamsSchema.extend({ rawNoteId: idSchema });

export const rawNoteTypeSchema = z.enum(["OBSERVATION", "REASSESSMENT_OUTCOME"]);
export type RawNoteType = z.infer<typeof rawNoteTypeSchema>;

export const createRawNoteInputSchema = z.strictObject({
  body: nonblankTextSchema,
  observedAt: timestampSchema,
  noteType: rawNoteTypeSchema,
  reassessmentId: idSchema.nullish(),
  clientRequestId: idSchema,
});
export type CreateRawNoteInput = z.infer<typeof createRawNoteInputSchema>;

export const voidRawNoteInputSchema = z.strictObject({ voidReason: nonblankTextSchema.nullish() });
export type VoidRawNoteInput = z.infer<typeof voidRawNoteInputSchema>;

export const reprocessRawNoteInputSchema = z.strictObject({ clientRequestId: idSchema });
export type ReprocessRawNoteInput = z.infer<typeof reprocessRawNoteInputSchema>;

export const rawNoteDtoSchema = z.object({
  id: idSchema,
  classId: idSchema,
  noteType: rawNoteTypeSchema,
  body: nonblankTextSchema,
  observedAt: timestampSchema,
  reassessmentId: idSchema.nullable(),
  voidedAt: timestampSchema.nullable(),
  voidReason: z.string().nullable(),
  createdAt: timestampSchema,
});
export type RawNoteDto = z.infer<typeof rawNoteDtoSchema>;

export const rawNoteProcessingSummarySchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["QUEUED", "PROCESSING"]), proposalRunId: idSchema.optional() }),
  z.object({ status: z.literal("READY"), proposalRunId: idSchema }),
  z.object({ status: z.literal("FAILED"), proposalRunId: idSchema.optional() }),
]);
export type RawNoteProcessingSummary = z.infer<typeof rawNoteProcessingSummarySchema>;

export const rawNoteDetailDtoSchema = z.object({
  rawNote: rawNoteDtoSchema,
  processing: rawNoteProcessingSummarySchema,
});
export type RawNoteDetailDto = z.infer<typeof rawNoteDetailDtoSchema>;

export const queuedRawNoteProcessingSchema = z.object({
  status: z.literal("QUEUED"),
  jobId: idSchema,
});
export type QueuedRawNoteProcessing = z.infer<typeof queuedRawNoteProcessingSchema>;

export const createRawNoteResponseSchema = z.object({
  rawNote: rawNoteDtoSchema,
  processing: queuedRawNoteProcessingSchema,
});
export type CreateRawNoteResponse = z.infer<typeof createRawNoteResponseSchema>;
