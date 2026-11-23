import type { AiTask, ProposalDraftItemV1, ProposalDraftV1, StudentIssueState } from "@tutorloop/contracts";

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
    version?: number;
  }[];
  studentIssues: readonly {
    studentIssueId: string;
    studentId: string;
    canonicalIssueId: string;
    manifestation: string | null;
    state: StudentIssueState;
    version: number;
  }[];
  evidenceHistory?: readonly {
    studentIssueId: string;
    observationText: string;
    learningContext: string | null;
  }[];
};

// An in-process port. A remote adapter must minimize and pseudonymize the input locally.
export interface NoteStructurer {
  structureNote(input: StructureNoteInput): Promise<ProposalDraftV1>;
}

type PreparedDraftItem = {
  item: ProposalDraftItemV1;
  dependencyKey: string | null;
  baseVersion: number | null;
  targetId: string | null;
};

function canStoreJsonText(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed() && !value.includes("\u0000");
  if (value && typeof value === "object") return Object.values(value).every(canStoreJsonText);
  return true;
}

// Both routed and injected drafts must fit the loaded class context and proposal storage.
export function prepareDraftForPersistence(
  draft: ProposalDraftV1, input: Pick<StructureNoteInput, "students" | "canonicalIssues" | "studentIssues">,
): PreparedDraftItem[] | undefined {
  if (!canStoreJsonText(draft)) return;

  const aliases = new Set(input.students.map(({ aiAlias }) => aiAlias));
  const canonicalIds = new Set(input.canonicalIssues.map(({ canonicalIssueId }) => canonicalIssueId));
  const studentIssueIds = new Set(input.studentIssues.map(({ studentIssueId }) => studentIssueId));
  const typesByKey = new Map(draft.items.map(({ key, type }) => [key, type]));
  const prepared: PreparedDraftItem[] = [];

  for (const item of draft.items) {
    if ("studentRef" in item && item.studentRef.kind === "RESOLVED" &&
      !aliases.has(item.studentRef.studentAlias)) return;

    let dependencyKey: string | null = null;
    if ("canonicalIssueRef" in item) {
      const ref = item.canonicalIssueRef;
      if (ref.kind === "PROPOSED") {
        if (typesByKey.get(ref.proposalKey) !== "CREATE_CANONICAL_ISSUE") return;
        dependencyKey = ref.proposalKey;
      } else if (ref.kind === "EXISTING" && !canonicalIds.has(ref.canonicalIssueId.toLowerCase())) {
        return;
      }
    }
    const issueRef = "studentIssueRef" in item ? item.studentIssueRef : null;
    if (issueRef?.kind === "PROPOSED") {
      if (typesByKey.get(issueRef.proposalKey) !== "CREATE_STUDENT_ISSUE") return;
      dependencyKey = issueRef.proposalKey;
    } else if (issueRef?.kind === "EXISTING" && !studentIssueIds.has(issueRef.studentIssueId.toLowerCase())) {
      return;
    }

    if (item.type === "MERGE_CANONICAL_ISSUE") {
      const source = input.canonicalIssues.find(({ canonicalIssueId }) => canonicalIssueId === item.sourceCanonicalIssueId.toLowerCase());
      const target = input.canonicalIssues.find(({ canonicalIssueId }) => canonicalIssueId === item.targetCanonicalIssueId.toLowerCase());
      if (!source || !target || source === target || source.version !== item.expectedSourceVersion ||
        target.version !== item.expectedTargetVersion || item.expectedSourceVersion > 2_147_483_647 ||
        item.expectedTargetVersion > 2_147_483_647) return;
      prepared.push({ item, dependencyKey: null, baseVersion: item.expectedSourceVersion, targetId: item.sourceCanonicalIssueId });
      continue;
    }
    const baseVersion = "expectedVersion" in item ? item.expectedVersion : null;
    if (baseVersion !== null && baseVersion > 2_147_483_647) return;
    prepared.push({
      item, dependencyKey, baseVersion,
      targetId: baseVersion !== null && issueRef?.kind === "EXISTING" ? issueRef.studentIssueId : null,
    });
  }
  return prepared;
}
