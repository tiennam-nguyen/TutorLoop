import {
  proposalDecisionBatchInputSchema, updateStudentIssueManifestationInputSchema, updateStudentIssueStateInputSchema,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { applyProposalDecisions, getProposalRun, updateStudentIssueManifestation, updateStudentIssueState } from "./service.ts";

type ProposalRunRoute = { Params: { classId: string; proposalRunId: string } };
type StudentIssueRoute = { Params: { classId: string; studentIssueId: string } };

export function registerProposalRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const run = "/api/v1/classes/:classId/proposal-runs/:proposalRunId";
  const issue = "/api/v1/classes/:classId/student-issues/:studentIssueId";

  app.get<ProposalRunRoute>(run, { exposeHeadRoute: false }, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, proposalRunId } = request.params;
    return getProposalRun(db, principal, classId, proposalRunId);
  });

  app.post<ProposalRunRoute>(`${run}/decisions`, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, proposalRunId } = request.params;
    const input = proposalDecisionBatchInputSchema.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return applyProposalDecisions(db, principal, classId, proposalRunId, input.data);
  });

  app.patch<StudentIssueRoute>(`${issue}/state`, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, studentIssueId } = request.params;
    const input = updateStudentIssueStateInputSchema.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return updateStudentIssueState(db, principal, classId, studentIssueId, input.data);
  });

  app.patch<StudentIssueRoute>(`${issue}/manifestation`, async (request) => {
    const principal = await requirePrincipal(request);
    const { classId, studentIssueId } = request.params;
    const input = updateStudentIssueManifestationInputSchema.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return updateStudentIssueManifestation(db, principal, classId, studentIssueId, input.data);
  });
}
