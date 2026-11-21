import { z } from "zod";
import { classParamsSchema, idSchema, nonblankTextSchema, timestampSchema } from "./common.ts";

export const interventionParamsSchema = classParamsSchema.extend({ interventionId: idSchema });

export const createInterventionInputSchema = z.strictObject({
  description: nonblankTextSchema,
  occurredAt: timestampSchema,
  studentIssueIds: z.array(idSchema).min(1),
  clientRequestId: idSchema,
});
export type CreateInterventionInput = z.infer<typeof createInterventionInputSchema>;

export const interventionDtoSchema = z.object({
  id: idSchema,
  classId: idSchema,
  description: nonblankTextSchema,
  occurredAt: timestampSchema,
  studentIssueIds: z.array(idSchema),
  createdAt: timestampSchema,
});
export type InterventionDto = z.infer<typeof interventionDtoSchema>;
