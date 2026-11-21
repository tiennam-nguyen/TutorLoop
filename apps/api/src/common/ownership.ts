import { idSchema } from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import type { Kysely, Selectable } from "kysely";
import type { AuthPrincipal } from "../auth/principal.ts";
import { ApiError } from "./errors.ts";

export type ClassRow = Selectable<Database["classes"]>;

export async function requireOwnedClass(
  db: Kysely<Database>,
  principal: AuthPrincipal,
  classId: string,
): Promise<ClassRow> {
  if (idSchema.safeParse(classId).success) {
    const classroom = await db.selectFrom("classes")
      .selectAll()
      .where("id", "=", classId)
      .where("owner_user_id", "=", principal.userId)
      .executeTakeFirst();
    if (classroom) return classroom;
  }

  throw new ApiError("NOT_FOUND", "Class not found.");
}
