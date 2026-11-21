import { z } from "zod";
import {
  idSchema, nonblankTextSchema, nonblankTextWithoutNulSchema, timestampSchema, versionSchema, versionedInputSchema,
} from "./common.ts";
import { studentDtoSchema } from "./students.ts";

const timezoneSchema = nonblankTextSchema.refine((timezone) => {
  if (timezone.startsWith("+") || timezone.startsWith("-")) return false;
  try {
    Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}, "Must be an IANA timezone");

export const createClassInputSchema = z.strictObject({
  name: nonblankTextWithoutNulSchema,
  timezone: timezoneSchema,
  clientRequestId: idSchema,
});
export type CreateClassInput = z.infer<typeof createClassInputSchema>;

export const updateClassInputSchema = versionedInputSchema.extend({
  name: nonblankTextWithoutNulSchema.optional(),
  timezone: timezoneSchema.optional(),
});
export type UpdateClassInput = z.infer<typeof updateClassInputSchema>;

export const classDtoSchema = z.object({
  id: idSchema,
  name: nonblankTextSchema,
  timezone: timezoneSchema,
  archivedAt: timestampSchema.nullable(),
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ClassDto = z.infer<typeof classDtoSchema>;

export const classListDtoSchema = z.array(classDtoSchema);
export type ClassListDto = z.infer<typeof classListDtoSchema>;

export const classDetailDtoSchema = classDtoSchema.extend({
  students: z.array(studentDtoSchema),
});
export type ClassDetailDto = z.infer<typeof classDetailDtoSchema>;
