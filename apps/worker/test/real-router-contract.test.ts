import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createConfiguredNoteRouter } from "@tutorloop/ai/router";
import { createRawNoteResponseSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { FakeNoteStructurer } from "@tutorloop/testkit/fake-note-structurer";
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
  const body = `Synthetic Sao Mai missed a sign. Synthetic Red Star left Synthetic Oak School. Contact parent@example.test or 0901234567. Ref ${student.id}.`;
  return { classroom, student, issue, studentIssueId, body, ...await captureNote(classroom, body) };
}

async function captureNote(classroom: ReturnType<typeof buildClass>, body: string) {
  const app = await createApp({ db, authVerifier: async () => ({ userId: classroom.owner_user_id }) });
  try {
    const response = await app.inject({
      method: "POST", url: `/api/v1/classes/${classroom.id}/raw-notes`,
      payload: { body, observedAt: "2026-11-20T07:00:00Z", noteType: "OBSERVATION", clientRequestId: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(201);
    const { processing, rawNote } = createRawNoteResponseSchema.parse(response.json());
    await db.updateTable("jobs").set({ run_after: new Date(START) }).where("id", "=", processing.jobId).execute();
    return { rawNoteId: rawNote.id, jobId: processing.jobId };
  } finally {
    await app.close();
  }
}

function provenance(jobId: string) {
  return db.selectFrom("ai_runs").innerJoin("proposal_runs", "proposal_runs.id", "ai_runs.proposal_run_id")
    .where("proposal_runs.source_job_id", "=", jobId).selectAll("ai_runs").execute();
}

function stubGemini(onRequest: (payload: string) => void, busy = false): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    onRequest(request.contents?.[0].parts[0].text ?? request.messages[1].content);
    if (busy) return new Response(null, { status: 503 });
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"schemaVersion":"1","items":[]}' }] } }] });
  };
}

const editTime = sql<Date>`'2026-11-21T01:00:00.000100Z'::timestamptz`;

test("blocks a note committed while a Student label edit waits for its row lock", async () => {
  const classroom = buildClass();
  const student = { ...buildStudent(classroom.id), display_label: "Synthetic Former Label" };
  await db.insertInto("classes").values(classroom).execute();
  await db.insertInto("students").values(student).execute();
  const app = await createApp({ db, authVerifier: async () => ({ userId: classroom.owner_user_id }) });
  try {
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom("students").select("id").where("id", "=", student.id).forNoKeyUpdate().executeTakeFirstOrThrow();
      const { rows: [backend] } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
      locked.resolve(backend.pid);
      await release.promise;
    });
    const blockerPid = await Promise.race([locked.promise, blocker]);
    const rename = Promise.resolve(app.inject({
      method: "PATCH", url: `/api/v1/classes/${classroom.id}/students/${student.id}`,
      payload: { expectedVersion: 1, displayLabel: "Synthetic Current Label" },
    }));
    let captured: Awaited<ReturnType<typeof captureNote>>;
    try {
      await expect.poll(async () => {
        const { rows: [activity] } = await sql<{ waiting: boolean }>`
          select exists(select 1 from pg_stat_activity
            where datname = current_database() and ${blockerPid} = any(pg_blocking_pids(pid))) as waiting
        `.execute(db);
        return activity.waiting;
      }, { timeout: 3_000 }).toBe(true);
      const blockedAt = Date.now();
      await expect.poll(() => Date.now()).toBeGreaterThan(blockedAt);
      captured = await Promise.race([
        captureNote(classroom, `${student.display_label} corrected a sign.`),
        delay(3_000).then(() => { throw new Error("Capture did not commit while the Student lock was held."); }),
      ]);
    } finally {
      release.resolve();
      await blocker;
      const response = await rename;
      expect(response.statusCode, response.body).toBe(200);
    }
    const { rows: [order] } = await sql<{ capture_before_edit: boolean }>`
      select raw_notes.created_at <= students.updated_at as capture_before_edit
      from raw_notes join students on students.class_id = raw_notes.class_id
      where raw_notes.id = ${captured.rawNoteId} and students.id = ${student.id}
    `.execute(db);
    const outbound: string[] = [];
    const route = createConfiguredNoteRouter(env, stubGemini((payload) => outbound.push(payload)));
    expect(await runNextJob({ db, now: () => new Date(), route })).toBe(true);
    expect({ ...order, outbound }).toEqual({ capture_before_edit: true, outbound: [] });
    expect(await provenance(captured.jobId)).toEqual([]);
  } finally {
    await app.close();
  }
}, 15_000);

