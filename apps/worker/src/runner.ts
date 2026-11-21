import type { Database } from "@tutorloop/db/database";
import {
  type JobRow, lockNextStructureJob, markJobFailure, markJobSucceeded, startStructureJob,
} from "@tutorloop/db/repositories/jobs";
import {
  findProposalRunBySourceJob, isPersistedProposalRun, markProcessingRunFailed,
} from "@tutorloop/db/repositories/proposals";
import type { Transaction } from "kysely";
import {
  JOB_LOCK_MS, processStructureRawNoteJob, type StructureJobDeps, StructureJobError, withCurrentStructureClaim,
} from "./jobs/structure-raw-note.ts";

const JOB_RETRY_DELAYS_MS = [30_000, 5 * 60_000] as const;
export const JOB_MAX_ATTEMPTS = 3;

async function failJob(
  trx: Transaction<Database>, job: JobRow, errorCode: string, failedAt: Date, now: Date,
): Promise<void> {
  const delay = JOB_RETRY_DELAYS_MS[job.attempts - 1];
  const retryAt = delay === undefined ? null : new Date(failedAt.getTime() + delay);
  await markJobFailure(trx, job.id, errorCode, now, retryAt);
  if (!retryAt) await markProcessingRunFailed(trx, job.id, now);
}

async function claimNextJob({ db, now }: StructureJobDeps) {
  return db.transaction().execute(async (trx) => {
    const time = now();
    const job = await lockNextStructureJob(trx, time, new Date(time.getTime() - JOB_LOCK_MS), JOB_MAX_ATTEMPTS);
    if (!job) return { kind: "idle" } as const;
    if (job.status !== "RUNNING") {
      return { kind: "claimed", job: await startStructureJob(trx, job, time) } as const;
    }

    const run = await findProposalRunBySourceJob(trx, job.id);
    if (isPersistedProposalRun(run?.status)) {
      await markJobSucceeded(trx, job.id, time);
    } else {
      const expiredAt = job.locked_at ? new Date(job.locked_at.getTime() + JOB_LOCK_MS) : time;
      await failJob(trx, job, "JOB_LOCK_EXPIRED", expiredAt, time);
    }
    return { kind: "recovered" } as const;
  });
}

export async function runNextJob(deps: StructureJobDeps): Promise<boolean> {
  let result = await claimNextJob(deps);
  while (result.kind === "recovered") result = await claimNextJob(deps);
  if (result.kind === "idle") return false;

  const { job } = result;
  try {
    await processStructureRawNoteJob(job, deps);
  } catch (error) {
    if (!(error instanceof StructureJobError)) throw error;
    await withCurrentStructureClaim(job, deps, (trx, time) => failJob(trx, job, error.code, time, time));
  }
  return true;
}
