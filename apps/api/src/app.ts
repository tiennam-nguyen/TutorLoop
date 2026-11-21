import type { Database } from "@tutorloop/db/database";
import fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { requirePrincipal, type AuthVerifier } from "./auth/principal.ts";
import { registerApiErrorHandlers } from "./common/errors.ts";
import { registerClassRoutes } from "./modules/classes/routes.ts";
import { registerProposalRoutes } from "./modules/proposals/routes.ts";
import { registerRawNoteRoutes } from "./modules/raw-notes/routes.ts";

export type CreateAppOptions = {
  authVerifier: AuthVerifier;
  db?: Kysely<Database>;
};

export async function createApp(
  { authVerifier, db }: CreateAppOptions,
): Promise<FastifyInstance> {
  const app = fastify();
  app.decorate("authVerifier", authVerifier);
  registerApiErrorHandlers(app);

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/v1/me", async (request) => {
    const { userId } = await requirePrincipal(request);
    return { userId };
  });

  if (db) {
    registerClassRoutes(app, db);
    registerRawNoteRoutes(app, db);
    registerProposalRoutes(app, db);
  }

  return app;
}
