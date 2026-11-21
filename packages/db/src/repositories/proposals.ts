import { randomUUID } from "node:crypto";
import type { ProposalRunStatus } from "@tutorloop/contracts";
import type { Insertable, Kysely, Transaction } from "kysely";
import type { Database } from "../database.ts";

export function findProposalRunBySourceJob(db: Transaction<Database>, sourceJobId: string) {
  return db.selectFrom("proposal_runs").selectAll().where("source_job_id", "=", sourceJobId).executeTakeFirst();
}

export function isPersistedProposalRun(status: ProposalRunStatus | null | undefined): boolean {
  return status === "READY" || status === "PARTIALLY_REVIEWED" || status === "APPLIED" || status === "SUPERSEDED";
}

// Call while holding the source job row lock.
export function insertProcessingRun(
  db: Transaction<Database>, classId: string, rawNoteId: string, sourceJobId: string, now: Date,
) {
  return db.insertInto("proposal_runs").values({
    id: randomUUID(), class_id: classId, raw_note_id: rawNoteId, source_job_id: sourceJobId,
    status: "PROCESSING", schema_version: "1", created_at: now, updated_at: now,
  }).returningAll().executeTakeFirstOrThrow();
}

export async function insertProposalItems(
  db: Transaction<Database>, items: Insertable<Database["proposal_items"]>[],
): Promise<void> {
  if (items.length > 0) await db.insertInto("proposal_items").values(items).execute();
}

export async function markProcessingRunReady(db: Transaction<Database>, runId: string, now: Date): Promise<void> {
  await db.updateTable("proposal_runs").set({ status: "READY", updated_at: now })
    .where("id", "=", runId).where("status", "=", "PROCESSING")
    .returning("id").executeTakeFirstOrThrow();
}

export async function markProcessingRunFailed(db: Transaction<Database>, sourceJobId: string, now: Date): Promise<void> {
  await db.updateTable("proposal_runs").set({ status: "FAILED", updated_at: now })
    .where("source_job_id", "=", sourceJobId).where("status", "=", "PROCESSING").execute();
}

export async function insertProposalItemDependency(
  db: Kysely<Database>,
  itemId: string,
  dependsOnItemId: string,
): Promise<void> {
  const dependency = await db.insertInto("proposal_item_dependencies")
    .columns(["proposal_item_id", "depends_on_item_id"])
    .expression(db.selectFrom("proposal_items as item")
      .innerJoin("proposal_items as dependency", (join) => join
        .onRef("dependency.proposal_run_id", "=", "item.proposal_run_id")
        .onRef("dependency.class_id", "=", "item.class_id"))
      .where("item.id", "=", itemId)
      .where("dependency.id", "=", dependsOnItemId)
      .select(["item.id as proposal_item_id", "dependency.id as depends_on_item_id"]))
    .returning("proposal_item_id")
    .executeTakeFirst();

  if (!dependency) {
    throw new Error("Proposal dependency must reference items in the same run.");
  }
}
