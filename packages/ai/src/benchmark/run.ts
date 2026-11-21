import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { aiTaskSchema, proposalDraftV1Schema, studentIssueStateSchema, timestampSchema } from "@tutorloop/contracts";
import { asObject } from "../adapters/http.ts";
import { prepareDraftForPersistence } from "../contract.ts";
import { pseudonymizeNote } from "../pseudonymize.ts";
import { AI_MODEL_REGISTRY } from "../registry.ts";
import { AIProcessingError, createConfiguredCandidateRouter, providerCredentialName } from "../router.ts";
import { evaluateDraft } from "./score.ts";
import { SCENARIOS, type BenchmarkCase, type CandidateResult, type CaseResult } from "./types.ts";
import { writeReport } from "./report.ts";

const PINNED_MODELS = {
  GEMINI: ["gemini-3.8-flash", "GEMINI_NATIVE", "NATIVE_JSON_SCHEMA"],
  OPENROUTER: ["z-ai/glm-5.3-flash:free", "OPENAI_COMPATIBLE", "PROMPT_JSON"],
  GROQ: ["openai/gpt-oss-120b", "OPENAI_COMPATIBLE", "STRICT_JSON_SCHEMA"],
  NVIDIA_NIM: ["nvidia/nemotron-3-ultra-550b-a55b", "OPENAI_COMPATIBLE", "PROMPT_JSON"],
} as const;

function validateCandidates(): void {
  if (AI_MODEL_REGISTRY.length !== Object.keys(PINNED_MODELS).length ||
      new Set(AI_MODEL_REGISTRY.map(({ provider }) => provider)).size !== AI_MODEL_REGISTRY.length) {
    throw new Error("Benchmark v1 requires exactly four distinct pinned providers.");
  }
  for (const candidate of AI_MODEL_REGISTRY) {
    const [model, transport, mode] = PINNED_MODELS[candidate.provider];
    if (candidate.model !== model || candidate.transport !== transport || candidate.structuredOutputMode !== mode ||
        !Number.isSafeInteger(candidate.timeoutMs) || candidate.timeoutMs <= 0 ||
        !Number.isSafeInteger(candidate.maxRetries) || candidate.maxRetries < 0) {
      throw new Error(`Invalid benchmark v1 route for ${candidate.provider}.`);
    }
  }
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.isWellFormed() && !value.includes("\u0000");
}

function nullableText(value: unknown): boolean {
  return value === null || nonblank(value);
}

function validContext(entries: unknown, id: string, check: (entry: Record<string, unknown>) => boolean): boolean {
  if (!Array.isArray(entries)) return false;
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = asObject(value);
    const key = entry?.[id];
    if (!entry || !nonblank(key) || seen.has(key) || !check(entry)) return false;
    seen.add(key);
  }
  return true;
}

function readInput(value: unknown): BenchmarkCase["input"] | undefined {
  const input = asObject(value);
  if (!input || !nonblank(input.body) || !nonblank(input.classId) || !nonblank(input.rawNoteId) ||
      !aiTaskSchema.safeParse(input.task).success || !timestampSchema.safeParse(input.observedAt).success ||
      !validContext(input.students, "studentId", ({ displayLabel, aiAlias }) =>
        nonblank(displayLabel) && typeof aiAlias === "string" && /^STU_\d{3}$/u.test(aiAlias)) ||
      !validContext(input.canonicalIssues, "canonicalIssueId", ({ label, description }) =>
        nonblank(label) && nullableText(description)) ||
      !validContext(input.studentIssues, "studentIssueId", ({ studentId, canonicalIssueId, state, version, manifestation }) =>
        nonblank(studentId) && nonblank(canonicalIssueId) && studentIssueStateSchema.safeParse(state).success &&
        typeof version === "number" && Number.isInteger(version) && version > 0 && version <= 2_147_483_647 &&
        nullableText(manifestation))) return;

  const typed = input as BenchmarkCase["input"];
  if (!typed.students.length || new Set(typed.students.map(({ aiAlias }) => aiAlias)).size !== typed.students.length ||
      typed.studentIssues.some((item) => !typed.students.some(({ studentId }) => studentId === item.studentId) ||
        !typed.canonicalIssues.some(({ canonicalIssueId }) => canonicalIssueId === item.canonicalIssueId))) return;
  return typed;
}

