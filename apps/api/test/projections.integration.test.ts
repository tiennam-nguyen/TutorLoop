import { randomUUID } from "node:crypto";
import {
  canonicalIssueDetailDtoSchema, canonicalIssueListDtoSchema, classOverviewDtoSchema, createRawNoteResponseSchema,
  studentOverviewDtoSchema,
} from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { insertClass } from "@tutorloop/db/repositories/classes";
import { insertProposalEvidence } from "@tutorloop/db/repositories/evidence";
import { appendStudentIssueTransition, insertCanonicalIssue, insertStudentIssue } from "@tutorloop/db/repositories/issues";
import { exactTimestamptz, insertRawNote } from "@tutorloop/db/repositories/raw-notes";
import { insertStudent } from "@tutorloop/db/repositories/students";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { anonymousAuthVerifier, fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
let fixture: Awaited<ReturnType<typeof seed>>;
const teacherId = randomUUID();
const secondTeacherId = randomUUID();

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherId) });
  fixture = await seed();
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
    await db?.destroy();
  } finally {
    await postgres?.stop();
  }
});

function seed() {
  return db.transaction().execute(async (trx) => {
    const classroom = await insertClass(trx, {
      ...buildClass(), owner_user_id: teacherId, client_request_id: randomUUID(), create_input_hash: "fixture",
    });
    const classId = classroom.id;
    const otherClass = await insertClass(trx, {
      ...buildClass(), owner_user_id: secondTeacherId, client_request_id: randomUUID(), create_input_hash: "fixture",
    });
    const now = new Date("2026-11-20T07:00:00Z");
    async function addStudent(studentClassId: string, alias: string, label: string, archivedAt: Date | null = null) {
      return insertStudent(trx, {
        ...buildStudent(studentClassId, alias), display_label: label, archived_at: archivedAt,
        client_request_id: randomUUID(), create_input_hash: "fixture",
      });
    }
    const an = await addStudent(classId, "STU_001", "An");
    const binh = await addStudent(classId, "STU_002", "Bình");
    const chi = await addStudent(classId, "STU_003", "Chi", now);
    const otherStudent = await addStudent(otherClass.id, "STU_001", "Private");
    const canonical = await insertCanonicalIssue(trx, buildCanonicalIssue(classId));
    const resolved = await insertCanonicalIssue(trx, { ...buildCanonicalIssue(classId), label: "Equivalent fractions" });
    const unused = await insertCanonicalIssue(trx, { ...buildCanonicalIssue(classId), label: "Subtracting fractions" });
    const otherIssue = await insertCanonicalIssue(trx, buildCanonicalIssue(otherClass.id));

    async function addIssue(
      studentId: string, canonicalIssueId: string, state: "OPEN" | "IMPROVING" | "RESOLVED_FOR_NOW", manifestation: string,
    ) {
      const id = randomUUID();
      await insertStudentIssue(trx, {
        id, class_id: classId, student_id: studentId, canonical_issue_id: canonicalIssueId,
        state, manifestation, created_at: now, updated_at: now,
      });
      return id;
    }
    const anIssue = await addIssue(an.id, canonical.id, "OPEN", "Compares numerators alone");
    const binhIssue = await addIssue(binh.id, canonical.id, "IMPROVING", "Uses the larger denominator as the larger value");
    const chiIssue = await addIssue(chi.id, canonical.id, "OPEN", "Inverts the comparison");
    const anResolvedIssue = await addIssue(an.id, resolved.id, "RESOLVED_FOR_NOW", "Now finds a common factor");
    const rawNoteId = randomUUID();
    await insertRawNote(trx, {
      id: rawNoteId, class_id: classId, author_user_id: teacherId, note_type: "OBSERVATION", body: "Original Raw Note",
      client_request_id: randomUUID(), observed_at: "2026-11-20T07:00:00.123455Z", created_at: now,
    });
    async function addEvidence(studentId: string, issueId: string | null, observedAt?: string, createdAt?: string) {
      const evidence = await insertProposalEvidence(trx, {
        id: randomUUID(), class_id: classId, student_id: studentId, student_issue_id: issueId,
        raw_note_id: rawNoteId, observation_text: "Observed in class", approved_by_user_id: teacherId,
        created_at: now,
      }, observedAt);
      if (createdAt) {
        await trx.updateTable("evidence_events").set({ created_at: exactTimestamptz(createdAt) })
          .where("id", "=", evidence.id).execute();
      }
      return evidence.id;
    }
    const laterObserved = await addEvidence(an.id, anIssue, "2026-11-20T07:00:00.123456Z");
    const laterCreated = await addEvidence(an.id, anIssue, undefined, "2026-11-20T07:00:00.000002Z");
    const first = await addEvidence(an.id, anIssue, undefined, "2026-11-20T07:00:00.000001Z");
    const issueFree = await addEvidence(an.id, null, "2026-11-20T07:01:00.987654Z");
    const binhEvidence = await addEvidence(binh.id, binhIssue);
    const chiEvidence = await addEvidence(chi.id, chiIssue);
    await appendStudentIssueTransition(trx, {
      class_id: classId, student_issue_id: anResolvedIssue, from_state: "IMPROVING", to_state: "RESOLVED_FOR_NOW",
      evidence_event_id: first, reason: "Independent practice", actor_user_id: teacherId, created_at: now,
    });
    return {
      classroom, an, binh, chi, canonical, resolved, unused, otherClass, otherStudent, otherIssue,
      anIssue, binhIssue, chiIssue, anResolvedIssue, rawNoteId, first, laterCreated, laterObserved, issueFree,
      binhEvidence, chiEvidence,
    };
  });
}

