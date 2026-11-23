import type { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { createDb } from "./client.ts";
import type { Database } from "./database.ts";
import * as core from "./migrations/001_core.ts";
import * as proposalsJobsAudit from "./migrations/002_proposals_jobs_audit.ts";
import * as betterAuth from "./migrations/003_better_auth.ts";
import * as classStudentCreateReceipts from "./migrations/004_class_student_create_receipts.ts";
import * as proposalDecisionReceipts from "./migrations/005_proposal_decision_receipts.ts";
import * as studentIssueTransitionOrder from "./migrations/006_student_issue_transition_order.ts";
import * as interventionCreateRequest from "./migrations/007_intervention_create_request.ts";
import * as reassessmentCreateRequest from "./migrations/008_reassessment_create_request.ts";

export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return {
          "001_core": core,
          "002_proposals_jobs_audit": proposalsJobsAudit,
          "003_better_auth": betterAuth,
          "004_class_student_create_receipts": classStudentCreateReceipts,
          "005_proposal_decision_receipts": proposalDecisionReceipts,
          "006_student_issue_transition_order": studentIssueTransitionOrder,
          "007_intervention_create_request": interventionCreateRequest,
          "008_reassessment_create_request": reassessmentCreateRequest,
        };
      },
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error !== undefined) {
    throw error;
  }
}

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.trim()) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const db = createDb(connectionString);
  try {
    await runMigrations(db);
  } finally {
    await db.destroy();
  }
}
