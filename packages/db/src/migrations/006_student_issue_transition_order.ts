import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Existing rows receive values during the migration. Their original insertion order is unavailable.
  await sql`
    ALTER TABLE student_issue_transitions ADD COLUMN insertion_order bigint GENERATED ALWAYS AS IDENTITY
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE student_issue_transitions DROP COLUMN insertion_order`.execute(db);
}
