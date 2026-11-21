import { randomUUID } from "node:crypto";
import { createRawNoteResponseSchema, rawNoteDetailDtoSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { anonymousAuthVerifier, fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
let teacherId: string;

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
}, 120_000);

beforeEach(async () => {
  teacherId = randomUUID();
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherId) });
});

afterEach(async () => { await app?.close(); });
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await postgres?.stop();
  }
});

async function addClass(owner = teacherId) {
  const classroom = { ...buildClass(), owner_user_id: owner };
  await db.insertInto("classes").values(classroom).execute();
  return classroom.id;
}

async function addReassessment(classId: string) {
  const id = randomUUID();
  const now = new Date();
  await db.insertInto("reassessments").values({
    id, class_id: classId, status: "PERFORMED_PENDING_EVIDENCE", due_at: now, performed_at: now,
    created_at: now, updated_at: now, created_by_user_id: teacherId,
  }).execute();
  return id;
}

function observation() {
  return {
    body: "  An lại sai dấu khi chuyển vế.\n",
    observedAt: "2026-11-20T14:00:00.123456+07:00",
    noteType: "OBSERVATION",
    clientRequestId: randomUUID(),
  };
}

function notesUrl(classId: string) {
  return `/api/v1/classes/${classId}/raw-notes`;
}

function capture(classId: string, payload: Record<string, unknown> = observation()) {
  return app.inject({ method: "POST", url: notesUrl(classId), payload });
}

async function readClassNotes(classId: string) {
  return db.selectFrom("raw_notes").selectAll().where("class_id", "=", classId).execute();
}

async function readClassJobs(classId: string) {
  return db.selectFrom("jobs").selectAll().where(sql<string>`payload ->> 'classId'`, "=", classId).execute();
}

test("persists the unedited note and a queued job without any AI dependency", async () => {
  const classId = await addClass();
  const input = observation();
  const response = await capture(classId, input);
  expect(response.statusCode).toBe(201);
  const { rawNote, processing } = createRawNoteResponseSchema.parse(response.json());
  expect(rawNote).toMatchObject({
    classId, body: input.body, noteType: "OBSERVATION", observedAt: "2026-11-20T07:00:00.123456Z",
    reassessmentId: null, voidedAt: null, voidReason: null,
  });
  expect(await readClassNotes(classId)).toMatchObject([{
    id: rawNote.id, author_user_id: teacherId, client_request_id: input.clientRequestId, body: input.body,
  }]);
  const storedInstant = await db.selectFrom("raw_notes")
    .select(sql<boolean>`observed_at = timestamptz '2026-11-20 07:00:00.123456+00'`.as("exact"))
    .where("id", "=", rawNote.id).executeTakeFirstOrThrow();
  expect(storedInstant.exact).toBe(true);
  expect(await readClassJobs(classId)).toMatchObject([{
    id: processing.jobId, kind: "STRUCTURE_RAW_NOTE", status: "QUEUED", attempts: 0,
    dedupe_key: `structure-raw-note:${rawNote.id}:initial`,
    payload: { rawNoteId: rawNote.id, classId },
  }]);
  const url = `${notesUrl(classId)}/${rawNote.id}`;
  expect(rawNoteDetailDtoSchema.parse((await app.inject(url)).json()))
    .toEqual({ rawNote, processing: { status: "QUEUED" } });
  expect((await app.inject({ method: "HEAD", url })).statusCode).toBe(404);
});

test("rolls back the note if PostgreSQL refuses the initial job insert", async () => {
  const classId = await addClass();
  await sql`
    ALTER TABLE jobs ADD CONSTRAINT reject_test_class_jobs CHECK (
      (payload ->> 'classId')::uuid <> ${sql.lit(classId)}::uuid
    )
  `.execute(db);
  try {
    const response = await capture(classId);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(await readClassNotes(classId)).toEqual([]);
    expect(await readClassJobs(classId)).toEqual([]);
  } finally {
    await sql`ALTER TABLE jobs DROP CONSTRAINT reject_test_class_jobs`.execute(db);
  }
});

test("replays concurrent captures and equivalent UTC offsets with the original note and job IDs", async () => {
  const classId = await addClass();
  const input = observation();
  const [initial, competing] = await Promise.all([capture(classId, input), capture(classId, input)]);
  expect(initial.statusCode).toBe(201);
  expect(competing.statusCode).toBe(201);
  expect(competing.json()).toEqual(initial.json());
  const retry = await capture(classId, { ...input, observedAt: "2026-11-20T07:00:00.123456000Z" });
  expect(retry.statusCode).toBe(201);
  expect(retry.json()).toEqual(initial.json());
  expect(await readClassNotes(classId)).toHaveLength(1);
  expect(await readClassJobs(classId)).toHaveLength(1);
});

