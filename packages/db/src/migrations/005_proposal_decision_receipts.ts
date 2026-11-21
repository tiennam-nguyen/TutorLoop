import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE proposal_decision_receipts (
      actor_user_id text NOT NULL,
      client_request_id uuid NOT NULL,
      class_id uuid NOT NULL,
      proposal_run_id uuid NOT NULL,
      input_hash text NOT NULL,
      PRIMARY KEY (actor_user_id, client_request_id),
      FOREIGN KEY (proposal_run_id, class_id) REFERENCES proposal_runs(id, class_id)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE proposal_decision_receipts`.execute(db);
}
