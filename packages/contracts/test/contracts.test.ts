import { describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  canonicalIssueDetailDtoSchema,
  createClassInputSchema,
  createInterventionInputSchema,
  createRawNoteInputSchema,
  createReassessmentInputSchema,
  proposalDecisionBatchInputSchema,
  proposalDraftV1Schema,
  recordProductEventInputSchema,
} from "@tutorloop/contracts";

const id = "12345678-1234-4234-8234-123456789abc";
const observedAt = "2026-11-20T14:00:00+07:00";
const evidence = {
  type: "CREATE_EVIDENCE",
  key: "evidence-1",
  studentRef: { kind: "RESOLVED", studentAlias: "STU_1" },
  observationText: "Used the wrong sign.",
};

describe("ProposalDraftV1", () => {
  it("accepts evidence linked to a resolved student without an issue", () => {
    const draft = { schemaVersion: "1", items: [evidence] };
    expect(proposalDraftV1Schema.parse(draft)).toEqual(draft);
  });

  it("preserves an ambiguous student and its candidates", () => {
    const studentRef = { kind: "AMBIGUOUS", token: "Minh", candidateAliases: ["STU_1", "STU_2"] };
    const draft = { schemaVersion: "1", items: [{ ...evidence, studentRef }] };
    expect(proposalDraftV1Schema.parse(draft)).toEqual(draft);
  });

  it("preserves proposed links and other unresolved references", () => {
    const draft = {
      schemaVersion: "1",
      items: [
        { type: "CREATE_CANONICAL_ISSUE", key: "canonical", label: "Sign error", description: null },
        {
          type: "CREATE_STUDENT_ISSUE", key: "student-issue",
          studentRef: { kind: "UNKNOWN", token: "Minh" },
          canonicalIssueRef: { kind: "PROPOSED", proposalKey: "canonical" },
          manifestation: null,
        },
        {
          type: "CREATE_STUDENT_ISSUE", key: "other-student-issue",
          studentRef: { kind: "RESOLVED", studentAlias: "STU_2" },
          canonicalIssueRef: { kind: "AMBIGUOUS", candidateIds: [id] },
        },
        {
          type: "UPDATE_MANIFESTATION", key: "update",
          studentIssueRef: { kind: "EXISTING", studentIssueId: id },
          expectedVersion: 1, manifestation: null,
        },
        {
          type: "TRANSITION_STUDENT_ISSUE", key: "transition",
          studentIssueRef: { kind: "PROPOSED", proposalKey: "student-issue" },
          expectedVersion: 1, toState: "IMPROVING", supportingEvidenceKey: "evidence-1",
        },
        { ...evidence, studentIssueRef: null, learningContext: null },
      ],
    };
    expect(proposalDraftV1Schema.parse(draft)).toEqual(draft);
    const legacy = {
      schemaVersion: "1",
      items: [{
        type: "TRANSITION_STUDENT_ISSUE", key: "transition",
        studentIssueRef: { kind: "EXISTING", studentIssueId: id },
        expectedVersion: 1, toState: "IMPROVING",
      }],
    };
    expect(proposalDraftV1Schema.parse(legacy)).toEqual(legacy);
  });

  it.each([
    ["unknown item", { ...evidence, type: "OTHER" }],
    ["standalone match", { ...evidence, type: "MATCH_CANONICAL_ISSUE" }],
    ["standalone merge", { ...evidence, type: "MERGE_CANONICAL_ISSUE" }],
    ["proposed issue without a key", { ...evidence, studentIssueRef: { kind: "PROPOSED" } }],
    ["blank supportingEvidenceKey", {
      type: "TRANSITION_STUDENT_ISSUE",
      key: "transition",
      studentIssueRef: { kind: "EXISTING", studentIssueId: id },
      expectedVersion: 1,
      toState: "IMPROVING",
      supportingEvidenceKey: "   ",
    }],
    ["mastered state", {
      type: "TRANSITION_STUDENT_ISSUE",
      key: "transition",
      studentIssueRef: { kind: "EXISTING", studentIssueId: id },
      expectedVersion: 1,
      toState: "MASTERED",
    }],
  ])("rejects %s", (_name, item) => {
    expect(proposalDraftV1Schema.safeParse({ schemaVersion: "1", items: [item] }).success).toBe(false);
  });

  it("rejects duplicate keys across item types", () => {
    const items = [evidence, { key: evidence.key, type: "CREATE_CANONICAL_ISSUE", label: "Sign error" }];
    expect(proposalDraftV1Schema.safeParse({ schemaVersion: "1", items }).success).toBe(false);
  });

  it("rejects unknown schema versions", () => {
    expect(proposalDraftV1Schema.safeParse({ schemaVersion: "2", items: [evidence] }).success).toBe(false);
  });
});

