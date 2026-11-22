import type {
  EvidenceDto,
  ProposalItemStatus,
  ProposalItemType,
  ProposalRunStatus,
  RawNoteType,
  ReassessmentStatus,
  ReassessmentTargetStatus,
  StudentIssueState,
} from "@tutorloop/contracts";
import type { ColumnType, Generated, GeneratedAlways } from "kysely";

type JsonObject = Record<string, unknown>;

export interface Database {
  classes: {
    id: string;
    owner_user_id: string;
    name: string;
    timezone: string;
    archived_at: Date | null;
    version: Generated<number>;
    created_at: Date;
    updated_at: Date;
    client_request_id: ColumnType<string | null, string | null | undefined, never>;
    create_input_hash: ColumnType<string | null, string | null | undefined, never>;
  };
  students: {
    id: string;
    class_id: string;
    display_label: string;
    ai_alias: string;
    archived_at: Date | null;
    version: Generated<number>;
    created_at: Date;
    updated_at: Date;
    client_request_id: ColumnType<string | null, string | null | undefined, never>;
    create_input_hash: ColumnType<string | null, string | null | undefined, never>;
  };
  raw_notes: {
    id: string;
    class_id: string;
    author_user_id: string;
    note_type: RawNoteType;
    body: string;
    observed_at: Date;
    reassessment_id: string | null;
    client_request_id: string | null;
    voided_at: Date | null;
    void_reason: string | null;
    created_at: Date;
  };
  canonical_issues: {
    id: string;
    class_id: string;
    label: string;
    description: string | null;
    merged_into_id: string | null;
    archived_at: Date | null;
    version: Generated<number>;
    created_at: Date;
    updated_at: Date;
  };
  student_issues: {
    id: string;
    class_id: string;
    student_id: string;
    canonical_issue_id: string;
    manifestation: string | null;
    state: StudentIssueState;
    version: Generated<number>;
    created_at: Date;
    updated_at: Date;
  };
  student_issue_transitions: {
    id: string;
    insertion_order: GeneratedAlways<string>;
    class_id: string;
    student_issue_id: string;
    from_state: StudentIssueState | null;
    to_state: StudentIssueState;
    evidence_event_id: string | null;
    proposal_item_id: string | null;
    actor_user_id: string;
    reason: string | null;
    created_at: Date;
  };
  evidence_events: {
    id: string;
    class_id: string;
    student_id: string;
    raw_note_id: string;
    student_issue_id: string | null;
    reassessment_id: string | null;
    observation_text: string;
    learning_context: string | null;
    observed_at: Date;
    provenance: EvidenceDto["provenance"];
    proposal_item_id: string | null;
    approved_by_user_id: string;
    created_at: Date;
  };
  interventions: {
    id: string;
    class_id: string;
    description: string;
    occurred_at: Date;
    created_by_user_id: string;
    created_at: Date;
    client_request_id: ColumnType<string | null, string | null | undefined, never>;
  };
  intervention_targets: {
    class_id: string;
    intervention_id: string;
    student_issue_id: string;
  };
  reassessments: {
    id: string;
    class_id: string;
    title: string | null;
    notes: string | null;
    due_at: Date;
    status: ReassessmentStatus;
    performed_at: Date | null;
    completed_at: Date | null;
    created_by_user_id: string;
    version: Generated<number>;
    created_at: Date;
    updated_at: Date;
  };
  reassessment_targets: {
    class_id: string;
    reassessment_id: string;
    student_issue_id: string;
    intervention_id: string | null;
    target_status: ReassessmentTargetStatus;
    skip_reason: string | null;
  };
  jobs: {
    id: string;
    kind: string;
    dedupe_key: string;
    payload: JsonObject;
    status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD";
    attempts: Generated<number>;
    run_after: Date;
    locked_at: Date | null;
    locked_by: string | null;
    last_error_code: string | null;
    created_at: Date;
    updated_at: Date;
  };
  proposal_runs: {
    id: string;
    class_id: string;
    raw_note_id: string;
    source_job_id: string;
    status: ProposalRunStatus;
    schema_version: string;
    created_at: Date;
    updated_at: Date;
  };
  proposal_items: {
    id: string;
    class_id: string;
    proposal_run_id: string;
    item_type: ProposalItemType;
    original_payload: ColumnType<JsonObject, JsonObject, never>;
    teacher_patch: JsonObject | null;
    status: ProposalItemStatus;
    target_entity_type: string | null;
    target_entity_id: string | null;
    base_version: number | null;
    result_entity_type: string | null;
    result_entity_id: string | null;
    decided_by_user_id: string | null;
    decided_at: Date | null;
    created_at: Date;
  };
  proposal_decision_receipts: {
    actor_user_id: string;
    client_request_id: string;
    class_id: string;
    proposal_run_id: string;
    input_hash: string;
  };
  proposal_item_dependencies: {
    proposal_item_id: string;
    depends_on_item_id: string;
  };
  ai_runs: {
    id: string;
    class_id: string;
    proposal_run_id: string;
    task_type: string;
    provider: string;
    model: string;
    prompt_version: string;
    schema_version: string;
    redaction_version: string;
    input_hash: string;
    status: "SUCCESS" | "TRANSIENT_FAILURE" | "PERMANENT_FAILURE";
    latency_ms: number | null;
    usage_json: Record<string, number> | null;
    error_code: string | null;
    created_at: Date;
  };
  audit_log: {
    id: string;
    class_id: string;
    actor_user_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    created_at: Date;
  };
  product_events: {
    id: string;
    class_id: string;
    actor_user_id: string;
    event_name:
      | "raw_note_created"
      | "proposal_review_opened"
      | "proposal_item_approved"
      | "proposal_item_edited"
      | "proposal_item_rejected"
      | "student_view_opened"
      | "class_issue_view_opened"
      | "reassessment_due_opened"
      | "history_opened";
    entity_id: string | null;
    created_at: Date;
  };
}
