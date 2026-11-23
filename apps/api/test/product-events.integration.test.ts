import { randomUUID } from "node:crypto";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { getValidationMetrics } from "@tutorloop/db/repositories/validation-metrics";
import { buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { fixedUserAuthVerifier, anonymousAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  postgres = await startPostgres(); db = createDb(postgres.getConnectionUri()); await runMigrations(db);
}, 120_000);
afterAll(async () => { try { await db?.destroy(); } finally { await postgres?.stop(); } });

test("accepts only strict client view names and checks Class and entity type ownership", async () => {
  const classroom = buildClass(); const other = buildClass();
  await db.insertInto("classes").values([classroom, other]).execute();
  const student = buildStudent(classroom.id); const foreignStudent = buildStudent(other.id);
  await db.insertInto("students").values([student, foreignStudent]).execute();
  const app = await createApp({ db, authVerifier: fixedUserAuthVerifier(classroom.owner_user_id) });
  const send = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/product-events", payload });
  try {
    expect((await send({ eventName: "student_view_opened", classId: classroom.id, entityId: student.id })).statusCode).toBe(204);
    expect((await send({ eventName: "history_opened", classId: classroom.id, entityId: student.id })).statusCode).toBe(204);
    expect((await send({ eventName: "class_issue_view_opened", classId: classroom.id })).statusCode).toBe(204);
    for (const eventName of ["raw_note_created", "proposal_item_approved", "arbitrary"]) {
      expect((await send({ eventName, classId: classroom.id })).statusCode).toBe(400);
    }
    expect((await send({ eventName: "student_view_opened", classId: classroom.id, body: "SYNTHETIC_NOTE" })).statusCode).toBe(400);
    expect((await send({ eventName: "student_view_opened", classId: other.id, entityId: foreignStudent.id })).statusCode).toBe(404);
    expect((await send({ eventName: "student_view_opened", classId: classroom.id, entityId: foreignStudent.id })).statusCode).toBe(404);
    expect((await send({ eventName: "proposal_review_opened", classId: classroom.id, entityId: student.id })).statusCode).toBe(404);
    const events = await db.selectFrom("product_events").selectAll().where("class_id", "=", classroom.id).execute();
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.actor_user_id === classroom.owner_user_id)).toBe(true);
    const anonymous = await createApp({ db, authVerifier: anonymousAuthVerifier });
    try {
      expect((await anonymous.inject({ method: "POST", url: "/api/v1/product-events", payload: {
        eventName: "student_view_opened", classId: classroom.id,
      } })).statusCode).toBe(401);
    } finally { await anonymous.close(); }
  } finally { await app.close(); }
});

test("committed raw note creation emits once across concurrent replay; failures emit none", async () => {
  const classroom = buildClass(); await db.insertInto("classes").values(classroom).execute();
  const app = await createApp({ db, authVerifier: fixedUserAuthVerifier(classroom.owner_user_id) });
  const payload = { body: "SYNTHETIC_NOTE", observedAt: "2026-11-20T00:00:00Z", noteType: "OBSERVATION", clientRequestId: randomUUID() };
  const send = (input: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1/classes/${classroom.id}/raw-notes`, payload: input });
  try {
    const responses = await Promise.all([send(payload), send(payload)]);
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    expect((await send({ ...payload, body: "changed" })).statusCode).toBe(409);
    const events = await db.selectFrom("product_events").selectAll().where("class_id", "=", classroom.id).execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_name: "raw_note_created", entity_id: responses[0].json().rawNote.id });
  } finally { await app.close(); }
});

test("proposal decisions emit exclusive names once per committed item, including concurrent replay", async () => {
  const classroom = buildClass(); await db.insertInto("classes").values(classroom).execute();
  const app = await createApp({ db, authVerifier: fixedUserAuthVerifier(classroom.owner_user_id) });
  const now = new Date(); const noteId = randomUUID(); const jobId = randomUUID(); const runId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  await db.insertInto("raw_notes").values({ id: noteId, class_id: classroom.id, author_user_id: classroom.owner_user_id,
    body: "SYNTHETIC_NOTE", observed_at: now, note_type: "OBSERVATION", created_at: now }).execute();
  await db.insertInto("jobs").values({ id: jobId, kind: "STRUCTURE_RAW_NOTE", dedupe_key: jobId,
    payload: {}, status: "SUCCEEDED", run_after: now, created_at: now, updated_at: now }).execute();
  await db.insertInto("proposal_runs").values({ id: runId, class_id: classroom.id, raw_note_id: noteId, source_job_id: jobId,
    status: "READY", schema_version: "1", created_at: now, updated_at: now }).execute();
  await db.insertInto("proposal_items").values(ids.map((id, index) => ({ id, class_id: classroom.id,
    proposal_run_id: runId, item_type: "CREATE_CANONICAL_ISSUE" as const, status: "PENDING" as const,
    original_payload: { key: `issue${index}`, type: "CREATE_CANONICAL_ISSUE", label: `SYNTHETIC_ISSUE_${index}` }, created_at: now,
  }))).execute();
  const payload = { clientRequestId: randomUUID(), items: [
    { proposalItemId: ids[0], decision: "APPROVE" },
    { proposalItemId: ids[1], decision: "EDIT_AND_APPROVE", patch: { label: "SYNTHETIC_EDIT" } },
    { proposalItemId: ids[2], decision: "REJECT" },
  ] };
  const send = (input: Record<string, unknown>) => app.inject({ method: "POST",
    url: `/api/v1/classes/${classroom.id}/proposal-runs/${runId}/decisions`, payload: input });
  try {
    const replies = await Promise.all([send(payload), send(payload)]);
    expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200]);
    expect((await send({ ...payload, clientRequestId: randomUUID() })).statusCode).toBe(409);
    const events = await db.selectFrom("product_events").selectAll().where("class_id", "=", classroom.id).execute();
    expect(events.map((event) => [event.entity_id, event.event_name]).sort()).toEqual([
      [ids[0], "proposal_item_approved"], [ids[1], "proposal_item_edited"], [ids[2], "proposal_item_rejected"],
    ].sort());
    expect((await getValidationMetrics(db, classroom.owner_user_id)).proposalDecisions).toEqual({ approved: 1, edited: 1, rejected: 1 });
  } finally { await app.close(); }
});
