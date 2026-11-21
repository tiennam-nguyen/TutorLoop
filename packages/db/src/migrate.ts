import type { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { createDb } from "./client.ts";
import type { Database } from "./database.ts";
import * as core from "./migrations/001_core.ts";
import * as proposalsJobsAudit from "./migrations/002_proposals_jobs_audit.ts";
import * as betterAuth from "./migrations/003_better_auth.ts";

export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return {
          "001_core": core,
          "002_proposals_jobs_audit": proposalsJobsAudit,
          "003_better_auth": betterAuth,
        };
      },
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error !== undefined) {
    throw error;
  }
}

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.trim()) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const db = createDb(connectionString);
  try {
    await runMigrations(db);
  } finally {
    await db.destroy();
  }
}
