import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE interventions
      ADD COLUMN client_request_id uuid,
      ADD CONSTRAINT interventions_creator_request_unique UNIQUE (created_by_user_id, client_request_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE interventions DROP COLUMN client_request_id`.execute(db);
}