test("preserves valid UTC year zero when applying the supplied offset", async () => {
  const classId = await addClass();
  const longAgo = await capture(classId, { ...observation(), observedAt: "0001-01-01T01:00:00+02:00" });
  expect(longAgo.statusCode).toBe(201);
  expect(createRawNoteResponseSchema.parse(longAgo.json()).rawNote.observedAt)
    .toBe("0000-12-31T23:00:00.000Z");
});

test("rejects changed capture fields on an existing request key", async () => {
  const classId = await addClass();
  const reassessmentId = await addReassessment(classId);
  const input = { ...observation(), noteType: "REASSESSMENT_OUTCOME", reassessmentId };
  expect((await capture(classId, input)).statusCode).toBe(201);
  const otherReassessment = await addReassessment(classId);
  for (const payload of [
    { ...input, body: "Different observation" },
    { ...input, observedAt: "2026-11-20T14:00:00.123457+07:00" },
    { ...input, reassessmentId: otherReassessment },
    { ...input, noteType: "OBSERVATION", reassessmentId: null },
  ]) {
    const response = await capture(classId, payload);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  }
  expect(await readClassNotes(classId)).toMatchObject([{ reassessment_id: reassessmentId }]);
  expect(await readClassJobs(classId)).toHaveLength(1);
});

