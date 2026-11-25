import { randomUUID } from "node:crypto";
import {
  type CreateReassessmentInput, idSchema, type ReassessmentDto, type ReassessmentDueQueueDto,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import { interventionsWithTargets, lockInterventionTargets } from "@tutorloop/db/repositories/interventions";
import {
  findReassessment, findReassessmentByRequest, insertReassessment, insertReassessmentTargets,
  listDueReassessments, listReassessmentTargetDisplay, listReassessmentTargetStatuses, lockLinkedInterventionTargets,
  lockReassessment, skipPendingReassessmentTarget, updateReassessmentAtVersion,
} from "@tutorloop/db/repositories/reassessments";
import { canCompleteReassessment } from "@tutorloop/domain";
import { type Kysely, sql } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";
import { toInterventionDto } from "../interventions/service.ts";
import { normalizeObservedAt } from "../raw-notes/service.ts";

type Db = Kysely<Database>;
type ReassessmentRow = NonNullable<Awaited<ReturnType<typeof findReassessment>>>;
type Clock = () => Date;
type Change = { type: "mark-performed" } | { type: "cancel" } | { type: "skip"; studentIssueId: string; skipReason: string };

export function toReassessmentDto(row: ReassessmentRow): ReassessmentDto {
  return {
    id: row.id, classId: row.class_id, title: row.title, notes: row.notes,
    dueAt: row.due_at_utc.replace(/(\.\d{3}\d*?)0+Z$/, "$1Z"), status: row.status, version: row.version,
    performedAt: row.performed_at?.toISOString() ?? null, completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    targets: row.targets.map((target) => ({
      studentIssueId: target.student_issue_id, interventionId: target.intervention_id,
      targetStatus: target.target_status, skipReason: target.skip_reason,
    })),
  };
}

function normalizeTargets(input: CreateReassessmentInput) {
  const issueIds = [...new Set(input.studentIssueIds.map((id) => id.toLowerCase()))].sort();
  const links = new Map<string, string>();
  for (const [issue, intervention] of Object.entries(input.interventionIdByStudentIssueId ?? {})) {
    const issueId = issue.toLowerCase();
    const interventionId = intervention.toLowerCase();
    const previous = links.get(issueId);
    if (previous && previous !== interventionId) {
      throw new ApiError("VALIDATION_ERROR", "Each Student Issue can link only one Intervention.");
    }
    links.set(issueId, interventionId);
  }
  const targets = issueIds.map((student_issue_id) => {
    const intervention_id = links.get(student_issue_id) ?? null;
    links.delete(student_issue_id);
    return { student_issue_id, intervention_id };
  });
  if (links.size) throw new ApiError("VALIDATION_ERROR", "Interventions must be linked to reassessment targets.");
  return targets;
}

export function scheduleReassessment(
  db: Db, principal: AuthPrincipal, classId: string, input: CreateReassessmentInput, now: Clock,
): Promise<ReassessmentDto> {
  const dueAt = normalizeObservedAt(input.dueAt, "Due time");
  const title = input.title ?? null;
  const notes = input.notes ?? null;
  const targets = normalizeTargets(input);

  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const time = now();
    const inserted = await insertReassessment(trx, {
      id: randomUUID(), class_id: classroom.id, title, notes, due_at: dueAt, status: "SCHEDULED",
      performed_at: null, completed_at: null, created_at: time, updated_at: time,
      created_by_user_id: principal.userId, client_request_id: input.clientRequestId,
    });

    if (!inserted) {
      // The unique-key wait completes before this read, so committed targets are visible on a retry.
      const existing = await findReassessmentByRequest(trx, classroom.id, principal.userId, input.clientRequestId);
      if (!existing || existing.title !== title || existing.notes !== notes || existing.due_at_utc !== dueAt ||
        existing.targets.length !== targets.length || existing.targets.some((target, i) =>
          target.student_issue_id !== targets[i]?.student_issue_id || target.intervention_id !== targets[i]?.intervention_id)) {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "The request ID was already used with different input.");
      }
      return toReassessmentDto(existing);
    }

    const issueIds = targets.map((target) => target.student_issue_id);
    const issues = await lockInterventionTargets(trx, classroom.id, issueIds);
    if (issues.length !== targets.length) throw new ApiError("NOT_FOUND", "Student Issue not found.");

    const linked = targets.filter((target) => target.intervention_id !== null);
    if (linked.length) {
      const links = await lockLinkedInterventionTargets(trx, classroom.id,
        linked.map((target) => target.student_issue_id),
        [...new Set(linked.map((target) => target.intervention_id!))]);
      const linkKeys = new Set(links.map((target) => `${target.student_issue_id}:${target.intervention_id}`));
      if (linked.some((target) => !linkKeys.has(`${target.student_issue_id}:${target.intervention_id}`))) {
        throw new ApiError("NOT_FOUND", "Intervention not found for the Student Issue.");
      }
    }
    await insertReassessmentTargets(trx, classroom.id, inserted.id, targets);
    return getReassessmentById(trx, classroom.id, inserted.id);
  });
}

