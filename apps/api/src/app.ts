import fastify, { type FastifyInstance } from "fastify";
import { requirePrincipal, type AuthVerifier } from "./auth/principal.ts";
import { registerApiErrorHandlers } from "./common/errors.ts";

export type CreateAppOptions = {
  authVerifier: AuthVerifier;
};

export async function createApp(
  { authVerifier }: CreateAppOptions,
): Promise<FastifyInstance> {
  const app = fastify();
  app.decorate("authVerifier", authVerifier);
  registerApiErrorHandlers(app);

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/v1/me", async (request) => {
    const { userId } = await requirePrincipal(request);
    return { userId };
  });

  return app;
}
