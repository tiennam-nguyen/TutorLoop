import type { StructureNoteInput } from "../../../packages/ai/src/contract.ts";
import type { ProposalDraftItemV1, ProposalDraftV1, StudentRef } from "../../../packages/contracts/src/index.ts";

export const notes = {
  mergeSeed: "Seed merge history branches.",
  merge: "These two sign issues describe the same issue.",
  shared: "An và Bình lại sai dấu khi chuyển vế.",
  projection: "An và Bình cần xem lại lỗi dấu khi chuyển vế.",
  ambiguousStudent: "Minh lại sai dấu khi chuyển vế.",
  unknownStudent: "Lan quên đổi dấu khi chuyển vế.",
  seedIssues: "Cần theo dõi hai lỗi khác nhau về dấu.",
  ambiguousIssue: "An làm sai dấu, chưa rõ ở bước nào.",
  followUp: "An nhớ đổi dấu ở bước đầu nhưng vẫn sai ở bước cuối.",
  retry: "An cần ghi lại bài kiểm tra về dấu.",
  reassessmentOutcome: "An tự đổi dấu đúng. Bình làm đúng sau khi được nhắc.",
  recurrence: "Ở bài sau, An lại quên đổi dấu khi chuyển vế.",
};

const draft = (items: ProposalDraftItemV1[]): ProposalDraftV1 => ({ schemaVersion: "1", items });

let sharedReleased = false;
let releasePendingShared: (() => void) | undefined;

export function releaseSharedCapture() {
  sharedReleased = true;
  releasePendingShared?.();
}

async function waitForSharedCapture(signal: AbortSignal) {
  if (sharedReleased) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("E2E worker stopped"));
    releasePendingShared = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  releasePendingShared = undefined;
}

