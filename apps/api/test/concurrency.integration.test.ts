import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRawNoteResponseSchema, proposalRunDetailDtoSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { FakeNoteStructurer } from "@tutorloop/testkit/fake-note-structurer";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql, type Transaction } from "kysely";
import type { Database } from "@tutorloop/db/database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runNextJob } from "../../worker/src/worker.ts";
import { createApp } from "../src/app.ts";
import { fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
const teacherId = randomUUID();
const observedAt = "2026-11-20T07:00:00Z";
beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherId) });
  await app.ready();
}, 120_000);
afterAll(async () => {
  try { await app?.close(); await db?.destroy(); } finally { await postgres?.stop(); }
});

async function seed() {
  const classroom = { ...buildClass(), owner_user_id: teacherId };
  const student = buildStudent(classroom.id);
  const canonical = buildCanonicalIssue(classroom.id);
  const issueId = randomUUID();
  await db.insertInto("classes").values(classroom).execute();
  await db.insertInto("students").values(student).execute();
  await db.insertInto("canonical_issues").values(canonical).execute();
  await db.insertInto("student_issues").values({ id: issueId, class_id: classroom.id, student_id: student.id,
    canonical_issue_id: canonical.id, state: "OPEN", created_at: new Date(), updated_at: new Date() }).execute();
  return { classroom, student, issueId, root: `/api/v1/classes/${classroom.id}` };
}

function noteInput() {
  return { body: "Synthetic observation", observedAt, noteType: "OBSERVATION", clientRequestId: randomUUID() };
}

// Hold a real PostgreSQL lock until BOTH HTTP transactions are blocked. This catches races that
// Promise.all alone can accidentally serialize. The deadline is a failure bound, never a synchronization sleep.
async function collide<T>(lock: (trx: Transaction<Database>) => Promise<unknown>, requests: () => [Promise<T>, Promise<T>]) {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = db.transaction().execute(async (trx) => {
    await lock(trx);
    held.resolve();
    await release.promise;
  });
  await Promise.race([held.promise, holder]);
  const pair = requests();
  try {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const { rows: [row] } = await sql<{ blocked: number }>`select count(*)::int as blocked from pg_stat_activity
        where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`.execute(db);
      if (row.blocked === 2) break;
      if (Date.now() >= deadline) throw new Error(`Expected two blocked HTTP transactions; saw ${row.blocked}.`);
      await delay(10);
    }
  } finally {
    release.resolve();
    await holder;
    await Promise.allSettled(pair);
  }
  return Promise.all(pair);
}

test("parallel approvals with distinct receipts apply one Evidence mutation and return one already-decided conflict", async () => {
  const f = await seed();
  const captured = await app.inject({ method: "POST", url: `${f.root}/raw-notes`, payload: noteInput() });
  expect(captured.statusCode, captured.body).toBe(201);
  const note = createRawNoteResponseSchema.parse(captured.json());
  expect(await runNextJob({ db, now: () => new Date(), structurer: new FakeNoteStructurer(() => ({
    schemaVersion: "1", items: [{ key: "e", type: "CREATE_EVIDENCE", observationText: "Synthetic evidence",
      studentRef: { kind: "RESOLVED", studentAlias: f.student.ai_alias },
      studentIssueRef: { kind: "EXISTING", studentIssueId: f.issueId } }],
  })) })).toBe(true);
  const run = await db.selectFrom("proposal_runs").selectAll().where("source_job_id", "=", note.processing.jobId!).executeTakeFirstOrThrow();
  const item = await db.selectFrom("proposal_items").selectAll().where("proposal_run_id", "=", run.id).executeTakeFirstOrThrow();
  const url = `${f.root}/proposal-runs/${run.id}/decisions`;
  const inputs = [0, 1].map(() => ({ clientRequestId: randomUUID(), items: [{ proposalItemId: item.id, decision: "APPROVE" }] }));
  const responses = await collide(
    (trx) => trx.selectFrom("proposal_runs").select("id").where("id", "=", run.id).forUpdate().execute(),
    () => [app.inject({ method: "POST", url, payload: inputs[0] }), app.inject({ method: "POST", url, payload: inputs[1] })],
  );
  expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  const winner = responses.findIndex(({ statusCode }) => statusCode === 200);
  expect(responses[1 - winner].json()).toMatchObject({ error: { code: "PROPOSAL_ITEM_ALREADY_DECIDED" } });
  const detail = proposalRunDetailDtoSchema.parse(responses[winner].json());
  expect(detail).toMatchObject({ status: "APPLIED", items: [{ id: item.id, status: "APPROVED" }] });
  expect(await db.selectFrom("evidence_events").select(["id", "proposal_item_id", "student_issue_id"])
    .where("class_id", "=", f.classroom.id).execute()).toEqual([
    { id: detail.items[0].resultEntityId, proposal_item_id: item.id, student_issue_id: f.issueId },
  ]);
  expect(await db.selectFrom("proposal_decision_receipts").select("client_request_id")
    .where("proposal_run_id", "=", run.id).execute()).toEqual([{ client_request_id: inputs[winner].clientRequestId }]);
  const replay = await app.inject({ method: "POST", url, payload: inputs[winner] });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json()).toEqual(detail);
  expect(await db.selectFrom("product_events").select("event_name").where("entity_id", "=", item.id).execute())
    .toEqual([{ event_name: "proposal_item_approved" }]);
  expect(await db.selectFrom("student_issue_transitions").selectAll().where("class_id", "=", f.classroom.id).execute()).toEqual([]);
  expect(await db.selectFrom("student_issues").select(["state", "version"]).where("id", "=", f.issueId).execute())
    .toEqual([{ state: "OPEN", version: 1 }]);
});

