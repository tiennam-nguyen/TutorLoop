import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalIssueDetailDtoSchema, interventionDtoSchema, studentOverviewDtoSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { anonymousAuthVerifier, fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
const teacherId = randomUUID();

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherId) });
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
    await db?.destroy();
  } finally {
    await postgres?.stop();
  }
});

async function seedClass(count: number, owner = teacherId) {
  const classroom = { ...buildClass(), owner_user_id: owner };
  const canonical = buildCanonicalIssue(classroom.id);
  const unrelated = buildCanonicalIssue(classroom.id);
  const students = Array.from({ length: count }, (_, index) => buildStudent(classroom.id, `STU_${index + 1}`));
  const states = ["OPEN", "IMPROVING", "RESOLVED_FOR_NOW"] as const;
  const issues = students.map((student, index) => ({
    id: randomUUID(), class_id: classroom.id, student_id: student.id, canonical_issue_id: canonical.id,
    state: states[index % states.length]!, created_at: student.created_at, updated_at: student.updated_at,
  }));
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("classes").values(classroom).execute();
    await trx.insertInto("canonical_issues").values([canonical, unrelated]).execute();
    await trx.insertInto("students").values(students).execute();
    await trx.insertInto("student_issues").values(issues).execute();
  });
  return { id: classroom.id, canonical, unrelated, students, issueIds: issues.map((issue) => issue.id) };
}

const classUrl = (id: string) => `/api/v1/classes/${id}`;
const interventionsUrl = (id: string) => `${classUrl(id)}/interventions`;

function groupInput(studentIssueIds: string[]) {
  return {
    description: "Practice with contrasting fractions",
    occurredAt: "2026-11-20T14:00:00.123456+07:00",
    studentIssueIds,
    clientRequestId: randomUUID(),
  };
}

function record(classId: string, payload: Partial<ReturnType<typeof groupInput>>) {
  return app.inject({ method: "POST", url: interventionsUrl(classId), payload });
}

