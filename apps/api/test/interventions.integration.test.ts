import { randomUUID } from "node:crypto";
import { canonicalIssueDetailDtoSchema, interventionDtoSchema, studentOverviewDtoSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
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
