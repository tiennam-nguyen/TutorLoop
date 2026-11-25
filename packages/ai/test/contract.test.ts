import type { ProposalDraftItemV1, ProposalDraftV1 } from "@tutorloop/contracts";
import { expect, test } from "vitest";
import { prepareDraftForPersistence, type StructureNoteInput } from "../src/contract.ts";

const input: Pick<StructureNoteInput, "students" | "canonicalIssues" | "studentIssues"> = {
  students: [
    { studentId: "stu-1", displayLabel: "An", aiAlias: "STU_001" },
    { studentId: "stu-2", displayLabel: "Bình", aiAlias: "STU_002" },
  ],
  canonicalIssues: [
    { canonicalIssueId: "ci-1", label: "Sign error", description: null, version: 1 },
  ],
  studentIssues: [
    {
      studentIssueId: "si-1",
      studentId: "stu-1",
      canonicalIssueId: "ci-1",
      manifestation: null,
      state: "OPEN",
      version: 2,
    },
    {
      studentIssueId: "si-1-other",
      studentId: "stu-1",
      canonicalIssueId: "ci-1",
      manifestation: null,
      state: "OPEN",
      version: 1,
    },
    {
      studentIssueId: "si-2",
      studentId: "stu-2",
      canonicalIssueId: "ci-1",
      manifestation: null,
      state: "OPEN",
      version: 1,
    },
  ],
};

function draft(items: ProposalDraftItemV1[]): ProposalDraftV1 {
  return { schemaVersion: "1", items };
}

test("prepares a valid transition depending on supporting CREATE_EVIDENCE for an existing issue", () => {
  const prepared = prepareDraftForPersistence(draft([
    {
      key: "e1",
      type: "CREATE_EVIDENCE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      observationText: "Solved without sign error.",
    },
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      expectedVersion: 2,
      toState: "IMPROVING",
      supportingEvidenceKey: "e1",
    },
  ]), input);

  expect(prepared).toBeDefined();
  expect(prepared!.map(({ item, dependencyKey, baseVersion, targetId }) => ({
    key: item.key, dependencyKey, baseVersion, targetId,
  }))).toEqual([
    { key: "e1", dependencyKey: null, baseVersion: null, targetId: null },
    { key: "t1", dependencyKey: "e1", baseVersion: 2, targetId: "si-1" },
  ]);
});

test("rejects a transition missing supportingEvidenceKey", () => {
  const prepared = prepareDraftForPersistence(draft([
    {
      key: "e1",
      type: "CREATE_EVIDENCE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      observationText: "Solved without sign error.",
    },
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      expectedVersion: 2,
      toState: "IMPROVING",
    },
  ]), input);

  expect(prepared).toBeUndefined();
});

test("rejects a transition whose supportingEvidenceKey references a non-Evidence item or missing key", () => {
  const withNonEvidence = prepareDraftForPersistence(draft([
    {
      key: "m1",
      type: "UPDATE_MANIFESTATION",
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      expectedVersion: 2,
      manifestation: "Updated",
    },
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      expectedVersion: 2,
      toState: "IMPROVING",
      supportingEvidenceKey: "m1",
    },
  ]), input);
  expect(withNonEvidence).toBeUndefined();

  const withMissing = prepareDraftForPersistence(draft([
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      expectedVersion: 2,
      toState: "IMPROVING",
      supportingEvidenceKey: "missing",
    },
  ]), input);
  expect(withMissing).toBeUndefined();
});

test("rejects a transition when supporting Evidence has missing or mismatched studentIssueRef", () => {
  const issueFreeEvidence = prepareDraftForPersistence(draft([
    {
      key: "e1",
      type: "CREATE_EVIDENCE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
      studentIssueRef: null,
      observationText: "General note.",
    },
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      expectedVersion: 2,
      toState: "IMPROVING",
      supportingEvidenceKey: "e1",
    },
  ]), input);
  expect(issueFreeEvidence).toBeUndefined();

  const otherIssueEvidence = prepareDraftForPersistence(draft([
    {
      key: "e1",
      type: "CREATE_EVIDENCE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1-other" },
      observationText: "Other issue evidence.",
    },
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      expectedVersion: 2,
      toState: "IMPROVING",
      supportingEvidenceKey: "e1",
    },
  ]), input);
  expect(otherIssueEvidence).toBeUndefined();
});

test("rejects a transition when supporting Evidence student does not own the StudentIssue", () => {
  const wrongExistingStudent = prepareDraftForPersistence(draft([
    {
      key: "e1",
      type: "CREATE_EVIDENCE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_002" },
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      observationText: "Attributed to wrong student.",
    },
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "EXISTING", studentIssueId: "si-1" },
      expectedVersion: 2,
      toState: "IMPROVING",
      supportingEvidenceKey: "e1",
    },
  ]), input);
  expect(wrongExistingStudent).toBeUndefined();

  const wrongProposedStudent = prepareDraftForPersistence(draft([
    {
      key: "s1",
      type: "CREATE_STUDENT_ISSUE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
      canonicalIssueRef: { kind: "EXISTING", canonicalIssueId: "ci-1" },
    },
    {
      key: "e1",
      type: "CREATE_EVIDENCE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_002" },
      studentIssueRef: { kind: "PROPOSED", proposalKey: "s1" },
      observationText: "Wrong student on proposed issue.",
    },
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "PROPOSED", proposalKey: "s1" },
      expectedVersion: 1,
      toState: "IMPROVING",
      supportingEvidenceKey: "e1",
    },
  ]), input);
  expect(wrongProposedStudent).toBeUndefined();
});

test("orders proposed StudentIssue -> Evidence -> transition dependency chain regardless of item order", () => {
  const prepared = prepareDraftForPersistence(draft([
    {
      key: "t1",
      type: "TRANSITION_STUDENT_ISSUE",
      studentIssueRef: { kind: "PROPOSED", proposalKey: "s1" },
      expectedVersion: 1,
      toState: "IMPROVING",
      supportingEvidenceKey: "e1",
    },
    {
      key: "e1",
      type: "CREATE_EVIDENCE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
      studentIssueRef: { kind: "PROPOSED", proposalKey: "s1" },
      observationText: "Evidence on proposed issue.",
    },
    {
      key: "s1",
      type: "CREATE_STUDENT_ISSUE",
      studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
      canonicalIssueRef: { kind: "EXISTING", canonicalIssueId: "ci-1" },
    },
  ]), input);

  expect(prepared).toBeDefined();
  expect(prepared!.map(({ item, dependencyKey }) => [item.key, dependencyKey])).toEqual([
    ["t1", "e1"],
    ["e1", "s1"],
    ["s1", null],
  ]);
});
