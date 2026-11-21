import type { StructureNoteInput } from "../../../packages/ai/src/contract.ts";
import type { ProposalDraftItemV1, ProposalDraftV1, StudentRef } from "../../../packages/contracts/src/index.ts";
import { setTimeout } from "node:timers/promises";

export const notes = {
  shared: "An và Bình lại sai dấu khi chuyển vế.",
  ambiguousStudent: "Minh lại sai dấu khi chuyển vế.",
  unknownStudent: "Lan quên đổi dấu khi chuyển vế.",
  seedIssues: "Cần theo dõi hai lỗi khác nhau về dấu.",
  ambiguousIssue: "An làm sai dấu, chưa rõ ở bước nào.",
  followUp: "An nhớ đổi dấu ở bước đầu nhưng vẫn sai ở bước cuối.",
  retry: "An cần ghi lại bài kiểm tra về dấu.",
};

const draft = (items: ProposalDraftItemV1[]): ProposalDraftV1 => ({ schemaVersion: "1", items });

export function captureFixtures(signal: AbortSignal) {
  const retries = new Map<string, number>();

  return async function structure(input: StructureNoteInput): Promise<ProposalDraftV1> {
    const resolved = (name: string): StudentRef => {
      const student = input.students.find(({ displayLabel }) => displayLabel === name);
      if (!student) throw new Error(`Missing fixture student ${name}`);
      return { kind: "RESOLVED", studentAlias: student.aiAlias };
    };

    switch (input.body) {
      case notes.shared:
        // Leave two browser polls worth of time to observe in-progress structuring.
        await setTimeout(4_600, undefined, { signal });
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
          { key: "state", type: "TRANSITION_STUDENT_ISSUE", studentIssueRef, expectedVersion: issue.version, toState: "IMPROVING" },
        ]);
      }
      case notes.retry: {
        const attempt = (retries.get(input.rawNoteId) ?? 0) + 1;
        if (attempt <= 3) {
          retries.set(input.rawNoteId, attempt);
          throw new Error("Fixture structuring failure");
        }
        retries.delete(input.rawNoteId);
        return draft([{ key: "retry", type: "CREATE_EVIDENCE", studentRef: resolved("An"), observationText: notes.retry }]);
      }
      default:
        throw new Error("No structuring fixture for this note");
    }
  };
}
