import {
  createReassessmentInputSchema, idSchema, nonblankTextWithoutNulSchema, skipReassessmentTargetInputSchema, versionedInputSchema,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { changeReassessment, getReassessment, getReassessmentDueQueue, scheduleReassessment } from "./service.ts";

type ClassParams = { classId: string };
type ReassessmentParams = ClassParams & { reassessmentId: string };
type TargetParams = ReassessmentParams & { studentIssueId: string };

const persistsAsText = (value: string) => value.isWellFormed() && !value.includes("\u0000");
const createInput = createReassessmentInputSchema.extend({
  title: createReassessmentInputSchema.shape.title.refine((value) => value == null || persistsAsText(value)),
  notes: createReassessmentInputSchema.shape.notes.refine((value) => value == null || persistsAsText(value)),
});
const skipInput = skipReassessmentTargetInputSchema.extend({
  skipReason: nonblankTextWithoutNulSchema.refine((value) => value.isWellFormed()),
});

export function registerReassessmentRoutes(app: FastifyInstance, db: Kysely<Database>, now: () => Date): void {
  const reassessments = "/api/v1/classes/:classId/reassessments";
  const detail = `${reassessments}/:reassessmentId`;
  const options = { exposeHeadRoute: false };

  app.post<{ Params: ClassParams }>(reassessments, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const input = createInput.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return reply.code(201).send(await scheduleReassessment(db, principal, request.params.classId, input.data, now));
  });

  app.get<{ Params: ClassParams }>(`${reassessments}/due`, options, async (request) => {
    const principal = await requirePrincipal(request);
    return getReassessmentDueQueue(db, principal, request.params.classId, now);
  });

  app.get<{ Params: ReassessmentParams }>(detail, options, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, reassessmentId } = request.params;
    return getReassessment(db, principal, classId, reassessmentId);
  });

  for (const type of ["mark-performed", "cancel"] as const) {
    app.post<{ Params: ReassessmentParams }>(`${detail}/${type}`, async (request) => {
      const principal = await requirePrincipal(request);
      const { classId, reassessmentId } = request.params;
      const input = versionedInputSchema.safeParse(request.body);
      if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
      return changeReassessment(db, principal, classId, reassessmentId, input.data.expectedVersion, { type }, now);
    });
  }

  app.post<{ Params: TargetParams }>(`${detail}/targets/:studentIssueId/skip`, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, reassessmentId, studentIssueId } = request.params;
    if (!idSchema.safeParse(studentIssueId).success) throw new ApiError("NOT_FOUND", "Reassessment target not found.");
    const input = skipInput.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    const { expectedVersion, skipReason } = input.data;
    return changeReassessment(db, principal, classId, reassessmentId, expectedVersion,
      { type: "skip", studentIssueId, skipReason }, now);
  });
}
