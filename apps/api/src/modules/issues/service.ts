import {
  idSchema, type CanonicalIssueDto, type MergeCanonicalIssueInput, type UpdateCanonicalIssueInput,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import {
  lockCanonicalGraph, updateCanonicalIssueAtVersion, type CanonicalIssueRow,
} from "@tutorloop/db/repositories/issues";
import type { Kysely, Transaction } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";

export function toCanonicalIssueDto(row: CanonicalIssueRow): CanonicalIssueDto {
  return { id: row.id, classId: row.class_id, label: row.label, description: row.description,
    mergedIntoId: row.merged_into_id, archivedAt: row.archived_at?.toISOString() ?? null, version: row.version,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

function requireCanonical(rows: CanonicalIssueRow[], id: string) {
  const row = idSchema.safeParse(id).success ? rows.find((row) => row.id === id.toLowerCase()) : undefined;
  if (!row) throw new ApiError("NOT_FOUND", "Canonical Issue not found.");
  return row;
}

// The graph size is the traversal bound. A visited set detects existing cycles without recursion.
export function resolveCanonicalRoot(rows: CanonicalIssueRow[], id: string): CanonicalIssueRow {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visited = new Set<string>();
  let current = requireCanonical(rows, id);
  for (let hops = 0; hops <= rows.length; hops++) {
    if (visited.has(current.id)) throw new ApiError("VALIDATION_ERROR", "Canonical Issue merge would form a cycle.");
    visited.add(current.id);
    if (current.merged_into_id === null) return current;
    const next = byId.get(current.merged_into_id);
    if (!next) throw new ApiError("NOT_FOUND", "Canonical Issue not found.");
    current = next;
  }
  throw new ApiError("VALIDATION_ERROR", "Invalid Canonical Issue merge chain.");
}

function version(row: CanonicalIssueRow, expected: number) {
  if (row.version !== expected) throw new ApiError("STALE_VERSION", "Canonical Issue has changed.");
}

// Caller holds the class graph lock. Only the source canonical row changes.
export async function applyCanonicalMerge(
  trx: Transaction<Database>, rows: CanonicalIssueRow[], sourceId: string, input: MergeCanonicalIssueInput, now: Date,
) {
  const source = requireCanonical(rows, sourceId), target = requireCanonical(rows, input.targetCanonicalIssueId);
  version(source, input.expectedSourceVersion); version(target, input.expectedTargetVersion);
  if (source.id === target.id || resolveCanonicalRoot(rows, target.id).id === source.id) {
    throw new ApiError("VALIDATION_ERROR", "Canonical Issue merge would form a cycle.");
  }
  if (source.merged_into_id !== null) throw new ApiError("STALE_VERSION", "Canonical Issue is already merged.");
  return updateCanonicalIssueAtVersion(trx, source, { merged_into_id: target.id }, now);
}

export function mergeCanonicalIssue(
  db: Kysely<Database>, principal: AuthPrincipal, classId: string, id: string, input: MergeCanonicalIssueInput,
) {
  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const rows = await lockCanonicalGraph(trx, classroom.id);
    return toCanonicalIssueDto(await applyCanonicalMerge(trx, rows, id, input, new Date()));
  });
}

export function updateCanonicalIssue(
  db: Kysely<Database>, principal: AuthPrincipal, classId: string, id: string, input: UpdateCanonicalIssueInput,
) {
  for (const text of [input.label, input.description]) {
    if (typeof text === "string" && (!text.isWellFormed() || text.includes("\u0000"))) {
      throw new ApiError("VALIDATION_ERROR", "Invalid request text.");
    }
  }
  if (input.label === undefined && input.description === undefined) throw new ApiError("VALIDATION_ERROR", "No issue changes supplied.");
  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const row = requireCanonical(await lockCanonicalGraph(trx, classroom.id), id);
    version(row, input.expectedVersion);
    const changes = { ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}) };
    return toCanonicalIssueDto(await updateCanonicalIssueAtVersion(trx, row, changes, new Date()));
  });
}
