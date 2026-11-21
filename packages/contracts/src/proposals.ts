import { z } from "zod";
import { classParamsSchema, idSchema, timestampSchema, versionSchema } from "./common.ts";
import { proposalDraftItemV1Schema } from "./ai.ts";
import { rawNoteDtoSchema } from "./raw-notes.ts";

export const proposalRunParamsSchema = classParamsSchema.extend({ proposalRunId: idSchema });

export const proposalItemStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "SUPERSEDED"]);
export type ProposalItemStatus = z.infer<typeof proposalItemStatusSchema>;

export const proposalRunStatusSchema = z.enum([
  "PROCESSING", "READY", "PARTIALLY_REVIEWED", "APPLIED", "FAILED", "SUPERSEDED",
]);
export type ProposalRunStatus = z.infer<typeof proposalRunStatusSchema>;

export const proposalItemTypeSchema = z.enum([
  "CREATE_CANONICAL_ISSUE",
  "CREATE_STUDENT_ISSUE",
  "CREATE_EVIDENCE",
  "UPDATE_MANIFESTATION",
  "TRANSITION_STUDENT_ISSUE",
  "MATCH_CANONICAL_ISSUE",
  "MERGE_CANONICAL_ISSUE",
]);
export type ProposalItemType = z.infer<typeof proposalItemTypeSchema>;

const patchSchema = z.record(z.string(), z.unknown());
export const proposalDecisionInputSchema = z.discriminatedUnion("decision", [
  z.strictObject({ proposalItemId: idSchema, decision: z.literal("APPROVE"), patch: z.null().optional() }),
  z.strictObject({ proposalItemId: idSchema, decision: z.literal("EDIT_AND_APPROVE"), patch: patchSchema }),
  z.strictObject({ proposalItemId: idSchema, decision: z.literal("REJECT"), patch: z.null().optional() }),
]);
export type ProposalDecisionInput = z.infer<typeof proposalDecisionInputSchema>;

export const proposalDecisionBatchInputSchema = z.strictObject({
  clientRequestId: idSchema,
  items: z.array(proposalDecisionInputSchema).min(1),
});
export type ProposalDecisionBatchInput = z.infer<typeof proposalDecisionBatchInputSchema>;

export const proposalItemDtoSchema = z.object({
  id: idSchema,
  itemType: proposalItemTypeSchema,
  status: proposalItemStatusSchema,
  originalPayload: proposalDraftItemV1Schema,
  teacherPatch: patchSchema.nullable(),
  dependencyIds: z.array(idSchema),
  targetEntityType: z.string().nullable(),
  targetEntityId: idSchema.nullable(),
  baseVersion: versionSchema.nullable(),
  resultEntityType: z.string().nullable(),
  resultEntityId: idSchema.nullable(),
  decidedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type ProposalItemDto = z.infer<typeof proposalItemDtoSchema>;

export const proposalRunDetailDtoSchema = z.object({
  id: idSchema,
  classId: idSchema,
  rawNote: rawNoteDtoSchema,
  status: proposalRunStatusSchema,
  schemaVersion: z.literal("1"),
  items: z.array(proposalItemDtoSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ProposalRunDetailDto = z.infer<typeof proposalRunDetailDtoSchema>;
