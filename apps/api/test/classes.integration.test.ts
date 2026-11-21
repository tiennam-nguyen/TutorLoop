import { randomUUID } from "node:crypto";
import {
  classDetailDtoSchema, classDtoSchema, classListDtoSchema, studentDtoSchema,
} from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { fixedUserAuthVerifier } from "./support/auth.ts";

const classesUrl = "/api/v1/classes";
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

async function createClass(payload = {
  name: "Fractions", timezone: "Asia/Bangkok", clientRequestId: randomUUID(),
}) {
  const response = await app.inject({ method: "POST", url: classesUrl, payload });
  expect(response.statusCode).toBe(201);
  return classDtoSchema.parse(response.json());
}

async function addStudent(classUrl: string, payload = {
  displayLabel: "Minh", clientRequestId: randomUUID(),
}) {
  const response = await app.inject({ method: "POST", url: `${classUrl}/students`, payload });
  expect(response.statusCode).toBe(201);
  return studentDtoSchema.parse(response.json());
}

test("lists the active class, updates its version, and preserves the archived class", async () => {
  const classroom = await createClass();
  const url = `${classesUrl}/${classroom.id}`;
  expect(classroom).toMatchObject({ name: "Fractions", timezone: "Asia/Bangkok", version: 1 });
  expect(classListDtoSchema.parse((await app.inject(classesUrl)).json())).toEqual([classroom]);
  expect(classDetailDtoSchema.parse((await app.inject(url)).json())).toEqual({ ...classroom, students: [] });

  const updated = await app.inject({
    method: "PATCH", url, payload: { name: "Algebra", expectedVersion: 1 },
  });
  expect(updated.statusCode).toBe(200);
  expect(classDtoSchema.parse(updated.json())).toMatchObject({ name: "Algebra", timezone: "Asia/Bangkok", version: 2 });

  const stale = await app.inject({ method: "POST", url: `${url}/archive`, payload: { expectedVersion: 1 } });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ error: { code: "STALE_VERSION" } });
  expect((await app.inject({
    method: "POST", url: `${url}/archive`, payload: { expectedVersion: 2 },
  })).statusCode).toBe(204);
  expect(classListDtoSchema.parse((await app.inject(classesUrl)).json())).toEqual([]);
  expect(classDetailDtoSchema.parse((await app.inject(url)).json())).toMatchObject({
    archivedAt: expect.any(String), version: 3,
  });
});

test("accepts duplicate student labels and preserves the alias and history across rename and archive", async () => {
  const classroom = await createClass();
  const url = `${classesUrl}/${classroom.id}`;
  const first = await addStudent(url);
  const second = await addStudent(url);
  expect(first.displayLabel).toBe("Minh");
  expect(second.displayLabel).toBe("Minh");
  expect(first.aiAlias).toBe(`STU_${first.id.replaceAll("-", "")}`);
  expect(second.aiAlias).not.toBe(first.aiAlias);

  const issue = buildCanonicalIssue(classroom.id);
  await db.insertInto("canonical_issues").values(issue).execute();
  const historyId = randomUUID();
  await db.insertInto("student_issues").values({
    id: historyId, class_id: classroom.id, student_id: first.id, canonical_issue_id: issue.id,
    state: "OPEN", created_at: new Date(), updated_at: new Date(),
  }).execute();

  const studentUrl = `${url}/students/${first.id}`;
  const rename = await app.inject({
    method: "PATCH", url: studentUrl, payload: { displayLabel: "Minh Anh", expectedVersion: 1 },
  });
  expect(rename.statusCode).toBe(200);
  expect(studentDtoSchema.parse(rename.json())).toMatchObject({
    displayLabel: "Minh Anh", aiAlias: first.aiAlias, version: 2,
  });

  const stale = await app.inject({
    method: "PATCH", url: studentUrl, payload: { displayLabel: "Wrong", expectedVersion: 1 },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ error: { code: "STALE_VERSION" } });
  const staleArchive = await app.inject({
    method: "POST", url: `${studentUrl}/archive`, payload: { expectedVersion: Number.MAX_SAFE_INTEGER },
  });
  expect(staleArchive.statusCode).toBe(409);
  expect(staleArchive.json()).toMatchObject({ error: { code: "STALE_VERSION" } });
  expect((await app.inject({
    method: "POST", url: `${studentUrl}/archive`, payload: { expectedVersion: 2 },
  })).statusCode).toBe(204);

  const detail = classDetailDtoSchema.parse((await app.inject(url)).json());
  expect(detail.students).toEqual([second]);
  expect(await db.selectFrom("students").selectAll().where("id", "=", first.id).executeTakeFirst()).toMatchObject({
    id: first.id, class_id: classroom.id, ai_alias: first.aiAlias, display_label: "Minh Anh",
    archived_at: expect.any(Date), version: 3,
  });
  expect(await db.selectFrom("student_issues").select("student_id").where("id", "=", historyId)
    .executeTakeFirst()).toEqual({ student_id: first.id });
});