async function getReassessmentById(db: Db, classId: string, reassessmentId: string): Promise<ReassessmentDto> {
  const row = idSchema.safeParse(reassessmentId).success ? await findReassessment(db, classId, reassessmentId) : undefined;
  if (!row) throw new ApiError("NOT_FOUND", "Reassessment not found.");
  return toReassessmentDto(row);
}

export async function getReassessment(
  db: Db, principal: AuthPrincipal, classId: string, reassessmentId: string,
): Promise<ReassessmentDto> {
  const classroom = await requireOwnedClass(db, principal, classId);
  return getReassessmentById(db, classroom.id, reassessmentId);
}

export function getReassessmentDueQueue(
  db: Db, principal: AuthPrincipal, classId: string, now: Clock,
): Promise<ReassessmentDueQueueDto> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const rows = await listDueReassessments(trx, classroom.id, now());
    const queue: ReassessmentDueQueueDto = { due: [], needsResults: [] };
    if (!rows.length) return queue;

    const allTargets = rows.flatMap((row) => row.targets);
    const issues = await listReassessmentTargetDisplay(trx, classroom.id,
      [...new Set(allTargets.map((target) => target.student_issue_id))]);
    const byIssue = new Map(issues.map((issue) => [issue.issue_id, issue]));
    const interventionIds = [...new Set(allTargets.flatMap((target) => target.intervention_id ?? []))];
    const interventions = interventionIds.length ? await interventionsWithTargets(trx, classroom.id)
      .where("interventions.id", "=", sql<string>`any(${interventionIds}::uuid[])`).execute() : [];
    const byIntervention = new Map(interventions.map((row) => [row.id, toInterventionDto(row)]));
    for (const row of rows) {
      const dto = toReassessmentDto(row);
      const entry = {
        ...dto, class: { id: classroom.id, name: classroom.name },
        targets: dto.targets.map((target) => {
          const issue = byIssue.get(target.studentIssueId)!;
          return {
            ...target, canonicalIssue: { id: issue.canonical_id, label: issue.canonical_label },
            student: { id: issue.student_id, displayLabel: issue.display_label },
            intervention: target.interventionId ? byIntervention.get(target.interventionId)! : null,
          };
        }),
      };
      if (row.status === "SCHEDULED") queue.due.push({ ...entry, status: row.status });
      if (row.status === "PERFORMED_PENDING_EVIDENCE") queue.needsResults.push({ ...entry, status: row.status });
    }
    return queue;
  });
}

export function changeReassessment(
  db: Db, principal: AuthPrincipal, classId: string, reassessmentId: string, expectedVersion: number,
  change: Change, now: Clock,
): Promise<ReassessmentDto> {
  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const row = idSchema.safeParse(reassessmentId).success ? await lockReassessment(trx, classroom.id, reassessmentId) : undefined;
    if (!row) throw new ApiError("NOT_FOUND", "Reassessment not found.");
    if (row.version !== expectedVersion) throw new ApiError("STALE_VERSION", "Reassessment has changed.");
    if (row.status === "CANCELLED" || row.status === "COMPLETED") {
      throw new ApiError("VALIDATION_ERROR", "Reassessment is closed.");
    }

    const time = now();
    switch (change.type) {
      case "mark-performed":
        if (row.status !== "SCHEDULED") throw new ApiError("VALIDATION_ERROR", "Reassessment is already performed.");
        await updateReassessmentAtVersion(trx, row, { status: "PERFORMED_PENDING_EVIDENCE", performed_at: time }, time);
        break;
      case "cancel":
        await updateReassessmentAtVersion(trx, row, { status: "CANCELLED" }, time);
        break;
      case "skip": {
        const issueId = change.studentIssueId.toLowerCase();
        const targets = await listReassessmentTargetStatuses(trx, classroom.id, row.id);
        const target = targets.find((item) => item.student_issue_id === issueId);
        if (!target) throw new ApiError("NOT_FOUND", "Reassessment target not found.");
        if (target.target_status !== "PENDING") throw new ApiError("VALIDATION_ERROR", "Reassessment target is already decided.");
        await skipPendingReassessmentTarget(trx, classroom.id, row.id, issueId, change.skipReason);
        const statuses = targets.map((item) => item === target ? "SKIPPED" : item.target_status);
        const complete = canCompleteReassessment(statuses);
        await updateReassessmentAtVersion(trx, row, complete
          ? { status: "COMPLETED", completed_at: time, ...(row.performed_at === null ? { performed_at: time } : {}) }
          : {}, time);
        break;
      }
    }
    return getReassessmentById(trx, classroom.id, row.id);
  });
}
