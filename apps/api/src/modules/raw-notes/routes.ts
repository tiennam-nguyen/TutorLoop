import {
  createRawNoteInputSchema, nonblankTextWithoutNulSchema, reprocessRawNoteInputSchema, voidRawNoteInputSchema,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { reprocessRawNote } from "./reprocess.ts";
import { captureRawNote, getRawNote, voidRawNote } from "./service.ts";

type ClassRoute = { Params: { classId: string } };
type RawNoteRoute = { Params: { classId: string; rawNoteId: string } };

const rawNoteText = nonblankTextWithoutNulSchema.refine(
  (value) => value.isWellFormed(), "Must be well-formed Unicode",
);
const captureInput = createRawNoteInputSchema.extend({ body: rawNoteText });
const voidInput = voidRawNoteInputSchema.extend({ voidReason: rawNoteText.nullish() });

export function registerRawNoteRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const rawNotes = "/api/v1/classes/:classId/raw-notes";
  const rawNote = `${rawNotes}/:rawNoteId`;

  app.post<ClassRoute>(rawNotes, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const input = captureInput.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return reply.code(201).send(await captureRawNote(db, principal, request.params.classId, input.data));
  });

  app.get<RawNoteRoute>(rawNote, { exposeHeadRoute: false }, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, rawNoteId } = request.params;
    return getRawNote(db, principal, classId, rawNoteId);
  });

  app.post<RawNoteRoute>(`${rawNote}/reprocess`, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const { classId, rawNoteId } = request.params;
    const input = reprocessRawNoteInputSchema.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return reply.code(201).send(await reprocessRawNote(db, principal, classId, rawNoteId, input.data));
  });

  app.post<RawNoteRoute>(`${rawNote}/void`, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, rawNoteId } = request.params;
    const input = voidInput.safeParse(request.body === undefined ? {} : request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return voidRawNote(db, principal, classId, rawNoteId, input.data);
  });
}
