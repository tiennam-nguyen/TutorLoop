import { randomUUID } from "node:crypto";
import type { Insertable, Transaction } from "kysely";
import type { Database } from "../database.ts";

export async function insertAIRun(db: Transaction<Database>, data: Omit<Insertable<Database["ai_runs"]>, "id">) {
  await db.insertInto("ai_runs").values({ id: randomUUID(), ...data }).execute();
}
