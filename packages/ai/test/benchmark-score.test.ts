import { expect, test } from "vitest";
import { AI_MODEL_REGISTRY } from "../src/registry.ts";
import type { AIRunRecordInput } from "../src/router.ts";
import type { BenchmarkCase, CaseResult } from "../src/benchmark/types.ts";
import { evaluateDraft, rankCandidates, SCORE_WEIGHTS } from "../src/benchmark/score.ts";
import { loadDataset, runBenchmark, validateDataset } from "../src/benchmark/run.ts";

const [gemini, openRouter, groq, nvidia] = AI_MODEL_REGISTRY;
const goodEvidence = {
  key: "e1", type: "CREATE_EVIDENCE", studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
  observationText: "Added the denominators when adding fractions.",
} as const;
const fixture: BenchmarkCase = {
  id: "01-a", scenario: "single-evidence",
  input: {
    classId: "class", rawNoteId: "note", task: "STRUCTURE_OBSERVATION_NOTE",
    body: "Fable added the denominators when adding fractions.", observedAt: "2026-01-01T00:00:00Z",
    students: [{ studentId: "student", displayLabel: "Fable", aiAlias: "STU_001" }],
    canonicalIssues: [], studentIssues: [],
  },
  expected: { schemaVersion: "1", items: [goodEvidence] },
  anchors: { e1: [["denominator"], ["added", "adding"]] },
};

const success: AIRunRecordInput = {
  provider: "GEMINI", model: gemini.model, promptVersion: "structure-note-v1", schemaVersion: "1",
  redactionVersion: "1", inputHash: "synthetic", latencyMs: 5000, status: "SUCCESS", errorCode: null,
};
const valid: CaseResult = {
  caseId: "01-a", status: "VALID", attempts: [success],
  semantic: { fraction: 1, missingKeys: [], unexpectedCount: 0, safetyFlags: [] },
};
const invalid: AIRunRecordInput = { ...success, status: "TRANSIENT_FAILURE", errorCode: "INVALID_STRUCTURED_OUTPUT" };

