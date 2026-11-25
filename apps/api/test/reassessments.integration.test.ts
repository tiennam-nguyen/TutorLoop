import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalIssueDetailDtoSchema, canonicalIssueListDtoSchema, classOverviewDtoSchema, interventionDtoSchema,
  reassessmentDtoSchema, reassessmentDueQueueDtoSchema, studentOverviewDtoSchema,
} from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { anonymousAuthVerifier, fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
const teacherId = randomUUID();
const dueAt = "2026-11-20T07:00:00.123Z";
let clock: Date;

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
  const options = { db, authVerifier: fixedUserAuthVerifier(teacherId), now: () => clock };
  app = await createApp(options);
}, 120_000);

beforeEach(() => {
  clock = new Date("2026-11-20T07:00:00.122Z");
});

afterAll(async () => {
  try {
    await app?.close();
    await db?.destroy();
  } finally {
    await postgres?.stop();
  }
});

async function seedClass(owner = teacherId) {
  const classroom = { ...buildClass(), owner_user_id: owner, timezone: "America/New_York" };
  const root = { ...buildCanonicalIssue(classroom.id), label: "Fractions" };
  const canonical = buildCanonicalIssue(classroom.id);
  const unrelated = buildCanonicalIssue(classroom.id);
  const students = [buildStudent(classroom.id), {
    ...buildStudent(classroom.id, "STU_002"), display_label: "Bình",
  }];
  const issues = students.map((student, index) => ({
    id: randomUUID(), class_id: classroom.id, student_id: student.id, canonical_issue_id: canonical.id,
    state: index === 0 ? "OPEN" as const : "IMPROVING" as const,
    created_at: student.created_at, updated_at: student.updated_at,
  }));
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("classes").values(classroom).execute();
    await trx.insertInto("canonical_issues").values([root, canonical, unrelated]).execute();
    await trx.insertInto("students").values(students).execute();
    await trx.insertInto("student_issues").values(issues).execute();
  });
  return { classroom, root, canonical, students, issueIds: issues.map(({ id }) => id) };
}

const classUrl = (id: string) => `/api/v1/classes/${id}`;
const reassessmentsUrl = (id: string) => `${classUrl(id)}/reassessments`;

function scheduleInput(studentIssueIds: string[]) {
  return { studentIssueIds, dueAt: "2026-11-20T14:00:00.123+07:00", clientRequestId: randomUUID() };
}

function post(url: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url, payload });
}

async function schedule(classId: string, studentIssueIds: string[], overrides?: Record<string, unknown>) {
  const response = await post(reassessmentsUrl(classId), { ...scheduleInput(studentIssueIds), ...overrides });
  expect(response.statusCode, response.body).toBe(201);
  return reassessmentDtoSchema.parse(response.json());
}

