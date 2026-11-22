import { createInterventionInputSchema, nonblankTextWithoutNulSchema } from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { getIntervention, recordIntervention } from "./service.ts";

type ClassParams = { classId: string };
const createInput = createInterventionInputSchema.extend({
  description: nonblankTextWithoutNulSchema.refine((value) => value.isWellFormed(), "Must be well-formed Unicode"),
});

export function registerInterventionRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const interventions = "/api/v1/classes/:classId/interventions";

  app.post<{ Params: ClassParams }>(interventions, async (request, reply) => {
    const principal = await requirePrincipal(request);
    const input = createInput.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    return reply.code(201).send(await recordIntervention(db, principal, request.params.classId, input.data));
  });

  app.get<{ Params: ClassParams & { interventionId: string } }>(`${interventions}/:interventionId`,
    { exposeHeadRoute: false }, async (request) => {
      const principal = await requirePrincipal(request);
      const { classId, interventionId } = request.params;
      return getIntervention(db, principal, classId, interventionId);
    });
}
