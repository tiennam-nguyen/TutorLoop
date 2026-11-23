import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { createDb } from "../src/client.ts";
import { runMigrations } from "../src/migrate.ts";
import { getValidationMetrics } from "../src/repositories/validation-metrics.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00Z`);
beforeAll(async () => {
  postgres = await startPostgres(); db = createDb(postgres.getConnectionUri()); await runMigrations(db);
}, 120_000);
afterAll(async () => { try { await db?.destroy(); } finally { await postgres?.stop(); } });

async function fixture() {
  const classroom = { ...buildClass(), timezone: "Asia/Bangkok", name: "SYNTHETIC_CLASS" };
  const student = { ...buildStudent(classroom.id), display_label: "SYNTHETIC_STUDENT" };
  const canonical = buildCanonicalIssue(classroom.id);
  const issueId = randomUUID(); const otherIssueId = randomUUID(); const otherCanonical = buildCanonicalIssue(classroom.id);
  await db.insertInto("classes").values(classroom).execute();
  await db.insertInto("students").values(student).execute();
  await db.insertInto("canonical_issues").values([canonical, otherCanonical]).execute();
  await db.insertInto("student_issues").values([canonical, otherCanonical].map((row, index) => ({
    id: index ? otherIssueId : issueId, class_id: classroom.id, student_id: student.id,
    canonical_issue_id: row.id, state: "OPEN" as const, created_at: at(1), updated_at: at(1),
  }))).execute();
  const interventionId = randomUUID(); const reassessmentId = randomUUID(); const evidenceIds = [randomUUID(), randomUUID()];
  await db.insertInto("interventions").values({ id: interventionId, class_id: classroom.id, description: "SYNTHETIC_INTERVENTION",
    occurred_at: at(3), created_by_user_id: classroom.owner_user_id, created_at: at(3) }).execute();
  await db.insertInto("intervention_targets").values({ class_id: classroom.id, intervention_id: interventionId, student_issue_id: issueId }).execute();
  await db.insertInto("reassessments").values({ id: reassessmentId, class_id: classroom.id, due_at: at(4), performed_at: at(5),
    status: "COMPLETED", completed_at: at(8), created_by_user_id: classroom.owner_user_id, created_at: at(3), updated_at: at(8) }).execute();
  await db.insertInto("reassessment_targets").values({ class_id: classroom.id, reassessment_id: reassessmentId,
    student_issue_id: issueId, intervention_id: interventionId, target_status: "EVIDENCED" }).execute();
  const noteIds = [randomUUID(), randomUUID()];
  await db.insertInto("raw_notes").values(noteIds.map((id, index) => ({ id, class_id: classroom.id,
    author_user_id: classroom.owner_user_id, note_type: index ? "REASSESSMENT_OUTCOME" as const : "OBSERVATION" as const,
    reassessment_id: index ? reassessmentId : null, body: "SYNTHETIC_NOTE", observed_at: index ? at(6) : new Date("2026-10-01T18:00:00Z"),
    created_at: at(8),
  }))).execute();
  await db.insertInto("evidence_events").values(evidenceIds.map((id, index) => ({ id, class_id: classroom.id, student_id: student.id,
    raw_note_id: noteIds[index], student_issue_id: issueId, reassessment_id: index ? reassessmentId : null,
    observation_text: "SYNTHETIC_EVIDENCE", observed_at: index ? at(6) : at(2), provenance: "TEACHER_DIRECT" as const,
    approved_by_user_id: classroom.owner_user_id, created_at: at(8),
  }))).execute();
  const transitionId = randomUUID();
  await db.insertInto("student_issue_transitions").values({ id: transitionId, class_id: classroom.id,
    student_issue_id: issueId, from_state: "OPEN", to_state: "IMPROVING", evidence_event_id: evidenceIds[1],
    actor_user_id: classroom.owner_user_id, created_at: at(9) }).execute();
  return { classroom, issueId, otherIssueId, interventionId, reassessmentId, evidenceIds, transitionId, noteIds };
}

test("counts distinct canonical loops and due follow-through, using educational time and Class-local capture days", async () => {
  const f = await fixture();
  // Forged client analytics do not establish canonical loops or proposal decisions.
  await db.insertInto("product_events").values({ id: randomUUID(), class_id: f.classroom.id,
    actor_user_id: f.classroom.owner_user_id, event_name: "proposal_item_approved", entity_id: randomUUID(), created_at: at(9) }).execute();
  const metrics = await getValidationMetrics(db, f.classroom.owner_user_id);
  expect(metrics.closedLoopStudentIssueCount).toBe(1);
  expect(metrics.reassessmentFollowThroughCount).toBe(1);
  expect(metrics.proposalDecisions).toEqual({ approved: 0, edited: 0, rejected: 0 });
  expect(metrics.rawNotesByClassAndDay).toEqual([
    { classId: f.classroom.id, day: "2026-10-02", count: 1 }, { classId: f.classroom.id, day: "2026-10-06", count: 1 },
  ]);
  expect((await getValidationMetrics(db, randomUUID())).closedLoopStudentIssueCount).toBe(0);
});

