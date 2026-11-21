import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import type { Database } from "../src/database.ts";
import { runMigrations } from "../src/migrate.ts";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";

const coreTables = [
  "canonical_issues",
  "classes",
  "evidence_events",
  "intervention_targets",
  "interventions",
  "raw_notes",
  "reassessment_targets",
  "reassessments",
  "student_issue_transitions",
  "student_issues",
  "students",
];

describe("core PostgreSQL schema", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let db: Kysely<Database>;
  let classroom: ReturnType<typeof buildClass>;
  let student: ReturnType<typeof buildStudent>;
  let issue: ReturnType<typeof buildCanonicalIssue>;

  beforeAll(async () => {
    postgres = await startPostgres();
    db = createDb(postgres.getConnectionUri());
    await runMigrations(db);
    await runMigrations(db);
  }, 120_000);

  afterAll(async () => {
    try {
      await db?.destroy();
    } finally {
      await postgres?.stop();
    }
  }, 30_000);

  beforeEach(async () => {
    classroom = buildClass();
    student = buildStudent(classroom.id);
    issue = buildCanonicalIssue(classroom.id);
    await db.insertInto("classes").values(classroom).execute();
    await db.insertInto("students").values(student).execute();
    await db.insertInto("canonical_issues").values(issue).execute();
  });

  function studentIssue() {
    return {
      id: randomUUID(),
      class_id: classroom.id,
      student_id: student.id,
      canonical_issue_id: issue.id,
      state: "OPEN" as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  function rawNote() {
    return {
      id: randomUUID(),
      class_id: classroom.id,
      author_user_id: classroom.owner_user_id,
      note_type: "OBSERVATION" as const,
      body: "Student identified the denominator.",
      observed_at: new Date(),
      created_at: new Date(),
    };
  }

  it("creates all core tables on PostgreSQL 18", async () => {
    const tables = await db.introspection.getTables();
    expect(tables.filter((table) => table.schema === "public").map((table) => table.name))
      .toEqual(expect.arrayContaining(coreTables));
    const { rows } = await sql<{ server_version_num: string }>`show server_version_num`.execute(db);
    expect(rows[0]?.server_version_num).toMatch(/^18\d{4}$/);
  });

  it.each(["student", "canonical issue"] as const)(
    "rejects a student issue with a %s from another class",
    async (relationship) => {
      const otherClass = buildClass();
      await db.insertInto("classes").values(otherClass).execute();
      const otherStudent = buildStudent(otherClass.id);
      const otherIssue = buildCanonicalIssue(otherClass.id);
      await db.insertInto("students").values(otherStudent).execute();
      await db.insertInto("canonical_issues").values(otherIssue).execute();
      const link = studentIssue();
      const foreignParent = relationship === "student"
        ? { student_id: otherStudent.id }
        : { canonical_issue_id: otherIssue.id };

      await expect(db.insertInto("student_issues").values({ ...link, ...foreignParent }).execute())
        .rejects.toMatchObject({ code: "23503" });
    },
  );

  it("rejects a duplicate student and canonical issue pair", async () => {
    await db.insertInto("student_issues").values(studentIssue()).execute();
    await expect(db.insertInto("student_issues").values(studentIssue()).execute())
      .rejects.toMatchObject({ code: "23505" });
  });

  it("allows duplicate student display labels in a class", async () => {
    await expect(db.insertInto("students").values({
      ...buildStudent(classroom.id, "STU_002"),
      display_label: student.display_label,
    }).returning("id").executeTakeFirstOrThrow()).resolves.toHaveProperty("id");
  });

  it("rejects a duplicate AI alias in a class", async () => {
    await expect(db.insertInto("students").values(buildStudent(classroom.id)).execute())
      .rejects.toMatchObject({ code: "23505" });
  });

  it("allows evidence without a student issue", async () => {
    const note = rawNote();
    await db.insertInto("raw_notes").values(note).execute();

    await expect(db.insertInto("evidence_events").values({
      id: randomUUID(),
      class_id: classroom.id,
      student_id: student.id,
      raw_note_id: note.id,
      student_issue_id: null,
      observation_text: "Identified the denominator.",
      observed_at: note.observed_at,
      provenance: "TEACHER_DIRECT",
      approved_by_user_id: classroom.owner_user_id,
      created_at: new Date(),
    }).returning("student_issue_id").executeTakeFirstOrThrow())
      .resolves.toEqual({ student_issue_id: null });
  });

  it("preserves an archived student and its issue", async () => {
    const link = studentIssue();
    await db.insertInto("student_issues").values(link).execute();
    const archivedAt = new Date();
    await db.updateTable("students").set({ archived_at: archivedAt }).where("id", "=", student.id).execute();

    await expect(db.selectFrom("students").select("archived_at").where("id", "=", student.id)
      .executeTakeFirstOrThrow()).resolves.toEqual({ archived_at: archivedAt });
    await expect(db.selectFrom("student_issues").select("student_id").where("id", "=", link.id)
      .executeTakeFirstOrThrow()).resolves.toEqual({ student_id: student.id });
  });

  it("allows multiple raw notes without an idempotency key", async () => {
    await expect(db.insertInto("raw_notes").values([rawNote(), rawNote()]).returning("id").execute())
      .resolves.toHaveLength(2);
  });

  it("rejects reuse of an author's non-null idempotency key", async () => {
    const key = randomUUID();
    await db.insertInto("raw_notes").values({ ...rawNote(), client_request_id: key }).execute();
    await expect(db.insertInto("raw_notes").values({ ...rawNote(), client_request_id: key }).execute())
      .rejects.toMatchObject({ code: "23505" });
  });

  it("rejects merging a canonical issue into itself", async () => {
    await expect(db.updateTable("canonical_issues").set({ merged_into_id: issue.id })
      .where("id", "=", issue.id).execute()).rejects.toMatchObject({ code: "23514" });
  });
});
