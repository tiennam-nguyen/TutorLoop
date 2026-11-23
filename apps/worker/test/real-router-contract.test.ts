import { createHash, randomUUID } from "node:crypto";
import { createConfiguredNoteRouter } from "@tutorloop/ai/router";
import { createRawNoteResponseSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../../api/src/app.ts";
import { runNextJob } from "../src/worker.ts";

const START = Date.parse("2026-11-21T01:00:00Z");
const env = {
  AI_PRIMARY_PROVIDER: "GEMINI",
  AI_PRIMARY_MODEL: "gemini-3.8-flash",
  GEMINI_API_KEY: "stub-gemini",
  AI_FALLBACK_PROVIDER: "GROQ",
  AI_FALLBACK_MODEL: "openai/gpt-oss-120b",
  GROQ_API_KEY: "stub-groq",
};

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
}, 120_000);
beforeEach(async () => { await sql`TRUNCATE classes, jobs CASCADE`.execute(db); });
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await postgres?.stop();
  }
});

async function capture() {
  const classroom = { ...buildClass(), name: "Synthetic Oak School" };
  const firstStudent = buildStudent(classroom.id);
  const student = { ...firstStudent, ai_alias: `STU_${firstStudent.id.replaceAll("-", "")}`,
    display_label: "Synthetic Sao Mai" };
  const archived = { ...buildStudent(classroom.id, "STU_ARCHIVED"), display_label: "Synthetic Red Star",
    archived_at: new Date(START - 1) };
  const issue = { ...buildCanonicalIssue(classroom.id), label: "Synthetic Sao Mai sign errors",
    description: "Old detail issue@example.test" };
  const studentIssueId = randomUUID();
  await db.insertInto("classes").values(classroom).execute();
  await db.insertInto("students").values([student, archived]).execute();
  await db.insertInto("canonical_issues").values(issue).execute();
  await db.insertInto("student_issues").values({
    id: studentIssueId, class_id: classroom.id, student_id: student.id, canonical_issue_id: issue.id,
    manifestation: "Synthetic Sao Mai 0901234567", state: "OPEN", created_at: new Date(START),
    updated_at: new Date(START),
  }).execute();
  const app = await createApp({ db, authVerifier: async () => ({ userId: classroom.owner_user_id }) });
  const body = `Synthetic Sao Mai missed a sign. Synthetic Red Star left Synthetic Oak School. Contact parent@example.test or 0901234567. Ref ${student.id}.`;
  try {
    const response = await app.inject({
      method: "POST", url: `/api/v1/classes/${classroom.id}/raw-notes`,
      payload: { body, observedAt: "2026-11-20T07:00:00Z", noteType: "OBSERVATION", clientRequestId: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(201);
    const { processing, rawNote } = createRawNoteResponseSchema.parse(response.json());
    await db.updateTable("jobs").set({ run_after: new Date(START) }).where("id", "=", processing.jobId).execute();
    return { classroom, student, issue, studentIssueId, body, rawNoteId: rawNote.id, jobId: processing.jobId };
  } finally {
    await app.close();
  }
}

function provenance(jobId: string) {
  return db.selectFrom("ai_runs").innerJoin("proposal_runs", "proposal_runs.id", "ai_runs.proposal_run_id")
    .where("proposal_runs.source_job_id", "=", jobId).selectAll("ai_runs").execute();
}

test("persists sanitized retries and fallback, restores local refs, and keeps the Raw Note intact", async () => {
  const { classroom, student, issue, studentIssueId, rawNoteId, jobId, body } = await capture();
  const requests: { url: string; userText: string }[] = [];
  const persistedBeforeRequests: number[] = [];
  const stub: typeof fetch = async (url, init) => {
    persistedBeforeRequests.push((await provenance(jobId)).length);
    const request = JSON.parse(String(init?.body));
    const userText = request.contents?.[0].parts[0].text ?? request.messages[1].content;
    requests.push({ url: String(url), userText });
    if (requests.length === 1) {
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        schemaVersion: "1", items: [{
          key: "invalid-evidence", type: "CREATE_EVIDENCE", observationText: "private provider output",
          studentRef: { kind: "RESOLVED", studentAlias: "STU_BOGUS" },
        }],
      }) }] } }] });
    }
    if (requests.length === 2) return new Response("private provider rate-limit body", { status: 429 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      schemaVersion: "1",
      items: [{
        key: "evidence", type: "CREATE_EVIDENCE", studentRef: { kind: "RESOLVED", studentAlias: student.ai_alias },
        studentIssueRef: { kind: "EXISTING", studentIssueId: "SI_001" },
        observationText: "Sign error", learningContext: null, observedAt: null,
      }, {
        key: "transition", type: "TRANSITION_STUDENT_ISSUE",
        studentIssueRef: { kind: "EXISTING", studentIssueId: "SI_001" },
        expectedVersion: 1, toState: "IMPROVING", reason: null,
      }],
    }) } }] });
  };
  const deps = { db, now: () => new Date(START), route: createConfiguredNoteRouter(env, stub) };
  expect(await runNextJob(deps)).toBe(true);
  const run = await db.selectFrom("proposal_runs").selectAll().where("source_job_id", "=", jobId).executeTakeFirstOrThrow();
  expect(run).toMatchObject({ status: "READY", raw_note_id: rawNoteId });
  const items = await db.selectFrom("proposal_items").selectAll().where("proposal_run_id", "=", run.id).execute();
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ item_type: "CREATE_EVIDENCE", original_payload: expect.objectContaining({
      studentIssueRef: { kind: "EXISTING", studentIssueId },
    }) }),
    expect.objectContaining({ item_type: "TRANSITION_STUDENT_ISSUE", target_entity_id: studentIssueId, base_version: 1 }),
  ]));
  expect(requests.map(({ url }) => new URL(url).hostname)).toEqual([
    "generativelanguage.googleapis.com", "generativelanguage.googleapis.com", "api.groq.com",
  ]);
  expect(persistedBeforeRequests).toEqual([0, 1, 2]);
  const sent = requests[0].userText;
  for (const secret of [classroom.id, student.id, issue.id, studentIssueId, rawNoteId,
    student.display_label, classroom.name, "Synthetic Red Star", "STU_ARCHIVED",
    "parent@example.test", "issue@example.test", "0901234567"]) {
    expect(requests.every(({ userText }) => !userText.includes(secret))).toBe(true);
  }
  expect(JSON.parse(sent)).toMatchObject({
    note: `${student.ai_alias} missed a sign. [PRIVATE] left [PRIVATE]. Contact [EMAIL] or [PHONE]. Ref [ID].`,
    studentAliases: [student.ai_alias],
    canonicalIssues: [{ canonicalIssueId: "CI_001", label: `${student.ai_alias} sign errors`,
      description: "Old detail [EMAIL]" }],
    studentIssues: [{ studentIssueId: "SI_001", manifestation: `${student.ai_alias} [PHONE]` }],
  });
  const rows = await provenance(jobId);
  expect(rows).toHaveLength(3);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider: "GEMINI", model: env.AI_PRIMARY_MODEL, error_code: "INVALID_STRUCTURED_OUTPUT" }),
    expect.objectContaining({ provider: "GEMINI", model: env.AI_PRIMARY_MODEL, error_code: "RATE_LIMITED" }),
    expect.objectContaining({ provider: "GROQ", model: env.AI_FALLBACK_MODEL, status: "SUCCESS", error_code: null }),
  ]));
  for (const row of rows) {
    expect(row).toMatchObject({
      class_id: classroom.id, proposal_run_id: run.id, task_type: "STRUCTURE_OBSERVATION_NOTE",
      prompt_version: "structure-note-v2", schema_version: "1", redaction_version: "1",
      input_hash: createHash("sha256").update(sent).digest("hex"), latency_ms: expect.any(Number), usage_json: null,
    });
  }
  expect(JSON.stringify(rows)).not.toMatch(/private provider|STU_BOGUS|Synthetic Sao Mai|Sign error|stub-groq/);
  expect(await db.selectFrom("raw_notes").select("body").where("id", "=", rawNoteId).executeTakeFirst())
    .toEqual({ body });
  expect(await db.selectFrom("student_issues").select("state").where("id", "=", studentIssueId).executeTakeFirst())
    .toEqual({ state: "OPEN" });
});

