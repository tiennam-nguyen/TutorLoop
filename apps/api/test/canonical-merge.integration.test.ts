import { randomUUID } from "node:crypto";
import { canonicalIssueDetailDtoSchema, canonicalIssueListDtoSchema, proposalRunDetailDtoSchema } from "@tutorloop/contracts";
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
const teacherId = randomUUID();
beforeAll(async () => {
  postgres = await startPostgres(); db = createDb(postgres.getConnectionUri()); await runMigrations(db);
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherId) });
}, 120_000);
afterAll(async () => { await app?.close(); await db?.destroy(); await postgres?.stop(); });

async function fixture() {
  const classroom = { ...buildClass(), owner_user_id: teacherId };
  await db.insertInto("classes").values(classroom).execute();
  const student = buildStudent(classroom.id);
  await db.insertInto("students").values(student).execute();
  const canonicals = ["Source", "Target", "Root"].map((label) => ({ ...buildCanonicalIssue(classroom.id), label }));
  await db.insertInto("canonical_issues").values(canonicals).execute();
  const issues = canonicals.map((canonical, index) => ({
    id: randomUUID(), class_id: classroom.id, student_id: student.id, canonical_issue_id: canonical.id,
    state: "OPEN" as const, manifestation: `Branch ${index}`, created_at: new Date(), updated_at: new Date(),
  }));
  await db.insertInto("student_issues").values(issues).execute();
  const noteId = randomUUID();
  await db.insertInto("raw_notes").values({ id: noteId, class_id: classroom.id, author_user_id: teacherId,
    body: "Keep history", note_type: "OBSERVATION", observed_at: new Date(), created_at: new Date() }).execute();
  const evidence = issues.map((issue) => ({ id: randomUUID(), class_id: classroom.id, student_id: student.id,
    student_issue_id: issue.id, raw_note_id: noteId, observation_text: issue.manifestation,
    provenance: "TEACHER_DIRECT" as const, approved_by_user_id: teacherId, observed_at: new Date(), created_at: new Date() }));
  await db.insertInto("evidence_events").values(evidence).execute();
  const api = `/api/v1/classes/${classroom.id}`;
  return { classroom, student, canonicals, issues, evidence, noteId, api };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function merge(f: Fixture, source = 0, target = 1, sourceVersion = 1, targetVersion = 1) {
  return app.inject({ method: "POST", url: `${f.api}/canonical-issues/${f.canonicals[source].id}/merge`, payload: {
    targetCanonicalIssueId: f.canonicals[target].id, expectedSourceVersion: sourceVersion, expectedTargetVersion: targetVersion,
  } });
}
async function snapshot(f: Fixture) {
  return { canonical: await db.selectFrom("canonical_issues").selectAll().where("class_id", "=", f.classroom.id).orderBy("id").execute(),
    issues: await db.selectFrom("student_issues").selectAll().where("class_id", "=", f.classroom.id).orderBy("id").execute(),
    evidence: await db.selectFrom("evidence_events").selectAll().where("class_id", "=", f.classroom.id).orderBy("id").execute() };
}
async function addMergeProposal(f: Fixture) {
  const now = new Date(), jobId = randomUUID(), runId = randomUUID(), itemId = randomUUID();
  await db.insertInto("jobs").values({ id: jobId, dedupe_key: jobId, kind: "STRUCTURE_RAW_NOTE", payload: {},
    status: "SUCCEEDED", run_after: now, created_at: now, updated_at: now }).execute();
  await db.insertInto("proposal_runs").values({ id: runId, class_id: f.classroom.id, raw_note_id: f.noteId,
    source_job_id: jobId, status: "READY", schema_version: "1", created_at: now, updated_at: now }).execute();
  await db.insertInto("proposal_items").values({ id: itemId, class_id: f.classroom.id, proposal_run_id: runId,
    item_type: "MERGE_CANONICAL_ISSUE", status: "PENDING", original_payload: { key: "merge", type: "MERGE_CANONICAL_ISSUE",
      sourceCanonicalIssueId: f.canonicals[0].id, targetCanonicalIssueId: f.canonicals[1].id,
      expectedSourceVersion: 1, expectedTargetVersion: 1 }, target_entity_type: "CANONICAL_ISSUE",
    target_entity_id: f.canonicals[0].id, base_version: 1, created_at: now }).execute();
  return { runId, itemId };
}

test("merge preserves canonical rows and historical IDs, collapses aliases transitively, and counts students once", async () => {
  const f = await fixture(), before = await snapshot(f);
  const response = await merge(f); expect(response.statusCode, response.body).toBe(200);
  const firstMerge = await snapshot(f);
  expect(firstMerge.canonical.find(({ id }) => id === f.canonicals[1].id)).toEqual(before.canonical.find(({ id }) => id === f.canonicals[1].id));
  expect(firstMerge.canonical.find(({ id }) => id === f.canonicals[2].id)).toEqual(before.canonical.find(({ id }) => id === f.canonicals[2].id));
  expect((await merge(f, 1, 2)).statusCode).toBe(200);
  const after = await snapshot(f);
  expect(after.canonical).toHaveLength(3);
  expect(after.issues).toEqual(before.issues); expect(after.evidence).toEqual(before.evidence);
  expect(after.canonical.find(({ id }) => id === f.canonicals[0].id)).toMatchObject({ merged_into_id: f.canonicals[1].id, version: 2 });
  const list = canonicalIssueListDtoSchema.parse((await app.inject(`${f.api}/issues`)).json());
  expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ id: f.canonicals[2].id, affectedStudents: 1, countsByState: { OPEN: 1, IMPROVING: 0, RESOLVED_FOR_NOW: 0 } });
  const detail = canonicalIssueDetailDtoSchema.parse((await app.inject(`${f.api}/issues/${f.canonicals[0].id}`)).json());
  expect(detail.id).toBe(f.canonicals[2].id);
  expect(detail.studentIssues.map(({ id }) => id).sort()).toEqual(f.issues.map(({ id }) => id).sort());
  expect(detail.studentIssues.map(({ canonicalIssueId }) => canonicalIssueId).sort()).toEqual(f.canonicals.map(({ id }) => id).sort());
  expect(detail.studentIssues.flatMap(({ evidenceIds }) => evidenceIds).sort()).toEqual(f.evidence.map(({ id }) => id).sort());
});

