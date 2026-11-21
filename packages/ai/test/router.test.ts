import { createHash } from "node:crypto";
import { proposalDraftV1Schema } from "@tutorloop/contracts";
import { expect, test } from "vitest";
import type { StructureNoteInput } from "../src/contract.ts";
import { AI_MODEL_REGISTRY } from "../src/registry.ts";
import { ProviderError } from "../src/provider-errors.ts";
import {
  createConfiguredNoteRouter, routeStructuredNote, type AIProviderAdapter,
} from "../src/router.ts";

const [gemini, openRouter, groq, nvidia] = AI_MODEL_REGISTRY;
const note: StructureNoteInput = {
  task: "STRUCTURE_OBSERVATION_NOTE",
  classId: "a91c130f-ea21-4cf9-86d8-532e11722d0d",
  rawNoteId: "33c7125b-f924-49bc-aed7-045e8ed32a2c",
  body: "Sao Mai observed a sign error. Contact parent@example.test or 0901234567.",
  observedAt: "2026-11-20T07:00:00Z",
  students: [{ studentId: "student-raw-id", displayLabel: "Sao Mai", aiAlias: "STU_001" }],
  canonicalIssues: [{ canonicalIssueId: "ci-raw-id", label: "Sao Mai sign errors",
    description: "Contact issue@example.test" }],
  studentIssues: [{ studentIssueId: "si-raw-id", studentId: "student-raw-id",
    canonicalIssueId: "ci-raw-id", manifestation: "Sao Mai 0901234567", state: "OPEN", version: 2 }],
};
const empty = { schemaVersion: "1", items: [] };

