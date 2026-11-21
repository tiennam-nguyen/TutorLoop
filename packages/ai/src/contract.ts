import type { AiTask, ProposalDraftV1, StudentIssueState } from "@tutorloop/contracts";

export type StructureNoteInput = {
  task: AiTask;
  classId: string;
  rawNoteId: string;
  body: string;
  observedAt: string;
  students: readonly {
    studentId: string;
    displayLabel: string;
    aiAlias: string;
  }[];
  canonicalIssues: readonly {
    canonicalIssueId: string;
    label: string;
    description: string | null;
  }[];
  studentIssues: readonly {
    studentIssueId: string;
    studentId: string;
    canonicalIssueId: string;
    manifestation: string | null;
    state: StudentIssueState;
    version: number;
  }[];
};

// An in-process port. A remote adapter must minimize and pseudonymize the input locally.
export interface NoteStructurer {
  structureNote(input: StructureNoteInput): Promise<ProposalDraftV1>;
}