test("rejects cycles, self merge, cross-class and stale versions without writes", async () => {
  const f = await fixture(), other = await fixture();
  for (const payload of [
    { targetCanonicalIssueId: f.canonicals[0].id, expectedSourceVersion: 1, expectedTargetVersion: 1 },
    { targetCanonicalIssueId: other.canonicals[1].id, expectedSourceVersion: 1, expectedTargetVersion: 1 },
    { targetCanonicalIssueId: f.canonicals[1].id, expectedSourceVersion: 2, expectedTargetVersion: 1 },
    { targetCanonicalIssueId: f.canonicals[1].id, expectedSourceVersion: 1, expectedTargetVersion: 2 },
  ]) {
    const before = await snapshot(f);
    const response = await app.inject({ method: "POST", url: `${f.api}/canonical-issues/${f.canonicals[0].id}/merge`, payload });
    expect([400, 404, 409]).toContain(response.statusCode); expect(await snapshot(f)).toEqual(before);
  }
  expect((await merge(f)).statusCode).toBe(200);
  const before = await snapshot(f);
  expect((await merge(f, 1, 0, 1, 2)).statusCode).toBe(400); expect(await snapshot(f)).toEqual(before);
});

test("teacher edits use optimistic versions and do not mutate history", async () => {
  const f = await fixture(), before = await snapshot(f), url = `${f.api}/canonical-issues/${f.canonicals[0].id}`;
  const edit = await app.inject({ method: "PATCH", url, payload: { expectedVersion: 1, label: "Teacher label", description: "Teacher description" } });
  expect(edit.statusCode, edit.body).toBe(200); expect(edit.json()).toMatchObject({ label: "Teacher label", version: 2 });
  const stale = await app.inject({ method: "PATCH", url, payload: { expectedVersion: 1, label: "Stale" } });
  expect(stale.statusCode).toBe(409);
  expect((await merge(f)).statusCode).toBe(409);
  const after = await snapshot(f); expect(after.issues).toEqual(before.issues); expect(after.evidence).toEqual(before.evidence);
});

test("concurrent opposing merges serialize and cannot form a cycle", async () => {
  const f = await fixture();
  const responses = await Promise.all([merge(f), merge(f, 1, 0)]);
  expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  expect((await snapshot(f)).canonical.filter(({ merged_into_id }) => merged_into_id !== null)).toHaveLength(1);
});

test("AI merge rejection changes no canonical state; teacher edited approval merges the reviewed target", async () => {
  const f = await fixture(), before = await snapshot(f), rejected = await addMergeProposal(f);
  const decide = (runId: string, itemId: string, decision: string, patch?: Record<string, unknown>) => app.inject({
    method: "POST", url: `${f.api}/proposal-runs/${runId}/decisions`, payload: { clientRequestId: randomUUID(),
      items: [{ proposalItemId: itemId, decision, ...(patch ? { patch } : {}) }] },
  });
  const response = await decide(rejected.runId, rejected.itemId, "REJECT");
  expect(response.statusCode, response.body).toBe(200); expect(await snapshot(f)).toEqual(before);
  const approved = await addMergeProposal(f);
  const applied = await decide(approved.runId, approved.itemId, "EDIT_AND_APPROVE", { targetCanonicalIssueId: f.canonicals[2].id });
  expect(applied.statusCode, applied.body).toBe(200);
  const run = proposalRunDetailDtoSchema.parse(applied.json());
  expect(run.items[0]).toMatchObject({ status: "APPROVED", teacherPatch: { targetCanonicalIssueId: f.canonicals[2].id }, resultEntityType: "CANONICAL_ISSUE", resultEntityId: f.canonicals[2].id });
  expect((await snapshot(f)).canonical.find(({ id }) => id === f.canonicals[0].id)).toMatchObject({ merged_into_id: f.canonicals[2].id });
  expect((await merge(f, 1, 2)).statusCode).toBe(200);
  const beforeRead = await snapshot(f);
  const reloaded = await app.inject(`${f.api}/proposal-runs/${approved.runId}`);
  expect(reloaded.statusCode, reloaded.body).toBe(200);
  expect(reloaded.json()).toMatchObject({ canonicalIssueReferences: expect.arrayContaining([
    { id: f.canonicals[0].id, label: "Source", description: null },
    { id: f.canonicals[1].id, label: "Target", description: null },
    { id: f.canonicals[2].id, label: "Root", description: null },
  ]) });
  expect(await snapshot(f)).toEqual(beforeRead);
  expect(canonicalIssueListDtoSchema.parse((await app.inject(`${f.api}/issues`)).json()).map(({ id }) => id)).toEqual([f.canonicals[2].id]);
});

