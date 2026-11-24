import { createDb } from "@tutorloop/db/client";
import { createApp } from "./app.ts";
import { betterAuthVerifier, createBetterAuth } from "./auth/better-auth.ts";
import { registerAuthRoutes } from "./auth/routes.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value;
}

const appUrl = new URL(requireEnv("APP_ORIGIN"));
if (!["http:", "https:"].includes(appUrl.protocol) || appUrl.href !== `${appUrl.origin}/`) {
  throw new Error("APP_ORIGIN must be an HTTP or HTTPS origin.");
}

const databaseUrl = requireEnv("DATABASE_URL");
const db = createDb(databaseUrl);
try {
  const auth = createBetterAuth(db, {
    origin: appUrl.origin,
    secret: requireEnv("BETTER_AUTH_SECRET"),
    googleClientId: requireEnv("GOOGLE_CLIENT_ID"),
    googleClientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
  });
  const app = await createApp({ authVerifier: betterAuthVerifier(auth), db, readinessDatabaseUrl: databaseUrl });
  app.addHook("onClose", () => db.destroy());
  registerAuthRoutes(app, appUrl.origin, auth.handler);

  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3001),
  });
} catch (error) {
  await db.destroy();
  throw error;
}
