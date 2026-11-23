import { randomUUID } from "node:crypto";
import type { StructureNoteInput } from "@tutorloop/ai/contract";
import { createRawNoteResponseSchema, type ProposalDraftV1, type StudentRef } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { FakeNoteStructurer } from "@tutorloop/testkit/fake-note-structurer";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../../api/src/app.ts";
import { runNextJob, runWorker } from "../src/worker.ts";

const startTime = Date.parse("2026-11-21T01:00:00.000Z");
const observedAt = "2026-11-20T07:00:00.123456Z";
const body = "Two students made sign errors.";
const ambiguousRef: StudentRef = { kind: "AMBIGUOUS", token: "An", candidateAliases: ["STU_001", "STU_002"] };
const emptyDraft: ProposalDraftV1 = { schemaVersion: "1", items: [] };

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
let classId: string;
let currentTime: number;
const now = () => new Date(currentTime);

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE classes, jobs CASCADE`.execute(db);
  const classroom = buildClass();
  classId = classroom.id;
  await db.insertInto("classes").values(classroom).execute();
  app = await createApp({ db, authVerifier: async () => ({ userId: classroom.owner_user_id }) });
  currentTime = startTime;
});

afterEach(async () => { await app?.close(); });
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await postgres?.stop();
  }
});

function collectionUrl() {
  return `/api/v1/classes/${classId}/raw-notes`;
}

async function capture() {
  const response = await app.inject({
    method: "POST", url: collectionUrl(), payload: {
      body, observedAt, noteType: "OBSERVATION", clientRequestId: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const { rawNote, processing } = createRawNoteResponseSchema.parse(response.json());
  await db.updateTable("jobs").set({ run_after: now() }).where("id", "=", processing.jobId).execute();
  return { jobId: processing.jobId, rawNote, url: `${collectionUrl()}/${rawNote.id}` };
}

function getJob(jobId: string) {
  return db.selectFrom("jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
}

function getRun(jobId: string) {
  return db.selectFrom("proposal_runs").selectAll().where("source_job_id", "=", jobId).executeTakeFirstOrThrow();
}

function work(structurer = new FakeNoteStructurer(() => emptyDraft)) {
  return runNextJob({ db, now, structurer });
}

test("persists unresolved proposal payloads and same-run dependencies without writing canonical rows", async () => {
  const { jobId, rawNote, url } = await capture();
  const first = buildStudent(classId);
  const second = buildStudent(classId, "STU_002");
  const otherClass = buildClass();
  await db.insertInto("classes").values(otherClass).execute();
  await db.insertInto("students").values([first, second, buildStudent(otherClass.id, "STU_OTHER")]).execute();
  const issue = buildCanonicalIssue(classId);
  await db.insertInto("canonical_issues").values([issue, buildCanonicalIssue(otherClass.id)]).execute();
  const draft: ProposalDraftV1 = {
    schemaVersion: "1",
    items: [
      { key: "e", type: "CREATE_EVIDENCE", studentRef: ambiguousRef, observationText: "Sign error",
        studentIssueRef: { kind: "PROPOSED", proposalKey: "s" } },
      { key: "s", type: "CREATE_STUDENT_ISSUE", studentRef: ambiguousRef,
        canonicalIssueRef: { kind: "PROPOSED", proposalKey: "c" } },
      { key: "c", type: "CREATE_CANONICAL_ISSUE", label: "Transposition signs" },
      { key: "u", type: "CREATE_STUDENT_ISSUE", studentRef: { kind: "UNKNOWN", token: "a learner" },
        canonicalIssueRef: { kind: "AMBIGUOUS", candidateIds: [issue.id] } },
    ],
  };
  const inputs: StructureNoteInput[] = [];
  await work(new FakeNoteStructurer((input) => {
    inputs.push(input);
    return draft;
  }));
  expect(inputs).toEqual([{
    task: "STRUCTURE_OBSERVATION_NOTE", classId, rawNoteId: rawNote.id, body, observedAt,
    students: expect.arrayContaining([
      { studentId: first.id, displayLabel: "An", aiAlias: "STU_001" },
      { studentId: second.id, displayLabel: "An", aiAlias: "STU_002" },
    ]),
    canonicalIssues: [{ canonicalIssueId: issue.id, label: issue.label, description: null, version: 1 }],
    studentIssues: [],
  }]);
  expect(inputs[0].students).toHaveLength(2);
  const run = await getRun(jobId);
  expect(run).toMatchObject({ status: "READY", class_id: classId, raw_note_id: rawNote.id, schema_version: "1" });
  expect(await getJob(jobId)).toMatchObject({ status: "SUCCEEDED", attempts: 1, locked_at: null, locked_by: null });
  const items = await db.selectFrom("proposal_items").selectAll().where("proposal_run_id", "=", run.id).execute();
  expect(items).toHaveLength(4);
  for (const original of draft.items) {
    expect(items).toContainEqual(expect.objectContaining({
      item_type: original.type, status: "PENDING", original_payload: original,
    }));
  }
  const ids = new Map(items.map((item) => [item.original_payload.key, item.id]));
  expect(await db.selectFrom("proposal_item_dependencies").selectAll().execute()).toEqual(expect.arrayContaining([
    { proposal_item_id: ids.get("e"), depends_on_item_id: ids.get("s") },
    { proposal_item_id: ids.get("s"), depends_on_item_id: ids.get("c") },
  ]));
  expect(await db.selectFrom("proposal_item_dependencies").selectAll().execute()).toHaveLength(2);
  expect(await db.selectFrom("evidence_events").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("student_issues").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("canonical_issues").select("id").where("class_id", "=", classId).execute())
    .toEqual([{ id: issue.id }]);
  expect((await app.inject(url)).json()).toEqual({ rawNote, processing: { status: "READY", proposalRunId: run.id } });
  const voided = await app.inject({ method: "POST", url: `${url}/void`, payload: {} });
  expect(voided.statusCode).toBe(200);
  expect(voided.json().processing).toEqual({ status: "READY", proposalRunId: run.id });
});

test("concurrent workers claim a due job once and expose PROCESSING during structuring", async () => {
  const { jobId, url } = await capture();
  const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
  const { promise: finish, resolve } = Promise.withResolvers<ProposalDraftV1>();
  const first = work(new FakeNoteStructurer(() => {
    signalStarted();
    return finish;
  }));
  // Surface a broken first worker instead of leaving the test waiting on its fixture.
  await Promise.race([started, first]);
  try {
    expect(await work()).toBe(false);
    const run = await getRun(jobId);
    expect(await getJob(jobId)).toMatchObject({ status: "RUNNING", attempts: 1 });
    expect((await app.inject(url)).json().processing).toEqual({ status: "PROCESSING", proposalRunId: run.id });
  } finally {
    resolve(emptyDraft);
    await first;
  }
  expect(await getJob(jobId)).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
});

test("skips an earlier due job held by another PostgreSQL transaction", async () => {
  const first = await capture();
  const second = await capture();
  await db.updateTable("jobs").set({ run_after: new Date(startTime - 1) }).where("id", "=", first.jobId).execute();
  const { promise: locked, resolve: signalLocked } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const holder = db.transaction().execute(async (trx) => {
    await trx.selectFrom("jobs").select("id").where("id", "=", first.jobId).forUpdate().executeTakeFirstOrThrow();
    signalLocked();
    await released;
  });
  await Promise.race([locked, holder]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const worker = work();
  try {
    await Promise.race([worker, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Worker waited on a locked job.")), 2_000);
    })]);
    expect(await getJob(first.jobId)).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(await getJob(second.jobId)).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
  } finally {
    clearTimeout(timer);
    release();
    await Promise.allSettled([holder, worker]);
  }
});

test("the worker entry finishes its in-flight attempt on abort and stops claiming jobs", async () => {
  const first = await capture();
  const second = await capture();
  await db.updateTable("jobs").set({ run_after: new Date(startTime - 1) }).where("id", "=", first.jobId).execute();
  const controller = new AbortController();
  const structurer = new FakeNoteStructurer((input) => {
    expect(input.rawNoteId).toBe(first.rawNote.id);
    controller.abort();
    return emptyDraft;
  });
  await runWorker({ db, now, structurer }, { signal: controller.signal });
  expect(await getJob(first.jobId)).toMatchObject({ status: "SUCCEEDED" });
  expect(await getJob(second.jobId)).toMatchObject({ status: "QUEUED", attempts: 0 });
});

test("recovers a READY run after PostgreSQL interrupts the separate job acknowledgement", async () => {
  const { jobId } = await capture();
  const draft: ProposalDraftV1 = {
    schemaVersion: "1",
    items: [{ key: "c", type: "CREATE_CANONICAL_ISSUE", label: "Transposition signs" }],
  };
  await sql`ALTER TABLE jobs ADD CONSTRAINT interrupt_ack CHECK (status <> 'SUCCEEDED')`.execute(db);
  try {
    await expect(work(new FakeNoteStructurer(() => draft))).rejects.toMatchObject({ code: "23514" });
    expect(await getJob(jobId)).toMatchObject({ status: "RUNNING", attempts: 1 });
  } finally {
    await sql`ALTER TABLE jobs DROP CONSTRAINT interrupt_ack`.execute(db);
  }
  const run = await getRun(jobId);
  expect(run.status).toBe("READY");
  const items = await db.selectFrom("proposal_items").selectAll().execute();
  expect(items).toHaveLength(1);
  currentTime += 5 * 60_000;
  let called = false;
  await work(new FakeNoteStructurer(() => {
    called = true;
    return draft;
  }));
  expect(called).toBe(false);
  expect(await getJob(jobId)).toMatchObject({ status: "SUCCEEDED", locked_at: null, locked_by: null, attempts: 1 });
  expect(await db.selectFrom("proposal_runs").selectAll().execute()).toEqual([run]);
  expect(await db.selectFrom("proposal_items").selectAll().execute()).toEqual(items);
});

test("retries invalid output at exactly 30 seconds and 5 minutes and keeps the saved note after attempt three", async () => {
  const { jobId, rawNote, url } = await capture();
  const invalid = new FakeNoteStructurer(() => ({ schemaVersion: "2", items: [] }) as unknown as ProposalDraftV1);
  await work(invalid);
  expect(await getJob(jobId)).toMatchObject({
    status: "FAILED", attempts: 1, run_after: new Date(startTime + 30_000),
    locked_at: null, locked_by: null, last_error_code: "INVALID_PROPOSAL_DRAFT",
  });
  const run = await getRun(jobId);
  expect(run.status).toBe("PROCESSING");
  currentTime += 29_999;
  expect(await work(invalid)).toBe(false);
  currentTime += 1;
  await work(invalid);
  expect(await getJob(jobId)).toMatchObject({
    status: "FAILED", attempts: 2, run_after: new Date(startTime + 330_000),
  });
  currentTime += 299_999;
  expect(await work(invalid)).toBe(false);
  currentTime += 1;
  await work(invalid);
  expect(await getJob(jobId)).toMatchObject({ status: "DEAD", attempts: 3, locked_by: null });
  expect(await getRun(jobId)).toMatchObject({ id: run.id, status: "FAILED" });
  currentTime += 300_000;
  expect(await work(invalid)).toBe(false);
  expect(await db.selectFrom("proposal_items").selectAll().execute()).toEqual([]);
  expect((await app.inject(url)).json()).toEqual({ rawNote, processing: { status: "FAILED", proposalRunId: run.id } });
});

test.each(["dangling", "wrong-kind", "cross-class"] as const)("rejects a %s reference without storing any items", async (kind) => {
  const { jobId } = await capture();
  const otherClass = buildClass();
  await db.insertInto("classes").values(otherClass).execute();
  const foreign = buildCanonicalIssue(otherClass.id);
  await db.insertInto("canonical_issues").values(foreign).execute();
  const reference = kind === "cross-class"
    ? { kind: "EXISTING", canonicalIssueId: foreign.id } as const
    : { kind: "PROPOSED", proposalKey: kind === "dangling" ? "missing" : "e" } as const;
  await work(new FakeNoteStructurer(() => ({
    schemaVersion: "1", items: [
      { key: "e", type: "CREATE_EVIDENCE", studentRef: ambiguousRef, observationText: "Sign error" },
      { key: "s", type: "CREATE_STUDENT_ISSUE", studentRef: ambiguousRef, canonicalIssueRef: reference },
    ],
  })));
  expect(await getJob(jobId)).toMatchObject({ status: "FAILED", last_error_code: "INVALID_PROPOSAL_DRAFT" });
  expect(await getRun(jobId)).toMatchObject({ status: "PROCESSING" });
  expect(await db.selectFrom("proposal_items").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("proposal_item_dependencies").selectAll().execute()).toEqual([]);
});

test("rolls back inserted items when PostgreSQL rejects a dependency row", async () => {
  const { jobId } = await capture();
  const structurer = new FakeNoteStructurer(() => ({
    schemaVersion: "1", items: [
      { key: "c", type: "CREATE_CANONICAL_ISSUE", label: "Signs" },
      { key: "s", type: "CREATE_STUDENT_ISSUE", studentRef: ambiguousRef,
        canonicalIssueRef: { kind: "PROPOSED", proposalKey: "c" } },
    ],
  }));
  await sql`ALTER TABLE proposal_item_dependencies ADD CONSTRAINT refuse_dependency CHECK (false)`.execute(db);
  try {
    await expect(work(structurer)).rejects.toMatchObject({ code: "23514" });
    expect(await getRun(jobId)).toMatchObject({ status: "PROCESSING" });
    expect(await db.selectFrom("proposal_items").selectAll().execute()).toEqual([]);
  } finally {
    await sql`ALTER TABLE proposal_item_dependencies DROP CONSTRAINT refuse_dependency`.execute(db);
  }
  currentTime += 330_000;
  await work(structurer);
  expect(await getJob(jobId)).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  expect(await getRun(jobId)).toMatchObject({ status: "READY" });
  expect(await db.selectFrom("proposal_items").selectAll().execute()).toHaveLength(2);
  expect(await db.selectFrom("proposal_item_dependencies").selectAll().execute()).toHaveLength(1);
});

test("reclaims an expired job and fences off its previous worker", async () => {
  const { jobId } = await capture();
  const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
  const { promise: finish, resolve } = Promise.withResolvers<ProposalDraftV1>();
  const stale = work(new FakeNoteStructurer(() => {
    signalStarted();
    return finish;
  }));
  await Promise.race([started, stale]);
  try {
    currentTime += 5 * 60_000;
    expect(await work()).toBe(false);
    expect(await getJob(jobId)).toMatchObject({
      status: "FAILED", attempts: 1, run_after: new Date(startTime + 330_000), last_error_code: "JOB_LOCK_EXPIRED",
    });
    currentTime += 30_000;
    await work();
  } finally {
    resolve({ schemaVersion: "1", items: [{ key: "stale", type: "CREATE_CANONICAL_ISSUE", label: "Stale" }] });
    await stale;
  }
  expect(await getJob(jobId)).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  expect(await getRun(jobId)).toMatchObject({ status: "READY" });
  expect(await db.selectFrom("proposal_items").selectAll().execute()).toEqual([]);
});

test("reprocess queues exactly one new job and preserves the earlier failed run", async () => {
  const { jobId, url } = await capture();
  const reprocess = (clientRequestId: string) => app.inject({
    method: "POST", url: `${url}/reprocess`, payload: { clientRequestId },
  });
  expect((await reprocess(randomUUID())).statusCode).toBe(409);
  const offline = new FakeNoteStructurer(() => { throw new Error("Provider unavailable"); });
  await work(offline);
  expect((await reprocess(randomUUID())).statusCode).toBe(409);
  currentTime += 30_000;
  await work(offline);
  currentTime += 300_000;
  await work(offline);
  const failed = await getRun(jobId);
  expect(failed.status).toBe("FAILED");
  const requestIds = [randomUUID(), randomUUID()];
  const responses = await Promise.all(requestIds.map(reprocess));
  expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  const winner = responses.findIndex((response) => response.statusCode === 201);
  const requestId = requestIds[winner];
  const first = responses[winner];
  const same = await reprocess(requestId.toUpperCase());
  expect(same.statusCode).toBe(201);
  expect(same.json()).toEqual(first.json());
  const { processing } = createRawNoteResponseSchema.parse(first.json());
  expect(processing.jobId).not.toBe(jobId);
  const newJob = await getJob(processing.jobId);
  expect(newJob.dedupe_key).toContain(requestId);
  expect((await app.inject(url)).json().processing).toEqual({ status: "QUEUED" });
  currentTime = newJob.run_after.getTime();
  await work();
  const ready = await getRun(processing.jobId);
  expect(ready).toMatchObject({ status: "READY", raw_note_id: failed.raw_note_id });
  expect(ready.id).not.toBe(failed.id);
  expect(await getRun(jobId)).toEqual(failed);
  expect((await reprocess(requestId)).json()).toEqual(first.json());
  for (const status of ["READY", "PARTIALLY_REVIEWED", "APPLIED"] as const) {
    await db.updateTable("proposal_runs").set({ status }).where("id", "=", ready.id).execute();
    const conflict = await reprocess(randomUUID());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  }
  expect(await db.selectFrom("jobs").select("id").execute()).toHaveLength(2);
});


test("merged aliases stay usable as historical Student Issue evidence while only roots are AI candidates", async () => {
  const student = buildStudent(classId), source = buildCanonicalIssue(classId), target = buildCanonicalIssue(classId);
  await db.insertInto("students").values(student).execute();
  await db.insertInto("canonical_issues").values([source, target]).execute();
  const issueId = randomUUID();
  await db.insertInto("student_issues").values({ id: issueId, class_id: classId, student_id: student.id,
    canonical_issue_id: source.id, state: "OPEN", manifestation: "Historical branch", created_at: now(), updated_at: now() }).execute();
  const merge = await app.inject({ method: "POST", url: `/api/v1/classes/${classId}/canonical-issues/${source.id}/merge`,
    payload: { targetCanonicalIssueId: target.id, expectedSourceVersion: 1, expectedTargetVersion: 1 } });
  expect(merge.statusCode, merge.body).toBe(200);
  const { jobId } = await capture();
  await work(new FakeNoteStructurer((input) => {
    expect(input.canonicalIssues).toEqual([{ canonicalIssueId: target.id, label: target.label, description: null, version: 1 }]);
    expect(input.studentIssues).toEqual([expect.objectContaining({ studentIssueId: issueId, canonicalIssueId: target.id })]);
    return { schemaVersion: "1", items: [{ key: "e", type: "CREATE_EVIDENCE", observationText: "Follow-up history",
      studentRef: { kind: "RESOLVED", studentAlias: student.ai_alias }, studentIssueRef: { kind: "EXISTING", studentIssueId: issueId } }] };
  }));
  const run = await getRun(jobId), item = await db.selectFrom("proposal_items").selectAll().where("proposal_run_id", "=", run.id).executeTakeFirstOrThrow();
  expect(await db.selectFrom("evidence_events").select("id").execute()).toHaveLength(0);
  const response = await app.inject({ method: "POST", url: `/api/v1/classes/${classId}/proposal-runs/${run.id}/decisions`,
    payload: { clientRequestId: randomUUID(), items: [{ proposalItemId: item.id, decision: "APPROVE" }] } });
  expect(response.statusCode, response.body).toBe(200);
  expect(await db.selectFrom("evidence_events").select("student_issue_id").execute()).toEqual([{ student_issue_id: issueId }]);
  expect(await db.selectFrom("student_issues").select("canonical_issue_id").where("id", "=", issueId).executeTakeFirst())
    .toEqual({ canonical_issue_id: source.id });
  const scheduled = await app.inject({ method: "POST", url: `/api/v1/classes/${classId}/reassessments`, payload: {
    studentIssueIds: [issueId], dueAt: "2026-11-20T07:00:00Z", clientRequestId: randomUUID(),
  } });
  expect(scheduled.statusCode, scheduled.body).toBe(201);
  const reassessment = scheduled.json<{ id: string }>();
  expect((await app.inject({ method: "POST", url: `/api/v1/classes/${classId}/reassessments/${reassessment.id}/mark-performed`,
    payload: { expectedVersion: 1 } })).statusCode).toBe(200);
  const outcome = await app.inject({ method: "POST", url: `/api/v1/classes/${classId}/reassessments/${reassessment.id}/outcome-note`,
    payload: { body: "Outcome for historical branch", observedAt, clientRequestId: randomUUID() } });
  expect(outcome.statusCode, outcome.body).toBe(201);
  const outcomeNote = createRawNoteResponseSchema.parse(outcome.json());
  await db.updateTable("jobs").set({ run_after: now() }).where("id", "=", outcomeNote.processing.jobId).execute();
  await work(new FakeNoteStructurer((input) => {
    expect(input.task).toBe("RECONCILE_REASSESSMENT_OUTCOME");
    expect(input.canonicalIssues.map(({ canonicalIssueId }) => canonicalIssueId)).toEqual([target.id]);
    expect(input.studentIssues.map(({ studentIssueId }) => studentIssueId)).toEqual([issueId]);
    expect(input.evidenceHistory).toContainEqual(expect.objectContaining({ studentIssueId: issueId, observationText: "Follow-up history" }));
    return { schemaVersion: "1", items: [{ key: "outcome", type: "CREATE_EVIDENCE", observationText: "Outcome evidence",
      studentRef: { kind: "RESOLVED", studentAlias: student.ai_alias }, studentIssueRef: { kind: "EXISTING", studentIssueId: issueId } }] };
  }));
  const outcomeRun = await getRun(outcomeNote.processing.jobId);
  const outcomeItem = await db.selectFrom("proposal_items").select("id").where("proposal_run_id", "=", outcomeRun.id).executeTakeFirstOrThrow();
  const applied = await app.inject({ method: "POST", url: `/api/v1/classes/${classId}/proposal-runs/${outcomeRun.id}/decisions`,
    payload: { clientRequestId: randomUUID(), items: [{ proposalItemId: outcomeItem.id, decision: "APPROVE" }] } });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(await db.selectFrom("reassessments").select("status").where("id", "=", reassessment.id).executeTakeFirst())
    .toEqual({ status: "COMPLETED" });
});

test("AI merge drafts persist pending canonical targets without autonomously merging", async () => {
  const source = buildCanonicalIssue(classId), target = buildCanonicalIssue(classId);
  await db.insertInto("canonical_issues").values([source, target]).execute();
  const { jobId } = await capture();
  await work(new FakeNoteStructurer(() => ({ schemaVersion: "1", items: [{ key: "m", type: "MERGE_CANONICAL_ISSUE",
    sourceCanonicalIssueId: source.id, targetCanonicalIssueId: target.id, expectedSourceVersion: 1, expectedTargetVersion: 1 }] })));
  const run = await getRun(jobId);
  expect(await db.selectFrom("proposal_items").select(["item_type", "status", "target_entity_type", "target_entity_id", "base_version"])
    .where("proposal_run_id", "=", run.id).execute()).toEqual([{ item_type: "MERGE_CANONICAL_ISSUE", status: "PENDING",
      target_entity_type: "CANONICAL_ISSUE", target_entity_id: source.id, base_version: 1 }]);
  expect(await db.selectFrom("canonical_issues").select("merged_into_id").where("id", "=", source.id).executeTakeFirst())
    .toEqual({ merged_into_id: null });
});
