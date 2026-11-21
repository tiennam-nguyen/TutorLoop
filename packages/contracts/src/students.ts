import { z } from "zod";
import {
  classParamsSchema, idSchema, nonblankTextSchema, timestampSchema, versionSchema, versionedInputSchema,
} from "./common.ts";

export const studentParamsSchema = classParamsSchema.extend({ studentId: idSchema });

export const addStudentInputSchema = z.strictObject({
  displayLabel: nonblankTextSchema,
  clientRequestId: idSchema,
});
export type AddStudentInput = z.infer<typeof addStudentInputSchema>;

export const updateStudentInputSchema = versionedInputSchema.extend({ displayLabel: nonblankTextSchema });
export type UpdateStudentInput = z.infer<typeof updateStudentInputSchema>;

export const studentDtoSchema = z.object({
  id: idSchema,
  classId: idSchema,
  displayLabel: nonblankTextSchema,
  aiAlias: nonblankTextSchema,
  archivedAt: timestampSchema.nullable(),
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type StudentDto = z.infer<typeof studentDtoSchema>;