test("an exhausted route keeps all attempt records through durable retries and final failure", async () => {
  const { jobId, rawNoteId, body } = await capture();
  const stub: typeof fetch = async () => new Response("private provider error body", { status: 503 });
  let time = START;
  const deps = { db, now: () => new Date(time), route: createConfiguredNoteRouter(env, stub) };
  for (const elapsed of [0, 30_000, 330_000]) {
    time = START + elapsed;
    expect(await runNextJob(deps)).toBe(true);
  }
  const job = await db.selectFrom("jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
  const run = await db.selectFrom("proposal_runs").selectAll().where("source_job_id", "=", jobId).executeTakeFirstOrThrow();
  expect(job).toMatchObject({ status: "DEAD", attempts: 3, last_error_code: "AI_PROCESSING_FAILED" });
  expect(run).toMatchObject({ status: "FAILED", raw_note_id: rawNoteId });
  const rows = await provenance(jobId);
  expect(rows).toHaveLength(12);
  expect(rows.filter(({ provider }) => provider === "GEMINI")).toHaveLength(6);
  expect(rows.filter(({ provider }) => provider === "GROQ")).toHaveLength(6);
  expect(rows.every(({ status, error_code }) => status === "TRANSIENT_FAILURE" && error_code === "PROVIDER_UNAVAILABLE"))
    .toBe(true);
  expect(JSON.stringify(rows)).not.toContain("private provider");
  expect(await db.selectFrom("proposal_items").select("id").where("proposal_run_id", "=", run.id).execute()).toEqual([]);
  expect(await db.selectFrom("raw_notes").select("body").where("id", "=", rawNoteId).executeTakeFirst())
    .toEqual({ body });
});

test("an expired claim retains earlier attempts and stops routing without new provenance or proposals", async () => {
  const { jobId } = await capture();
  let time = START;
  let requests = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  const stub: typeof fetch = async () => {
    requests++;
    if (requests === 1) return new Response(null, { status: 503 });
    started.resolve();
    return release.promise;
  };
  const deps = { db, now: () => new Date(time), route: createConfiguredNoteRouter(env, stub) };
  const stale = runNextJob(deps);
  await Promise.race([started.promise, stale]);
  try {
    expect(await provenance(jobId)).toEqual([expect.objectContaining({ error_code: "PROVIDER_UNAVAILABLE" })]);
    time += 5 * 60_000;
    expect(await runNextJob(deps)).toBe(false);
  } finally {
    release.resolve(new Response(null, { status: 503 }));
    await stale;
  }
  expect(requests).toBe(2);
  expect(await provenance(jobId)).toHaveLength(1);
  const run = await db.selectFrom("proposal_runs").selectAll().where("source_job_id", "=", jobId).executeTakeFirstOrThrow();
  expect(run.status).toBe("PROCESSING");
  expect(await db.selectFrom("proposal_items").select("id").where("proposal_run_id", "=", run.id).execute()).toEqual([]);
  expect(await db.selectFrom("jobs").select(["status", "last_error_code"]).where("id", "=", jobId).executeTakeFirst())
    .toEqual({ status: "FAILED", last_error_code: "JOB_LOCK_EXPIRED" });
});
