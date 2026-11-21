import type { Database } from "@tutorloop/db/database";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal } from "../../auth/principal.ts";
import { getClassIssueDetail, getClassIssueList, getClassOverview, getStudentOverview } from "./service.ts";

type ClassParams = { classId: string };

export function registerProjectionRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const classroom = "/api/v1/classes/:classId";
  const options = { exposeHeadRoute: false };

  app.get<{ Params: ClassParams }>(`${classroom}/overview`, options, async (request) => {
    const principal = await requirePrincipal(request);
    return getClassOverview(db, principal, request.params.classId);
  });

  app.get<{ Params: ClassParams & { studentId: string } }>(`${classroom}/students/:studentId/overview`, options, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, studentId } = request.params;
    return getStudentOverview(db, principal, classId, studentId);
  });

  app.get<{ Params: ClassParams }>(`${classroom}/issues`, options, async (request) => {
    const principal = await requirePrincipal(request);
    return getClassIssueList(db, principal, request.params.classId);
  });

  app.get<{ Params: ClassParams & { canonicalIssueId: string } }>(`${classroom}/issues/:canonicalIssueId`, options, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, canonicalIssueId } = request.params;
    return getClassIssueDetail(db, principal, classId, canonicalIssueId);
  });
}