test("parallel StudentIssue transitions with the same expectedVersion append only the winner's history", async () => {
  const f = await seed();
  const states = ["IMPROVING", "RESOLVED_FOR_NOW"] as const;
  const responses = await collide(
    (trx) => trx.selectFrom("student_issues").select("id").where("id", "=", f.issueId).forUpdate().execute(),
    () => states.map((toState) => app.inject({ method: "PATCH", url: `${f.root}/student-issues/${f.issueId}/state`,
      payload: { expectedVersion: 1, toState, reason: `Synthetic ${toState}` } })) as [ReturnType<typeof app.inject>, ReturnType<typeof app.inject>],
  );
  expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  const winner = responses.findIndex(({ statusCode }) => statusCode === 200);
  expect(responses[1 - winner].json()).toMatchObject({ error: { code: "STALE_VERSION" } });
  expect(await db.selectFrom("student_issues").select(["state", "version"]).where("id", "=", f.issueId).execute())
    .toEqual([{ state: states[winner], version: 2 }]);
  expect(await db.selectFrom("student_issue_transitions").select(["from_state", "to_state", "reason", "actor_user_id"])
    .where("student_issue_id", "=", f.issueId).execute()).toEqual([
    { from_state: "OPEN", to_state: states[winner], reason: `Synthetic ${states[winner]}`, actor_user_id: teacherId },
  ]);
});

test("parallel identical clientRequestId captures return the same RawNote and job without duplicate analytics or runs", async () => {
  const f = await seed();
  const payload = noteInput();
  const responses = await collide(
    (trx) => sql`lock table raw_notes in share mode`.execute(trx),
    () => [app.inject({ method: "POST", url: `${f.root}/raw-notes`, payload }),
      app.inject({ method: "POST", url: `${f.root}/raw-notes`, payload })],
  );
  expect(responses.map(({ statusCode }) => statusCode)).toEqual([201, 201]);
  const result = createRawNoteResponseSchema.parse(responses[0].json());
  expect(responses[1].json()).toEqual(result);
  expect(await db.selectFrom("raw_notes").select("id").where("class_id", "=", f.classroom.id).execute())
    .toEqual([{ id: result.rawNote.id }]);
  expect(await db.selectFrom("jobs").select(["id", "status", "attempts"])
    .where(sql<string>`payload ->> 'classId'`, "=", f.classroom.id).execute())
    .toEqual([{ id: result.processing.jobId, status: "QUEUED", attempts: 0 }]);
  expect(await db.selectFrom("proposal_runs").selectAll().where("class_id", "=", f.classroom.id).execute()).toEqual([]);
  expect(await db.selectFrom("product_events").select("event_name").where("entity_id", "=", result.rawNote.id).execute())
    .toEqual([{ event_name: "raw_note_created" }]);
  expect(await runNextJob({ db, now: () => new Date(), structurer: new FakeNoteStructurer(() => ({ schemaVersion: "1", items: [] })) })).toBe(true);
  expect(await runNextJob({ db, now: () => new Date(), structurer: new FakeNoteStructurer(() => ({ schemaVersion: "1", items: [] })) })).toBe(false);
  expect(await db.selectFrom("proposal_runs").select(["source_job_id", "raw_note_id", "status"])
    .where("class_id", "=", f.classroom.id).execute()).toEqual([
    { source_job_id: result.processing.jobId, raw_note_id: result.rawNote.id, status: "READY" },
  ]);
});
