import { randomUUID } from "node:crypto";
import { studentOverviewDtoSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
const teacherA = randomUUID();
const teacherB = randomUUID();
const observedAt = "2026-11-20T07:00:00Z";
const path = (id: string) => `/api/v1/classes/${id}`;

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherA) });
}, 120_000);

afterAll(async () => {
  try { await app?.close(); await db?.destroy(); } finally { await postgres?.stop(); }
});

async function seed(owner: string) {
  const classroom = { ...buildClass(), owner_user_id: owner };
  const student = buildStudent(classroom.id);
  const canonical = buildCanonicalIssue(classroom.id);
  const ids = { issue: randomUUID(), note: randomUUID(), evidence: randomUUID(), job: randomUUID(),
    run: randomUUID(), item: randomUUID(), intervention: randomUUID(), reassessment: randomUUID() };
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("classes").values(classroom).execute();
    await trx.insertInto("students").values(student).execute();
    await trx.insertInto("canonical_issues").values(canonical).execute();
    await trx.insertInto("student_issues").values({ id: ids.issue, class_id: classroom.id,
      student_id: student.id, canonical_issue_id: canonical.id, state: "OPEN", created_at: now, updated_at: now }).execute();
    await trx.insertInto("raw_notes").values({ id: ids.note, class_id: classroom.id, author_user_id: owner,
      body: "Synthetic private observation", note_type: "OBSERVATION", observed_at: new Date(observedAt), created_at: now }).execute();
    await trx.insertInto("evidence_events").values({ id: ids.evidence, class_id: classroom.id, student_id: student.id,
      student_issue_id: ids.issue, raw_note_id: ids.note, observation_text: "Synthetic private evidence",
      observed_at: new Date(observedAt), provenance: "TEACHER_DIRECT", approved_by_user_id: owner, created_at: now }).execute();
    await trx.insertInto("jobs").values({ id: ids.job, dedupe_key: ids.job, kind: "STRUCTURE_RAW_NOTE",
      payload: { classId: classroom.id, rawNoteId: ids.note }, status: "SUCCEEDED", run_after: now, created_at: now, updated_at: now }).execute();
    await trx.insertInto("proposal_runs").values({ id: ids.run, class_id: classroom.id, raw_note_id: ids.note,
      source_job_id: ids.job, status: "READY", schema_version: "1", created_at: now, updated_at: now }).execute();
    await trx.insertInto("proposal_items").values({ id: ids.item, class_id: classroom.id, proposal_run_id: ids.run,
      item_type: "CREATE_EVIDENCE", status: "PENDING", original_payload: { key: "e", type: "CREATE_EVIDENCE",
        studentRef: { kind: "RESOLVED", studentAlias: student.ai_alias }, observationText: "Synthetic approval" }, created_at: now }).execute();
    await trx.insertInto("interventions").values({ id: ids.intervention, class_id: classroom.id, description: "Synthetic practice",
      occurred_at: now, created_by_user_id: owner, created_at: now }).execute();
    await trx.insertInto("intervention_targets").values({ class_id: classroom.id, intervention_id: ids.intervention,
      student_issue_id: ids.issue }).execute();
    await trx.insertInto("reassessments").values({ id: ids.reassessment, class_id: classroom.id, status: "SCHEDULED",
      due_at: now, created_by_user_id: owner, created_at: now, updated_at: now }).execute();
    await trx.insertInto("reassessment_targets").values({ class_id: classroom.id, reassessment_id: ids.reassessment,
      student_issue_id: ids.issue, intervention_id: ids.intervention, target_status: "PENDING" }).execute();
  });
  return { ...ids, classroom, student, canonical };
}

// Include links, receipts, operational jobs and analytics: an error must leave no partial work anywhere.
const tables = ["classes", "students", "raw_notes", "canonical_issues", "student_issues", "evidence_events",
  "student_issue_transitions", "interventions", "intervention_targets", "reassessments", "reassessment_targets",
  "jobs", "proposal_runs", "proposal_items", "proposal_item_dependencies", "proposal_decision_receipts",
  "ai_runs", "audit_log", "product_events"] as const;
