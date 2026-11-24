import { createDbReadiness } from "@tutorloop/db/client";
import type { Database } from "@tutorloop/db/database";
import { randomUUID } from "node:crypto";
import type { LogSink } from "@tutorloop/observability/logger";
import fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal, type AuthVerifier } from "./auth/principal.ts";
import { registerApiErrorHandlers } from "./common/errors.ts";
import { registerPrivacyLogging } from "./common/logging.ts";
import { registerProductEventRoutes } from "./modules/product-events/routes.ts";
import { registerClassRoutes } from "./modules/classes/routes.ts";
import { registerIssueRoutes } from "./modules/issues/routes.ts";
import { registerInterventionRoutes } from "./modules/interventions/routes.ts";
import { registerProjectionRoutes } from "./modules/projections/routes.ts";
import { registerProposalRoutes } from "./modules/proposals/routes.ts";
import { registerRawNoteRoutes } from "./modules/raw-notes/routes.ts";
import { registerReassessmentRoutes } from "./modules/reassessments/routes.ts";

export type CreateAppOptions = {
  authVerifier: AuthVerifier;
  db?: Kysely<Database>;
  readinessDatabaseUrl?: string;
  now?: () => Date;
  logSink?: LogSink;
};

export async function createApp(
  { authVerifier, db, readinessDatabaseUrl, now = () => new Date(), logSink }: CreateAppOptions,
): Promise<FastifyInstance> {
  const app = fastify({ logger: false, requestIdHeader: false, genReqId: () => randomUUID() });
  registerPrivacyLogging(app, logSink);
  app.decorate("authVerifier", authVerifier);
  registerApiErrorHandlers(app);

  const readiness = readinessDatabaseUrl ? createDbReadiness(readinessDatabaseUrl) : undefined;
  if (readiness) app.addHook("onClose", () => readiness.close());
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    if (await readiness?.check()) return { status: "ready" };
    return reply.code(503).send({ status: "unavailable" });
  });

  app.get("/api/v1/me", async (request) => {
    const { userId } = await requirePrincipal(request);
    return { userId };
  });

  if (db) {
    registerProductEventRoutes(app, db);
    registerClassRoutes(app, db);
    registerIssueRoutes(app, db);
    registerRawNoteRoutes(app, db);
    registerProposalRoutes(app, db);
    registerProjectionRoutes(app, db, now);
    registerInterventionRoutes(app, db);
    registerReassessmentRoutes(app, db, now);
  }

  return app;
}
