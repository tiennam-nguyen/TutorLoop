import { readFile } from "node:fs/promises";
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // The official auth@1.7.26 CLI generated this from the API's Better Auth configuration.
  const schema = await readFile(new URL("./auth/schema.sql", import.meta.url), "utf8");
  await sql.raw(schema).execute(db);
}
