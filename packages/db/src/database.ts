import type {
  EvidenceDto,
  RawNoteType,
  ReassessmentStatus,
  ReassessmentTargetStatus,
  StudentIssueState,
} from "@tutorloop/contracts";
import type { Generated } from "kysely";

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
}
