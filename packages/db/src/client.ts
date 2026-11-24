import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./database.ts";

function createPool(config: pg.PoolConfig) {
  const pool = new pg.Pool(config);
  pool.on("connect", (client) => {
    client.on("error", () => {
      // pg rejects pending work independently. pg-pool removes its idle listener at checkout.
    });
  });
  pool.on("error", () => {
    // pg has already discarded the idle connection. Keep its error and client details private.
    console.error("PostgreSQL idle connection lost.");
  });
  return pool;
}

export function createDb(connectionString: string): Kysely<Database> {
  if (!connectionString.trim()) {
    throw new Error("A PostgreSQL connection string is required.");
  }

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: createPool({ connectionString }) }) });
}

export function createDbReadiness(connectionString: string) {
  const timeoutMs = 1_000;
  const pool = createPool({ connectionString, max: 1, connectionTimeoutMillis: timeoutMs });
  let inFlight: Promise<boolean> | undefined;

  return {
    check() {
      // pool.query discards the physical connection on query timeout. Share it across concurrent probes.
      return inFlight ??= Promise.resolve().then(() => {
        const query = { text: "select 1", query_timeout: timeoutMs };
        return pool.query(query);
      }).then(() => true, () => false).finally(() => { inFlight = undefined; });
    },
    close: () => pool.end(),
  };
}
