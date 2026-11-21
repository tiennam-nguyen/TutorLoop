import type { Kysely } from "kysely";
import type { Database } from "../database.ts";

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
