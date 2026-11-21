import { type CreateRawNoteResponse, idSchema, type ReprocessRawNoteInput } from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import {
  findLatestStructureAttempt, findReprocessStructureJob, insertReprocessStructureJob,
} from "@tutorloop/db/repositories/jobs";
import { isPersistedProposalRun } from "@tutorloop/db/repositories/proposals";
import { lockRawNote } from "@tutorloop/db/repositories/raw-notes";
import type { Kysely } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { requireOwnedClass } from "../../common/ownership.ts";
import { toRawNoteDto } from "./service.ts";

export function reprocessRawNote(
  db: Kysely<Database>, principal: AuthPrincipal, classId: string, rawNoteId: string, input: ReprocessRawNoteInput,
): Promise<CreateRawNoteResponse> {
  return db.transaction().setIsolationLevel("read committed").execute(async (trx) => {
    const classroom = await requireOwnedClass(trx, principal, classId);
    const note = idSchema.safeParse(rawNoteId).success && await lockRawNote(trx, classroom.id, rawNoteId);
    if (!note) throw new ApiError("NOT_FOUND", "Raw Note not found.");

    const requestId = input.clientRequestId.toLowerCase();
    const replay = await findReprocessStructureJob(trx, note.id, requestId);
    if (replay) return { rawNote: toRawNoteDto(note), processing: { status: "QUEUED", jobId: replay.id } };

    const latest = await findLatestStructureAttempt(trx, classroom.id, note.id);
    if (!latest || latest.jobStatus !== "DEAD" || isPersistedProposalRun(latest.runStatus)) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "Only a failed final processing attempt can be reprocessed.");
    }
    const job = await insertReprocessStructureJob(trx, note.id, classroom.id, requestId, latest.jobId);
    return { rawNote: toRawNoteDto(note), processing: { status: "QUEUED", jobId: job.id } };
  });
}