function validExpectations(row: BenchmarkCase): boolean {
  const { expected, input, anchors, contradictions } = row;
  const minimized = pseudonymizeNote({ body: input.body, students: input.students });
  if (!expected.items.length || !prepareDraftForPersistence(expected, input) ||
      Object.keys(anchors).length !== expected.items.length) return false;
  if (contradictions && Object.entries(contradictions).some(([key, phrases]) =>
    !expected.items.some((item) => item.key === key) || !Array.isArray(phrases) || !phrases.length || !phrases.every(nonblank))) return false;
  for (const item of expected.items) {
    const groups = anchors[item.key];
    if (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group) || !group.length ||
      !group.every(nonblank))) return false;
    if ((item.type === "CREATE_EVIDENCE" || item.type === "CREATE_CANONICAL_ISSUE") && !groups.length) return false;
    if ("studentRef" in item) {
      const ref = item.studentRef;
      if (ref.kind === "RESOLVED" && !minimized.text.includes(ref.studentAlias)) return false;
      if (ref.kind === "UNKNOWN" && (!minimized.text.includes(ref.token) || input.students.some(({ aiAlias }) => aiAlias === ref.token))) return false;
      if (ref.kind === "AMBIGUOUS" && !minimized.ambiguousTokens.some(({ token, candidateAliases }) =>
        token === ref.token && minimized.text.includes(token) && candidateAliases.length === ref.candidateAliases.length &&
        candidateAliases.every((alias) => ref.candidateAliases.includes(alias)))) return false;
    }
    if (item.type === "CREATE_STUDENT_ISSUE" && item.canonicalIssueRef.kind === "AMBIGUOUS") {
      const { candidateIds } = item.canonicalIssueRef;
      if (candidateIds.length < 2 || new Set(candidateIds).size !== candidateIds.length ||
          candidateIds.some((id) => !input.canonicalIssues.some(({ canonicalIssueId }) => id === canonicalIssueId))) return false;
    }
    if ("studentIssueRef" in item && item.studentIssueRef?.kind === "EXISTING") {
      const id = item.studentIssueRef.studentIssueId;
      const issue = input.studentIssues.find(({ studentIssueId }) => id === studentIssueId);
      if (!issue || ("expectedVersion" in item && item.expectedVersion !== issue.version)) return false;
      if (item.type === "CREATE_EVIDENCE" && item.studentRef.kind === "RESOLVED" &&
          !input.students.some(({ studentId, aiAlias }) => studentId === issue.studentId &&
            item.studentRef.kind === "RESOLVED" && item.studentRef.studentAlias === aiAlias)) return false;
    }
  }
  return evaluateDraft(row, expected).fraction === 1;
}

export function validateDataset(value: unknown): { revision: "v1"; cases: BenchmarkCase[] } {
  const data = asObject(value);
  if (data?.revision !== "v1" || !Array.isArray(data.cases) || data.cases.length !== 32) {
    throw new Error("Benchmark v1 requires exactly 32 cases.");
  }
  const rows: BenchmarkCase[] = [];
  const scenarios = new Set<string>(SCENARIOS);
  for (const value of data.cases) {
    const row = asObject(value);
    if (!row || typeof row.id !== "string" || !/^\d{2}-[ab]$/u.test(row.id)) throw new Error("Invalid benchmark case ID.");
    const input = readInput(row.input);
    const expected = proposalDraftV1Schema.safeParse(row.expected);
    const anchors = asObject(row.anchors);
    const contradictions = asObject(row.contradictions);
    const scenario = row.scenario as BenchmarkCase["scenario"];
    if (!scenarios.has(scenario) || !input || !expected.success || !anchors || (row.contradictions !== undefined && !contradictions) ||
        rows.some(({ id, input: other }) => id === row.id || other.rawNoteId === input.rawNoteId || other.body === input.body)) {
      throw new Error(`Invalid benchmark case ${row.id}.`);
    }
    const parsed = { id: row.id, scenario, input, expected: expected.data, anchors: anchors as BenchmarkCase["anchors"],
      contradictions: contradictions as BenchmarkCase["contradictions"] };
    if (!validExpectations(parsed)) throw new Error(`Invalid benchmark expectations for ${row.id}.`);
    rows.push(parsed);
  }
  for (const scenario of SCENARIOS) {
    if (rows.filter((row) => row.scenario === scenario).length !== 2) {
      throw new Error(`Benchmark v1 requires two cases for ${scenario}.`);
    }
  }
  return { revision: "v1", cases: rows };
}

export async function loadDataset() {
  const data = await readFile(new URL("./cases.v1.json", import.meta.url));
  return { ...validateDataset(JSON.parse(data.toString("utf8"))), sha256: createHash("sha256").update(data).digest("hex") };
}

export async function runBenchmark(
  cases: readonly BenchmarkCase[], env: Readonly<Record<string, string | undefined>>, fetcher: typeof fetch = fetch,
): Promise<CandidateResult[]> {
  return Promise.all(AI_MODEL_REGISTRY.map(async (candidate): Promise<CandidateResult> => {
    const route = createConfiguredCandidateRouter(candidate, env, fetcher);
    if (!route) return { candidate, status: "MISSING_CREDENTIAL", credential: providerCredentialName(candidate.provider), cases: [] };
    const results: CaseResult[] = [];
    for (const row of cases) {
      try {
        const { draft, attempts } = await route(row.input);
        results.push({ caseId: row.id, status: "VALID", attempts, semantic: evaluateDraft(row, draft) });
      } catch (error) {
        if (!(error instanceof AIProcessingError)) throw error;
        results.push({ caseId: row.id, status: "FAILED", attempts: error.attempts });
      }
    }
    return { candidate, status: "MEASURED", cases: results };
  }));
}

async function main(args: string[]): Promise<void> {
  const options = args[0] === "--" ? args.slice(1) : args;
  const dryRun = options.length === 1 && options[0] === "--dry-run";
  if (options.length && !dryRun) throw new Error("Usage: pnpm benchmark:ai [-- --dry-run]");
  validateCandidates();
  const dataset = await loadDataset();
  if (dryRun) {
    console.log(`Validated benchmark ${dataset.revision}: ${dataset.cases.length} synthetic cases, ${AI_MODEL_REGISTRY.length} pinned candidates.`);
    return;
  }
  const credentialNames = AI_MODEL_REGISTRY.map(({ provider }) => providerCredentialName(provider));
  if (!credentialNames.some((name) => process.env[name]?.trim())) {
    throw new Error(`Set at least one provider credential before running: ${credentialNames.join(", ")}.`);
  }
  const startedAt = new Date();
  const results = await runBenchmark(dataset.cases, process.env);
  const directory = await writeReport(dataset, results, startedAt);
  console.log(`Benchmark artifacts: ${directory}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "AI benchmark failed.");
    process.exitCode = 1;
  }
}
