import type { Insertable, Transaction } from "kysely";
import type { Database } from "../database.ts";
import { exactTimestamptz } from "./raw-notes.ts";

type ProposalEvidence = Omit<Insertable<Database["evidence_events"]>, "observed_at" | "provenance">;

export function insertProposalEvidence(db: Transaction<Database>, values: ProposalEvidence, observedAt?: string) {
  // Copy the original timestamptz in PostgreSQL to retain its full precision.
  const observed = observedAt === undefined
    ? db.selectFrom("raw_notes").select("observed_at")
      .where("id", "=", values.raw_note_id).where("class_id", "=", values.class_id)
    : exactTimestamptz(observedAt);
  return db.insertInto("evidence_events")
    .values({ ...values, observed_at: observed, provenance: "AI_PROPOSED_TEACHER_APPROVED" })
    .returning("id").executeTakeFirstOrThrow();
}