export function captureFixtures(signal: AbortSignal) {
  const retries = new Map<string, number>();

  return async function structure(input: StructureNoteInput): Promise<ProposalDraftV1> {
    const resolved = (name: string): StudentRef => {
      const student = input.students.find(({ displayLabel }) => displayLabel === name);
      if (!student) throw new Error(`Missing fixture student ${name}`);
      return { kind: "RESOLVED", studentAlias: student.aiAlias };
    };

    switch (input.body) {
      case notes.mergeSeed:
        return draft([...["Source", "Target"].flatMap((name): ProposalDraftItemV1[] => [
          { key: name, type: "CREATE_CANONICAL_ISSUE", label: `${name} sign issue` },
          { key: `${name}-issue`, type: "CREATE_STUDENT_ISSUE", studentRef: resolved("An"),
            canonicalIssueRef: { kind: "PROPOSED", proposalKey: name }, manifestation: `${name} manifestation` },
          { key: `${name}-evidence`, type: "CREATE_EVIDENCE", studentRef: resolved("An"),
            studentIssueRef: { kind: "PROPOSED", proposalKey: `${name}-issue` }, observationText: `${name} evidence` },
        ])]);
      case notes.merge: {
        const source = input.canonicalIssues.find(({ label }) => label === "Teacher source label");
        const target = input.canonicalIssues.find(({ label }) => label === "Target sign issue");
        if (!source || !target) throw new Error("Missing merge fixture candidates");
        return draft([{ key: "merge", type: "MERGE_CANONICAL_ISSUE", sourceCanonicalIssueId: source.canonicalIssueId,
          targetCanonicalIssueId: target.canonicalIssueId, expectedSourceVersion: source.version!, expectedTargetVersion: target.version! }]);
      }
      case notes.shared:
      case notes.projection:
        // The browser releases this test-only gate after two completed status reads.
        if (input.body === notes.shared) await waitForSharedCapture(signal);
        return draft([
          { key: "signs", type: "CREATE_CANONICAL_ISSUE", label: "Sai dấu khi chuyển vế" },
          ...["An", "Bình"].flatMap((name): ProposalDraftItemV1[] => [
            {
              key: `${name}-issue`, type: "CREATE_STUDENT_ISSUE", studentRef: resolved(name),
              canonicalIssueRef: { kind: "PROPOSED", proposalKey: "signs" },
            },
            {
              key: `${name}-evidence`, type: "CREATE_EVIDENCE", studentRef: resolved(name),
              studentIssueRef: { kind: "PROPOSED", proposalKey: `${name}-issue` },
              observationText: `${name} sai dấu khi chuyển vế.`,
            },
          ]),
          ...(input.body === notes.projection ? [{ key: "rejected-observation", type: "CREATE_EVIDENCE" as const,
            studentRef: resolved("An"), observationText: "Rejected fixture observation must stay a proposal." }] : []),
        ]);
      case notes.ambiguousStudent:
        return draft([{
          key: "minh", type: "CREATE_EVIDENCE", observationText: notes.ambiguousStudent,
          studentRef: {
            kind: "AMBIGUOUS", token: "Minh",
            candidateAliases: input.students.filter(({ displayLabel }) => displayLabel === "Minh").map(({ aiAlias }) => aiAlias),
          },
        }]);
      case notes.unknownStudent:
        return draft([{
          key: "lan", type: "CREATE_EVIDENCE", observationText: notes.unknownStudent,
          studentRef: { kind: "UNKNOWN", token: "Lan" },
        }]);
      case notes.seedIssues:
        return draft([
          { key: "signs", type: "CREATE_CANONICAL_ISSUE", label: "Sai dấu khi chuyển vế" },
          { key: "negative", type: "CREATE_CANONICAL_ISSUE", label: "Nhầm dấu số âm" },
        ]);
      case notes.ambiguousIssue:
        return draft([{
          key: "an", type: "CREATE_STUDENT_ISSUE", studentRef: resolved("An"),
          canonicalIssueRef: { kind: "AMBIGUOUS", candidateIds: input.canonicalIssues.map(({ canonicalIssueId }) => canonicalIssueId) },
        }]);
      case notes.followUp: {
        const issue = input.studentIssues[0];
        if (!issue) throw new Error("Missing fixture Student Issue");
        const studentIssueRef = { kind: "EXISTING", studentIssueId: issue.studentIssueId } as const;
        return draft([
          { key: "an", type: "CREATE_EVIDENCE", studentRef: resolved("An"), studentIssueRef, observationText: notes.followUp },
          { key: "manifestation", type: "UPDATE_MANIFESTATION", studentIssueRef, expectedVersion: issue.version, manifestation: "Sai ở bước cuối." },
          { key: "state", type: "TRANSITION_STUDENT_ISSUE", studentIssueRef, expectedVersion: issue.version, toState: "IMPROVING", supportingEvidenceKey: "an" },
        ]);
      }
      case notes.retry: {
        const attempt = (retries.get(input.rawNoteId) ?? 0) + 1;
        if (attempt <= 3) {
          retries.set(input.rawNoteId, attempt);
          throw new Error("Fixture structuring failure");
        }
        retries.delete(input.rawNoteId);
        return draft([
          { key: "retry-canonical", type: "CREATE_CANONICAL_ISSUE", label: "Lỗi dấu trong bài kiểm tra" },
          { key: "retry-issue", type: "CREATE_STUDENT_ISSUE", studentRef: resolved("An"),
            canonicalIssueRef: { kind: "PROPOSED", proposalKey: "retry-canonical" } },
          { key: "retry", type: "CREATE_EVIDENCE", studentRef: resolved("An"), observationText: notes.retry,
            studentIssueRef: { kind: "PROPOSED", proposalKey: "retry-issue" } },
        ]);
      }
      case notes.recurrence: {
        const student = input.students.find(({ displayLabel }) => displayLabel === "An");
        const issue = input.studentIssues.find(({ studentId }) => studentId === student?.studentId);
        if (!issue) throw new Error("Missing recurrence target for An");
        const studentIssueRef = { kind: "EXISTING", studentIssueId: issue.studentIssueId } as const;
        return draft([
          { key: "An-outcome", type: "CREATE_EVIDENCE", studentRef: resolved("An"), studentIssueRef,
            observationText: "An forgot to change the sign again." },
          { key: "An-transition", type: "TRANSITION_STUDENT_ISSUE", studentIssueRef, expectedVersion: issue.version, toState: "OPEN", supportingEvidenceKey: "An-outcome" },
        ]);
      }
      case notes.reassessmentOutcome:
        return draft(["An", "Bình"].flatMap((name): ProposalDraftItemV1[] => {
          const student = input.students.find(({ displayLabel }) => displayLabel === name);
          const issue = input.studentIssues.find(({ studentId }) => studentId === student?.studentId);
          if (!issue) throw new Error(`Missing reassessment target for ${name}`);
          const studentIssueRef = { kind: "EXISTING", studentIssueId: issue.studentIssueId } as const;
          return [
            {
              key: `${name}-outcome`, type: "CREATE_EVIDENCE", studentRef: resolved(name), studentIssueRef,
              observationText: name === "An" ? "An independently changed the sign correctly." : "Bình corrected the sign after a prompt.",
            },
            {
              key: `${name}-transition`, type: "TRANSITION_STUDENT_ISSUE", studentIssueRef, expectedVersion: issue.version,
              toState: name === "An" ? "RESOLVED_FOR_NOW" : "IMPROVING", supportingEvidenceKey: `${name}-outcome`,
            },
          ];
        }));
      default:
        throw new Error("No structuring fixture for this note");
    }
  };
}
