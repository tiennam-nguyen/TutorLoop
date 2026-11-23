import { mergeCanonicalIssueInputSchema, updateCanonicalIssueInputSchema } from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { mergeCanonicalIssue, updateCanonicalIssue } from "./service.ts";

type Route = { Params: { classId: string; canonicalIssueId: string } };
export function registerIssueRoutes(app: FastifyInstance, db: Kysely<Database>) {
  const path = "/api/v1/classes/:classId/canonical-issues/:canonicalIssueId";
  app.patch<Route>(path, async (request) => {
    const principal = await requirePrincipal(request), input = updateCanonicalIssueInputSchema.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return updateCanonicalIssue(db, principal, request.params.classId, request.params.canonicalIssueId, input.data);
  });
  app.post<Route>(`${path}/merge`, async (request) => {
    const principal = await requirePrincipal(request), input = mergeCanonicalIssueInputSchema.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return mergeCanonicalIssue(db, principal, request.params.classId, request.params.canonicalIssueId, input.data);
  });
}
