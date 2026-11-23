import type { Database } from "@tutorloop/db/database";
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { Kysely } from "kysely";
import type { AuthVerifier } from "./principal.ts";

export const authBasePath = "/api/auth";

export function createBetterAuth(
  db: Kysely<Database>,
  config: { origin: string; secret: string; googleClientId: string; googleClientSecret: string },
) {
  return betterAuth({
    baseURL: config.origin,
    basePath: authBasePath,
    secret: config.secret,
    database: { db, type: "postgres" },
    socialProviders: {
      google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret },
    },
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
}

export function betterAuthVerifier(auth: ReturnType<typeof createBetterAuth>): AuthVerifier {
  return async (request) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      query: { disableRefresh: true },
    });
    return session ? { userId: session.user.id, email: session.user.email } : null;
  };
}