test("conceals another teacher's class and prevents cross-class student mutations", async () => {
  const classroom = await createClass();
  const url = `${classesUrl}/${classroom.id}`;
  const student = await addStudent(url);
  const another = await createClass();
  const other = buildClass();
  await db.insertInto("classes").values(other).execute();
  const unknownClassId = randomUUID();
  const unknownStudentId = randomUUID();
  const classPatch = (classId: string) => app.inject({
    method: "PATCH", url: `${classesUrl}/${classId}`, payload: { name: "Wrong", expectedVersion: 1 },
  });
  const studentPatch = (studentId: string) => app.inject({
    method: "PATCH", url: `${classesUrl}/${another.id}/students/${studentId}`,
    payload: { displayLabel: "Wrong", expectedVersion: 1 },
  });
  const updates = await Promise.all([
    classPatch(other.id),
    classPatch(unknownClassId),
    studentPatch(student.id),
    studentPatch(unknownStudentId),
    app.inject({
      method: "POST", url: `${classesUrl}/${other.id}/students`,
      payload: { displayLabel: "Wrong", clientRequestId: randomUUID() },
    }),
  ]);
  for (const response of updates) {
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  }
  const [foreignClass, missingClass, foreignStudent, missingStudent] = updates;
  expect(foreignClass.json()).toEqual(missingClass.json());
  expect(foreignStudent.json()).toEqual(missingStudent.json());
  expect(classDetailDtoSchema.parse((await app.inject(url)).json()).students).toEqual([student]);
  expect(await db.selectFrom("classes").select("name").where("id", "=", other.id).executeTakeFirst()).toEqual({ name: other.name });
});

test("replays concurrent creates and resolves original requests after edits and archive", async () => {
  const input = { name: "Geometry", timezone: "UTC", clientRequestId: randomUUID() };
  const [classroom, duplicateClass] = await Promise.all([createClass(input), createClass(input)]);
  expect(duplicateClass.id).toBe(classroom.id);
  const url = `${classesUrl}/${classroom.id}`;
  const studentInput = { displayLabel: "Minh", clientRequestId: randomUUID() };
  const [student, duplicateStudent] = await Promise.all([
    addStudent(url, studentInput), addStudent(url, studentInput),
  ]);
  expect(duplicateStudent).toEqual(student);
  const studentUrl = `${url}/students/${student.id}`;

  expect((await app.inject({
    method: "PATCH", url: studentUrl, payload: { displayLabel: "Minh Anh", expectedVersion: 1 },
  })).statusCode).toBe(200);
  expect((await app.inject({
    method: "POST", url: `${studentUrl}/archive`, payload: { expectedVersion: 2 },
  })).statusCode).toBe(204);
  expect(await addStudent(url, studentInput)).toMatchObject({
    id: student.id, displayLabel: "Minh Anh", archivedAt: expect.any(String),
  });

  expect((await app.inject({
    method: "PATCH", url, payload: { name: "Angles", expectedVersion: 1 },
  })).statusCode).toBe(200);
  expect((await app.inject({
    method: "POST", url: `${url}/archive`, payload: { expectedVersion: 2 },
  })).statusCode).toBe(204);
  expect(await createClass(input)).toMatchObject({ id: classroom.id, name: "Angles", archivedAt: expect.any(String) });

  const conflicts = await Promise.all([
    app.inject({ method: "POST", url: classesUrl, payload: { ...input, name: "Different" } }),
    app.inject({
      method: "POST", url: `${url}/students`, payload: { ...studentInput, displayLabel: "Different" },
    }),
  ]);
  for (const response of conflicts) {
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  }
  expect(await db.selectFrom("classes").select("id").where("owner_user_id", "=", teacherId).execute())
    .toEqual([{ id: classroom.id }]);
  expect(await db.selectFrom("students").select("id").where("class_id", "=", classroom.id).execute())
    .toEqual([{ id: student.id }]);

  const otherClass = await createClass();
  expect((await addStudent(`${classesUrl}/${otherClass.id}`, studentInput)).id).not.toBe(student.id);
});