function path(suffix: string) {
  return `/api/v1/classes/${fixture.classroom.id}${suffix}`;
}

async function read(url: string) {
  const response = await app.inject(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<unknown>();
}

test("Class overview and issue list report matching state counts for distinct active Students", async () => {
  const { classroom, an, binh, canonical, resolved, unused } = fixture;
  const overview = classOverviewDtoSchema.parse(await read(path("/overview")));
  expect(overview).toMatchObject({ id: classroom.id, name: classroom.name, timezone: "UTC" });
  expect(overview.students.map((student) => student.id).sort()).toEqual([an.id, binh.id].sort());
  const summaries = canonicalIssueListDtoSchema.parse(await read(path("/issues")));
  expect(overview.issues).toEqual(summaries);
  expect(summaries).toHaveLength(3);
  expect(summaries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: canonical.id, countsByState: { OPEN: 1, IMPROVING: 1, RESOLVED_FOR_NOW: 0 }, affectedStudents: 2, dueCount: 0,
    }),
    expect.objectContaining({
      id: resolved.id, countsByState: { OPEN: 0, IMPROVING: 0, RESOLVED_FOR_NOW: 1 }, affectedStudents: 1, dueCount: 0,
    }),
    expect.objectContaining({
      id: unused.id, countsByState: { OPEN: 0, IMPROVING: 0, RESOLVED_FOR_NOW: 0 }, affectedStudents: 0, dueCount: 0,
    }),
  ]));
});

test("Class issue detail preserves each active Student manifestation and traceable Evidence links", async () => {
  const { an, anIssue, binh, binhIssue, canonical, first, laterCreated, laterObserved, binhEvidence, rawNoteId } = fixture;
  const detail = canonicalIssueDetailDtoSchema.parse(await read(path(`/issues/${canonical.id}`)));
  const summaries = canonicalIssueListDtoSchema.parse(await read(path("/issues")));
  expect(detail).toMatchObject(summaries.find((issue) => issue.id === canonical.id)!);
  expect(detail).toMatchObject({ interventions: [], reassessments: [] });
  expect(detail.studentIssues).toHaveLength(2);
  expect(detail.studentIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: anIssue, manifestation: "Compares numerators alone", student: expect.objectContaining({ id: an.id }),
      evidenceIds: [first, laterCreated, laterObserved],
    }),
    expect.objectContaining({
      id: binhIssue, manifestation: "Uses the larger denominator as the larger value",
      student: expect.objectContaining({ id: binh.id }), evidenceIds: [binhEvidence],
    }),
  ]));
  const student = studentOverviewDtoSchema.parse(await read(path(`/students/${an.id}/overview`)));
  expect(detail.studentIssues.find((issue) => issue.id === anIssue)).toMatchObject({
    id: student.activeStudentIssues[0].id, version: student.activeStudentIssues[0].version,
    manifestation: student.activeStudentIssues[0].manifestation,
  });
  expect(student.evidence.find((event) => event.id === first)).toMatchObject({ rawNoteId, studentIssueId: anIssue });
  expect(await read(path(`/raw-notes/${rawNoteId}`))).toMatchObject({ rawNote: { id: rawNoteId } });
});

