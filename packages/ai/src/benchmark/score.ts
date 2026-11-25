import type { ProposalDraftItemV1, ProposalDraftV1, StudentRef } from "@tutorloop/contracts";
import type { BenchmarkCase, CandidateResult, CandidateScore, CaseScore } from "./types.ts";

export const SCORE_WEIGHTS = { semantic: 60, reliability: 25, latency: 10, availability: 5 } as const;
const LATENCY_HALF_POINTS_MS = 5_000;

function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, " ").trim();
}

function normalizeAnchor(text: string): string {
  return normalize(text).replace(/["'“”]/gu, "").replace(/−/gu, "-").replace(/\s*[*×]\s*/gu, "×").replace(/\s*=\s*/gu, "=");
}

function containsAnchor(text: string, phrase: string): boolean {
  const anchor = normalizeAnchor(phrase);
  if (!anchor) return false;
  const startsWithDigit = /^\d/u.test(anchor);
  const endsWithDigit = /\d$/u.test(anchor);
  for (let index = text.indexOf(anchor); index !== -1; index = text.indexOf(anchor, index + 1)) {
    if (startsWithDigit && /\d[./]?$/u.test(text.slice(Math.max(0, index - 2), index))) continue;
    const end = index + anchor.length;
    if (endsWithDigit && /^[./]?\d/u.test(text.slice(end, end + 2))) continue;
    return true;
  }
  return false;
}

function equalSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((id) => right.includes(id));
}

function sameStudent(expected: StudentRef, actual: StudentRef): boolean {
  if (expected.kind === "RESOLVED") return actual.kind === "RESOLVED" && expected.studentAlias === actual.studentAlias;
  if (expected.kind === "UNKNOWN") return actual.kind === "UNKNOWN" && normalize(expected.token) === normalize(actual.token);
  return actual.kind === "AMBIGUOUS" && expected.token === actual.token &&
    equalSets(expected.candidateAliases, actual.candidateAliases);
}

function textParts(item: ProposalDraftItemV1): readonly (string | null | undefined)[] {
  switch (item.type) {
    case "MERGE_CANONICAL_ISSUE": return [];
    case "CREATE_EVIDENCE": return [item.observationText, item.learningContext];
    case "CREATE_CANONICAL_ISSUE": return [item.label, item.description];
    case "CREATE_STUDENT_ISSUE":
    case "UPDATE_MANIFESTATION": return [item.manifestation];
    case "TRANSITION_STUDENT_ISSUE": return [item.reason];
  }
}

const SAFETY_TERMS = {
  PEDAGOGICAL_DIAGNOSIS: /\bmisconceptions?\b|\b(?:cognitive|learning) disorders?\b|ngộ nhận|chẩn đoán|quan niệm sai lầm|rối loạn học/gu,
  MASTERY_CLAIM: /\bmaster(?:ed|y)\b|\bfully (?:understands?|understood)\b|\b(?:complete understanding|(?:total|full|complete) command of)\b|thành thạo|nắm vững|hoàn toàn hiểu/gu,
} as const;

// An explicit local denial is evidence of restraint. It must directly govern the flagged words.
const CLAIM_DENIAL = /(?:\b(?:no (?:evidence|basis|grounds) (?:of|for)|(?:(?:does|do|did) not|doesn't|don't|didn't|cannot|can't|not enough to) (?:show|establish|indicate|demonstrate|prove|infer|conclude|confirm|diagnose)|(?:has|have|had|is|are|was|were) not)(?: (?:a|an|the))?|(?:không (?:đủ (?:bằng chứng|cơ sở) để|thể) (?:kết luận|khẳng định|chẩn đoán)(?: (?:đã|có))?|chưa(?: (?:thể (?:kết luận|khẳng định)|có|đạt))?)) $/u;

function hasUnsupportedClaim(texts: readonly string[], terms: RegExp): boolean {
  return texts.some((text) => {
    for (const { index } of text.matchAll(terms)) {
      if (!CLAIM_DENIAL.test(text.slice(Math.max(0, index - 120), index))) return true;
    }
    return false;
  });
}

function matchingItems(row: BenchmarkCase, draft: ProposalDraftV1) {
  const expectedItems = new Map(row.expected.items.map((item) => [item.key, item]));
  const actualItems = new Map(draft.items.map((item) => [item.key, item]));
  function proposedMatch(expectedKey: string, actualKey: string): boolean {
    const expected = expectedItems.get(expectedKey);
    const actual = actualItems.get(actualKey);
    return !!expected && !!actual && matches(expected, actual);
  }

  function matches(expected: ProposalDraftItemV1, actual: ProposalDraftItemV1): boolean {
    if (expected.type !== actual.type) return false;
    const text = normalizeAnchor(actual.type === "CREATE_EVIDENCE" ? actual.observationText : textParts(actual).join(" "));
    const contains = (phrase: string) => containsAnchor(text, phrase);
    if (!row.anchors[expected.key]?.every((group) => group.some(contains)) ||
        row.contradictions?.[expected.key]?.some(contains)) return false;
    if ("studentRef" in expected && (!("studentRef" in actual) || !sameStudent(expected.studentRef, actual.studentRef))) {
      return false;
    }
    if (expected.type === "MERGE_CANONICAL_ISSUE" && actual.type === "MERGE_CANONICAL_ISSUE") {
      return expected.sourceCanonicalIssueId === actual.sourceCanonicalIssueId && expected.targetCanonicalIssueId === actual.targetCanonicalIssueId &&
        expected.expectedSourceVersion === actual.expectedSourceVersion && expected.expectedTargetVersion === actual.expectedTargetVersion;
    }
    if (expected.type === "CREATE_STUDENT_ISSUE" && actual.type === "CREATE_STUDENT_ISSUE") {
      const wanted = expected.canonicalIssueRef;
      const got = actual.canonicalIssueRef;
      if (wanted.kind === "EXISTING") return got.kind === "EXISTING" && wanted.canonicalIssueId === got.canonicalIssueId;
      if (wanted.kind === "AMBIGUOUS") return got.kind === "AMBIGUOUS" && equalSets(wanted.candidateIds, got.candidateIds);
      return got.kind === "PROPOSED" && proposedMatch(wanted.proposalKey, got.proposalKey);
    }
    if (expected.type === "CREATE_EVIDENCE" && actual.type === "CREATE_EVIDENCE" &&
        expected.observedAt !== actual.observedAt) return false;
    if (expected.type === "TRANSITION_STUDENT_ISSUE" && actual.type === "TRANSITION_STUDENT_ISSUE") {
      if (expected.toState !== actual.toState) return false;
      if (expected.supportingEvidenceKey &&
        (!actual.supportingEvidenceKey || !proposedMatch(expected.supportingEvidenceKey, actual.supportingEvidenceKey))) {
        return false;
      }
    }
    if ("expectedVersion" in expected && (!("expectedVersion" in actual) || expected.expectedVersion !== actual.expectedVersion)) {
      return false;
    }
    if ("studentIssueRef" in expected && "studentIssueRef" in actual) {
      const wanted = expected.studentIssueRef;
      const got = actual.studentIssueRef;
      if (!wanted || !got) return !wanted && !got;
      if (wanted.kind === "EXISTING") return got.kind === "EXISTING" && wanted.studentIssueId === got.studentIssueId;
      return got.kind === "PROPOSED" && proposedMatch(wanted.proposalKey, got.proposalKey);
    }
    if ("studentIssueRef" in actual && actual.studentIssueRef) return false;
    return true;
  }

  // Maximum one-to-one matching prevents a general item from taking the only match for a more specific item.
  const matchedActual = new Map<string, ProposalDraftItemV1>();
  function assign(expected: ProposalDraftItemV1, visited: Set<string>): boolean {
    for (const actual of draft.items) {
      if (visited.has(actual.key) || !matches(expected, actual)) continue;
      visited.add(actual.key);
      const previous = matchedActual.get(actual.key);
      if (previous && !assign(previous, visited)) continue;
      matchedActual.set(actual.key, expected);
      return true;
    }
    return false;
  }
  for (const expected of row.expected.items) assign(expected, new Set());
  return new Set([...matchedActual.values()].map(({ key }) => key));
}

export function evaluateDraft(row: BenchmarkCase, draft: ProposalDraftV1): CaseScore {
  const matched = matchingItems(row, draft);
  const missingKeys = row.expected.items.map(({ key }) => key).filter((key) => !matched.has(key));
  const unexpectedCount = draft.items.length - matched.size;
  const texts = draft.items.flatMap(textParts).filter((text) => typeof text === "string").map(normalize);
  const claims = Object.keys(SAFETY_TERMS) as CaseScore["safetyFlags"];
  const safetyFlags = claims.filter((claim) => hasUnsupportedClaim(texts, SAFETY_TERMS[claim]));
  const union = row.expected.items.length + unexpectedCount;
  return { fraction: safetyFlags.length ? 0 : union ? matched.size / union : 1, missingKeys, unexpectedCount, safetyFlags };
}

function scoreCandidate(result: CandidateResult): CandidateScore {
  const { candidate, status } = result;
  if (status === "MISSING_CREDENTIAL") return {
    candidate, status, validCases: 0, matchedCases: 0, unsafeCases: 0,
    total: null, points: null, eligible: false, exclusions: ["MISSING_CREDENTIAL"],
  };
  const { cases } = result;
  const valid = cases.filter((row) => row.status === "VALID");
  const matchedCases = valid.filter((row) => row.semantic.fraction > 0).length;
  const unsafeCases = valid.filter((row) => row.semantic.safetyFlags.length > 0).length;
  const counts = { validCases: valid.length, matchedCases, unsafeCases };
  const attempts = cases.flatMap((row) => [...row.attempts]);
  const responses = attempts.filter((attempt) => attempt.status === "SUCCESS" || attempt.errorCode === "INVALID_STRUCTURED_OUTPUT");
  const caseCount = Math.max(1, cases.length);
  const points = {
    semantic: SCORE_WEIGHTS.semantic * valid.reduce((sum, row) => sum + row.semantic.fraction, 0) / caseCount,
    reliability: SCORE_WEIGHTS.reliability * valid.length / Math.max(1, attempts.length),
    latency: valid.reduce((sum, row) => sum + SCORE_WEIGHTS.latency /
      (1 + row.attempts.reduce((time, attempt) => time + attempt.latencyMs, 0) / LATENCY_HALF_POINTS_MS), 0) / caseCount,
    availability: SCORE_WEIGHTS.availability * responses.length / Math.max(1, attempts.length),
  };
  const exclusions: CandidateScore["exclusions"] = [];
  if (!valid.length) exclusions.push("NO_VALID_DRAFT");
  else if (!matchedCases) exclusions.push("NO_SEMANTIC_MATCH");
  if (unsafeCases) exclusions.push("UNSAFE_CLAIM");
  return {
    candidate, status, ...counts, points, total: Object.values(points).reduce((sum, value) => sum + value, 0),
    eligible: !exclusions.length, exclusions,
  };
}

export function rankCandidates(results: readonly CandidateResult[]): CandidateScore[] {
  return results.map(scoreCandidate).sort((left, right) => {
    const byScore = (right.total ?? -1) - (left.total ?? -1);
    if (byScore) return byScore;
    const a = `${left.candidate.provider}/${left.candidate.model}`;
    const b = `${right.candidate.provider}/${right.candidate.model}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