test("rejects invalid create inputs and accepts only one writer per class version", async () => {
  const invalid = await app.inject({
    method: "POST", url: classesUrl,
    payload: { name: "Geometry", timezone: "+07:00", clientRequestId: randomUUID() },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

  const classroom = await createClass();
  const url = `${classesUrl}/${classroom.id}`;
  const writes = await Promise.all(["Angles", "Shapes"].map((name) => app.inject({
    method: "PATCH", url, payload: { name, expectedVersion: classroom.version },
  })));
  expect(writes.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  expect(writes.find((response) => response.statusCode === 409)?.json()).toMatchObject({
    error: { code: "STALE_VERSION" },
  });
});

test("rejects a NUL in a new class name without creating a class", async () => {
  const response = await app.inject({
    method: "POST", url: classesUrl,
    payload: { name: "Geo\u0000metry", timezone: "UTC", clientRequestId: randomUUID() },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(await db.selectFrom("classes").select("id").where("owner_user_id", "=", teacherId).execute()).toEqual([]);
});

test("rejects a NUL when renaming a class without changing the class", async () => {
  const classroom = await createClass();
  const url = `${classesUrl}/${classroom.id}`;
  const response = await app.inject({
    method: "PATCH", url, payload: { name: "Geo\u0000metry", expectedVersion: classroom.version },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(classDetailDtoSchema.parse((await app.inject(url)).json())).toEqual({ ...classroom, students: [] });
});

test("rejects a NUL in a new student label without creating a student", async () => {
  const classroom = await createClass();
  const response = await app.inject({
    method: "POST", url: `${classesUrl}/${classroom.id}/students`,
    payload: { displayLabel: "Mi\u0000nh", clientRequestId: randomUUID() },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(await db.selectFrom("students").select("id").where("class_id", "=", classroom.id).execute()).toEqual([]);
});

test("rejects a NUL when renaming a student without changing the student", async () => {
  const classroom = await createClass();
  const url = `${classesUrl}/${classroom.id}`;
  const student = await addStudent(url);
  const response = await app.inject({
    method: "PATCH", url: `${url}/students/${student.id}`,
    payload: { displayLabel: "Mi\u0000nh", expectedVersion: student.version },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(classDetailDtoSchema.parse((await app.inject(url)).json()).students).toEqual([student]);
});

test("allows GET and rejects the unlisted HEAD method on both Class read routes", async () => {
  const classroom = await createClass();
  const urls = [classesUrl, `${classesUrl}/${classroom.id}`];
  const get = await Promise.all(urls.map((url) => app.inject({ method: "GET", url })));
  expect(get.map((response) => response.statusCode)).toEqual([200, 200]);
  const head = await Promise.all(urls.map((url) => app.inject({ method: "HEAD", url })));
  expect(head.map((response) => response.statusCode)).toEqual([404, 404]);
  expect((await app.inject({ method: "HEAD", url: "/health" })).statusCode).toBe(200);
});
