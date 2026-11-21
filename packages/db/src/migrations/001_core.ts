import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Keep historical enum definitions independent of changes to the API contracts.
  await sql`
    CREATE TYPE raw_note_type AS ENUM ('OBSERVATION', 'REASSESSMENT_OUTCOME');
    CREATE TYPE student_issue_state AS ENUM ('OPEN', 'IMPROVING', 'RESOLVED_FOR_NOW');
    CREATE TYPE evidence_provenance AS ENUM ('TEACHER_DIRECT', 'AI_PROPOSED_TEACHER_APPROVED');
    CREATE TYPE reassessment_status AS ENUM (
      'SCHEDULED', 'PERFORMED_PENDING_EVIDENCE', 'COMPLETED', 'CANCELLED'
    );
    CREATE TYPE reassessment_target_status AS ENUM ('PENDING', 'EVIDENCED', 'SKIPPED');

    CREATE TABLE classes (
      id uuid PRIMARY KEY,
      owner_user_id text NOT NULL,
      name text NOT NULL,
      timezone text NOT NULL,
      archived_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE students (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      display_label text NOT NULL,
      ai_alias text NOT NULL,
      archived_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (class_id, ai_alias),
      UNIQUE (id, class_id)
    );

    CREATE TABLE canonical_issues (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      label text NOT NULL,
      description text,
      merged_into_id uuid,
      archived_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (id, class_id),
      CONSTRAINT canonical_issue_merge_target_not_self CHECK (merged_into_id <> id),
      FOREIGN KEY (merged_into_id, class_id) REFERENCES canonical_issues(id, class_id)
    );

    CREATE TABLE student_issues (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      student_id uuid NOT NULL,
      canonical_issue_id uuid NOT NULL,
      manifestation text,
      state student_issue_state NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (student_id, canonical_issue_id),
      UNIQUE (id, class_id),
      FOREIGN KEY (student_id, class_id) REFERENCES students(id, class_id),
      FOREIGN KEY (canonical_issue_id, class_id) REFERENCES canonical_issues(id, class_id)
    );

    CREATE TABLE reassessments (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      title text,
      notes text,
      due_at timestamptz NOT NULL,
      status reassessment_status NOT NULL,
      performed_at timestamptz,
      completed_at timestamptz,
      created_by_user_id text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (id, class_id)
    );

    CREATE TABLE raw_notes (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      author_user_id text NOT NULL,
      note_type raw_note_type NOT NULL,
      body text NOT NULL,
      observed_at timestamptz NOT NULL,
      reassessment_id uuid,
      client_request_id uuid,
      voided_at timestamptz,
      void_reason text,
      created_at timestamptz NOT NULL,
      UNIQUE (id, class_id),
      FOREIGN KEY (reassessment_id, class_id) REFERENCES reassessments(id, class_id)
    );

    CREATE UNIQUE INDEX raw_notes_author_request_unique
      ON raw_notes (author_user_id, client_request_id)
      WHERE client_request_id IS NOT NULL;

    CREATE TABLE evidence_events (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      student_id uuid NOT NULL,
      raw_note_id uuid NOT NULL,
      student_issue_id uuid,
      reassessment_id uuid,
      observation_text text NOT NULL,
      learning_context text,
      observed_at timestamptz NOT NULL,
      provenance evidence_provenance NOT NULL,
      proposal_item_id uuid,
      approved_by_user_id text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (id, class_id),
      FOREIGN KEY (student_id, class_id) REFERENCES students(id, class_id),
      FOREIGN KEY (raw_note_id, class_id) REFERENCES raw_notes(id, class_id),
      FOREIGN KEY (student_issue_id, class_id) REFERENCES student_issues(id, class_id),
      FOREIGN KEY (reassessment_id, class_id) REFERENCES reassessments(id, class_id)
    );

    CREATE TABLE student_issue_transitions (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      student_issue_id uuid NOT NULL,
      from_state student_issue_state,
      to_state student_issue_state NOT NULL,
      evidence_event_id uuid,
      proposal_item_id uuid,
      actor_user_id text NOT NULL,
      reason text,
      created_at timestamptz NOT NULL,
      FOREIGN KEY (student_issue_id, class_id) REFERENCES student_issues(id, class_id),
      FOREIGN KEY (evidence_event_id, class_id) REFERENCES evidence_events(id, class_id)
    );

    CREATE TABLE interventions (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      description text NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_by_user_id text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (id, class_id)
    );

    CREATE TABLE intervention_targets (
      class_id uuid NOT NULL,
      intervention_id uuid NOT NULL,
      student_issue_id uuid NOT NULL,
      PRIMARY KEY (intervention_id, student_issue_id),
      FOREIGN KEY (intervention_id, class_id) REFERENCES interventions(id, class_id),
      FOREIGN KEY (student_issue_id, class_id) REFERENCES student_issues(id, class_id)
    );

    CREATE TABLE reassessment_targets (
      class_id uuid NOT NULL,
      reassessment_id uuid NOT NULL,
      student_issue_id uuid NOT NULL,
      intervention_id uuid,
      target_status reassessment_target_status NOT NULL,
      skip_reason text,
      PRIMARY KEY (reassessment_id, student_issue_id),
      FOREIGN KEY (reassessment_id, class_id) REFERENCES reassessments(id, class_id),
      FOREIGN KEY (student_issue_id, class_id) REFERENCES student_issues(id, class_id),
      FOREIGN KEY (intervention_id, class_id) REFERENCES interventions(id, class_id)
    );
  `.execute(db);
}