test("Student overview separates current issues and retains chronologically ordered Evidence and transitions", async () => {
  const { an, anIssue, anResolvedIssue, canonical, resolved, first, laterCreated, laterObserved, issueFree, rawNoteId } = fixture;
  const overview = studentOverviewDtoSchema.parse(await read(path(`/students/${an.id}/overview`)));
  expect(overview).toMatchObject({
    student: { id: an.id, displayLabel: "An", archivedAt: null },
    activeStudentIssues: [{ id: anIssue, canonicalIssue: { id: canonical.id } }],
    resolvedStudentIssues: [{ id: anResolvedIssue, canonicalIssue: { id: resolved.id } }],
    transitions: [{
      studentIssueId: anResolvedIssue, fromState: "IMPROVING", toState: "RESOLVED_FOR_NOW", evidenceEventId: first,
      reason: "Independent practice",
    }],
    interventions: [],
    reassessments: [],
  });
  expect(overview.evidence.map(({ id, observedAt, studentIssueId, rawNoteId: source }) => [id, observedAt, studentIssueId, source]))
    .toEqual([
      [first, "2026-11-20T07:00:00.123455Z", anIssue, rawNoteId],
      [laterCreated, "2026-11-20T07:00:00.123455Z", anIssue, rawNoteId],
      [laterObserved, "2026-11-20T07:00:00.123456Z", anIssue, rawNoteId],
      [issueFree, "2026-11-20T07:01:00.987654Z", null, rawNoteId],
    ]);
  expect(overview.evidence.slice(0, 2).map(({ createdAt }) => createdAt)).toEqual([
    "2026-11-20T07:00:00.000001Z", "2026-11-20T07:00:00.000002Z",
  ]);
});

test("an archived Student retains their own issue, Evidence, and original identity in history", async () => {
  const { chi, chiIssue, chiEvidence, rawNoteId } = fixture;
  const overview = studentOverviewDtoSchema.parse(await read(path(`/students/${chi.id}/overview`)));
  expect(overview).toMatchObject({
    student: { id: chi.id, displayLabel: "Chi", archivedAt: "2026-11-20T07:00:00.000Z" },
    activeStudentIssues: [{ id: chiIssue, studentId: chi.id }],
    evidence: [{ id: chiEvidence, studentId: chi.id, rawNoteId }],
  });
});

test("projection routes require authentication and do not expose implicit HEAD", async () => {
  const { an, canonical } = fixture;
  const anonymous = await createApp({ db, authVerifier: anonymousAuthVerifier });
  try {
    for (const url of [path("/overview"), path("/issues"), path(`/issues/${canonical.id}`), path(`/students/${an.id}/overview`)]) {
      const unauthorized = await anonymous.inject(url);
      expect(unauthorized.statusCode, unauthorized.body).toBe(401);
      expect(unauthorized.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
      expect((await app.inject({ method: "HEAD", url })).statusCode).toBe(404);
    }
  } finally {
    await anonymous.close();
  }
});

test("unknown, malformed, and out-of-scope projection resources return 404", async () => {
  const { otherClass, otherIssue, otherStudent } = fixture;
  for (const url of [
    `/api/v1/classes/${otherClass.id}/overview`,
    `/api/v1/classes/${otherClass.id}/issues`,
    `/api/v1/classes/${otherClass.id}/issues/${otherIssue.id}`,
    `/api/v1/classes/${otherClass.id}/students/${otherStudent.id}/overview`,
    path(`/issues/${otherIssue.id}`), path(`/students/${otherStudent.id}/overview`),
    path(`/issues/${randomUUID()}`), path(`/students/${randomUUID()}/overview`),
    path("/issues/invalid"), path("/students/invalid/overview"), "/api/v1/classes/invalid/overview",
  ]) {
    const response = await app.inject(url);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  }
});

test("Student Evidence preserves the UTC calendar day and microseconds of a year-zero leap day", async () => {
  const { classroom, binh } = fixture;
  const classId = classroom.id;
  const createdAt = new Date("2026-11-20T07:00:00Z");
  const observedAt = "0000-02-29T09:00:00.123456Z";
  const captured = await app.inject({
    method: "POST", url: path("/raw-notes"),
    payload: { body: "Historical record", observedAt, noteType: "OBSERVATION", clientRequestId: randomUUID() },
  });
  expect(captured.statusCode, captured.body).toBe(201);
  const { rawNote } = createRawNoteResponseSchema.parse(captured.json());
  const evidence = await db.transaction().execute((trx) => insertProposalEvidence(trx, {
    id: randomUUID(), class_id: classId, student_id: binh.id, raw_note_id: rawNote.id,
    observation_text: "Historical observation", approved_by_user_id: teacherId, created_at: createdAt,
  }));
  const stored = await db.selectFrom("evidence_events")
    .select(sql<boolean>`observed_at = '0001-02-29 09:00:00.123456+00 BC'::timestamptz`.as("exact"))
    .where("id", "=", evidence.id).executeTakeFirstOrThrow();
  expect(stored.exact).toBe(true);
  const overview = studentOverviewDtoSchema.parse(await read(path(`/students/${binh.id}/overview`)));
  expect(rawNote.observedAt).toBe(observedAt);
  expect(overview.evidence.find((event) => event.id === evidence.id)).toMatchObject({ observedAt, rawNoteId: rawNote.id });
});
