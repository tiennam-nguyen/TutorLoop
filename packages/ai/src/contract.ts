import type {
  AiTask, ProposalDraftItemV1, ProposalDraftV1, StudentIssueRef, StudentIssueState, StudentRef,
} from "@tutorloop/contracts";

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

function sameStudentIssueRef(left: StudentIssueRef | null | undefined, right: StudentIssueRef): boolean {
  if (!left || left.kind !== right.kind) return false;
  return left.kind === "EXISTING" && right.kind === "EXISTING"
    ? left.studentIssueId.toLowerCase() === right.studentIssueId.toLowerCase()
    : left.kind === "PROPOSED" && right.kind === "PROPOSED" && left.proposalKey === right.proposalKey;
}

function sameStudentRef(left: StudentRef, right: StudentRef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "RESOLVED" && right.kind === "RESOLVED") return left.studentAlias === right.studentAlias;
  if (left.kind === "UNKNOWN" && right.kind === "UNKNOWN") return left.token === right.token;
  return left.kind === "AMBIGUOUS" && right.kind === "AMBIGUOUS" &&
    left.token === right.token &&
    left.candidateAliases.length === right.candidateAliases.length &&
    left.candidateAliases.every((alias) => right.candidateAliases.includes(alias));
}

// Both routed and injected drafts must fit the loaded class context and proposal storage.
export function prepareDraftForPersistence(
  draft: ProposalDraftV1, input: Pick<StructureNoteInput, "students" | "canonicalIssues" | "studentIssues">,
): PreparedDraftItem[] | undefined {
  if (!canStoreJsonText(draft)) return;

  const studentIdByAlias = new Map(input.students.map(({ aiAlias, studentId }) => [aiAlias, studentId]));
  const canonicalIds = new Set(input.canonicalIssues.map(({ canonicalIssueId }) => canonicalIssueId.toLowerCase()));
  const studentIssuesById = new Map(input.studentIssues.map((issue) => [issue.studentIssueId.toLowerCase(), issue]));
  const itemsByKey = new Map(draft.items.map((item) => [item.key, item]));
  const prepared: PreparedDraftItem[] = [];

  for (const item of draft.items) {
    if ("studentRef" in item && item.studentRef.kind === "RESOLVED" &&
      !studentIdByAlias.has(item.studentRef.studentAlias)) return;

    let dependencyKey: string | null = null;
    if ("canonicalIssueRef" in item) {
      const ref = item.canonicalIssueRef;
      if (ref.kind === "PROPOSED") {
        if (itemsByKey.get(ref.proposalKey)?.type !== "CREATE_CANONICAL_ISSUE") return;
        dependencyKey = ref.proposalKey;
      } else if (ref.kind === "EXISTING" && !canonicalIds.has(ref.canonicalIssueId.toLowerCase())) {
        return;
      }
    }
    const issueRef = "studentIssueRef" in item ? item.studentIssueRef : null;
    if (issueRef?.kind === "PROPOSED") {
      if (itemsByKey.get(issueRef.proposalKey)?.type !== "CREATE_STUDENT_ISSUE") return;
      dependencyKey = issueRef.proposalKey;
    } else if (issueRef?.kind === "EXISTING") {
      const existingIssue = studentIssuesById.get(issueRef.studentIssueId.toLowerCase());
      if (!existingIssue || ("expectedVersion" in item && item.expectedVersion !== existingIssue.version)) return;
    }

    if (item.type === "TRANSITION_STUDENT_ISSUE") {
      if (!item.supportingEvidenceKey) return;
      const evidence = itemsByKey.get(item.supportingEvidenceKey);
      if (evidence?.type !== "CREATE_EVIDENCE" || !sameStudentIssueRef(evidence.studentIssueRef, item.studentIssueRef)) {
        return;
      }
      if (item.studentIssueRef.kind === "EXISTING") {
        const existingIssue = studentIssuesById.get(item.studentIssueRef.studentIssueId.toLowerCase());
        if (!existingIssue || evidence.studentRef.kind !== "RESOLVED" ||
          studentIdByAlias.get(evidence.studentRef.studentAlias) !== existingIssue.studentId) {
          return;
        }
      } else {
        const proposedIssue = itemsByKey.get(item.studentIssueRef.proposalKey);
        if (proposedIssue?.type !== "CREATE_STUDENT_ISSUE" || !sameStudentRef(evidence.studentRef, proposedIssue.studentRef)) {
          return;
        }
      }
      dependencyKey = item.supportingEvidenceKey;
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
