import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./database.ts";

export function createDb(connectionString: string): Kysely<Database> {
  if (!connectionString.trim()) {
    throw new Error("A PostgreSQL connection string is required.");
  }

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  });
}