describe("HTTP contracts", () => {
  it("preserves reassessment history in canonical issue detail", () => {
    const reassessment = {
      id: "12345678-1234-4234-8234-123456789abd",
      classId: id,
      title: "Check sign changes",
      notes: null,
      dueAt: observedAt,
      status: "SCHEDULED",
      performedAt: null,
      completedAt: null,
      version: 1,
      createdAt: observedAt,
      targets: [],
    };
    const issue = {
      id: "12345678-1234-4234-8234-123456789abe",
      classId: id,
      label: "Sign error",
      description: null,
      mergedIntoId: null,
      archivedAt: null,
      version: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
      countsByState: { OPEN: 1, IMPROVING: 0, RESOLVED_FOR_NOW: 0 },
      affectedStudents: 1,
      dueCount: 1,
      studentIssues: [],
      interventions: [],
      reassessments: [reassessment],
    };
    expect(canonicalIssueDetailDtoSchema.parse(issue)).toHaveProperty("reassessments", [reassessment]);
  });

  it("accepts the documented Raw Note with a timestamp offset and null reassessment", () => {
    const input = { body: "Sign error", observedAt, noteType: "OBSERVATION", reassessmentId: null, clientRequestId: id };
    expect(createRawNoteInputSchema.parse(input)).toEqual(input);
    expect(createRawNoteInputSchema.safeParse({ ...input, observedAt: "2026-11-20T14:00:00" }).success).toBe(false);
  });

  it("requires idempotency on creates and decision batches", () => {
    const classInput = { name: "Math", timezone: "Asia/Bangkok" };
    const intervention = { description: "Practice", occurredAt: observedAt, studentIssueIds: [id] };
    const reassessment = { dueAt: observedAt, studentIssueIds: [id], title: null, notes: null };
    const items = [{ proposalItemId: id, decision: "APPROVE", patch: null }];
    expect(createClassInputSchema.safeParse(classInput).success).toBe(false);
    expect(createClassInputSchema.parse({ ...classInput, clientRequestId: id })).toEqual({ ...classInput, clientRequestId: id });
    expect(createInterventionInputSchema.safeParse(intervention).success).toBe(false);
    expect(createInterventionInputSchema.parse({ ...intervention, clientRequestId: id })).toEqual({ ...intervention, clientRequestId: id });
    expect(createReassessmentInputSchema.safeParse(reassessment).success).toBe(false);
    expect(createReassessmentInputSchema.parse({ ...reassessment, clientRequestId: id })).toEqual({ ...reassessment, clientRequestId: id });
    expect(proposalDecisionBatchInputSchema.safeParse({ items }).success).toBe(false);
    expect(proposalDecisionBatchInputSchema.parse({ items, clientRequestId: id })).toEqual({ items, clientRequestId: id });
  });

  it("requires an edit patch for edit-and-approve", () => {
    const item = { proposalItemId: id, decision: "EDIT_AND_APPROVE" };
    expect(proposalDecisionBatchInputSchema.safeParse({ clientRequestId: id, items: [item] }).success).toBe(false);
    const input = { clientRequestId: id, items: [{ ...item, patch: { observationText: "Edited" } }] };
    expect(proposalDecisionBatchInputSchema.parse(input)).toEqual(input);
  });

  it("enforces the fixed API error codes", () => {
    const body = { error: { code: "STALE_VERSION", message: "Reload the record", details: { version: 2 } } };
    expect(apiErrorBodySchema.parse(body)).toEqual(body);
    expect(apiErrorBodySchema.safeParse({ error: { code: "OTHER_CONFLICT", message: "Conflict" } }).success).toBe(false);
  });

  it("rejects non-view events and arbitrary event properties", () => {
    const input = { eventName: "proposal_review_opened", classId: id, entityId: id };
    expect(recordProductEventInputSchema.parse(input)).toEqual(input);
    expect(recordProductEventInputSchema.safeParse({ ...input, eventName: "raw_note_created" }).success).toBe(false);
    expect(recordProductEventInputSchema.safeParse({ ...input, body: "private note" }).success).toBe(false);
  });
});
