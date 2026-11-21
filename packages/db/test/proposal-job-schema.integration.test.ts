import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildClass } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { createDb } from "../src/client.ts";
import type { Database } from "../src/database.ts";
import { runMigrations } from "../src/migrate.ts";
import { insertProposalItemDependency } from "@tutorloop/db/repositories/proposals";

describe("proposal, job, and audit PostgreSQL schema", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let db: Kysely<Database>;
  let classroom: ReturnType<typeof buildClass>;
  let rawNoteId: string;
  let now: Date;

  beforeAll(async () => {
    postgres = await startPostgres();
    db = createDb(postgres.getConnectionUri());
    await runMigrations(db);
  }, 120_000);

  afterAll(async () => {
    try {
      await db?.destroy();
    } finally {
      await postgres?.stop();
    }
  }, 30_000);

  beforeEach(async () => {
    now = new Date();
    classroom = buildClass();
    rawNoteId = randomUUID();
    await db.insertInto("classes").values(classroom).execute();
    await db.insertInto("raw_notes").values({
      id: rawNoteId,
      class_id: classroom.id,
      author_user_id: classroom.owner_user_id,
      note_type: "OBSERVATION",
      body: "Student identified the denominator.",
      observed_at: now,
      created_at: now,
    }).execute();
  });

  function job() {
    return {
      id: randomUUID(),
      kind: "STRUCTURE_RAW_NOTE",
      dedupe_key: randomUUID(),
      payload: { classId: classroom.id, rawNoteId },
      status: "QUEUED" as const,
      run_after: now,
      created_at: now,
      updated_at: now,
    };
  }

  async function insertRun() {
    const sourceJob = job();
    await db.insertInto("jobs").values(sourceJob).execute();
    return db.insertInto("proposal_runs").values({
      id: randomUUID(),
      class_id: classroom.id,
      raw_note_id: rawNoteId,
      source_job_id: sourceJob.id,
      status: "PROCESSING",
      schema_version: "1",
      created_at: now,
      updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async function insertItem(runId: string) {
    const id = randomUUID();
    await db.insertInto("proposal_items").values({
      id,
      class_id: classroom.id,
      proposal_run_id: runId,
      item_type: "CREATE_CANONICAL_ISSUE",
      original_payload: { type: "CREATE_CANONICAL_ISSUE", key: id, label: "Fraction equivalence" },
      status: "PENDING",
      created_at: now,
    }).execute();
    return id;
  }

  it("rejects duplicate job dedupe keys", async () => {
    const queuedJob = job();
    await db.insertInto("jobs").values(queuedJob).execute();
    await expect(db.insertInto("jobs").values({ ...queuedJob, id: randomUUID() }).execute())
      .rejects.toMatchObject({ code: "23505", constraint: "jobs_dedupe_key_key" });
  });

  it("rejects a second proposal run for the same job", async () => {
    const run = await insertRun();
    await expect(db.insertInto("proposal_runs").values({ ...run, id: randomUUID() }).execute())
      .rejects.toMatchObject({ code: "23505", constraint: "proposal_runs_source_job_id_key" });
  });

  it("persists a dependency on another item in the same run", async () => {
    const run = await insertRun();
    const itemId = await insertItem(run.id);
    const dependsOnItemId = await insertItem(run.id);

    await insertProposalItemDependency(db, itemId, dependsOnItemId);

    await expect(db.selectFrom("proposal_item_dependencies").selectAll()
      .where("proposal_item_id", "=", itemId).execute())
      .resolves.toEqual([{ proposal_item_id: itemId, depends_on_item_id: dependsOnItemId }]);
  });

  it("rejects a dependency across runs in the same class", async () => {
    const firstRun = await insertRun();
    const secondRun = await insertRun();
    const itemId = await insertItem(firstRun.id);
    const dependsOnItemId = await insertItem(secondRun.id);

    await expect(insertProposalItemDependency(db, itemId, dependsOnItemId))
      .rejects.toThrow("Proposal dependency must reference items in the same run.");
    await expect(db.selectFrom("proposal_item_dependencies").selectAll()
      .where("proposal_item_id", "=", itemId).execute()).resolves.toEqual([]);
  });

  it("stores AI execution provenance and input hash", async () => {
    const run = await insertRun();
    const id = randomUUID();
    await db.insertInto("ai_runs").values({
      id,
      class_id: classroom.id,
      proposal_run_id: run.id,
      task_type: "STRUCTURE_OBSERVATION_NOTE",
      provider: "FAKE",
      model: "fixture-model",
      prompt_version: "structure-note-v1",
      schema_version: "1",
      redaction_version: "aliases-v1",
      input_hash: "a".repeat(64),
      status: "SUCCESS",
      created_at: now,
    }).execute();

    await expect(db.selectFrom("ai_runs")
      .select(["provider", "model", "prompt_version", "schema_version", "redaction_version", "input_hash"])
      .where("id", "=", id).executeTakeFirstOrThrow()).resolves.toEqual({
      provider: "FAKE",
      model: "fixture-model",
      prompt_version: "structure-note-v1",
      schema_version: "1",
      redaction_version: "aliases-v1",
      input_hash: "a".repeat(64),
    });
  });

  it("rejects a proposal run that links to a raw note from another class", async () => {
    const run = await insertRun();
    const otherClassroom = buildClass();
    const sourceJob = job();
    await db.insertInto("classes").values(otherClassroom).execute();
    await db.insertInto("jobs").values(sourceJob).execute();

    await expect(db.insertInto("proposal_runs").values({
      ...run, id: randomUUID(), class_id: otherClassroom.id, source_job_id: sourceJob.id,
    }).execute()).rejects.toMatchObject({ code: "23503" });
  });

  it("persists metadata-only audit and product records", async () => {
    const metadata = {
      class_id: classroom.id,
      actor_user_id: classroom.owner_user_id,
      entity_id: rawNoteId,
      created_at: now,
    };
    const audit = { ...metadata, id: randomUUID(), action: "raw_note_created", entity_type: "raw_note" };
    const event = { ...metadata, id: randomUUID(), event_name: "raw_note_created" as const };

    await expect(db.insertInto("audit_log").values(audit).returningAll().executeTakeFirstOrThrow())
      .resolves.toEqual(audit);
    await expect(db.insertInto("product_events").values(event).returningAll().executeTakeFirstOrThrow())
      .resolves.toEqual(event);
  });
});
