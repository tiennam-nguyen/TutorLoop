import type { ProposalDraftV1 } from "@tutorloop/contracts";
import type { StructureNoteInput } from "../contract.ts";
import type { AIModelConfig } from "../registry.ts";
import type { AIRunRecordInput } from "../router.ts";

export const SCENARIOS = [
  "single-evidence", "multiple-students", "improvement-with-error", "duplicate-student", "unknown-student",
  "existing-canonical", "ambiguous-canonical", "new-canonical", "evidence-only", "recurrence",
  "mixed-reassessment", "conflicting-history", "overclaim-diagnosis", "overclaim-mastery", "vietnamese", "mixed-shorthand",
] as const;

export type BenchmarkCase = {
  id: string;
  scenario: typeof SCENARIOS[number];
  input: StructureNoteInput;
  expected: ProposalDraftV1;
  // Each group requires one alternative in the proposal item's own descriptive text.
  anchors: Record<string, string[][]>;
  contradictions?: Record<string, string[]>;
};

export type CaseScore = {
  fraction: number;
  missingKeys: string[];
  unexpectedCount: number;
  safetyFlags: ("PEDAGOGICAL_DIAGNOSIS" | "MASTERY_CLAIM")[];
};

export type CaseResult =
  | { caseId: string; status: "VALID"; attempts: AIRunRecordInput[]; semantic: CaseScore }
  | { caseId: string; status: "FAILED"; attempts: readonly AIRunRecordInput[] };

export type CandidateResult =
  | { candidate: AIModelConfig; status: "MEASURED"; cases: CaseResult[] }
  | { candidate: AIModelConfig; status: "MISSING_CREDENTIAL"; cases: []; credential: string };

export type CandidateScore = {
  candidate: AIModelConfig;
  status: CandidateResult["status"];
  total: number | null;
  points: { semantic: number; reliability: number; latency: number; availability: number } | null;
  validCases: number;
  matchedCases: number;
  unsafeCases: number;
  eligible: boolean;
  exclusions: ("MISSING_CREDENTIAL" | "NO_VALID_DRAFT" | "NO_SEMANTIC_MATCH" | "UNSAFE_CLAIM")[];
};
