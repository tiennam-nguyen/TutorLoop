import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "STALE_VERSION",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_ISSUE_TRANSITION",
  "PROPOSAL_DEPENDENCY_UNSATISFIED",
  "PROPOSAL_ITEM_ALREADY_DECIDED",
  "REASSESSMENT_NOT_COMPLETABLE",
  "AI_PROCESSING_FAILED",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