async function snapshot() {
  return Promise.all(tables.map(async (table) => ({ table,
    rows: (await db.selectFrom(table).selectAll().execute()).map((row) => JSON.stringify(row)).sort(),
  })));
}

test("Teacher A cannot read or mutate Teacher B's objects, nor substitute their IDs under an owned Class", async () => {
  const own = await seed(teacherA);
  const foreign = await seed(teacherB);
  const foreignApp = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherB) });
  try {
    const allowed = await foreignApp.inject(`${path(foreign.classroom.id)}/students/${foreign.student.id}/overview`);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(studentOverviewDtoSchema.parse(allowed.json()).evidence.map(({ id }) => id)).toEqual([foreign.evidence]);
  } finally { await foreignApp.close(); }
  const before = await snapshot();
  // Both a foreign Class path and a foreign child inside an owned path must fail ownership/scoping.
  for (const classId of [foreign.classroom.id, own.classroom.id]) {
    const root = path(classId);
    const operations = [
      { method: "GET", url: `${root}/students/${foreign.student.id}/overview` }, // Evidence is exposed through this projection.
      { method: "PATCH", url: `${root}/students/${foreign.student.id}`, payload: { expectedVersion: 1, displayLabel: "Changed" } },
      { method: "POST", url: `${root}/students/${foreign.student.id}/archive`, payload: { expectedVersion: 1 } },
      { method: "GET", url: `${root}/raw-notes/${foreign.note}` },
      { method: "POST", url: `${root}/raw-notes/${foreign.note}/void`, payload: {} },
      { method: "POST", url: `${root}/raw-notes/${foreign.note}/reprocess`, payload: { clientRequestId: randomUUID() } },
      { method: "GET", url: `${root}/issues/${foreign.canonical.id}` },
      { method: "PATCH", url: `${root}/canonical-issues/${foreign.canonical.id}`, payload: { expectedVersion: 1, label: "Changed" } },
      { method: "POST", url: `${root}/canonical-issues/${foreign.canonical.id}/merge`, payload: {
        targetCanonicalIssueId: own.canonical.id, expectedSourceVersion: 1, expectedTargetVersion: 1 } },
      { method: "PATCH", url: `${root}/student-issues/${foreign.issue}/state`, payload: { expectedVersion: 1, toState: "IMPROVING" } },
      { method: "PATCH", url: `${root}/student-issues/${foreign.issue}/manifestation`, payload: { expectedVersion: 1, manifestation: "Changed" } },
      { method: "GET", url: `${root}/interventions/${foreign.intervention}` },
      { method: "GET", url: `${root}/reassessments/${foreign.reassessment}` },
      { method: "POST", url: `${root}/reassessments/${foreign.reassessment}/mark-performed`, payload: { expectedVersion: 1 } },
      { method: "POST", url: `${root}/reassessments/${foreign.reassessment}/cancel`, payload: { expectedVersion: 1 } },
      { method: "POST", url: `${root}/reassessments/${foreign.reassessment}/outcome-note`, payload: {
        body: "Synthetic outcome", observedAt, clientRequestId: randomUUID() } },
      { method: "POST", url: `${root}/reassessments/${foreign.reassessment}/targets/${foreign.issue}/skip`, payload: {
        expectedVersion: 1, skipReason: "Absent" } },
      { method: "GET", url: `${root}/proposal-runs/${foreign.run}` },
      { method: "POST", url: `${root}/proposal-runs/${foreign.run}/decisions`, payload: {
        clientRequestId: randomUUID(), items: [{ proposalItemId: foreign.item, decision: "APPROVE" }] } },
    ] as const;
    for (const operation of operations) {
      const response = await app.inject(operation);
      expect(response.statusCode, `${operation.method} ${operation.url}: ${response.body}`).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(await snapshot(), operation.url).toEqual(before);
    }
  }
  for (const classId of [foreign.classroom.id, randomUUID()]) {
    for (const operation of [
      { method: "GET", url: path(classId) },
      { method: "GET", url: `${path(classId)}/overview` },
      { method: "GET", url: `${path(classId)}/issues` },
      { method: "PATCH", url: path(classId), payload: { expectedVersion: 1, name: "Changed" } },
      { method: "POST", url: `${path(classId)}/archive`, payload: { expectedVersion: 1 } },
    ] as const) {
      const response = await app.inject(operation);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(await snapshot()).toEqual(before);
    }
  }
  for (const operation of [
    { url: `${path(foreign.classroom.id)}/students`, payload: {
      displayLabel: "Synthetic learner", clientRequestId: randomUUID() } },
    { url: `${path(foreign.classroom.id)}/raw-notes`, payload: {
      body: "Synthetic observation", observedAt, noteType: "OBSERVATION", clientRequestId: randomUUID() } },
    { url: `${path(foreign.classroom.id)}/interventions`, payload: {
      description: "Synthetic practice", occurredAt: observedAt, studentIssueIds: [foreign.issue],
      clientRequestId: randomUUID() } },
    { url: `${path(foreign.classroom.id)}/reassessments`, payload: {
      dueAt: observedAt, studentIssueIds: [foreign.issue], clientRequestId: randomUUID() } },
    { url: `${path(own.classroom.id)}/canonical-issues/${own.canonical.id}/merge`, payload: {
      targetCanonicalIssueId: foreign.canonical.id, expectedSourceVersion: 1, expectedTargetVersion: 1 } },
    { url: `${path(own.classroom.id)}/reassessments/${own.reassessment}/targets/${foreign.issue}/skip`, payload: {
      expectedVersion: 1, skipReason: "Absent" } },
  ] as const) {
    const response = await app.inject({ method: "POST", ...operation });
    expect(response.statusCode, `${operation.url}: ${response.body}`).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await snapshot(), operation.url).toEqual(before);
  }
  const allowed = await app.inject(`${path(own.classroom.id)}/students/${own.student.id}/overview`);
  expect(allowed.statusCode, allowed.body).toBe(200);
  expect(studentOverviewDtoSchema.parse(allowed.json()).evidence.map(({ id }) => id)).toEqual([own.evidence]);
  expect(await snapshot()).toEqual(before);
});