test("weights add to 100 and schema failure loses reliability without counting as provider unavailability", () => {
  expect(SCORE_WEIGHTS).toEqual({ semantic: 60, reliability: 25, latency: 10, availability: 5 });
  expect(Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(100);
  const [clean] = rankCandidates([{ candidate: gemini, status: "MEASURED", cases: [valid] }]);
  const [retried] = rankCandidates([{ candidate: gemini, status: "MEASURED", cases: [
    { ...valid, attempts: [invalid, success] },
  ] }]);
  expect(clean.points).toEqual({ semantic: 60, reliability: 25, latency: 5, availability: 5 });
  expect(retried.points).toEqual({ semantic: 60, reliability: 12.5, latency: 10 / 3, availability: 5 });
});

test.each(["The student has a fundamental misconception.", "The student has mastered fraction addition."])(
  "a forbidden claim zeroes semantic points and disqualifies the candidate (%s)", (claim) => {
    const semantic = evaluateDraft(fixture, { schemaVersion: "1", items: [
      { ...goodEvidence, observationText: `${goodEvidence.observationText} ${claim}` },
    ] });
    expect(semantic.fraction).toBe(0);
    expect(semantic.safetyFlags).toHaveLength(1);
    const [score] = rankCandidates([{ candidate: gemini, status: "MEASURED", cases: [{ ...valid, semantic }] }]);
    expect(score.eligible).toBe(false);
  },
);

test("meaningful evidence and correct student resolution are both required", () => {
  expect(evaluateDraft(fixture, fixture.expected).fraction).toBe(1);
  expect(evaluateDraft(fixture, { schemaVersion: "1", items: [
    { ...goodEvidence, observationText: "Did mathematics." },
  ] }).fraction).toBe(0);
  expect(evaluateDraft(fixture, { schemaVersion: "1", items: [
    { ...goodEvidence, studentRef: { kind: "UNKNOWN", token: "Fable" } },
  ] }).fraction).toBe(0);
});

test.each([
  { caseId: "02-b", key: "b", correct: "Marked the x-axis as y.",
    wrong: "Correctly labeled the horizontal axis x, not y." },
  { caseId: "03-a", key: "e", correct: "Most unlike-sign products were correct, though the student wrote (-3)*2=6 once.",
    wrong: "Got most products wrong, but correctly wrote (-3) × 2 = -6 once." },
  { caseId: "03-a", key: "e", correct: "Got most products right but reported 6 instead of -6 on one product.",
    wrong: "Got most products right, and also correctly wrote (-3) × 2 = -6 once." },
  { caseId: "03-a", key: "e", correct: "Got most products right but wrote (-3) × 2 = 6 once.",
    wrong: "Got most products right but wrote (-3) × 2 = 60 once." },
  { caseId: "07-a", key: "s", correct: "Could be an error in either subtraction or multiplication.",
    wrong: "The learner definitely made a multiplication error. Subtraction was correct." },
])("$caseId credits the supported relation for $key only", async ({ caseId, key, correct, wrong }) => {
  const { cases } = await loadDataset();
  const row = cases.find(({ id }) => id === caseId)!;
  const draft = (text: string) => ({ ...row.expected, items: row.expected.items.map((item) => {
    if (item.key !== key) return item;
    if (item.type === "CREATE_EVIDENCE") return { ...item, observationText: text };
    if (item.type === "CREATE_STUDENT_ISSUE") return { ...item, manifestation: text };
    throw new Error(`Unexpected draft type for ${caseId}/${key}`);
  }) });
  expect(evaluateDraft(row, draft(correct)).fraction).toBe(1);
  expect(evaluateDraft(row, draft(wrong)).missingKeys).toContain(key);
});

test.each([
  ["and now has total command of sign rules.", ["MASTERY_CLAIM"]],
  [" This does not establish mastery.", []],
  [" There is no evidence of a misconception.", []],
  [" This does not establish mastery. The student now has total command of sign rules.", ["MASTERY_CLAIM"]],
])("distinguishes a forbidden claim from an explicit denial (%s)", async (suffix, flags) => {
  const { cases } = await loadDataset();
  const row = cases.find(({ id }) => id === "14-a")!;
  const [item] = row.expected.items;
  if (item.type !== "CREATE_EVIDENCE") throw new Error("Expected evidence in 14-a");
  const actual = { ...item, observationText: `${item.observationText.replace(/\.$/u, "")} ${suffix.trim()}` };
  const semantic = evaluateDraft(row, { schemaVersion: "1", items: [actual] });
  expect(semantic.safetyFlags).toEqual(flags);
  expect(semantic.fraction).toBe(flags.length ? 0 : 1);
});

test("ties use a stable identifier and missing or failed candidates are ineligible", () => {
  const ranked = rankCandidates([
    { candidate: openRouter, status: "MEASURED", cases: [valid] },
    { candidate: nvidia, status: "MISSING_CREDENTIAL", credential: "NVIDIA_NIM_API_KEY", cases: [] },
    { candidate: groq, status: "MEASURED", cases: [{ caseId: "01-a", status: "FAILED", attempts: [invalid] }] },
    { candidate: gemini, status: "MEASURED", cases: [valid] },
  ]);
  expect(ranked.map(({ candidate, eligible, total }) => [candidate.provider, eligible, total])).toEqual([
    ["GEMINI", true, 95], ["OPENROUTER", true, 95], ["GROQ", false, 5], ["NVIDIA_NIM", false, null],
  ]);
});

test("the 32-gold-case corpus validates and rejects inconsistent expectations", async () => {
  const dataset = await loadDataset();
  expect(dataset.revision).toBe("v2");
  expect(dataset.cases).toHaveLength(32);
  expect(new Set(dataset.cases.map(({ scenario }) => scenario)).size).toBe(16);
  for (const row of dataset.cases) expect(evaluateDraft(row, row.expected).fraction, row.id).toBe(1);
  const cases = structuredClone(dataset.cases);
  cases[0].expected.items[0] = { ...goodEvidence, studentRef: { kind: "RESOLVED", studentAlias: "not-on-roster" } };
  expect(() => validateDataset({ revision: "v2", cases })).toThrow(/01-a/);
});

test("scores supportingEvidenceKey links by resolved Evidence item rather than item key", async () => {
  const { cases } = await loadDataset();
  const row = cases.find(({ id }) => id === "11-a")!;
  const renamed = {
    schemaVersion: "1" as const,
    items: row.expected.items.map((item) => {
      if (item.type === "CREATE_EVIDENCE") return { ...item, key: `ev-${item.key}` };
      if (item.type === "TRANSITION_STUDENT_ISSUE") {
        return { ...item, key: `tr-${item.key}`, supportingEvidenceKey: `ev-${item.supportingEvidenceKey}` };
      }
      return item;
    }),
  };
  expect(evaluateDraft(row, renamed).fraction).toBe(1);

  const missingLink = {
    schemaVersion: "1" as const,
    items: renamed.items.map((item) =>
      item.type === "TRANSITION_STUDENT_ISSUE" && item.key === "tr-tb"
        ? { ...item, supportingEvidenceKey: undefined }
        : item),
  };
  expect(evaluateDraft(row, missingLink).missingKeys).toContain("tb");

  const wrongStudentLink = {
    schemaVersion: "1" as const,
    items: renamed.items.map((item) =>
      item.type === "TRANSITION_STUDENT_ISSUE" && item.key === "tr-tb"
        ? { ...item, supportingEvidenceKey: "ev-l" }
        : item),
  };
  expect(evaluateDraft(row, wrongStudentLink).missingKeys).toContain("tb");
});

test("live execution keeps all retry attempts isolated and missing keys visible", async () => {
  const calls: string[] = [];
  const results = await runBenchmark([fixture], { GEMINI_API_KEY: "synthetic", GROQ_API_KEY: "synthetic" },
    async (url, request) => {
      calls.push(String(url));
      if (String(url).includes("googleapis.com")) {
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "invalid" }] } }] });
      }
      const payload = JSON.parse(String(request?.body));
      expect(payload.model).toBe("openai/gpt-oss-120b");
      expect(payload.messages[1].content).toContain("STU_001 added the denominators");
      expect(payload.messages[1].content).not.toContain("Fable");
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        schemaVersion: "1", items: [{ ...goodEvidence, observedAt: null, learningContext: null, studentIssueRef: null }],
      }) } }] });
    });
  expect(calls.sort()).toEqual([
    "https://api.groq.com/openai/v1/chat/completions",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  ]);
  expect(results.map(({ status, cases }) => [status, cases.map((row) => row.status)])).toEqual([
    ["MEASURED", ["FAILED"]], ["MISSING_CREDENTIAL", []], ["MEASURED", ["VALID"]], ["MISSING_CREDENTIAL", []],
  ]);
  expect(results[0].cases[0].attempts.map(({ errorCode }) => errorCode)).toEqual([
    "INVALID_STRUCTURED_OUTPUT", "INVALID_STRUCTURED_OUTPUT",
  ]);
});
