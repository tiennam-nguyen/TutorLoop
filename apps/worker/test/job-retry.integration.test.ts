import { randomUUID } from "node:crypto";
import { createRawNoteResponseSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildClass } from "@tutorloop/testkit/builders";
import { FakeNoteStructurer } from "@tutorloop/testkit/fake-note-structurer";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../../api/src/app.ts";
import { runNextJob } from "../src/worker.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
const classroom = buildClass();
let currentTime = Date.parse("2026-11-21T01:00:00Z");
const now = () => new Date(currentTime);
const root = `/api/v1/classes/${classroom.id}/raw-notes`;
beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
  await db.insertInto("classes").values(classroom).execute();
  app = await createApp({ db, authVerifier: async () => ({ userId: classroom.owner_user_id }) });
}, 120_000);
afterAll(async () => {
  try { await app?.close(); await db?.destroy(); } finally { await postgres?.stop(); }
});

test("real worker retries at +30s and +5m, marks the third failure DEAD, and reprocesses into a new job/run", async () => {
  const input = { body: "Synthetic retry observation", observedAt: "2026-11-20T07:00:00.123456Z",
    noteType: "OBSERVATION", clientRequestId: randomUUID() };
  const response = await app.inject({ method: "POST", url: root, payload: input });
  expect(response.statusCode, response.body).toBe(201);
  const captured = createRawNoteResponseSchema.parse(response.json());
  const jobId = captured.processing.jobId!;
  await db.updateTable("jobs").set({ run_after: now() }).where("id", "=", jobId).execute();
  const originalNote = await db.selectFrom("raw_notes").selectAll().where("id", "=", captured.rawNote.id).executeTakeFirstOrThrow();
  const failure = new FakeNoteStructurer(() => { throw new Error("Deterministic provider failure"); });
  const work = () => runNextJob({ db, now, structurer: failure });
  const job = () => db.selectFrom("jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
  const runs = () => db.selectFrom("proposal_runs").selectAll().where("source_job_id", "=", jobId).execute();
  let runId: string | undefined;
  for (const step of [
    { attempt: 1, at: "2026-11-21T01:00:00Z", next: "2026-11-21T01:00:30Z", status: "FAILED", runStatus: "PROCESSING" },
    { attempt: 2, at: "2026-11-21T01:00:30Z", next: "2026-11-21T01:05:30Z", status: "FAILED", runStatus: "PROCESSING" },
    { attempt: 3, at: "2026-11-21T01:05:30Z", next: "2026-11-21T01:05:30Z", status: "DEAD", runStatus: "FAILED" },
  ]) {
    currentTime = Date.parse(step.at);
    expect(await work()).toBe(true);
    expect(await job()).toMatchObject({ status: step.status, attempts: step.attempt, run_after: new Date(step.next),
      locked_at: null, locked_by: null, last_error_code: "AI_PROCESSING_FAILED", updated_at: now() });
    const attempts = await runs();
    expect(attempts).toHaveLength(1);
    runId ??= attempts[0].id;
    expect(attempts[0]).toMatchObject({ id: runId, raw_note_id: captured.rawNote.id, status: step.runStatus });
    expect(await db.selectFrom("proposal_items").selectAll().where("proposal_run_id", "=", runId).execute()).toEqual([]);
    expect(await db.selectFrom("raw_notes").selectAll().where("id", "=", captured.rawNote.id).executeTakeFirstOrThrow()).toEqual(originalNote);
    if (step.attempt < 3) {
      currentTime = Date.parse(step.next) - 1;
      const before = await job();
      expect(await work()).toBe(false);
      expect(await job()).toEqual(before);
      expect(await runs()).toEqual(attempts);
    }
  }
  currentTime += 86_400_000;
  const dead = await job();
  expect(await work()).toBe(false);
  expect(await job()).toEqual(dead);
  const failed = await app.inject(`${root}/${captured.rawNote.id}`);
  expect(failed.statusCode, failed.body).toBe(200);
  expect(failed.json().processing).toEqual({ status: "FAILED", proposalRunId: runId });
  expect(await db.selectFrom("evidence_events").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("canonical_issues").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("student_issues").selectAll().execute()).toEqual([]);

  const requestId = randomUUID();
  const reprocess = () => app.inject({ method: "POST", url: `${root}/${captured.rawNote.id}/reprocess`,
    payload: { clientRequestId: requestId } });
  const retried = await reprocess();
  expect(retried.statusCode, retried.body).toBe(201);
  const manual = createRawNoteResponseSchema.parse(retried.json());
  expect(manual.rawNote).toEqual(captured.rawNote);
  expect(manual.processing.status).toBe("QUEUED");
  expect(manual.processing.jobId).not.toBe(jobId);
  const replay = await reprocess();
  expect(replay.statusCode, replay.body).toBe(201);
  expect(replay.json()).toEqual(manual);
  const newJobId = manual.processing.jobId!;
  await db.updateTable("jobs").set({ run_after: now() }).where("id", "=", newJobId).execute();
  expect(await runNextJob({ db, now, structurer: new FakeNoteStructurer(() => ({ schemaVersion: "1", items: [
    { key: "c", type: "CREATE_CANONICAL_ISSUE", label: "Synthetic draft only" },
  ] })) })).toBe(true);
  const allRuns = await db.selectFrom("proposal_runs").selectAll().where("raw_note_id", "=", captured.rawNote.id).execute();
  expect(allRuns).toHaveLength(2);
  const newRun = allRuns.find(({ source_job_id }) => source_job_id === newJobId)!;
  expect(newRun).toMatchObject({ status: "READY", class_id: classroom.id });
  expect(newRun.id).not.toBe(runId);
  expect(await runs()).toMatchObject([{ id: runId, status: "FAILED" }]);
  expect(await job()).toEqual(dead);
  expect(await db.selectFrom("jobs").select(["status", "attempts", "locked_by", "locked_at"])
    .where("id", "=", newJobId).execute()).toEqual([{ status: "SUCCEEDED", attempts: 1, locked_by: null, locked_at: null }]);
  expect(await db.selectFrom("proposal_items").select(["proposal_run_id", "status"]).execute())
    .toEqual([{ proposal_run_id: newRun.id, status: "PENDING" }]);
  const stableRuns = await db.selectFrom("proposal_runs").selectAll().execute();
  expect(await runNextJob({ db, now, structurer: failure })).toBe(false);
  expect(await db.selectFrom("proposal_runs").selectAll().execute()).toEqual(stableRuns);
  expect(await db.selectFrom("jobs").select("id").execute()).toHaveLength(2);
  expect(await db.selectFrom("raw_notes").selectAll().execute()).toEqual([originalNote]);
  expect(await db.selectFrom("canonical_issues").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("evidence_events").selectAll().execute()).toEqual([]);
});