test("never replays an author-global request key into another Class", async () => {
  const classA = await addClass();
  const classB = await addClass();
  const input = observation();
  const responses = await Promise.all([capture(classA, input), capture(classB, input)]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  const winner = createRawNoteResponseSchema.parse(responses.find((response) => response.statusCode === 201)?.json());
  const losingClass = winner.rawNote.classId === classA ? classB : classA;
  const conflict = responses.find((response) => response.statusCode === 409)?.json();
  expect(conflict).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  expect(JSON.stringify(conflict)).not.toContain(winner.rawNote.id);
  expect(await readClassNotes(losingClass)).toEqual([]);
  expect(await readClassJobs(losingClass)).toEqual([]);
});

test("validates the note type and reassessment relationship before writing", async () => {
  const classId = await addClass();
  const reassessmentId = await addReassessment(classId);
  const foreignReassessment = await addReassessment(await addClass());
  const input = observation();
  for (const payload of [
    { ...input, reassessmentId },
    { ...input, noteType: "REASSESSMENT_OUTCOME" },
  ]) {
    const response = await capture(classId, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  }
  const response = await capture(classId, {
    ...input, noteType: "REASSESSMENT_OUTCOME", reassessmentId: foreignReassessment,
  });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(await readClassNotes(classId)).toEqual([]);
  expect(await readClassJobs(classId)).toEqual([]);
});

test("rejects unpersistable body text and timestamp precision at the request boundary", async () => {
  const classId = await addClass();
  const input = observation();
  for (const payload of [
    { ...input, body: "Invalid\u0000body" },
    { ...input, observedAt: "2026-11-20T14:00:00.1234567+07:00" },
    { ...input, observedAt: "9999-12-31T23:59:59-02:00" },
  ]) {
    const response = await capture(classId, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  }
  expect(await readClassNotes(classId)).toEqual([]);
  expect(await readClassJobs(classId)).toEqual([]);
});

test("rejects an isolated surrogate in the note body before writing", async () => {
  const classId = await addClass();
  const response = await capture(classId, { ...observation(), body: "Note\ud800" });
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(await readClassNotes(classId)).toEqual([]);
  expect(await readClassJobs(classId)).toEqual([]);
});

test("rejects an isolated surrogate in the void reason before changing the note", async () => {
  const classId = await addClass();
  const captured = await capture(classId);
  expect(captured.statusCode).toBe(201);
  const { rawNote } = createRawNoteResponseSchema.parse(captured.json());
  const response = await app.inject({
    method: "POST", url: `${notesUrl(classId)}/${rawNote.id}/void`, payload: { voidReason: "Mistake\udc00" },
  });
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(await readClassNotes(classId)).toMatchObject([{ voided_at: null, void_reason: null }]);
});

test("stores and exactly replays a note containing a valid emoji", async () => {
  const classId = await addClass();
  const input = { ...observation(), body: "Note \u{1f4dd}" };
  const response = await capture(classId, input);
  expect(response.statusCode).toBe(201);
  expect(createRawNoteResponseSchema.parse(response.json()).rawNote.body).toBe(input.body);
  expect(await readClassNotes(classId)).toMatchObject([{ body: input.body }]);
  const retry = await capture(classId, input);
  expect(retry.statusCode).toBe(201);
  expect(retry.json()).toEqual(response.json());
});

test("restricts capture, read, and void to the authenticated Class owner", async () => {
  const classId = await addClass();
  const differentClass = await addClass();
  const foreignClass = await addClass(randomUUID());
  const response = await capture(classId);
  expect(response.statusCode).toBe(201);
  const { rawNote } = createRawNoteResponseSchema.parse(response.json());
  const wrongUrl = `${notesUrl(differentClass)}/${rawNote.id}`;
  const missingUrl = `${notesUrl(differentClass)}/${randomUUID()}`;
  const [wrong, missing, wrongVoid, foreignCapture] = await Promise.all([
    app.inject(wrongUrl), app.inject(missingUrl),
    app.inject({ method: "POST", url: `${wrongUrl}/void`, payload: {} }),
    capture(foreignClass),
  ]);
  expect(wrong.statusCode).toBe(404);
  expect(wrong.json()).toEqual(missing.json());
  expect(wrongVoid.json()).toEqual(missing.json());
  expect(foreignCapture.statusCode).toBe(404);
  expect(await readClassNotes(foreignClass)).toEqual([]);
  expect(await readClassNotes(classId)).toMatchObject([{ voided_at: null }]);
  const anonymous = await createApp({ db, authVerifier: anonymousAuthVerifier });
  try {
    const noteUrl = `${notesUrl(classId)}/${rawNote.id}`;
    const attempts = await Promise.all([
      anonymous.inject({ method: "POST", url: notesUrl(classId), payload: observation() }),
      anonymous.inject(noteUrl),
      anonymous.inject({ method: "POST", url: `${noteUrl}/void`, payload: {} }),
    ]);
    expect(attempts.map((attempt) => attempt.statusCode)).toEqual([401, 401, 401]);
  } finally {
    await anonymous.close();
  }
});

test("void retains the note, initial job, and linked evidence", async () => {
  const classId = await addClass();
  const captured = await capture(classId);
  expect(captured.statusCode).toBe(201);
  const { rawNote, processing } = createRawNoteResponseSchema.parse(captured.json());
  const student = buildStudent(classId);
  await db.insertInto("students").values(student).execute();
  const evidenceId = randomUUID();
  await db.insertInto("evidence_events").values({
    id: evidenceId, class_id: classId, student_id: student.id, raw_note_id: rawNote.id,
    observation_text: "Retained", observed_at: new Date(), provenance: "TEACHER_DIRECT",
    approved_by_user_id: teacherId, created_at: new Date(),
  }).execute();
  const url = `${notesUrl(classId)}/${rawNote.id}`;
  const invalid = await app.inject({ method: "POST", url: `${url}/void`, payload: { voidReason: "No\u0000" } });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(await readClassNotes(classId)).toMatchObject([{ voided_at: null, void_reason: null }]);
  const voided = await app.inject({ method: "POST", url: `${url}/void`, payload: { voidReason: "Mistaken entry" } });
  expect(voided.statusCode).toBe(200);
  const detail = rawNoteDetailDtoSchema.parse(voided.json());
  expect(detail.rawNote).toEqual({ ...rawNote, voidedAt: expect.any(String), voidReason: "Mistaken entry" });
  const retry = await app.inject({ method: "POST", url: `${url}/void` });
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toEqual(detail);
  expect((await app.inject(url)).json()).toEqual(detail);
  expect(await readClassJobs(classId)).toMatchObject([{ id: processing.jobId, status: "QUEUED" }]);
  expect(await db.selectFrom("evidence_events").select("raw_note_id").where("id", "=", evidenceId)
    .executeTakeFirst()).toEqual({ raw_note_id: rawNote.id });
});

test("manual reprocessing rejects an active job and scopes the note to its owned Class", async () => {
  const classId = await addClass();
  const differentClass = await addClass();
  const captured = await capture(classId);
  const { rawNote } = createRawNoteResponseSchema.parse(captured.json());
  const reprocess = (id: string) => app.inject({
    method: "POST", url: `${notesUrl(id)}/${rawNote.id}/reprocess`, payload: { clientRequestId: randomUUID() },
  });
  const busy = await reprocess(classId);
  expect(busy.statusCode).toBe(409);
  expect(busy.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  const wrongClass = await reprocess(differentClass);
  expect(wrongClass.statusCode).toBe(404);
  expect(wrongClass.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
});
