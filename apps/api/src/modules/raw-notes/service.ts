import { randomUUID } from "node:crypto";
import {
  type CreateRawNoteInput, type CreateRawNoteResponse, idSchema, type RawNoteDetailDto, type RawNoteDto,
  type VoidRawNoteInput,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import {
  findInitialStructureJob, findLatestStructureAttempt, insertInitialStructureJob,
} from "@tutorloop/db/repositories/jobs";
import { isPersistedProposalRun } from "@tutorloop/db/repositories/proposals";
import {
  findCaptureReassessment, findRawNote, findRawNoteByRequest, formatRawNoteObservedAt, insertRawNote, markRawNoteVoided,
} from "@tutorloop/db/repositories/raw-notes";
import type { Kysely } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";

type Db = Kysely<Database>;
type RawNoteRow = NonNullable<Awaited<ReturnType<typeof findRawNote>>>;

export function normalizeObservedAt(timestamp: string): string {
  const fraction = /\.(\d+)/.exec(timestamp)?.[1] ?? "";
  const wholeSecond = new Date(timestamp.replace(/\.\d+/, ""));
  // PostgreSQL can store six fractional digits, and the DTO uses a four-digit UTC year.
  if (/[1-9]/.test(fraction.slice(6)) || !Number.isFinite(wholeSecond.getTime()) ||
      wholeSecond.getUTCFullYear() < 0 || wholeSecond.getUTCFullYear() > 9999) {
    throw new ApiError("VALIDATION_ERROR", "Observed time must be representable exactly in UTC.");
  }
  return `${wholeSecond.toISOString().slice(0, 19)}.${fraction.slice(0, 6).padEnd(6, "0")}Z`;
}

export function toRawNoteDto(row: RawNoteRow): RawNoteDto {
  return {
    id: row.id,
    classId: row.class_id,
    body: row.body,
    noteType: row.note_type,
    observedAt: formatRawNoteObservedAt(row).replace(/(\.\d{3}\d*?)0+Z$/, "$1Z"),
    reassessmentId: row.reassessment_id,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidReason: row.void_reason,
    createdAt: row.created_at.toISOString(),
  };
}

async function toDetailDto(db: Db, row: RawNoteRow): Promise<RawNoteDetailDto> {
  const rawNote = toRawNoteDto(row);
  const attempt = await findLatestStructureAttempt(db, row.class_id, row.id);
  if (!attempt) return { rawNote, processing: { status: "QUEUED" } };

  const { proposalRunId, runStatus, jobStatus } = attempt;
  if (proposalRunId && isPersistedProposalRun(runStatus)) {
    return { rawNote, processing: { status: "READY", proposalRunId } };
  }
  const run = proposalRunId ? { proposalRunId } : {};
  if (jobStatus === "DEAD" || runStatus === "FAILED") {
    return { rawNote, processing: { status: "FAILED", ...run } };
  }
  if (jobStatus === "RUNNING" || jobStatus === "FAILED" || runStatus === "PROCESSING") {
    return { rawNote, processing: { status: "PROCESSING", ...run } };
  }
  return { rawNote, processing: { status: "QUEUED" } };
}

export async function captureRawNote(
  db: Db, principal: AuthPrincipal, classId: string, input: CreateRawNoteInput,
): Promise<CreateRawNoteResponse> {
  const observedAt = normalizeObservedAt(input.observedAt);
  const reassessmentId = input.reassessmentId?.toLowerCase() ?? null;
  if ((input.noteType === "REASSESSMENT_OUTCOME") !== (reassessmentId !== null)) {
    throw new ApiError("VALIDATION_ERROR", "A reassessment is required only for an outcome note.");
  }

  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    if (reassessmentId !== null && !(await findCaptureReassessment(trx, classroom.id, reassessmentId))) {
      throw new ApiError("NOT_FOUND", "Reassessment not found.");
    }

    const inserted = await insertRawNote(trx, {
      id: randomUUID(), class_id: classroom.id, author_user_id: principal.userId, body: input.body,
      observed_at: observedAt, note_type: input.noteType, reassessment_id: reassessmentId,
      client_request_id: input.clientRequestId, created_at: new Date(), voided_at: null, void_reason: null,
    });
    if (inserted) {
      const job = await insertInitialStructureJob(trx, inserted.id, classroom.id);
      return { rawNote: toRawNoteDto(inserted), processing: { status: "QUEUED", jobId: job.id } };
    }

    // A fresh statement sees the winning transaction's note and job after the unique-index wait.
    const existing = await findRawNoteByRequest(trx, classroom.id, principal.userId, input.clientRequestId);
    if (!existing || existing.body !== input.body || formatRawNoteObservedAt(existing) !== observedAt ||
      existing.note_type !== input.noteType || existing.reassessment_id !== reassessmentId) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "The request ID was already used with different input.");
    }
    const job = await findInitialStructureJob(trx, existing.id);
    return { rawNote: toRawNoteDto(existing), processing: { status: "QUEUED", jobId: job.id } };
  });
}

export async function getRawNote(
  db: Db, principal: AuthPrincipal, classId: string, rawNoteId: string,
): Promise<RawNoteDetailDto> {
  const classroom = await requireOwnedClass(db, principal, classId);
  if (idSchema.safeParse(rawNoteId).success) {
    const row = await findRawNote(db, classroom.id, rawNoteId);
    if (row) return toDetailDto(db, row);
  }
  throw new ApiError("NOT_FOUND", "Raw Note not found.");
}

export async function voidRawNote(
  db: Db, principal: AuthPrincipal, classId: string, rawNoteId: string, input: VoidRawNoteInput,
): Promise<RawNoteDetailDto> {
  const classroom = await requireOwnedClass(db, principal, classId);
  if (idSchema.safeParse(rawNoteId).success) {
    const row = await markRawNoteVoided(db, classroom.id, rawNoteId, input.voidReason ?? null)
      ?? await findRawNote(db, classroom.id, rawNoteId);
    if (row) return toDetailDto(db, row);
  }
  throw new ApiError("NOT_FOUND", "Raw Note not found.");
}