test("two owned Classes cannot link a foreign StudentIssue through Intervention, Reassessment or Proposal patch", async () => {
  const a = await seed(teacherA);
  const b = await seed(teacherA);
  const before = await snapshot();
  const root = path(a.classroom.id);
  const key = randomUUID();
  for (const operation of [
    { method: "POST", url: `${root}/interventions`, payload: { description: "Synthetic practice", occurredAt: observedAt,
      studentIssueIds: [a.issue, b.issue], clientRequestId: key } },
    { method: "POST", url: `${root}/reassessments`, payload: { dueAt: observedAt,
      studentIssueIds: [a.issue, b.issue], clientRequestId: key } },
    { method: "POST", url: `${root}/proposal-runs/${a.run}/decisions`, payload: { clientRequestId: key,
      items: [{ proposalItemId: a.item, decision: "EDIT_AND_APPROVE", patch: {
        studentIssueRef: { kind: "EXISTING", studentIssueId: b.issue } } }] } },
  ] as const) {
    const response = await app.inject(operation);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await snapshot()).toEqual(before);
  }
  // A failed request did not consume its receipt or leave a partial group Intervention.
  const corrected = await app.inject({ method: "POST", url: `${root}/interventions`, payload: {
    description: "Synthetic practice", occurredAt: observedAt, studentIssueIds: [a.issue], clientRequestId: key,
  } });
  expect(corrected.statusCode, corrected.body).toBe(201);
  expect(await db.selectFrom("intervention_targets").selectAll()
    .where("intervention_id", "=", corrected.json().id).execute()).toEqual([
    { class_id: a.classroom.id, intervention_id: corrected.json().id, student_issue_id: a.issue },
  ]);
  const scheduled = await app.inject({ method: "POST", url: `${root}/reassessments`, payload: {
    dueAt: observedAt, studentIssueIds: [a.issue], clientRequestId: key,
  } });
  expect(scheduled.statusCode, scheduled.body).toBe(201);
  expect(await db.selectFrom("reassessment_targets").select(["class_id", "student_issue_id"])
    .where("reassessment_id", "=", scheduled.json().id).execute())
    .toEqual([{ class_id: a.classroom.id, student_issue_id: a.issue }]);
});