function setup(...responses: unknown[]) {
  const calls: Parameters<AIProviderAdapter["generateStructured"]>[0][] = [];
  const adapter: AIProviderAdapter = {
    async generateStructured(input) {
      calls.push(input);
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const route = (input = note) => routeStructuredNote({
    note: input, adapters: { GEMINI: adapter, GROQ: adapter },
  }, { primary: gemini, fallback: groq });
  return { calls, route };
}

test("accepts a valid primary and records only versioned metadata and the sent payload hash", async () => {
  const { calls, route } = setup(empty);
  const result = await route();
  expect(result.draft).toEqual(empty);
  expect(calls).toHaveLength(1);
  expect(calls[0].userPayload).toEqual({
    task: "STRUCTURE_OBSERVATION_NOTE",
    note: "STU_001 observed a sign error. Contact [EMAIL] or [PHONE].",
    studentAliases: ["STU_001"],
    ambiguousTokens: [],
    canonicalIssues: [{ canonicalIssueId: "CI_001", label: "STU_001 sign errors",
      description: "Contact [EMAIL]" }],
    studentIssues: [{ studentIssueId: "SI_001", studentAlias: "STU_001",
      canonicalIssueId: "CI_001", manifestation: "STU_001 [PHONE]", state: "OPEN", version: 2 }],
  });
  expect(result.attempts).toEqual([{
    provider: "GEMINI",
    model: "gemini-3.8-flash",
    promptVersion: "structure-note-v1",
    schemaVersion: "1",
    redactionVersion: "1",
    inputHash: createHash("sha256").update(JSON.stringify(calls[0].userPayload)).digest("hex"),
    status: "SUCCESS",
    latencyMs: expect.any(Number),
    errorCode: null,
  }]);
});

test("rate limits retry the primary once, then use the pinned fallback", async () => {
  const { calls, route } = setup(new ProviderError("RATE_LIMITED"), new ProviderError("RATE_LIMITED"), empty);
  const result = await route();
  expect(calls.map(({ model }) => model)).toEqual([gemini.model, gemini.model, groq.model]);
  expect(result.attempts.map(({ status, errorCode }) => [status, errorCode])).toEqual([
    ["TRANSIENT_FAILURE", "RATE_LIMITED"], ["TRANSIENT_FAILURE", "RATE_LIMITED"], ["SUCCESS", null],
  ]);
  expect(new Set(result.attempts.map(({ inputHash }) => inputHash)).size).toBe(1);
});

test("invalid canonical drafts exhaust the primary budget before fallback", async () => {
  const invalid = { schemaVersion: "1", items: [], extra: "provider-secret" };
  const { calls, route } = setup(invalid, { schemaVersion: "2", items: [] }, empty);
  const result = await route();
  expect(calls.map(({ model }) => model)).toEqual([gemini.model, gemini.model, groq.model]);
  expect(result.attempts.map(({ errorCode }) => errorCode)).toEqual([
    "INVALID_STRUCTURED_OUTPUT", "INVALID_STRUCTURED_OUTPUT", null,
  ]);
  expect(JSON.stringify(result.attempts)).not.toContain("provider-secret");
});

const evidenceItem = {
  key: "e", type: "CREATE_EVIDENCE", observationText: "Observed a sign error",
  studentRef: { kind: "RESOLVED", studentAlias: "STU_001" },
};

test.each([
  ["unlisted resolved student alias", [
    { ...evidenceItem, studentRef: { kind: "RESOLVED", studentAlias: "STU_BOGUS" } },
  ]],
  ["dangling proposed student issue", [
    { ...evidenceItem, studentIssueRef: { kind: "PROPOSED", proposalKey: "missing" } },
  ]],
  ["wrong-kind proposed student issue", [
    { ...evidenceItem, studentIssueRef: { kind: "PROPOSED", proposalKey: "c" } },
    { key: "c", type: "CREATE_CANONICAL_ISSUE", label: "Sign errors" },
  ]],
  ["dangling proposed canonical issue", [
    { key: "s", type: "CREATE_STUDENT_ISSUE", studentRef: evidenceItem.studentRef,
      canonicalIssueRef: { kind: "PROPOSED", proposalKey: "missing" } },
  ]],
  ["wrong-kind proposed canonical issue", [
    evidenceItem,
    { key: "s", type: "CREATE_STUDENT_ISSUE", studentRef: evidenceItem.studentRef,
      canonicalIssueRef: { kind: "PROPOSED", proposalKey: "e" } },
  ]],
  ["a NUL inside text", [{ ...evidenceItem, observationText: "Sign\u0000error" }]],
  ["an unpaired surrogate inside text", [{ ...evidenceItem, observationText: "Sign\ud800error" }]],
  ["a version outside the storage range", [{
    key: "u", type: "UPDATE_MANIFESTATION", manifestation: "Signs",
    studentIssueRef: { kind: "EXISTING", studentIssueId: "SI_001" }, expectedVersion: 2_147_483_648,
  }]],
])("invalid drafts with %s retry and use fallback before recording success", async (_, items) => {
  const invalid = { schemaVersion: "1", items };
  expect(proposalDraftV1Schema.safeParse(invalid).success).toBe(true);
  const { calls, route } = setup(invalid, invalid, empty);
  const result = await route();
  expect(calls.map(({ model }) => model)).toEqual([gemini.model, gemini.model, groq.model]);
  expect(result.draft).toEqual(empty);
  expect(result.attempts.map(({ status, errorCode }) => [status, errorCode])).toEqual([
    ["TRANSIENT_FAILURE", "INVALID_STRUCTURED_OUTPUT"],
    ["TRANSIENT_FAILURE", "INVALID_STRUCTURED_OUTPUT"],
    ["SUCCESS", null],
  ]);
});

test("accepts an unknown student as a valid unresolved draft", async () => {
  const draft = { schemaVersion: "1", items: [
    { ...evidenceItem, studentRef: { kind: "UNKNOWN", token: "a student" } },
  ] };
  const { calls, route } = setup(draft);
  const result = await route();
  expect(result.draft).toEqual(draft);
  expect(calls).toHaveLength(1);
  expect(result.attempts).toEqual([expect.objectContaining({ status: "SUCCESS", errorCode: null })]);
});

test("accepts valid ambiguity without retry and restores local issue IDs", async () => {
  const draft = { schemaVersion: "1", items: [{
    key: "e", type: "CREATE_STUDENT_ISSUE",
    studentRef: { kind: "AMBIGUOUS", token: "AMBIG_001", candidateAliases: ["STU_001", "STU_002"] },
    canonicalIssueRef: { kind: "AMBIGUOUS", candidateIds: ["CI_001"] },
  }] };
  const { calls, route } = setup(draft);
  const result = await route({ ...note, students: [...note.students,
    { studentId: "other-raw-id", aiAlias: "STU_002", displayLabel: "Sao Mai" }] });
  expect(calls).toHaveLength(1);
  expect(calls[0].userPayload).toMatchObject({ ambiguousTokens: [
    { token: "AMBIG_001", candidateAliases: ["STU_001", "STU_002"] },
  ] });
  expect(result.draft.items[0]).toEqual({ ...draft.items[0],
    canonicalIssueRef: { kind: "AMBIGUOUS", candidateIds: ["ci-raw-id"] } });
});

test("all-fail exposes only fixed codes and the four attempts", async () => {
  const { calls, route } = setup(
    new ProviderError("TIMEOUT"), new ProviderError("NETWORK_ERROR"), undefined, undefined,
  );
  const failure = await route().catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: "AI_PROCESSING_FAILED", code: "AI_PROCESSING_FAILED" });
  expect(calls.map(({ model }) => model)).toEqual([gemini.model, gemini.model, groq.model, groq.model]);
  expect(failure).toMatchObject({ attempts: [
    { errorCode: "TIMEOUT" }, { errorCode: "NETWORK_ERROR" },
    { errorCode: "INVALID_STRUCTURED_OUTPUT" }, { errorCode: "INVALID_STRUCTURED_OUTPUT" },
  ] });
  expect(JSON.stringify(failure)).not.toContain("Sao Mai");
});