test.each(["Student", "Class"] as const)("blocks a queued Raw Note captured at a %s edit before transport", async (kind) => {
  const { classroom, student, rawNoteId, jobId, body } = await capture();
  await db.updateTable("raw_notes").set({ created_at: editTime }).where("id", "=", rawNoteId).execute();
  if (kind === "Student") {
    await db.updateTable("students").set({ display_label: "Replacement Display", version: 2, updated_at: editTime })
      .where("id", "=", student.id).execute();
  } else {
    await db.updateTable("classes").set({ name: "Replacement Class", version: 2, updated_at: editTime })
      .where("id", "=", classroom.id).execute();
  }
  const requests: string[] = [];
  const route = createConfiguredNoteRouter(env, stubGemini((payload) => requests.push(payload)));
  for (const elapsed of [0, 30_000, 330_000]) {
    expect(await runNextJob({ db, now: () => new Date(START + elapsed), route })).toBe(true);
    expect(requests).toHaveLength(0);
  }
  expect(await provenance(jobId)).toEqual([]);
  expect(await db.selectFrom("jobs").select(["status", "last_error_code"]).where("id", "=", jobId).executeTakeFirst())
    .toEqual({ status: "DEAD", last_error_code: "AI_PROCESSING_FAILED" });
  expect(await db.selectFrom("proposal_runs").select("status").where("source_job_id", "=", jobId).executeTakeFirst())
    .toEqual({ status: "FAILED" });
  expect(await db.selectFrom("raw_notes").select("body").where("id", "=", rawNoteId).executeTakeFirst())
    .toEqual({ body });
}, 15_000);

test("a durable retry uses the new roster cutoff even when the prior attempt sent a redacted note", async () => {
  const { student, rawNoteId, jobId } = await capture();
  await db.updateTable("raw_notes").set({ created_at: sql<Date>`${editTime} - interval '1 microsecond'` })
    .where("id", "=", rawNoteId).execute();
  const requests: string[] = [];
  const route = createConfiguredNoteRouter(env, stubGemini((payload) => requests.push(payload), true));
  expect(await runNextJob({ db, now: () => new Date(START), route })).toBe(true);
  expect(requests).toHaveLength(4);
  expect(requests.every((payload) => !payload.includes(student.display_label))).toBe(true);

  await db.updateTable("students").set({ display_label: "Replacement Display", version: 2, updated_at: editTime })
    .where("id", "=", student.id).execute();
  expect(await runNextJob({ db, now: () => new Date(START + 30_000), route })).toBe(true);
  expect(requests).toHaveLength(4);
  expect(await provenance(jobId)).toHaveLength(4);
}, 15_000);