test("merged history accepts ongoing interventions and reassessments and distinct due counts", async () => {
  const f = await fixture();
  expect((await merge(f)).statusCode).toBe(200);
  const intervention = await app.inject({ method: "POST", url: `${f.api}/interventions`, payload: {
    clientRequestId: randomUUID(), studentIssueIds: f.issues.slice(0, 2).map(({ id }) => id),
    description: "Teacher follows both historical branches", occurredAt: "2026-11-20T07:00:00Z",
  } });
  expect(intervention.statusCode, intervention.body).toBe(201);
  const activity = intervention.json<{ id: string }>();
  const reassessment = await app.inject({ method: "POST", url: `${f.api}/reassessments`, payload: {
    clientRequestId: randomUUID(), title: "Both branches", dueAt: "2026-11-20T07:00:00Z",
    studentIssueIds: f.issues.slice(0, 2).map(({ id }) => id),
    interventionIdByStudentIssueId: Object.fromEntries(f.issues.slice(0, 2).map(({ id }) => [id, activity.id])),
  } });
  expect(reassessment.statusCode, reassessment.body).toBe(201);
  const detail = canonicalIssueDetailDtoSchema.parse((await app.inject(`${f.api}/issues/${f.canonicals[1].id}`)).json());
  expect(detail).toMatchObject({ affectedStudents: 1, dueCount: 1 });
  expect(detail.interventions).toHaveLength(1); expect(detail.reassessments).toHaveLength(1);
  expect(detail.reassessments[0].targets.map(({ studentIssueId }) => studentIssueId).sort()).toEqual(f.issues.slice(0, 2).map(({ id }) => id).sort());
  const overview = (await app.inject(`${f.api}/students/${f.student.id}/overview`)).json<{
    activeStudentIssues: { canonicalIssueId: string; canonicalIssue: { id: string } }[];
  }>();
  expect(overview.activeStudentIssues.find(({ canonicalIssueId }) => canonicalIssueId === f.canonicals[0].id)?.canonicalIssue.id)
    .toBe(f.canonicals[1].id);
});

test("stale AI merge approval rolls back decision receipt and canonical mutation", async () => {
  const f = await fixture(), proposal = await addMergeProposal(f);
  expect((await app.inject({ method: "PATCH", url: `${f.api}/canonical-issues/${f.canonicals[1].id}`,
    payload: { expectedVersion: 1, label: "Changed target" } })).statusCode).toBe(200);
  const before = await snapshot(f), clientRequestId = randomUUID();
  const response = await app.inject({ method: "POST", url: `${f.api}/proposal-runs/${proposal.runId}/decisions`,
    payload: { clientRequestId, items: [{ proposalItemId: proposal.itemId, decision: "APPROVE" }] } });
  expect(response.statusCode, response.body).toBe(409); expect(await snapshot(f)).toEqual(before);
  expect(await db.selectFrom("proposal_items").select("status").where("id", "=", proposal.itemId).executeTakeFirst())
    .toEqual({ status: "PENDING" });
  expect(await db.selectFrom("proposal_decision_receipts").select("client_request_id").where("client_request_id", "=", clientRequestId).execute())
    .toEqual([]);
});

test("unowned and malformed canonical mutations do not expose or change issues", async () => {
  const f = await fixture(), before = await snapshot(f);
  const outsider = await createApp({ db, authVerifier: fixedUserAuthVerifier(randomUUID()) });
  try {
    for (const method of ["PATCH", "POST"] as const) {
      const response = await outsider.inject({ method,
        url: `${f.api}/canonical-issues/${f.canonicals[0].id}${method === "POST" ? "/merge" : ""}`,
        payload: method === "POST" ? { targetCanonicalIssueId: f.canonicals[1].id, expectedSourceVersion: 1, expectedTargetVersion: 1 }
          : { label: "Unauthorized", expectedVersion: 1 } });
      expect(response.statusCode).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: `${f.api}/canonical-issues/not-an-id/merge`,
      payload: { targetCanonicalIssueId: f.canonicals[1].id, expectedSourceVersion: 1, expectedTargetVersion: 1 } })).statusCode).toBe(404);
    expect(await snapshot(f)).toEqual(before);
  } finally { await outsider.close(); }
});