test("a permanent error ends routing and never surfaces the caught error text", async () => {
  const { calls, route } = setup(new Error("secret provider response"), empty);
  const failure = await route().catch((error: unknown) => error);
  expect(calls).toHaveLength(1);
  expect(failure).toMatchObject({ attempts: [{ status: "PERMANENT_FAILURE", errorCode: "PROVIDER_ERROR" }] });
  expect(JSON.stringify(failure)).not.toContain("secret");
});

const env = {
  AI_PRIMARY_PROVIDER: gemini.provider, AI_PRIMARY_MODEL: gemini.model, GEMINI_API_KEY: "synthetic-gemini",
  AI_FALLBACK_PROVIDER: groq.provider, AI_FALLBACK_MODEL: groq.model, GROQ_API_KEY: "synthetic-groq",
  OPENROUTER_API_KEY: "synthetic-openrouter", NVIDIA_NIM_API_KEY: "synthetic-nvidia",
};

test("startup requires two registered, distinct routes and their explicit keys", () => {
  expect(() => createConfiguredNoteRouter({ ...env, AI_PRIMARY_MODEL: "unregistered-secret" }))
    .toThrow(/^Configure AI_PRIMARY_PROVIDER and AI_PRIMARY_MODEL/);
  expect(() => createConfiguredNoteRouter({ ...env, GROQ_API_KEY: "" })).toThrow(/^GROQ_API_KEY is required/);
  expect(() => createConfiguredNoteRouter({ ...env, AI_FALLBACK_MODEL: gemini.model,
    AI_FALLBACK_PROVIDER: gemini.provider })).toThrow(/must be distinct/);
});

type WireBody = Record<string, unknown>;
function stubFetch(handler: (url: string, body: WireBody, headers: Headers) => Response): typeof fetch {
  return async (input, init) => handler(String(input), JSON.parse(String(init?.body)), new Headers(init?.headers));
}

test("Gemini uses native JSON Schema and excludes thought parts", async () => {
  const fetcher = stubFetch((url, body, headers) => {
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(headers.get("x-goog-api-key")).toBe("synthetic-gemini");
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: expect.any(String) }] },
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } },
      contents: [{ role: "user", parts: [{ text: expect.stringContaining("STU_001 observed") }] }],
    });
    return Response.json({ candidates: [{ content: { parts: [
      { thought: true, text: "provider thought" }, { text: JSON.stringify(empty) },
    ] } }] });
  });
  expect((await createConfiguredNoteRouter(env, fetcher)(note)).draft).toEqual(empty);
});