test("retains issue identities but hides text from before a label edit, including delayed approvals and state-only changes", async () => {
  const { classroom, student, issue, studentIssueId, rawNoteId, jobId, body } = await capture();
  const beforeEdit = sql<Date>`${editTime} - interval '1 microsecond'`;
  const afterEdit = sql<Date>`${editTime} + interval '1 microsecond'`;
  const oldDescription = `Notes from ${classroom.name}`;
  const delayedLabel = `Delayed issue for ${student.display_label}`;
  const delayedManifestation = `Delayed detail from ${classroom.name}`;
  const freshLabel = "Signs in replacement examples";
  const fresh = buildCanonicalIssue(classroom.id);
  const freshIssueId = randomUUID();
  const freshManifestation = "Replacement Display misses one sign";
  const secondStudent = buildStudent(classroom.id, "STU_SECOND");
  await db.updateTable("raw_notes").set({ created_at: beforeEdit }).where("id", "=", rawNoteId).execute();
  await db.updateTable("canonical_issues").set({ created_at: beforeEdit, updated_at: beforeEdit, description: oldDescription })
    .where("id", "=", issue.id).execute();
  await db.insertInto("canonical_issues").values({ ...fresh, label: freshLabel, created_at: afterEdit, updated_at: afterEdit })
    .execute();
  await db.insertInto("students").values(secondStudent).execute();
  await db.insertInto("student_issues").values({
    id: freshIssueId, class_id: classroom.id, student_id: student.id, canonical_issue_id: fresh.id,
    manifestation: freshManifestation, state: "OPEN", created_at: afterEdit, updated_at: afterEdit,
  }).execute();
  await db.insertInto("student_issues").values({
    id: randomUUID(), class_id: classroom.id, student_id: secondStudent.id, canonical_issue_id: fresh.id,
    manifestation: freshManifestation, state: "OPEN", created_at: afterEdit, updated_at: afterEdit,
  }).execute();
  const fake = new FakeNoteStructurer((input) => {
    expect(input.body).toBe(body);
    expect(input.canonicalIssues).toContainEqual(expect.objectContaining({ label: issue.label, description: oldDescription }));
    return { schemaVersion: "1", items: [
      { key: "c", type: "CREATE_CANONICAL_ISSUE", label: delayedLabel, description: oldDescription },
      { key: "s", type: "CREATE_STUDENT_ISSUE", studentRef: { kind: "RESOLVED", studentAlias: student.ai_alias },
        canonicalIssueRef: { kind: "PROPOSED", proposalKey: "c" }, manifestation: delayedManifestation },
      { key: "u", type: "UPDATE_MANIFESTATION", expectedVersion: 1,
        studentIssueRef: { kind: "EXISTING", studentIssueId: freshIssueId }, manifestation: delayedManifestation },
    ] };
  });
  expect(await runNextJob({ db, now: () => new Date(START), structurer: fake })).toBe(true);
  const run = await db.selectFrom("proposal_runs").select("id").where("source_job_id", "=", jobId).executeTakeFirstOrThrow();
  const items = await db.selectFrom("proposal_items").select("id").where("proposal_run_id", "=", run.id).execute();
  await db.updateTable("students").set({ display_label: "Replacement Display", version: 2, updated_at: editTime })
    .where("id", "=", student.id).execute();
  await db.updateTable("classes").set({ name: "Replacement Class", version: 2, updated_at: editTime })
    .where("id", "=", classroom.id).execute();

  const app = await createApp({ db, authVerifier: async () => ({ userId: classroom.owner_user_id }) });
  const classPath = `/api/v1/classes/${classroom.id}`;
  try {
    const changeState = await app.inject({ method: "PATCH", url: `${classPath}/student-issues/${studentIssueId}/state`,
      payload: { expectedVersion: 1, toState: "IMPROVING" } });
    expect(changeState.statusCode, changeState.body).toBe(200);
    const changeLabel = await app.inject({ method: "PATCH", url: `${classPath}/canonical-issues/${issue.id}`,
      payload: { expectedVersion: 1, label: "Updated label" } });
    expect(changeLabel.statusCode, changeLabel.body).toBe(200);
    const approval = await app.inject({ method: "POST", url: `${classPath}/proposal-runs/${run.id}/decisions`,
      payload: { clientRequestId: randomUUID(), items: items.map(({ id }) => ({ proposalItemId: id, decision: "APPROVE" })) },
    });
    expect(approval.statusCode, approval.body).toBe(200);
  } finally {
    await app.close();
  }
  const local = await captureNote(classroom, body);
  await db.updateTable("raw_notes").set({ created_at: beforeEdit }).where("id", "=", local.rawNoteId).execute();
  expect(await runNextJob({ db, now: () => new Date(START), structurer: new FakeNoteStructurer((input) => {
    expect(input.body).toBe(body);
    expect(input.canonicalIssues).toContainEqual(expect.objectContaining({ label: delayedLabel }));
    expect(input.studentIssues).toContainEqual(expect.objectContaining({ manifestation: delayedManifestation }));
    return { schemaVersion: "1", items: [] };
  }) })).toBe(true);
  expect(await db.selectFrom("jobs").select("status").where("id", "=", local.jobId).executeTakeFirst())
    .toEqual({ status: "SUCCEEDED" });

  const latest = await captureNote(classroom, "Replacement Display kept one sign at Replacement Class.");
  await db.updateTable("raw_notes").set({ created_at: afterEdit }).where("id", "=", latest.rawNoteId).execute();
  const requests: string[] = [];
  const route = createConfiguredNoteRouter(env, stubGemini((payload) => requests.push(payload)));
  expect(await runNextJob({ db, now: () => new Date(START), route })).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain(student.display_label);
  expect(requests[0]).not.toContain(classroom.name);
  const sent = JSON.parse(requests[0]);
  expect(sent).toMatchObject({
    note: `${student.ai_alias} kept one sign at [PRIVATE].`,
    canonicalIssues: expect.arrayContaining([
      { canonicalIssueId: expect.stringMatching(/^CI_/), label: freshLabel, description: null, version: 1 },
      { canonicalIssueId: expect.stringMatching(/^CI_/), label: "[PRIVATE]", description: null, version: 1 },
      { canonicalIssueId: expect.stringMatching(/^CI_/), label: "[PRIVATE]", description: null, version: 2 },
    ]),
    studentIssues: expect.arrayContaining([
      { studentIssueId: expect.stringMatching(/^SI_/), canonicalIssueId: expect.stringMatching(/^CI_/),
        studentAlias: student.ai_alias, state: "IMPROVING", version: 2, manifestation: null },
      { studentIssueId: expect.stringMatching(/^SI_/), canonicalIssueId: expect.stringMatching(/^CI_/),
        studentAlias: secondStudent.ai_alias, state: "OPEN", version: 1, manifestation: `${student.ai_alias} misses one sign` },
    ]),
  });
  expect(sent.canonicalIssues).toHaveLength(3);
  expect(sent.studentIssues).toHaveLength(4);
  expect(sent.studentIssues.filter(({ manifestation }: { manifestation: string | null }) => manifestation === null)).toHaveLength(3);
  expect(await db.selectFrom("canonical_issues").select(["label", "description"]).where("class_id", "=", classroom.id).execute())
    .toEqual(expect.arrayContaining([{ label: "Updated label", description: oldDescription },
      { label: delayedLabel, description: oldDescription }]));
  expect(await db.selectFrom("student_issues").select(["state", "manifestation"]).where("id", "=", studentIssueId).executeTakeFirst())
    .toEqual({ state: "IMPROVING", manifestation: "Synthetic Sao Mai 0901234567" });
}, 15_000);

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
          key: "invalid-transition", type: "TRANSITION_STUDENT_ISSUE", expectedVersion: 2, toState: "IMPROVING",
          studentIssueRef: { kind: "EXISTING", studentIssueId: "SI_001" }, reason: "private provider output",
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
        expectedVersion: 1, toState: "IMPROVING", reason: null, supportingEvidenceKey: "evidence",
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
  const evidenceRow = items.find(({ item_type }) => item_type === "CREATE_EVIDENCE")!;
  const transitionRow = items.find(({ item_type }) => item_type === "TRANSITION_STUDENT_ISSUE")!;
  expect(await db.selectFrom("proposal_item_dependencies").selectAll()
    .where("proposal_item_id", "=", transitionRow.id).execute()).toEqual([
    { proposal_item_id: transitionRow.id, depends_on_item_id: evidenceRow.id },
  ]);
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
      prompt_version: "structure-note-v3", schema_version: "1", redaction_version: "1",
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