test("unknown object IDs under an owned Class return NOT_FOUND with no persisted work", async () => {
  const f = await seed(teacherA);
  const root = path(f.classroom.id);
  const missing = randomUUID();
  const before = await snapshot();
  for (const operation of [
    { method: "GET", url: `${root}/students/${missing}/overview` },
    { method: "PATCH", url: `${root}/students/${missing}`, payload: { expectedVersion: 1, displayLabel: "Changed" } },
    { method: "GET", url: `${root}/raw-notes/${missing}` },
    { method: "POST", url: `${root}/raw-notes/${missing}/void`, payload: {} },
    { method: "GET", url: `${root}/issues/${missing}` },
    { method: "PATCH", url: `${root}/canonical-issues/${missing}`, payload: { expectedVersion: 1, label: "Changed" } },
    { method: "PATCH", url: `${root}/student-issues/${missing}/state`, payload: { expectedVersion: 1, toState: "IMPROVING" } },
    { method: "GET", url: `${root}/interventions/${missing}` },
    { method: "GET", url: `${root}/reassessments/${missing}` },
    { method: "POST", url: `${root}/reassessments/${missing}/mark-performed`, payload: { expectedVersion: 1 } },
    { method: "GET", url: `${root}/proposal-runs/${missing}` },
    { method: "POST", url: `${root}/proposal-runs/${missing}/decisions`, payload: {
      clientRequestId: randomUUID(), items: [{ proposalItemId: f.item, decision: "APPROVE" }] } },
  ] as const) {
    const response = await app.inject(operation);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await snapshot()).toEqual(before);
  }
});