async function read(url: string) {
  const response = await app.inject(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<unknown>();
}

function issueRows(classId: string) {
  return db.selectFrom("student_issues").selectAll().where("class_id", "=", classId).orderBy("id").execute();
}

async function expectNoInterventions(classId: string) {
  expect(await db.selectFrom("interventions").select("id").where("class_id", "=", classId).execute()).toEqual([]);
  expect(await db.selectFrom("intervention_targets").select("intervention_id").where("class_id", "=", classId).execute()).toEqual([]);
}

test("records one group intervention in six Student histories and the Canonical Issue without changing issue state", async () => {
  const fixture = await seedClass(7);
  const issueIds = fixture.issueIds.slice(0, 6);
  const input = groupInput(issueIds);
  const before = await issueRows(fixture.id);
  const created = await record(fixture.id, input);
  expect(created.statusCode, created.body).toBe(201);
  const intervention = interventionDtoSchema.parse(created.json());
  expect(intervention).toMatchObject({
    classId: fixture.id, description: input.description, occurredAt: "2026-11-20T07:00:00.123456Z",
    studentIssueIds: [...issueIds].sort(),
  });
  expect(await read(`${interventionsUrl(fixture.id)}/${intervention.id}`)).toEqual(intervention);
  expect(await db.selectFrom("interventions").select(["id", "created_by_user_id"])
    .where("class_id", "=", fixture.id).execute()).toEqual([{ id: intervention.id, created_by_user_id: teacherId }]);
  expect(await db.selectFrom("intervention_targets").select(["intervention_id", "student_issue_id"])
    .where("class_id", "=", fixture.id).orderBy("student_issue_id").execute()).toEqual(
    [...issueIds].sort().map((id) => ({ intervention_id: intervention.id, student_issue_id: id })),
  );

  const overviews = await Promise.all(fixture.students.map(async (student) =>
    studentOverviewDtoSchema.parse(await read(`${classUrl(fixture.id)}/students/${student.id}/overview`))));
  expect(overviews.map((overview) => overview.interventions)).toEqual([
    [intervention], [intervention], [intervention], [intervention], [intervention], [intervention], [],
  ]);
  const issueUrl = `${classUrl(fixture.id)}/issues`;
  expect(canonicalIssueDetailDtoSchema.parse(await read(`${issueUrl}/${fixture.canonical.id}`)).interventions).toEqual([intervention]);
  expect(canonicalIssueDetailDtoSchema.parse(await read(`${issueUrl}/${fixture.unrelated.id}`)).interventions).toEqual([]);
  expect(await issueRows(fixture.id)).toEqual(before);
  expect(await db.selectFrom("student_issue_transitions").select("id").where("class_id", "=", fixture.id).execute()).toEqual([]);
});

test("keeps Intervention history after Student archive and orders by the exact instructional instant", async () => {
  const fixture = await seedClass(1);
  const laterResponse = await record(fixture.id, groupInput(fixture.issueIds));
  expect(laterResponse.statusCode, laterResponse.body).toBe(201);
  const earlierResponse = await record(fixture.id, {
    ...groupInput(fixture.issueIds), occurredAt: "2026-11-20T07:00:00.123455Z",
  });
  expect(earlierResponse.statusCode, earlierResponse.body).toBe(201);
  const earlier = interventionDtoSchema.parse(earlierResponse.json());
  const later = interventionDtoSchema.parse(laterResponse.json());
  const studentId = fixture.students[0]!.id;
  await db.updateTable("students").set({ archived_at: new Date() }).where("id", "=", studentId).execute();
  const issue = canonicalIssueDetailDtoSchema.parse(await read(`${classUrl(fixture.id)}/issues/${fixture.canonical.id}`));
  const student = studentOverviewDtoSchema.parse(await read(`${classUrl(fixture.id)}/students/${studentId}/overview`));
  expect(issue.studentIssues).toEqual([]);
  expect(issue.interventions).toEqual([earlier, later]);
  expect(student.interventions).toEqual([earlier, later]);
});

test("rejects cross-Class or unknown targets without persisting a partial Intervention", async () => {
  const fixture = await seedClass(1);
  const otherOwned = await seedClass(1);
  const otherTeacher = await seedClass(1, randomUUID());
  const input = groupInput(fixture.issueIds);
  for (const invalidTarget of [otherOwned.issueIds[0]!, otherTeacher.issueIds[0]!, randomUUID()]) {
    const response = await record(fixture.id, { ...input, studentIssueIds: [...fixture.issueIds, invalidTarget] });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  }
  await expectNoInterventions(fixture.id);
  const corrected = await record(fixture.id, input);
  expect(corrected.statusCode, corrected.body).toBe(201);
});

test("rejects missing targets and descriptions or instants PostgreSQL cannot preserve", async () => {
  const fixture = await seedClass(1);
  const input = groupInput(fixture.issueIds);
  for (const payload of [
    { ...input, studentIssueIds: [] }, { ...input, description: "  " }, { ...input, description: "Note\u0000" },
    { ...input, description: "Note\ud800" }, { ...input, occurredAt: "2026-11-20T14:00:00.1234567+07:00" },
    { ...input, occurredAt: "9999-12-31T23:59:59-02:00" }, { ...input, clientRequestId: undefined },
  ]) {
    const response = await record(fixture.id, payload);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  }
  await expectNoInterventions(fixture.id);
});

test("replays concurrent retries by normalized target set and exact instant, and rejects changed input", async () => {
  const fixture = await seedClass(2);
  const other = await seedClass(1);
  const input = groupInput(fixture.issueIds);
  const equivalent = {
    ...input,
    occurredAt: "2026-11-20T07:00:00.123456Z",
    studentIssueIds: [...fixture.issueIds, fixture.issueIds[0]!.toUpperCase()].reverse(),
  };
  const [created, retry] = await Promise.all([record(fixture.id, input), record(fixture.id, equivalent)]);
  for (const response of [created, retry]) expect(response.statusCode, response.body).toBe(201);
  expect(retry.json()).toEqual(created.json());
  for (const [classId, payload] of [
    [fixture.id, { ...input, description: "Other instructional activity" }],
    [fixture.id, { ...input, occurredAt: "2026-11-20T07:00:00.123457Z" }],
    [fixture.id, { ...input, studentIssueIds: fixture.issueIds.slice(0, 1) }],
    [other.id, { ...input, studentIssueIds: other.issueIds }],
  ] as const) {
    const response = await record(classId, payload);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(response.body).not.toContain(interventionDtoSchema.parse(created.json()).id);
  }
  await expectNoInterventions(other.id);
  expect(await db.selectFrom("interventions").select("id").where("class_id", "=", fixture.id).execute()).toHaveLength(1);
  expect(await db.selectFrom("intervention_targets").select("intervention_id").where("class_id", "=", fixture.id).execute()).toHaveLength(2);
});

test("scopes create and detail to an authenticated Class owner", async () => {
  const owned = await seedClass(1);
  const otherOwned = await seedClass(1);
  const foreignOwner = randomUUID();
  const foreign = await seedClass(1, foreignOwner);
  const foreignApp = await createApp({ db, authVerifier: fixedUserAuthVerifier(foreignOwner) });
  const anonymousApp = await createApp({ db, authVerifier: anonymousAuthVerifier });
  try {
    const created = await record(owned.id, groupInput(owned.issueIds));
    expect(created.statusCode, created.body).toBe(201);
    const { id } = interventionDtoSchema.parse(created.json());
    const ownDetail = `${interventionsUrl(owned.id)}/${id}`;
    const [wrongClass, unknown, foreignDetail, foreignPost, anonymousGet, anonymousPost, head] = await Promise.all([
      app.inject(`${interventionsUrl(otherOwned.id)}/${id}`), app.inject(`${interventionsUrl(otherOwned.id)}/${randomUUID()}`),
      foreignApp.inject(ownDetail), record(foreign.id, groupInput(foreign.issueIds)), anonymousApp.inject(ownDetail),
      anonymousApp.inject({ method: "POST", url: interventionsUrl(owned.id), payload: groupInput(owned.issueIds) }),
      app.inject({ method: "HEAD", url: ownDetail }),
    ]);
    expect(wrongClass.statusCode).toBe(404);
    expect(wrongClass.json()).toEqual(unknown.json());
    expect([foreignDetail.statusCode, foreignPost.statusCode, anonymousGet.statusCode, anonymousPost.statusCode, head.statusCode])
      .toEqual([404, 404, 401, 401, 404]);
    await expectNoInterventions(foreign.id);
  } finally {
    await foreignApp.close();
    await anonymousApp.close();
  }
});

test("rejects new Interventions targeting an archived Student or mixed active/archived batch while preserving retries", async () => {
  const fixture = await seedClass(2);
  const [active, archived] = fixture.students;
  const [activeIssue, archivedIssue] = fixture.issueIds;

  const priorInput = groupInput([activeIssue!, archivedIssue!]);
  const prior = await record(fixture.id, priorInput);
  expect(prior.statusCode, prior.body).toBe(201);
  const priorDto = interventionDtoSchema.parse(prior.json());

  const archiveRes = await app.inject({
    method: "POST", url: `${classUrl(fixture.id)}/students/${archived!.id}/archive`, payload: { expectedVersion: 1 },
  });
  expect(archiveRes.statusCode, archiveRes.body).toBe(204);

  const retryAfterArchive = await record(fixture.id, priorInput);
  expect(retryAfterArchive.statusCode, retryAfterArchive.body).toBe(201);
  expect(retryAfterArchive.json()).toEqual(priorDto);

  const singleBlockedId = randomUUID();
  for (const [ids, reqId] of [
    [[archivedIssue!], singleBlockedId],
    [[activeIssue!, archivedIssue!], randomUUID()],
  ] as const) {
    const blocked = await record(fixture.id, { ...groupInput([...ids]), clientRequestId: reqId });
    expect(blocked.statusCode, blocked.body).toBe(404);
    expect(blocked.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  }
  expect(await db.selectFrom("interventions").select("id").where("class_id", "=", fixture.id).execute()).toHaveLength(1);

  const activeOnly = await record(fixture.id, { ...groupInput([activeIssue!]), clientRequestId: singleBlockedId });
  expect(activeOnly.statusCode, activeOnly.body).toBe(201);
  expect(studentOverviewDtoSchema.parse(await read(`${classUrl(fixture.id)}/students/${active!.id}/overview`)).interventions)
    .toHaveLength(2);
  expect(studentOverviewDtoSchema.parse(await read(`${classUrl(fixture.id)}/students/${archived!.id}/overview`)).interventions)
    .toEqual([priorDto]);
});

test("serializes concurrent archive and Intervention create across lock interleavings", async () => {
  const fixture = await seedClass(2);
  const [firstStudent, secondStudent] = fixture.students;
  const [firstIssue, secondIssue] = fixture.issueIds;

  await sql`
    CREATE FUNCTION hold_student_archive_lock() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = ${sql.lit(firstStudent!.id)}::uuid AND NEW.archived_at IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(2031);
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER hold_student_archive_lock BEFORE UPDATE ON students
      FOR EACH ROW EXECUTE FUNCTION hold_student_archive_lock();

    CREATE FUNCTION hold_intervention_target_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.student_issue_id = ${sql.lit(secondIssue!)}::uuid THEN
        PERFORM pg_advisory_xact_lock_shared(2032);
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER hold_intervention_target_insert BEFORE INSERT ON intervention_targets
      FOR EACH ROW EXECUTE FUNCTION hold_intervention_target_insert();
  `.execute(db);

  try {
    // Interleaving A: archive holds students FOR NO KEY UPDATE first; create must wait and then return 404.
    await db.connection().execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(2031)`.execute(connection);
      let archivePromise: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
      let createPromise: Promise<Awaited<ReturnType<typeof record>>> | undefined;
      try {
        archivePromise = Promise.resolve(app.inject({
          method: "POST", url: `${classUrl(fixture.id)}/students/${firstStudent!.id}/archive`, payload: { expectedVersion: 1 },
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

        createPromise = Promise.resolve(record(fixture.id, groupInput([firstIssue!])));
        let createBlocked = false;
        const blockDeadline = Date.now() + 3_000;
        while (!createBlocked && Date.now() < blockDeadline) {
          const { rows } = await sql<{ blocked: boolean }>`
            SELECT EXISTS(
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${archivePid!} = ANY(pg_blocking_pids(pid))
            ) AS blocked
          `.execute(connection);
          createBlocked = rows[0]!.blocked;
          if (!createBlocked) await delay(20);
        }
        expect(createBlocked).toBe(true);
      } finally {
        await sql`SELECT pg_advisory_unlock(2031)`.execute(connection);
      }
      const [archiveRes, createRes] = await Promise.all([archivePromise!, createPromise!]);
      expect(archiveRes.statusCode, archiveRes.body).toBe(204);
      expect(createRes.statusCode, createRes.body).toBe(404);
      expect(createRes.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      await expectNoInterventions(fixture.id);
    });

    // Interleaving B: create locks students FOR SHARE first; archive waits until create commits 201.
    await db.connection().execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(2032)`.execute(connection);
      let createPromise: Promise<Awaited<ReturnType<typeof record>>> | undefined;
      let archivePromise: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
      try {
        createPromise = Promise.resolve(record(fixture.id, groupInput([secondIssue!])));
        const deadline = Date.now() + 3_000;
        let createPid: number | undefined;
        while (!createPid && Date.now() < deadline) {
          const { rows } = await sql<{ pid: number }>`
            SELECT activity.pid FROM pg_stat_activity AS activity
            WHERE activity.datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(activity.pid))
          `.execute(connection);
          createPid = rows[0]?.pid;
          if (!createPid) await delay(20);
        }
        expect(createPid).toBeDefined();

        archivePromise = Promise.resolve(app.inject({
          method: "POST", url: `${classUrl(fixture.id)}/students/${secondStudent!.id}/archive`, payload: { expectedVersion: 1 },
        }));
        let archiveBlocked = false;
        const blockDeadline = Date.now() + 3_000;
        while (!archiveBlocked && Date.now() < blockDeadline) {
          const { rows } = await sql<{ blocked: boolean }>`
            SELECT EXISTS(
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${createPid!} = ANY(pg_blocking_pids(pid))
            ) AS blocked
          `.execute(connection);
          archiveBlocked = rows[0]!.blocked;
          if (!archiveBlocked) await delay(20);
        }
        expect(archiveBlocked).toBe(true);
      } finally {
        await sql`SELECT pg_advisory_unlock(2032)`.execute(connection);
      }
      const [createRes, archiveRes] = await Promise.all([createPromise!, archivePromise!]);
      expect(createRes.statusCode, createRes.body).toBe(201);
      expect(archiveRes.statusCode, archiveRes.body).toBe(204);
      expect(await db.selectFrom("interventions").select("id").where("class_id", "=", fixture.id).execute()).toHaveLength(1);
    });
  } finally {
    await sql`
      DROP TRIGGER hold_intervention_target_insert ON intervention_targets;
      DROP FUNCTION hold_intervention_target_insert();
      DROP TRIGGER hold_student_archive_lock ON students;
      DROP FUNCTION hold_student_archive_lock();
    `.execute(db);
  }
}, 15_000);
