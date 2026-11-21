import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE classes
      ADD COLUMN client_request_id uuid,
      ADD COLUMN create_input_hash text,
      ADD CONSTRAINT classes_create_request_unique UNIQUE (owner_user_id, client_request_id),
      ADD CONSTRAINT classes_create_receipt_complete
        CHECK ((client_request_id IS NULL) = (create_input_hash IS NULL));

    ALTER TABLE students
      ADD COLUMN client_request_id uuid,
      ADD COLUMN create_input_hash text,
      ADD CONSTRAINT students_create_request_unique UNIQUE (class_id, client_request_id),
      ADD CONSTRAINT students_create_receipt_complete
        CHECK ((client_request_id IS NULL) = (create_input_hash IS NULL));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE students DROP COLUMN create_input_hash, DROP COLUMN client_request_id;
    ALTER TABLE classes DROP COLUMN create_input_hash, DROP COLUMN client_request_id;
  `.execute(db);
}
