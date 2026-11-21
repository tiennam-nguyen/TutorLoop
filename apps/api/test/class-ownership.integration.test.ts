import { randomUUID } from "node:crypto";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildClass } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { requirePrincipal } from "../src/auth/principal.ts";
import { requireOwnedClass } from "../src/common/ownership.ts";
import { fixedUserAuthVerifier } from "./support/auth.ts";

test("class lookups reveal an owned class and hide a different teacher's class", async () => {
  const postgres = await startPostgres();
  const db = createDb(postgres.getConnectionUri());
  const app = await createApp({ authVerifier: fixedUserAuthVerifier("teacher-a") });

  try {
    await runMigrations(db);
    const ownClass = { ...buildClass(), owner_user_id: "teacher-a" };
    const otherClass = { ...buildClass(), owner_user_id: "teacher-b" };
    await db.insertInto("classes").values([ownClass, otherClass]).execute();

    app.get<{ Params: { classId: string } }>("/api/v1/classes/:classId", async (request) => {
      const principal = await requirePrincipal(request);
      const classroom = await requireOwnedClass(db, principal, request.params.classId);
      return { id: classroom.id };
    });

    const owned = await app.inject(`/api/v1/classes/${ownClass.id}`);
    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toEqual({ id: ownClass.id });

    for (const classId of [otherClass.id, randomUUID(), "invalid-uuid"]) {
      const hidden = await app.inject(`/api/v1/classes/${classId}`);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Class not found." },
      });
    }
  } finally {
    try {
      await app.close();
    } finally {
      try {
        await db.destroy();
      } finally {
        await postgres.stop();
      }
    }
  }
}, 120_000);