async function read(url: string) {
  const response = await app.inject(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<unknown>();
}

function issueRows(classId: string) {
  return db.selectFrom("student_issues").selectAll().where("class_id", "=", classId).orderBy("id").execute();
}

test("includes the exact due boundary and presents the root issue, Students, and prior Intervention", async () => {
  const { classroom, root, canonical, students, issueIds } = await seedClass();
  const middle = buildCanonicalIssue(classroom.id);
  await db.insertInto("canonical_issues").values({ ...middle, merged_into_id: root.id }).execute();
  await db.updateTable("canonical_issues").set({ merged_into_id: middle.id }).where("id", "=", canonical.id).execute();
  const interventionResponse = await post(`${classUrl(classroom.id)}/interventions`, {
    studentIssueIds: issueIds, occurredAt: "2026-11-19T14:00:00.654321+07:00",
    description: "Contrast common denominators", clientRequestId: randomUUID(),
  });
  expect(interventionResponse.statusCode, interventionResponse.body).toBe(201);
  const intervention = interventionDtoSchema.parse(interventionResponse.json());
  const reassessment = await schedule(classroom.id, issueIds, {
    title: "Short check", interventionIdByStudentIssueId: { [issueIds[0]!]: intervention.id },
  });
  const later = await schedule(classroom.id, issueIds, { dueAt: "2026-11-20T14:00:00.123001+07:00" });
  const url = reassessmentsUrl(classroom.id);
  expect(reassessment).toMatchObject({ status: "SCHEDULED", dueAt, version: 1, performedAt: null, completedAt: null });
  expect(await read(`${url}/${reassessment.id}`)).toEqual(reassessment);
  expect(await read(`${url}/due`)).toEqual({ due: [], needsResults: [] });
  const exact = await db.selectFrom("reassessments")
    .select(sql<boolean>`due_at = '2026-11-20 07:00:00.123001+00'::timestamptz`.as("matches"))
    .where("id", "=", later.id).executeTakeFirstOrThrow();
  expect(exact.matches).toBe(true);
  clock = new Date(dueAt);
  const queue = reassessmentDueQueueDtoSchema.parse(await read(`${url}/due`));
  expect(queue.due.map(({ id }) => id)).toEqual([reassessment.id]);
  expect(queue.due[0]).toMatchObject({
    title: "Short check", dueAt, class: { id: classroom.id, name: classroom.name },
    targets: expect.arrayContaining(students.map((student, index) => expect.objectContaining({
      studentIssueId: issueIds[index],
      targetStatus: "PENDING",
      student: { id: student.id, displayLabel: student.display_label, archivedAt: null },
      canonicalIssue: { id: root.id, label: root.label },
      intervention: index === 0 ? intervention : null,
    }))),
  });
  expect(queue.needsResults).toEqual([]);
});

test("Class issue counts are distinct and Student overview retains relevant upcoming, due and needs-results entries", async () => {
  const { classroom, canonical, students, issueIds } = await seedClass();
  const [an, binh] = students;
  const group = await schedule(classroom.id, issueIds);
  const overlap = await schedule(classroom.id, [issueIds[0]!]);
  const earlyPerformed = await schedule(classroom.id, [issueIds[0]!], { dueAt: "2026-12-20T07:00:00Z" });
  const classPath = classUrl(classroom.id);
  const url = reassessmentsUrl(classroom.id);
  const studentView = async (studentId: string) => studentOverviewDtoSchema.parse(
    await read(`${classPath}/students/${studentId}/overview`),
  );
  const dueCount = async () => {
    const list = canonicalIssueListDtoSchema.parse(await read(`${classPath}/issues`));
    const overview = classOverviewDtoSchema.parse(await read(`${classPath}/overview`));
    const detail = canonicalIssueDetailDtoSchema.parse(await read(`${classPath}/issues/${canonical.id}`));
    expect(overview.issues).toEqual(list);
    expect(detail.dueCount).toBe(list.find(({ id }) => id === canonical.id)?.dueCount);
    expect(detail.reassessments.map(({ id }) => id).sort()).toEqual([group.id, overlap.id, earlyPerformed.id].sort());
    return detail.dueCount;
  };
  expect(await dueCount()).toBe(0);
  expect((await studentView(an!.id)).reassessments.map(({ id }) => id).sort()).toEqual(
    [group.id, overlap.id, earlyPerformed.id].sort(),
  );
  expect((await studentView(binh!.id)).reassessments).toEqual([group]);
  clock = new Date(dueAt);
  expect(await dueCount()).toBe(2);
  const before = await issueRows(classroom.id);
  const performed = await post(`${url}/${group.id}/mark-performed`, { expectedVersion: 1 });
  expect(performed.statusCode, performed.body).toBe(200);
  expect(reassessmentDtoSchema.parse(performed.json())).toMatchObject({
    version: 2, status: "PERFORMED_PENDING_EVIDENCE", performedAt: dueAt, targets: group.targets,
  });
  const early = await post(`${url}/${earlyPerformed.id}/mark-performed`, { expectedVersion: 1 });
  expect(early.statusCode, early.body).toBe(200);
  const { due, needsResults } = reassessmentDueQueueDtoSchema.parse(await read(`${url}/due`));
  expect(due.map(({ id }) => id)).toEqual([overlap.id]);
  expect(needsResults.map(({ id }) => id)).toEqual([group.id, earlyPerformed.id]);
  expect(await dueCount()).toBe(1);
  expect((await studentView(binh!.id)).reassessments).toMatchObject([{
    id: group.id, status: "PERFORMED_PENDING_EVIDENCE", performedAt: dueAt,
  }]);
  expect(await issueRows(classroom.id)).toEqual(before);
  expect((await studentView(binh!.id)).transitions).toEqual([]);
});

test("rejects foreign and unrelated targets without consuming the request ID or exposing other Classes", async () => {
  const own = await seedClass();
  const foreign = await seedClass(randomUUID());
  const foreignApp = await createApp({ db, authVerifier: fixedUserAuthVerifier(foreign.classroom.owner_user_id) });
  const anonymous = await createApp({ db, authVerifier: anonymousAuthVerifier });
  try {
    const url = reassessmentsUrl(own.classroom.id);
    const foreignUrl = reassessmentsUrl(foreign.classroom.id);
    const foreignCreate = await foreignApp.inject({
      method: "POST", url: foreignUrl, payload: scheduleInput(foreign.issueIds),
    });
    expect(foreignCreate.statusCode, foreignCreate.body).toBe(201);
    const other = reassessmentDtoSchema.parse(foreignCreate.json());
    const input = scheduleInput([own.issueIds[0]!, foreign.issueIds[0]!]);
    expect((await post(url, input)).statusCode).toBe(404);
    expect(await db.selectFrom("reassessments").select("id").where("class_id", "=", own.classroom.id).execute()).toEqual([]);
    const interventionResponse = await post(`${classUrl(own.classroom.id)}/interventions`, {
      studentIssueIds: [own.issueIds[1]!], occurredAt: "2026-11-19T14:00:00Z",
      description: "Prior help", clientRequestId: randomUUID(),
    });
    expect(interventionResponse.statusCode, interventionResponse.body).toBe(201);
    const intervention = interventionDtoSchema.parse(interventionResponse.json());
    const corrected = { ...input, studentIssueIds: [own.issueIds[0]!] };
    expect((await post(url, {
      ...corrected, interventionIdByStudentIssueId: { [own.issueIds[0]!]: intervention.id },
    })).statusCode).toBe(404);
    const created = await schedule(own.classroom.id, corrected.studentIssueIds, corrected);
    clock = new Date(dueAt);
    expect((await app.inject(`${foreignUrl}/due`)).statusCode).toBe(404);
    expect((await app.inject(`${url}/${other.id}`)).statusCode).toBe(404);
    expect((await post(`${url}/${other.id}/mark-performed`, { expectedVersion: 1 })).statusCode).toBe(404);
    expect((await anonymous.inject(`${url}/due`)).statusCode).toBe(401);
    expect((await anonymous.inject({ method: "POST", url, payload: corrected })).statusCode).toBe(401);
    expect((await app.inject({ method: "HEAD", url: `${url}/${created.id}` })).statusCode).toBe(404);
    const queue = reassessmentDueQueueDtoSchema.parse(await read(`${url}/due`));
    expect(queue.due.map(({ id }) => id)).toEqual([created.id]);
  } finally {
    await anonymous.close();
    await foreignApp.close();
  }
});

test("serializes concurrent creates and compares normalized input and Class for replay", async () => {
  const { classroom, issueIds } = await seedClass();
  const other = await seedClass();
  const url = reassessmentsUrl(classroom.id);
  const input = scheduleInput(issueIds);
  const replay = { ...input, title: null, notes: null, dueAt, studentIssueIds: [
    issueIds[1]!.toUpperCase(), issueIds[0]!, issueIds[0]!,
  ], interventionIdByStudentIssueId: {} };
  const responses = await Promise.all([post(url, input), post(url, replay)]);
  for (const response of responses) expect(response.statusCode, response.body).toBe(201);
  expect(responses[0]!.json()).toEqual(responses[1]!.json());
  for (const conflict of [
    await post(url, { ...input, dueAt: "2026-11-20T07:00:00.123001Z" }),
    await post(reassessmentsUrl(other.classroom.id), { ...input, studentIssueIds: other.issueIds }),
  ]) {
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  }
  expect(await db.selectFrom("reassessments").select("id").where("class_id", "=", classroom.id).execute())
    .toEqual([{ id: reassessmentDtoSchema.parse(responses[0]!.json()).id }]);
});

test("all-skipped stays incomplete and version checks serialize skips and cancellation", async () => {
  const { classroom, issueIds } = await seedClass();
  const before = await issueRows(classroom.id);
  const reassessment = await schedule(classroom.id, issueIds);
  const url = `${reassessmentsUrl(classroom.id)}/${reassessment.id}`;
  const skip = (issueId: string, expectedVersion: number, skipReason: string) =>
    post(`${url}/targets/${issueId}/skip`, { expectedVersion, skipReason });
  expect((await skip(issueIds[0]!, 1, "   ")).statusCode).toBe(400);
  expect((await skip(randomUUID(), 1, "Absent")).statusCode).toBe(404);
  const performed = await post(`${url}/mark-performed`, { expectedVersion: 1 });
  expect(performed.statusCode, performed.body).toBe(200);
  const firstAttempts = await Promise.all(issueIds.map((id) => skip(id, 2, "Absent")));
  expect(firstAttempts.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  const remaining = issueIds[firstAttempts.findIndex(({ statusCode }) => statusCode === 409)]!;
  const last = await skip(remaining, 3, "Absent");
  expect(last.statusCode, last.body).toBe(200);
  const skipped = reassessmentDtoSchema.parse(last.json());
  expect(skipped).toMatchObject({ version: 4, status: "PERFORMED_PENDING_EVIDENCE", completedAt: null });
  expect(skipped.targets.map(({ targetStatus, skipReason }) => ({ targetStatus, skipReason }))).toEqual(
    issueIds.map(() => ({ targetStatus: "SKIPPED", skipReason: "Absent" })),
  );
  expect((await post(`${url}/cancel`, { expectedVersion: 3 })).statusCode).toBe(409);
  const cancelled = await post(`${url}/cancel`, { expectedVersion: 4 });
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  expect(reassessmentDtoSchema.parse(cancelled.json())).toMatchObject({ version: 5, status: "CANCELLED" });
  expect((await post(`${url}/mark-performed`, { expectedVersion: 5 })).statusCode).toBe(400);
  expect((await skip(issueIds[0]!, 5, "Already cancelled")).statusCode).toBe(400);
  expect(await issueRows(classroom.id)).toEqual(before);
});

test("the final skip completes a performed Reassessment when a target already has evidence", async () => {
  const { classroom, issueIds } = await seedClass();
  const reassessment = await schedule(classroom.id, issueIds);
  const url = `${reassessmentsUrl(classroom.id)}/${reassessment.id}`;
  const performed = await post(`${url}/mark-performed`, { expectedVersion: 1 });
  expect(performed.statusCode, performed.body).toBe(200);
  // Seed the persisted result of evidence reconciliation, implemented in Task 20.
  await db.updateTable("reassessment_targets").set({ target_status: "EVIDENCED" })
    .where("reassessment_id", "=", reassessment.id).where("student_issue_id", "=", issueIds[0]!).execute();
  expect((await post(`${url}/targets/${issueIds[0]!}/skip`, { expectedVersion: 2, skipReason: "Absent" })).statusCode).toBe(400);
  clock = new Date(dueAt);
  const result = await post(`${url}/targets/${issueIds[1]!}/skip`, { expectedVersion: 2, skipReason: "Absent" });
  expect(result.statusCode, result.body).toBe(200);
  expect(reassessmentDtoSchema.parse(result.json())).toMatchObject({ status: "COMPLETED", completedAt: dueAt, version: 3 });
  expect((await post(`${url}/cancel`, { expectedVersion: 3 })).statusCode).toBe(400);

  const scheduled = await schedule(classroom.id, issueIds);
  const cancelScheduled = await post(`${reassessmentsUrl(classroom.id)}/${scheduled.id}/cancel`, { expectedVersion: 1 });
  expect(cancelScheduled.statusCode, cancelScheduled.body).toBe(200);
  expect(reassessmentDtoSchema.parse(cancelScheduled.json())).toMatchObject({ status: "CANCELLED", performedAt: null });
});

test("rejects new Reassessments targeting an archived Student or mixed batch while preserving retries and existing targets", async () => {
  const { classroom, students, issueIds } = await seedClass();
  const [active, archived] = students;
  const [activeIssue, archivedIssue] = issueIds;

  const existingInput = scheduleInput(issueIds);
  const existing = reassessmentDtoSchema.parse((await post(reassessmentsUrl(classroom.id), existingInput)).json());

  const archiveRes = await app.inject({
    method: "POST", url: `${classUrl(classroom.id)}/students/${archived!.id}/archive`, payload: { expectedVersion: 1 },
  });
  expect(archiveRes.statusCode, archiveRes.body).toBe(204);

  const retryRes = await post(reassessmentsUrl(classroom.id), existingInput);
  expect(retryRes.statusCode, retryRes.body).toBe(201);
  expect(retryRes.json()).toEqual(existing);

  const blockedId = randomUUID();
  for (const [ids, reqId] of [
    [[archivedIssue!], blockedId],
    [[activeIssue!, archivedIssue!], randomUUID()],
  ] as const) {
    const blocked = await post(reassessmentsUrl(classroom.id), { ...scheduleInput([...ids]), clientRequestId: reqId });
    expect(blocked.statusCode, blocked.body).toBe(404);
    expect(blocked.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  }
  expect(await db.selectFrom("reassessments").select("id").where("class_id", "=", classroom.id).execute())
    .toEqual([{ id: existing.id }]);

  const activeOnly = await post(reassessmentsUrl(classroom.id), { ...scheduleInput([activeIssue!]), clientRequestId: blockedId });
  expect(activeOnly.statusCode, activeOnly.body).toBe(201);

  clock = new Date(dueAt);
  const queue = reassessmentDueQueueDtoSchema.parse(await read(`${reassessmentsUrl(classroom.id)}/due`));
  const queuedExisting = queue.due.find(({ id }) => id === existing.id);
  expect(queuedExisting?.targets.map(({ student }) => student.id).sort())
    .toEqual([active!.id, archived!.id].sort());
  expect(queuedExisting?.targets.find(({ student }) => student.id === active!.id)?.student.archivedAt).toBeNull();
  expect(queuedExisting?.targets.find(({ student }) => student.id === archived!.id)?.student.archivedAt)
    .toEqual(expect.any(String));
  expect(studentOverviewDtoSchema.parse(await read(`${classUrl(classroom.id)}/students/${archived!.id}/overview`)).reassessments)
    .toEqual([existing]);
});

test("serializes concurrent archive and Reassessment schedule so schedule never commits after archive wins", async () => {
  const { classroom, students, issueIds } = await seedClass();
  const [targetStudent] = students;
  const [targetIssue] = issueIds;

  await sql`
    CREATE FUNCTION hold_reassessment_archive_lock() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = ${sql.lit(targetStudent!.id)}::uuid AND NEW.archived_at IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(2033);
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER hold_reassessment_archive_lock BEFORE UPDATE ON students
      FOR EACH ROW EXECUTE FUNCTION hold_reassessment_archive_lock();
  `.execute(db);

  try {
    await db.connection().execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(2033)`.execute(connection);
      let archivePromise: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
      let schedulePromise: Promise<Awaited<ReturnType<typeof post>>> | undefined;
      try {
        archivePromise = Promise.resolve(app.inject({
          method: "POST", url: `${classUrl(classroom.id)}/students/${targetStudent!.id}/archive`, payload: { expectedVersion: 1 },
        }));
        const deadline = Date.now() + 3_000;
        let archivePid: number | undefined;
        while (!archivePid && Date.now() < deadline) {
          const { rows } = await sql<{ pid: number }>`
            SELECT activity.pid FROM pg_stat_activity AS activity
            WHERE activity.datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(activity.pid))
          `.execute(connection);
          archivePid = rows[0]?.pid;
          if (!archivePid) await delay(20);
        }
        expect(archivePid).toBeDefined();

        schedulePromise = Promise.resolve(post(reassessmentsUrl(classroom.id), scheduleInput([targetIssue!])));
        let scheduleBlocked = false;
        const blockDeadline = Date.now() + 3_000;
        while (!scheduleBlocked && Date.now() < blockDeadline) {
          const { rows } = await sql<{ blocked: boolean }>`
            SELECT EXISTS(
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${archivePid!} = ANY(pg_blocking_pids(pid))
            ) AS blocked
          `.execute(connection);
          scheduleBlocked = rows[0]!.blocked;
          if (!scheduleBlocked) await delay(20);
        }
        expect(scheduleBlocked).toBe(true);
      } finally {
        await sql`SELECT pg_advisory_unlock(2033)`.execute(connection);
      }
      const [archiveRes, scheduleRes] = await Promise.all([archivePromise!, schedulePromise!]);
      expect(archiveRes.statusCode, archiveRes.body).toBe(204);
      expect(scheduleRes.statusCode, scheduleRes.body).toBe(404);
      expect(scheduleRes.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(await db.selectFrom("reassessments").select("id").where("class_id", "=", classroom.id).execute()).toEqual([]);
    });
  } finally {
    await sql`
      DROP TRIGGER hold_reassessment_archive_lock ON students;
      DROP FUNCTION hold_reassessment_archive_lock();
    `.execute(db);
  }
}, 15_000);