function assertStrictObjects(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if ("type" in value && value.type === "object") {
    expect(value).toHaveProperty("properties");
    const properties = "properties" in value ? value.properties : undefined;
    expect(value).toHaveProperty("required", Object.keys(properties as object));
    expect(value).toHaveProperty("additionalProperties", false);
  }
  expect(value).not.toHaveProperty("oneOf");
  for (const child of Object.values(value)) assertStrictObjects(child);
}

test("Groq sends a strict wire schema and decodes null optional timestamps before canonical validation", async () => {
  const evidence = { key: "e", type: "CREATE_EVIDENCE", observationText: "Sign error",
    studentRef: { kind: "RESOLVED", studentAlias: "STU_001" }, learningContext: null, studentIssueRef: null };
  const fetcher = stubFetch((url, body, headers) => {
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer synthetic-groq");
    expect(body).toMatchObject({
      model: "openai/gpt-oss-120b",
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    assertStrictObjects(body.response_format);
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: "1", items: [{ ...evidence, observedAt: null }],
    }) } }] });
  });
  const route = createConfiguredNoteRouter({ ...env, AI_PRIMARY_PROVIDER: groq.provider, AI_PRIMARY_MODEL: groq.model,
    AI_FALLBACK_PROVIDER: gemini.provider, AI_FALLBACK_MODEL: gemini.model }, fetcher);
  expect((await route(note)).draft).toEqual({ schemaVersion: "1", items: [evidence] });
});

test("Groq receives a flat strict union for nullable evidence issue references", async () => {
  type ItemBranch = { properties: { type: { enum: string[] }; studentIssueRef?: unknown } };
  let branches: ItemBranch[] | undefined;
  const fetcher = stubFetch((_url, body) => {
    const format = body.response_format as {
      json_schema: { schema: { properties: { items: { items: { anyOf: ItemBranch[] } } } } };
    };
    branches = format.json_schema.schema.properties.items.items.anyOf;
    return Response.json({ choices: [{ message: { content: JSON.stringify(empty) } }] });
  });
  const route = createConfiguredNoteRouter({ ...env, AI_PRIMARY_PROVIDER: groq.provider, AI_PRIMARY_MODEL: groq.model,
    AI_FALLBACK_PROVIDER: gemini.provider, AI_FALLBACK_MODEL: gemini.model }, fetcher);
  await route(note);
  const evidence = branches?.find(({ properties }) => properties.type.enum.includes("CREATE_EVIDENCE"));
  expect(evidence?.properties.studentIssueRef).toMatchObject({ anyOf: [
    { type: "object", properties: { kind: { enum: ["EXISTING"] }, studentIssueId: { type: "string" } } },
    { type: "object", properties: { kind: { enum: ["PROPOSED"] }, proposalKey: { type: "string" } } },
    { type: "null" },
  ] });
});

test.each([
  [openRouter, "https://openrouter.ai/api/v1/chat/completions"],
  [nvidia, "https://integrate.api.nvidia.com/v1/chat/completions"],
])("uses prompt JSON with the exact %o model and no unverified response_format", async (model, endpoint) => {
  const fetcher = stubFetch((url, body) => {
    expect(url).toBe(endpoint);
    expect(body).toMatchObject({ model: model.model, messages: [
      { role: "system", content: expect.stringContaining("CREATE_CANONICAL_ISSUE") },
      { role: "user", content: expect.stringContaining("STU_001 observed") },
    ] });
    expect(body).not.toHaveProperty("response_format");
    return Response.json({ choices: [{ message: { content: JSON.stringify(empty) } }] });
  });
  expect((await createConfiguredNoteRouter({
    ...env, AI_PRIMARY_PROVIDER: model.provider, AI_PRIMARY_MODEL: model.model,
  }, fetcher)(note)).draft).toEqual(empty);
});
