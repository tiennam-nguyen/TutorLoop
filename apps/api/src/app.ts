import fastify, { type FastifyInstance } from "fastify";
import type { AuthVerifier } from "./auth/principal.ts";

export type CreateAppOptions = {
  authVerifier: AuthVerifier;
};

export async function createApp(
  _options: CreateAppOptions,
): Promise<FastifyInstance> {
  // The health route is public. Authenticated routes will use the verifier.
  const app = fastify();

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
