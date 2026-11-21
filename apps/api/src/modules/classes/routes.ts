import {
  addStudentInputSchema, createClassInputSchema, updateClassInputSchema, updateStudentInputSchema,
  versionedInputSchema,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import {
  addStudent, archiveClass, archiveStudent, createClass, getClassDetail, listClasses, updateClass, updateStudent,
} from "./service.ts";

type ClassRoute = { Params: { classId: string } };
type StudentRoute = { Params: { classId: string; studentId: string } };

function parseBody<T>(schema: { safeParse(body: unknown): { success: true; data: T } | { success: false } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
  return result.data;
}

export function registerClassRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const classes = "/api/v1/classes";
  const classroom = `${classes}/:classId`;
  const students = `${classroom}/students`;
  const student = `${students}/:studentId`;

  app.post(classes, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const input = parseBody(createClassInputSchema, request.body);
    return reply.code(201).send(await createClass(db, principal, input));
  });

  app.get(classes, { exposeHeadRoute: false }, async (request) => listClasses(db, await requirePrincipal(request)));

  app.get<ClassRoute>(classroom, { exposeHeadRoute: false }, async (request) =>
    getClassDetail(db, await requirePrincipal(request), request.params.classId));

  app.patch<ClassRoute>(classroom, async (request) => {
    const principal = await requirePrincipal(request);
    const { expectedVersion, ...input } = parseBody(updateClassInputSchema, request.body);
    return updateClass(db, principal, request.params.classId, input, expectedVersion);
  });

  app.post<ClassRoute>(`${classroom}/archive`, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const { expectedVersion } = parseBody(versionedInputSchema, request.body);
    await archiveClass(db, principal, request.params.classId, expectedVersion);
    return reply.code(204).send();
  });

  app.post<ClassRoute>(students, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const input = parseBody(addStudentInputSchema, request.body);
    return reply.code(201).send(await addStudent(db, principal, request.params.classId, input));
  });

  app.patch<StudentRoute>(student, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, studentId } = request.params;
    const { expectedVersion, ...input } = parseBody(updateStudentInputSchema, request.body);
    return updateStudent(db, principal, classId, studentId, input, expectedVersion);
  });

  app.post<StudentRoute>(`${student}/archive`, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const { classId, studentId } = request.params;
    const { expectedVersion } = parseBody(versionedInputSchema, request.body);
    await archiveStudent(db, principal, classId, studentId, expectedVersion);
    return reply.code(204).send();
  });
}