test.each(["other-issue", "wrong-intervention", "intervention-after", "initial-after-intervention", "old-evidence", "initial-transition", "old-transition", "no-change", "foreign-actor", "cancelled"])(
  "rejects an apparent loop with %s", async (variant) => {
    const f = await fixture();
    if (variant === "other-issue") await db.updateTable("evidence_events").set({ student_issue_id: f.otherIssueId }).where("id", "=", f.evidenceIds[1]).execute();
    if (variant === "wrong-intervention") {
      await db.deleteFrom("intervention_targets").where("intervention_id", "=", f.interventionId).execute();
      await db.insertInto("intervention_targets").values({ class_id: f.classroom.id, intervention_id: f.interventionId,
        student_issue_id: f.otherIssueId }).execute();
    }
    if (variant === "old-evidence") await db.updateTable("evidence_events").set({ observed_at: at(1) }).where("id", "=", f.evidenceIds[1]).execute();
    if (variant === "intervention-after") await db.updateTable("interventions").set({ occurred_at: at(7) }).where("id", "=", f.interventionId).execute();
    if (variant === "initial-after-intervention") await db.updateTable("evidence_events").set({ observed_at: at(4) }).where("id", "=", f.evidenceIds[0]).execute();
    if (variant === "initial-transition") await db.updateTable("student_issue_transitions").set({ from_state: null }).where("id", "=", f.transitionId).execute();
    if (variant === "old-transition") await db.updateTable("student_issue_transitions").set({ created_at: at(7) }).where("id", "=", f.transitionId).execute();
    if (variant === "no-change") await db.updateTable("student_issue_transitions").set({ to_state: "OPEN" }).where("id", "=", f.transitionId).execute();
    if (variant === "foreign-actor") await db.updateTable("student_issue_transitions").set({ actor_user_id: "other-teacher" }).where("id", "=", f.transitionId).execute();
    if (variant === "cancelled") await db.updateTable("reassessments").set({ status: "CANCELLED" }).where("id", "=", f.reassessmentId).execute();
    expect((await getValidationMetrics(db, f.classroom.owner_user_id)).closedLoopStudentIssueCount).toBe(0);
  },
);

test("optional intervention links and retained canonical outcomes do not hide complete workflows", async () => {
  const f = await fixture();
  await db.updateTable("reassessment_targets").set({ intervention_id: null }).where("reassessment_id", "=", f.reassessmentId).execute();
  await db.updateTable("reassessments").set({ status: "SCHEDULED", performed_at: null }).where("id", "=", f.reassessmentId).execute();
  await db.updateTable("raw_notes").set({ voided_at: at(10) }).where("id", "in", f.noteIds).execute();
  const metrics = await getValidationMetrics(db, f.classroom.owner_user_id);
  expect(metrics.closedLoopStudentIssueCount).toBe(1);
  expect(metrics.reassessmentFollowThroughCount).toBe(1);
});

test("counts views by owning actor only, and counts a canonical loop once across multiple transitions", async () => {
  const f = await fixture();
  await db.insertInto("student_issue_transitions").values({ id: randomUUID(), class_id: f.classroom.id, student_issue_id: f.issueId,
    from_state: "IMPROVING", to_state: "RESOLVED_FOR_NOW", actor_user_id: f.classroom.owner_user_id, created_at: at(10) }).execute();
  await db.insertInto("product_events").values([f.classroom.owner_user_id, "someone_else"].map((actor) => ({
    id: randomUUID(), class_id: f.classroom.id, actor_user_id: actor, event_name: "history_opened" as const,
    entity_id: f.issueId, created_at: at(10),
  }))).execute();
  const metrics = await getValidationMetrics(db, f.classroom.owner_user_id);
  expect(metrics.closedLoopStudentIssueCount).toBe(1);
  expect(metrics.historyOpenCount).toBe(1);
  expect(metrics.viewEvents).toEqual({ proposal_review_opened: 0, student_view_opened: 0, class_issue_view_opened: 0,
    reassessment_due_opened: 0, history_opened: 1 });
  expect((await getValidationMetrics(db, "someone_else")).historyOpenCount).toBe(0);
});

test("report CLI prints agreed aggregates only and uses a generic failure", async () => {
  const f = await fixture();
  const script = fileURLToPath(new URL("../../../scripts/validation-report.ts", import.meta.url));
  const execute = promisify(execFile);
  const { stdout, stderr } = await execute(process.execPath, [script, "--owner-user-id", f.classroom.owner_user_id], {
    env: { ...process.env, DATABASE_URL: postgres.getConnectionUri() },
  });
  expect(stderr).toBe("");
  expect(stdout).not.toContain("SYNTHETIC");
  expect(JSON.parse(stdout)).toEqual(await getValidationMetrics(db, f.classroom.owner_user_id));
  await expect(execute(process.execPath, [script, "--invalid", "SYNTHETIC_SECRET"], { env: { ...process.env, DATABASE_URL: "SYNTHETIC_SECRET" } }))
    .rejects.toMatchObject({ stdout: "", stderr: "Validation report failed.\n" });
});
