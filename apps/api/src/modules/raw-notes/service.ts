import { randomUUID } from "node:crypto";
import {
  type CreateRawNoteInput, type CreateRawNoteResponse, idSchema, type RawNoteDetailDto, type RawNoteDto,
  type VoidRawNoteInput,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import { lockClassForNoteCapture } from "@tutorloop/db/repositories/classes";
import { insertProductEvent } from "@tutorloop/db/repositories/product-events";
import {
  findInitialStructureJob, findLatestStructureAttempt, insertInitialStructureJob,
} from "@tutorloop/db/repositories/jobs";
import { isPersistedProposalRun } from "@tutorloop/db/repositories/proposals";
import {
  findRawNote, findRawNoteByRequest, insertRawNote, lockCaptureReassessment, markRawNoteVoided,
} from "@tutorloop/db/repositories/raw-notes";
import { updateReassessmentAtVersion } from "@tutorloop/db/repositories/reassessments";
import type { Kysely } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";

type Db = Kysely<Database>;
type RawNoteRow = NonNullable<Awaited<ReturnType<typeof findRawNote>>>;

export function normalizeObservedAt(timestamp: string, label = "Observed time"): string {
  const fraction = /\.(\d+)/.exec(timestamp)?.[1] ?? "";
  const wholeSecond = new Date(timestamp.replace(/\.\d+/, ""));
  // PostgreSQL can store six fractional digits, and the DTO uses a four-digit UTC year.
  if (/[1-9]/.test(fraction.slice(6)) || !Number.isFinite(wholeSecond.getTime()) ||
      wholeSecond.getUTCFullYear() < 0 || wholeSecond.getUTCFullYear() > 9999) {
    throw new ApiError("VALIDATION_ERROR", `${label} must be representable exactly in UTC.`);
  }
  return `${wholeSecond.toISOString().slice(0, 19)}.${fraction.slice(0, 6).padEnd(6, "0")}Z`;
}

export function toRawNoteDto(row: RawNoteRow): RawNoteDto {
  return {
    id: row.id,
    classId: row.class_id,
    body: row.body,
    noteType: row.note_type,
    observedAt: row.observed_at_utc.replace(/(\.\d{3}\d*?)0+Z$/, "$1Z"),
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
  if (!input.body.isWellFormed() || input.body.includes("\u0000")) {
    throw new ApiError("VALIDATION_ERROR", "Invalid request.");
  }
  const observedAt = normalizeObservedAt(input.observedAt);
  const reassessmentId = input.reassessmentId?.toLowerCase() ?? null;
  if ((input.noteType === "REASSESSMENT_OUTCOME") !== (reassessmentId !== null)) {
    throw new ApiError("VALIDATION_ERROR", "A reassessment is required only for an outcome note.");
  }

  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const reassessment = reassessmentId === null ? undefined : idSchema.safeParse(reassessmentId).success
      ? await lockCaptureReassessment(trx, classroom.id, reassessmentId) : undefined;
    if (reassessmentId !== null && !reassessment) {
      throw new ApiError("NOT_FOUND", "Reassessment not found.");
    }
    // Lock the outcome's Reassessment first, matching proposal approvals. Hold the Class share lock
    // through commit so the database clock orders this capture against edits to private labels.
    await lockClassForNoteCapture(trx, classroom.id);

    const inserted = await insertRawNote(trx, {
      id: randomUUID(), class_id: classroom.id, author_user_id: principal.userId, body: input.body,
      observed_at: observedAt, note_type: input.noteType, reassessment_id: reassessmentId,
      client_request_id: input.clientRequestId, voided_at: null, void_reason: null,
    });
    let note: RawNoteRow;
    let job: { id: string };
    if (inserted) {
      note = inserted;
      job = await insertInitialStructureJob(trx, inserted.id, classroom.id);
      await insertProductEvent(trx, { class_id: classroom.id, actor_user_id: principal.userId,
        event_name: "raw_note_created", entity_id: inserted.id });
    } else {
      // A fresh statement sees the winning transaction's note and job after the unique-index wait.
      const existing = await findRawNoteByRequest(trx, classroom.id, principal.userId, input.clientRequestId);
      if (!existing || existing.body !== input.body || existing.observed_at_utc !== observedAt ||
        existing.note_type !== input.noteType || existing.reassessment_id !== reassessmentId) {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "The request ID was already used with different input.");
      }
      note = existing;
      job = await findInitialStructureJob(trx, existing.id);
    }

    if (reassessment?.status === "SCHEDULED") {
      const performedAt = inserted ? inserted.created_at : new Date();
      await updateReassessmentAtVersion(trx, reassessment, {
        status: "PERFORMED_PENDING_EVIDENCE",
        performed_at: reassessment.performed_at ?? performedAt,
      }, performedAt);
    }
    return { rawNote: toRawNoteDto(note), processing: { status: "QUEUED", jobId: job.id } };
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