test("owning-teacher controls prove the isolation matrix uses registered routes and valid mutation inputs", async () => {
  const f = await seed(teacherA);
  const root = path(f.classroom.id);
  for (const url of [root, `${root}/overview`, `${root}/issues`, `${root}/students/${f.student.id}/overview`,
    `${root}/raw-notes/${f.note}`, `${root}/issues/${f.canonical.id}`, `${root}/interventions/${f.intervention}`,
    `${root}/reassessments/${f.reassessment}`, `${root}/proposal-runs/${f.run}`]) {
    const response = await app.inject(url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
  }
  for (const operation of [
    { method: "PATCH", url: root, payload: { expectedVersion: 1, name: "Changed" } },
    { method: "PATCH", url: `${root}/students/${f.student.id}`, payload: { expectedVersion: 1, displayLabel: "Changed" } },
    { method: "PATCH", url: `${root}/canonical-issues/${f.canonical.id}`, payload: { expectedVersion: 1, label: "Changed" } },
    { method: "PATCH", url: `${root}/student-issues/${f.issue}/state`, payload: { expectedVersion: 1, toState: "IMPROVING" } },
    { method: "PATCH", url: `${root}/student-issues/${f.issue}/manifestation`, payload: { expectedVersion: 2, manifestation: "Changed" } },
    { method: "POST", url: `${root}/reassessments/${f.reassessment}/mark-performed`, payload: { expectedVersion: 1 } },
    { method: "POST", url: `${root}/reassessments/${f.reassessment}/cancel`, payload: { expectedVersion: 2 } },
    { method: "POST", url: `${root}/proposal-runs/${f.run}/decisions`, payload: { clientRequestId: randomUUID(),
      items: [{ proposalItemId: f.item, decision: "APPROVE" }] } },
    { method: "POST", url: `${root}/raw-notes/${f.note}/void`, payload: {} },
  ] as const) {
    const response = await app.inject(operation);
    expect(response.statusCode, `${operation.method} ${operation.url}: ${response.body}`).toBe(200);
  }
  for (const url of [`${root}/students/${f.student.id}/archive`, `${root}/archive`]) {
    const response = await app.inject({ method: "POST", url, payload: { expectedVersion: 2 } });
    expect(response.statusCode, response.body).toBe(204);
  }
  // Reprocess has a DEAD/FAILED precondition; give this positive control its own eligible fixture.
  const failed = await seed(teacherA);
  await db.deleteFrom("proposal_items").where("id", "=", failed.item).execute();
  await db.updateTable("jobs").set({ status: "DEAD", attempts: 3 }).where("id", "=", failed.job).execute();
  await db.updateTable("proposal_runs").set({ status: "FAILED" }).where("id", "=", failed.run).execute();
  const reprocess = await app.inject({ method: "POST", url: `${path(failed.classroom.id)}/raw-notes/${failed.note}/reprocess`,
    payload: { clientRequestId: randomUUID() } });
  expect(reprocess.statusCode, reprocess.body).toBe(201);
  // The same within-Class Proposal patch shape rejected above is usable with a correctly scoped ID.
  const patchFixture = await seed(teacherA);
  const patched = await app.inject({ method: "POST", url: `${path(patchFixture.classroom.id)}/proposal-runs/${patchFixture.run}/decisions`,
    payload: { clientRequestId: randomUUID(), items: [{ proposalItemId: patchFixture.item, decision: "EDIT_AND_APPROVE",
      patch: { studentIssueRef: { kind: "EXISTING", studentIssueId: patchFixture.issue } } }] } });
  expect(patched.statusCode, patched.body).toBe(200);
});

test("owning-teacher controls exercise merge, outcome-note, target skip, and all four child creations", async () => {
  const f = await seed(teacherA);
  const root = path(f.classroom.id);
  const target = buildCanonicalIssue(f.classroom.id);
  await db.insertInto("canonical_issues").values(target).execute();
  let createdReassessmentId = "";
  for (const operation of [
    { url: `${root}/students`, payload: { displayLabel: "Synthetic learner", clientRequestId: randomUUID() } },
    { url: `${root}/raw-notes`, payload: {
      body: "Synthetic observation", observedAt, noteType: "OBSERVATION", clientRequestId: randomUUID() } },
    { url: `${root}/interventions`, payload: {
      description: "Synthetic practice", occurredAt: observedAt, studentIssueIds: [f.issue],
      clientRequestId: randomUUID() } },
    { url: `${root}/reassessments`, payload: {
      dueAt: observedAt, studentIssueIds: [f.issue], clientRequestId: randomUUID() } },
    { url: `${root}/reassessments/${f.reassessment}/outcome-note`, payload: {
      body: "Synthetic outcome", observedAt, clientRequestId: randomUUID() } },
  ] as const) {
    const response = await app.inject({ method: "POST", ...operation });
    expect(response.statusCode, `${operation.url}: ${response.body}`).toBe(201);
    if (operation.url.endsWith("/reassessments")) {
      createdReassessmentId = response.json<{ id: string }>().id;
    }
  }
  const merged = await app.inject({ method: "POST", url: `${root}/canonical-issues/${f.canonical.id}/merge`, payload: {
    targetCanonicalIssueId: target.id, expectedSourceVersion: 1, expectedTargetVersion: 1,
  } });
  expect(merged.statusCode, merged.body).toBe(200);
  // outcome-note promotes f.reassessment to v2 PERFORMED_PENDING_EVIDENCE; mark-performed exercises a fresh v1 SCHEDULED record
  const performed = await app.inject({ method: "POST", url: `${root}/reassessments/${createdReassessmentId}/mark-performed`,
    payload: { expectedVersion: 1 } });
  expect(performed.statusCode, performed.body).toBe(200);
  const skipped = await app.inject({ method: "POST", url: `${root}/reassessments/${f.reassessment}/targets/${f.issue}/skip`,
    payload: { expectedVersion: 2, skipReason: "Absent" } });
  expect(skipped.statusCode, skipped.body).toBe(200);
});
