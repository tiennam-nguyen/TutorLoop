import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE job_status AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');
    CREATE TYPE proposal_run_status AS ENUM (
      'PROCESSING', 'READY', 'PARTIALLY_REVIEWED', 'APPLIED', 'FAILED', 'SUPERSEDED'
    );
    CREATE TYPE proposal_item_type AS ENUM (
      'CREATE_EVIDENCE', 'MATCH_CANONICAL_ISSUE', 'CREATE_CANONICAL_ISSUE', 'CREATE_STUDENT_ISSUE',
      'UPDATE_MANIFESTATION', 'TRANSITION_STUDENT_ISSUE', 'MERGE_CANONICAL_ISSUE'
    );
    CREATE TYPE proposal_item_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');
    CREATE TYPE ai_run_status AS ENUM ('SUCCESS', 'TRANSIENT_FAILURE', 'PERMANENT_FAILURE');
    CREATE TYPE product_event_name AS ENUM (
      'raw_note_created', 'proposal_review_opened', 'proposal_item_approved', 'proposal_item_edited',
      'proposal_item_rejected', 'student_view_opened', 'class_issue_view_opened',
      'reassessment_due_opened', 'history_opened'
    );

    CREATE TABLE jobs (
      id uuid PRIMARY KEY,
      kind text NOT NULL,
      dedupe_key text NOT NULL UNIQUE,
      payload jsonb NOT NULL,
      status job_status NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      run_after timestamptz NOT NULL,
      locked_at timestamptz,
      locked_by text,
      last_error_code text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE proposal_runs (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      raw_note_id uuid NOT NULL,
      source_job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
      status proposal_run_status NOT NULL,
      schema_version text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (id, class_id),
      FOREIGN KEY (raw_note_id, class_id) REFERENCES raw_notes(id, class_id)
    );

    CREATE TABLE proposal_items (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      proposal_run_id uuid NOT NULL,
      item_type proposal_item_type NOT NULL,
      original_payload jsonb NOT NULL,
      teacher_patch jsonb,
      status proposal_item_status NOT NULL,
      target_entity_type text,
      target_entity_id uuid,
      base_version integer,
      result_entity_type text,
      result_entity_id uuid,
      decided_by_user_id text,
      decided_at timestamptz,
      created_at timestamptz NOT NULL,
      UNIQUE (id, class_id),
      FOREIGN KEY (proposal_run_id, class_id) REFERENCES proposal_runs(id, class_id)
    );

    CREATE TABLE proposal_item_dependencies (
      proposal_item_id uuid NOT NULL REFERENCES proposal_items(id),
      depends_on_item_id uuid NOT NULL REFERENCES proposal_items(id),
      PRIMARY KEY (proposal_item_id, depends_on_item_id)
    );

    CREATE TABLE ai_runs (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      proposal_run_id uuid NOT NULL,
      task_type text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      prompt_version text NOT NULL,
      schema_version text NOT NULL,
      redaction_version text NOT NULL,
      input_hash text NOT NULL,
      status ai_run_status NOT NULL,
      latency_ms integer,
      usage_json jsonb,
      error_code text,
      created_at timestamptz NOT NULL,
      FOREIGN KEY (proposal_run_id, class_id) REFERENCES proposal_runs(id, class_id)
    );

    CREATE TABLE audit_log (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      actor_user_id text NOT NULL,
      action text NOT NULL,
      entity_type text NOT NULL,
      entity_id uuid NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE product_events (
      id uuid PRIMARY KEY,
      class_id uuid NOT NULL REFERENCES classes(id),
      actor_user_id text NOT NULL,
      event_name product_event_name NOT NULL,
      entity_id uuid,
      created_at timestamptz NOT NULL
    );

    ALTER TABLE evidence_events ADD CONSTRAINT evidence_events_proposal_item_fk
      FOREIGN KEY (proposal_item_id, class_id) REFERENCES proposal_items(id, class_id);
    ALTER TABLE student_issue_transitions ADD CONSTRAINT student_issue_transitions_proposal_item_fk
      FOREIGN KEY (proposal_item_id, class_id) REFERENCES proposal_items(id, class_id);
  `.execute(db);
}
