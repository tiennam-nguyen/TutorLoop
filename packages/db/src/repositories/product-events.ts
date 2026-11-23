import { randomUUID } from "node:crypto";
import type { Insertable, Kysely } from "kysely";
import type { ProductViewEventName } from "@tutorloop/contracts";
import type { Database } from "../database.ts";

export async function insertProductEvent(
  db: Kysely<Database>, values: Pick<Insertable<Database["product_events"]>, "class_id" | "actor_user_id" | "event_name" | "entity_id">,
): Promise<void> {
  await db.insertInto("product_events").values({ id: randomUUID(), ...values, created_at: new Date() }).execute();
}

export async function viewEventEntityExists(db: Kysely<Database>, classId: string, eventName: ProductViewEventName, entityId: string) {
  const tables = eventName === "student_view_opened" ? ["students"] as const
    : eventName === "class_issue_view_opened" ? ["canonical_issues"] as const
    : eventName === "proposal_review_opened" ? ["proposal_runs"] as const
    : eventName === "reassessment_due_opened" ? ["reassessments"] as const
    : ["students", "canonical_issues", "student_issues", "evidence_events", "interventions", "raw_notes"] as const;
  for (const table of tables) {
    if (await db.selectFrom(table).select("id").where("class_id", "=", classId).where("id", "=", entityId).executeTakeFirst()) return true;
  }
  return false;
}
