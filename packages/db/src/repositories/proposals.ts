import { randomUUID } from "node:crypto";
import type { ProposalRunStatus } from "@tutorloop/contracts";
import { type Insertable, type Kysely, type Transaction, type Updateable, sql } from "kysely";
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

function proposalRun(db: Kysely<Database>, classId: string, runId: string) {
  return db.selectFrom("proposal_runs").selectAll().where("class_id", "=", classId).where("id", "=", runId);
}

export function findProposalRun(db: Kysely<Database>, classId: string, runId: string) {
  return proposalRun(db, classId, runId).executeTakeFirst();
}

export function lockProposalRun(db: Transaction<Database>, classId: string, runId: string) {
  // The run lock serializes every review of its items, including receipt replays.
  return proposalRun(db, classId, runId).forUpdate().executeTakeFirst();
}

export function listProposalItems(db: Kysely<Database>, classId: string, runId: string) {
  return db.selectFrom("proposal_items").selectAll().select(sql<string[]>`ARRAY(
    SELECT depends_on_item_id FROM proposal_item_dependencies
    WHERE proposal_item_id = proposal_items.id ORDER BY depends_on_item_id
  )`.as("dependency_ids"))
    .where("class_id", "=", classId).where("proposal_run_id", "=", runId)
    .orderBy("created_at").orderBy("id").execute();
}

export async function claimProposalDecisionReceipt(
  db: Transaction<Database>, values: Insertable<Database["proposal_decision_receipts"]>,
) {
  const inserted = await db.insertInto("proposal_decision_receipts").values(values)
    .onConflict((conflict) => conflict.columns(["actor_user_id", "client_request_id"]).doNothing())
    .returning("client_request_id").executeTakeFirst();
  if (inserted) return { inserted: true } as const;

  const receipt = await db.selectFrom("proposal_decision_receipts").selectAll()
    .where("actor_user_id", "=", values.actor_user_id).where("client_request_id", "=", values.client_request_id)
    .executeTakeFirstOrThrow();
  return { inserted: false, receipt } as const;
}

type ItemDecision = Pick<Updateable<Database["proposal_items"]>,
  "status" | "teacher_patch" | "decided_by_user_id" | "decided_at" | "result_entity_type" | "result_entity_id">;

export function recordProposalDecision(
  db: Transaction<Database>, classId: string, runId: string, itemId: string, decision: ItemDecision,
) {
  return db.updateTable("proposal_items").set(decision)
    .where("class_id", "=", classId).where("proposal_run_id", "=", runId)
    .where("id", "=", itemId).where("status", "=", "PENDING")
    .returning("id").executeTakeFirstOrThrow();
}

export async function updateProposalReviewStatus(db: Transaction<Database>, classId: string, runId: string, now: Date) {
  const counts = await db.selectFrom("proposal_items")
    .select(({ fn }) => [fn.countAll<string>().as("total"), fn.countAll<string>()
      .filterWhere("status", "in", ["APPROVED", "REJECTED"]).as("decided")])
    .where("class_id", "=", classId).where("proposal_run_id", "=", runId).executeTakeFirstOrThrow();
  const status = counts.decided === "0" ? "READY" : counts.decided === counts.total ? "APPLIED" : "PARTIALLY_REVIEWED";
  return db.updateTable("proposal_runs").set({ status, updated_at: now })
    .where("class_id", "=", classId).where("id", "=", runId).returningAll().executeTakeFirstOrThrow();
}
