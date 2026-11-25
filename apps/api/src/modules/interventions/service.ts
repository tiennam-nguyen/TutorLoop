import { randomUUID } from "node:crypto";
import { type CreateInterventionInput, idSchema, type InterventionDto } from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import {
  findIntervention, findInterventionByRequest, insertIntervention, insertInterventionTargets,
} from "@tutorloop/db/repositories/interventions";
import { lockActiveStudentIssueTargets } from "@tutorloop/db/repositories/students";
import type { Kysely } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";
import { normalizeObservedAt } from "../raw-notes/service.ts";

type Db = Kysely<Database>;
type InterventionRow = NonNullable<Awaited<ReturnType<typeof findIntervention>>>;

export function toInterventionDto(row: InterventionRow): InterventionDto {
  return {
    id: row.id, classId: row.class_id, description: row.description,
    occurredAt: row.occurred_at_utc.replace(/(\.\d{3}\d*?)0+Z$/, "$1Z"),
    studentIssueIds: row.student_issue_ids, createdAt: row.created_at.toISOString(),
  };
}

export function recordIntervention(
  db: Db, principal: AuthPrincipal, classId: string, input: CreateInterventionInput,
): Promise<InterventionDto> {
  const occurredAt = normalizeObservedAt(input.occurredAt, "Occurrence time");
  const targets = [...new Set(input.studentIssueIds.map((id) => id.toLowerCase()))].sort();

  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const inserted = await insertIntervention(trx, {
      id: randomUUID(), class_id: classroom.id, description: input.description, occurred_at: occurredAt,
      created_by_user_id: principal.userId, client_request_id: input.clientRequestId, created_at: new Date(),
    });
    if (inserted) {
      const issues = await lockActiveStudentIssueTargets(trx, classroom.id, targets);
      if (issues.length !== targets.length) throw new ApiError("NOT_FOUND", "Student Issue not found.");
      await insertInterventionTargets(trx, classroom.id, inserted.id, targets);
      return toInterventionDto({ ...inserted, student_issue_ids: targets });
    }

    // The next read-committed statement sees the winning Intervention and its targets after the unique-key wait.
    const existing = await findInterventionByRequest(trx, classroom.id, principal.userId, input.clientRequestId);
    if (!existing || existing.description !== input.description || existing.occurred_at_utc !== occurredAt ||
        existing.student_issue_ids.length !== targets.length || existing.student_issue_ids.some((id, i) => id !== targets[i])) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "The request ID was already used with different input.");
    }
    return toInterventionDto(existing);
  });
}

export async function getIntervention(
  db: Db, principal: AuthPrincipal, classId: string, interventionId: string,
): Promise<InterventionDto> {
  const classroom = await requireOwnedClass(db, principal, classId);
  if (idSchema.safeParse(interventionId).success) {
    const row = await findIntervention(db, classroom.id, interventionId);
    if (row) return toInterventionDto(row);
  }
  throw new ApiError("NOT_FOUND", "Intervention not found.");
}
