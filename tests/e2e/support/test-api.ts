import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { createApp } from "../../../apps/api/src/app.ts";
import { createBetterAuth } from "../../../apps/api/src/auth/better-auth.ts";
import type { AuthVerifier } from "../../../apps/api/src/auth/principal.ts";
import { registerAuthRoutes } from "../../../apps/api/src/auth/routes.ts";

const testTeacher: AuthVerifier = async (request) => {
  const cookies = request.headers.cookie?.split(";").map((cookie) => cookie.trim());
  return cookies?.includes("tutorloop-e2e=teacher") ? { userId: "e2e-teacher" } : null;
};

export async function startTestApi(origin: string, port: number) {
  const postgres = await startPostgres();
  const db = createDb(postgres.getConnectionUri());
  let app: Awaited<ReturnType<typeof createApp>> | undefined;

  async function close() {
    try {
      await app?.close();
    } finally {
      try {
        await db.destroy();
      } finally {
        await postgres.stop();
      }
    }
  }

  try {
    await runMigrations(db);
    app = await createApp({ authVerifier: testTeacher, db });
    const auth = createBetterAuth(db, {
      origin,
      secret: "tutorloop-e2e-only-secret-with-no-production-access",
      googleClientId: "test-client.apps.googleusercontent.com",
      googleClientSecret: "tutorloop-e2e-google-secret",
    });
    registerAuthRoutes(app, origin, auth.handler);
    await app.listen({ host: "127.0.0.1", port });
    return { app, db, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (import.meta.main) {
  const origin = process.env.TEST_WEB_ORIGIN;
  const port = Number(process.env.TEST_API_PORT);
  if (!origin || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Set TEST_WEB_ORIGIN and TEST_API_PORT via the Playwright config.");
  }
  const api = await startTestApi(origin, port);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void api.close().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  }
}
