import { z } from "zod";

export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime({ offset: true });
export const versionSchema = z.int().positive();
export const nonblankTextSchema = z.string().regex(/\S/, "Must not be blank");
export const nonblankTextWithoutNulSchema = nonblankTextSchema.refine(
  (value) => !value.includes("\u0000"), "Must not contain a NUL character",
);

export const classParamsSchema = z.strictObject({ classId: idSchema });
export const versionedInputSchema = z.strictObject({ expectedVersion: versionSchema });
export type VersionedInput = z.infer<typeof versionedInputSchema>;

export const meDtoSchema = z.object({ userId: nonblankTextSchema });
export type MeDto = z.infer<typeof meDtoSchema>;

export const productViewEventNameSchema = z.enum([
  "proposal_review_opened",
  "student_view_opened",
  "class_issue_view_opened",
  "reassessment_due_opened",
  "history_opened",
]);
export type ProductViewEventName = z.infer<typeof productViewEventNameSchema>;

export const recordProductEventInputSchema = z.strictObject({
  eventName: productViewEventNameSchema,
  classId: idSchema,
  entityId: idSchema.optional(),
});
export type RecordProductEventInput = z.infer<typeof recordProductEventInputSchema>;
