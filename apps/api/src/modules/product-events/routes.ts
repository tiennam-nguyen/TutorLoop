import { recordProductEventInputSchema } from "@tutorloop/observability/product-events";
import { insertProductEvent, viewEventEntityExists } from "@tutorloop/db/repositories/product-events";
import type { Database } from "@tutorloop/db/database";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";

export function registerProductEventRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.post("/api/v1/product-events", async (request, reply) => {
    const principal = await requirePrincipal(request);
    const input = recordProductEventInputSchema.safeParse(request.body);
    if (!input.success) throw new ApiError("VALIDATION_ERROR", "Invalid request.");
    await db.transaction().execute(async (trx) => {
      const classroom = await requireOwnedClass(trx, principal, input.data.classId);
      const { eventName, entityId } = input.data;
      if (entityId && !await viewEventEntityExists(trx, classroom.id, eventName, entityId)) {
        throw new ApiError("NOT_FOUND", "Entity not found.");
      }
      await insertProductEvent(trx, { class_id: classroom.id, actor_user_id: principal.userId,
        event_name: eventName, entity_id: entityId?.toLowerCase() ?? null });
    });
    return reply.code(204).send();
  });
}
