import { randomUUID } from "node:crypto";
import {
  createRawNoteResponseSchema, type ProposalDecisionInput, type ProposalDraftItemV1, proposalRunDetailDtoSchema,
  reassessmentDtoSchema, studentOverviewDtoSchema,
} from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { FakeNoteStructurer } from "@tutorloop/testkit/fake-note-structurer";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { AI_MODEL_REGISTRY } from "../../../packages/ai/src/registry.ts";
import { routeStructuredNote } from "../../../packages/ai/src/router.ts";
import { runNextJob } from "../../worker/src/worker.ts";
import { createApp } from "../src/app.ts";
import { fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
let classroom: ReturnType<typeof buildClass>;

const observedAt = "2026-11-20T07:00:00.123456Z";
const olderTime = "2026-11-18T07:00:00.432198Z";
const noteInput = () => ({
  body: "An works independently. Bình still makes errors.",
  observedAt: "2026-11-20T14:00:00.123456+07:00",
  clientRequestId: randomUUID(),
});
const classPath = (id = classroom.id) => `/api/v1/classes/${id}`;
const reassessmentsPath = () => `${classPath()}/reassessments`;

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE classes, jobs CASCADE`.execute(db);
  classroom = buildClass();
  await db.insertInto("classes").values(classroom).execute();
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(classroom.owner_user_id) });
});

afterEach(async () => {
  await app?.close();
});
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await postgres?.stop();
  }
});

async function student(label: string, alias: string, classId = classroom.id) {
  const row = { ...buildStudent(classId, alias), display_label: label };
  await db.insertInto("students").values(row).execute();
  return row;
}

async function issue(learner: Awaited<ReturnType<typeof student>>, label = "Common denominators") {
  const canonical = { ...buildCanonicalIssue(learner.class_id), label };
  await db.insertInto("canonical_issues").values(canonical).execute();
  const id = randomUUID();
  await db.insertInto("student_issues").values({
    id, class_id: learner.class_id, student_id: learner.id, canonical_issue_id: canonical.id,
    state: "OPEN", manifestation: label, created_at: new Date(), updated_at: new Date(),
  }).execute();
  return { id, learner, canonical };
}

async function priorEvidence(
  target: Awaited<ReturnType<typeof issue>>, text: string, context: string | null = null, time = olderTime,
) {
  const { class_id: classId, id: studentId } = target.learner;
  const noteId = randomUUID();
  const observed = sql<Date>`${time}::timestamptz`;
  await db.insertInto("raw_notes").values({
    id: noteId, class_id: classId, author_user_id: classroom.owner_user_id, note_type: "OBSERVATION",
    body: text, observed_at: observed, created_at: new Date(),
  }).execute();
  const id = randomUUID();
  await db.insertInto("evidence_events").values({
    id, class_id: classId, student_id: studentId, student_issue_id: target.id, raw_note_id: noteId,
    observation_text: text, learning_context: context, observed_at: observed,
    provenance: "TEACHER_DIRECT", approved_by_user_id: classroom.owner_user_id, created_at: new Date(),
  }).execute();
  return id;
}

function post(url: string, payload: object) {
  return app.inject({ method: "POST", url, payload });
}

async function schedule(studentIssueIds: string[]) {
  const response = await post(reassessmentsPath(), {
    clientRequestId: randomUUID(), dueAt: observedAt, studentIssueIds,
  });
  expect(response.statusCode, response.body).toBe(201);
  return `${reassessmentsPath()}/${reassessmentDtoSchema.parse(response.json()).id}`;
}

async function capture(reassessmentPath: string, input = noteInput()) {
  // Exercise the pre-existing generic path separately from the new route.
  const response = await post(`${classPath()}/raw-notes`, {
    ...input, noteType: "REASSESSMENT_OUTCOME", reassessmentId: reassessmentPath.split("/").at(-1),
  });
  expect(response.statusCode, response.body).toBe(201);
  return createRawNoteResponseSchema.parse(response.json());
}

async function getReassessment(path: string) {
  const response = await app.inject(path);
  expect(response.statusCode, response.body).toBe(200);
  return reassessmentDtoSchema.parse(response.json());
}

function evidence(
  target: Awaited<ReturnType<typeof issue>>, key: string, observationText: string,
): ProposalDraftItemV1 {
  return {
    key, type: "CREATE_EVIDENCE", studentRef: { kind: "RESOLVED", studentAlias: target.learner.ai_alias },
    studentIssueRef: { kind: "EXISTING", studentIssueId: target.id }, observationText,
  };
}

async function structure(jobId: string, items: ProposalDraftItemV1[]) {
  expect(await runNextJob({ db, now: () => new Date(),
    structurer: new FakeNoteStructurer(() => ({ schemaVersion: "1", items })),
  })).toBe(true);
  const { id } = await db.selectFrom("proposal_runs").select("id").where("source_job_id", "=", jobId)
    .executeTakeFirstOrThrow();
  const url = `${classPath()}/proposal-runs/${id}`;
  const response = await app.inject(url);
  expect(response.statusCode, response.body).toBe(200);
  const run = proposalRunDetailDtoSchema.parse(response.json());
  expect(run.status).toBe("READY");
  return {
    url, decide: (key: string, decision: "APPROVE" | "REJECT"): ProposalDecisionInput => ({
      decision, proposalItemId: run.items.find(({ originalPayload }) => originalPayload.key === key)!.id,
    }),
  };
}

async function providerPayload(jobId: string) {
  const payloads: unknown[] = [];
  expect(await runNextJob({ db, now: () => new Date(), route: (note, options) => routeStructuredNote({
    ...options, note, adapters: { GEMINI: { generateStructured: async ({ userPayload }) => {
      payloads.push(userPayload);
      return { schemaVersion: "1", items: [] };
    } } },
  }, { primary: AI_MODEL_REGISTRY[0], fallback: AI_MODEL_REGISTRY[1] }) })).toBe(true);
  const job = await db.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirstOrThrow();
  expect(job.status).toBe("SUCCEEDED");
  expect(payloads).toHaveLength(1);
  return payloads[0];
}

test("captures an exact outcome once across the dedicated and generic routes within the owning Class", async () => {
  const an = await issue(await student("An", "STU_001"));
  const path = await schedule([an.id]);
  const input = noteInput();
  const first = await post(`${path}/outcome-note`, input);
  expect(first.statusCode, first.body).toBe(201);
  const created = createRawNoteResponseSchema.parse(first.json());
  const { id } = await getReassessment(path);
  expect(created.rawNote).toMatchObject({
    noteType: "REASSESSMENT_OUTCOME", reassessmentId: id, observedAt,
  });
  expect(await capture(path, { ...input, observedAt })).toEqual(created);
  const replay = await post(`${path}/outcome-note`, { ...input, observedAt });
  expect(replay.statusCode, replay.body).toBe(201);
  expect(replay.json()).toEqual(created);
  expect((await post(`${path}/outcome-note`, { ...input, observedAt: "2026-11-20T07:00:00.123457Z" }))
    .json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  expect((await post(`${path}/outcome-note`, { ...input, reassessmentId: randomUUID() })).statusCode).toBe(400);
  const sameOwner = { ...buildClass(), owner_user_id: classroom.owner_user_id };
  const foreignOwner = buildClass();
  await db.insertInto("classes").values([sameOwner, foreignOwner]).execute();
  for (const classId of [sameOwner.id, foreignOwner.id]) {
    const wrongPath = `${classPath(classId)}/reassessments/${id}/outcome-note`;
    expect((await post(wrongPath, noteInput())).statusCode).toBe(404);
  }
  expect((await post(`${reassessmentsPath()}/bad-id/outcome-note`, input)).statusCode).toBe(404);
  const jobs = await db.selectFrom("jobs").select("id").where(sql<string>`payload ->> 'rawNoteId'`, "=", created.rawNote.id)
    .execute();
  expect(jobs).toEqual([{ id: created.processing.jobId }]);
});

test("one outcome saves conflicting evidence for different students and completes without applying a rejected resolution", async () => {
  const an = await issue(await student("An", "STU_001"));
  const binh = await issue(await student("Bình", "STU_002"));
  const cuong = await issue(await student("Cường", "STU_003"));
  const oldEvidenceId = await priorEvidence(an, "An needed help on every question.");
  const path = await schedule([an.id, binh.id, cuong.id]);
  expect((await post(`${path}/mark-performed`, { expectedVersion: 1 })).statusCode).toBe(200);
  expect((await post(`${path}/targets/${cuong.id}/skip`, { expectedVersion: 2, skipReason: "Absent" })).statusCode).toBe(200);
  const note = await capture(path);
  const run = await structure(note.processing.jobId, [
    evidence(an, "an-evidence", "An worked independently on every question."),
    { key: "an-resolve", type: "TRANSITION_STUDENT_ISSUE", toState: "RESOLVED_FOR_NOW", expectedVersion: 1,
      studentIssueRef: { kind: "EXISTING", studentIssueId: an.id } },
    evidence(binh, "binh-evidence", "Bình still made denominator errors."),
  ]);

  const first = await post(`${run.url}/decisions`, { clientRequestId: randomUUID(), items: [
    run.decide("an-evidence", "APPROVE"), run.decide("an-resolve", "REJECT"),
  ] });
  expect(first.statusCode, first.body).toBe(200);
  const partial = await getReassessment(path);
  expect(partial).toMatchObject({ version: 4, status: "PERFORMED_PENDING_EVIDENCE", completedAt: null });
  expect(Object.fromEntries(partial.targets.map(({ studentIssueId, targetStatus }) => [studentIssueId, targetStatus])))
    .toEqual({ [an.id]: "EVIDENCED", [binh.id]: "PENDING", [cuong.id]: "SKIPPED" });
  const request = { clientRequestId: randomUUID(), items: [run.decide("binh-evidence", "APPROVE")] };
  const last = await post(`${run.url}/decisions`, request);
  expect(last.statusCode, last.body).toBe(200);
  expect((await post(`${run.url}/decisions`, request)).json()).toEqual(last.json());
  const complete = await getReassessment(path);
  expect(complete).toMatchObject({ version: 5, status: "COMPLETED", completedAt: expect.any(String) });
  expect(Object.fromEntries(complete.targets.map(({ studentIssueId, targetStatus }) => [studentIssueId, targetStatus])))
    .toEqual({ [an.id]: "EVIDENCED", [binh.id]: "EVIDENCED", [cuong.id]: "SKIPPED" });
  const overview = async (id: string) => studentOverviewDtoSchema.parse(
    (await app.inject(`${classPath()}/students/${id}/overview`)).json(),
  );
  const anHistory = await overview(an.learner.id);
  const binhHistory = await overview(binh.learner.id);
  expect(anHistory.evidence).toMatchObject([
    { id: oldEvidenceId, observationText: "An needed help on every question.", observedAt: olderTime, reassessmentId: null },
    { rawNoteId: note.rawNote.id, observationText: "An worked independently on every question.", observedAt,
      reassessmentId: complete.id, studentIssueId: an.id },
  ]);
  expect(binhHistory.evidence).toMatchObject([
    { rawNoteId: note.rawNote.id, observationText: "Bình still made denominator errors.", observedAt,
      reassessmentId: complete.id, studentIssueId: binh.id },
  ]);
  for (const history of [anHistory, binhHistory]) {
    expect(history.activeStudentIssues).toMatchObject([{ state: "OPEN", version: 1 }]);
    expect(history.transitions).toEqual([]);
  }
});

test("sends only current Class aliases and targeted issue context with redacted, bounded history to the provider", async () => {
  const an = await student("An", "STU_001");
  const binh = await student("Bình", "STU_002");
  const target = await issue(an);
  const nonTarget = await issue(an, "Same learner unrelated issue");
  const otherLearner = await issue(binh, "Other learner unrelated issue");
  const otherClass = buildClass();
  await db.insertInto("classes").values(otherClass).execute();
  await issue(await student("Other", "STU_OTHER", otherClass.id), "Foreign Class unrelated issue");
  const latestEvidenceId = await priorEvidence(target, "An made one error. Email person@example.com.", "Test class worksheet.");
  await priorEvidence(target, "Second most recent", null, "2026-11-17T07:00:00Z");
  await priorEvidence(target, "Third most recent", null, "2026-11-16T07:00:00Z");
  await priorEvidence(target, "Fourth oldest entry", null, "2026-11-15T07:00:00Z");
  await priorEvidence(nonTarget, "Same learner unrelated history");
  await priorEvidence(otherLearner, "Other learner unrelated history");
  const path = await schedule([target.id]);
  const { processing } = await capture(path);
  const payload = await providerPayload(processing.jobId);
  expect(payload).toMatchObject({
    task: "RECONCILE_REASSESSMENT_OUTCOME", note: "STU_001 works independently. STU_002 still makes errors.",
    studentAliases: expect.arrayContaining(["STU_001", "STU_002"]),
    canonicalIssues: [{ canonicalIssueId: "CI_001", label: "Common denominators", description: null }],
    studentIssues: [{ studentIssueId: "SI_001", studentAlias: "STU_001", canonicalIssueId: "CI_001" }],
    evidenceHistory: [
      { studentIssueId: "SI_001", observationText: "STU_001 made one error. Email [EMAIL].", learningContext: "[PRIVATE] worksheet." },
      { studentIssueId: "SI_001", observationText: "Second most recent", learningContext: null },
      { studentIssueId: "SI_001", observationText: "Third most recent", learningContext: null },
    ],
  });
  for (const privateValue of [an.id, target.id, target.canonical.id, latestEvidenceId, "STU_OTHER", "person@example.com", "unrelated"]) {
    expect(JSON.stringify(payload)).not.toContain(privateValue);
  }
});

test.each(["Student", "Class"] as const)("omits history sourced before or at a %s edit", async (kind) => {
  const formerLabel = kind === "Student" ? "Former Synthetic Label" : classroom.name;
  const newLabel = "Replacement Display";
  const an = await issue(await student(kind === "Student" ? formerLabel : "An", "STU_001"));
  const path = await schedule([an.id]);
  const studentPath = `${classPath()}/students/${an.learner.id}`;
  const redactedLabel = kind === "Student" ? "STU_001" : "[PRIVATE]";

  async function captureObservation(body: string, time: string, atEdit = false) {
    const response = await post(`${classPath()}/raw-notes`, {
      body, observedAt: time, noteType: "OBSERVATION", clientRequestId: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
    const { processing, rawNote } = createRawNoteResponseSchema.parse(response.json());
    if (atEdit) {
      const editTime = kind === "Student"
        ? db.selectFrom("students").select("updated_at").where("id", "=", an.learner.id)
        : db.selectFrom("classes").select("updated_at").where("id", "=", classroom.id);
      await db.updateTable("raw_notes").set({ created_at: editTime }).where("id", "=", rawNote.id).execute();
    }
    const run = await structure(processing.jobId, [evidence(an, "note-evidence", body)]);
    return async () => {
      const decision = await post(`${run.url}/decisions`, {
        clientRequestId: randomUUID(), items: [run.decide("note-evidence", "APPROVE")],
      });
      expect(decision.statusCode, decision.body).toBe(200);
    };
  }

  const oldText = `${formerLabel} worked independently.`;
  const approveBeforeEdit = await captureObservation(oldText, observedAt);
  const rename = await app.inject({
    method: "PATCH", url: kind === "Student" ? studentPath : classPath(),
    payload: { expectedVersion: 1, [kind === "Student" ? "displayLabel" : "name"]: newLabel },
  });
  expect(rename.statusCode, rename.body).toBe(200);
  await approveBeforeEdit();
  const approveAtEdit = await captureObservation(`${formerLabel} passed the second quiz.`, observedAt, true);
  await approveAtEdit();
  const firstOutcome = await capture(path, { ...noteInput(), body: `${newLabel} reviewed quiz results.` });
  const noHistory = await providerPayload(firstOutcome.processing.jobId);

  const safeText = `${newLabel} explained the denominator.`;
  const approveAfterEdit = await captureObservation(safeText, olderTime);
  await approveAfterEdit();
  const nextOutcome = await capture(path, { ...noteInput(), body: `${newLabel} checked one example.` });
  const payload = await providerPayload(nextOutcome.processing.jobId);

  expect(JSON.stringify([noHistory, payload])).not.toContain(formerLabel);
  expect(noHistory).not.toHaveProperty("evidenceHistory");
  expect(payload).toMatchObject({
    note: `${redactedLabel} checked one example.`,
    evidenceHistory: [{ studentIssueId: "SI_001", observationText: `${redactedLabel} explained the denominator.`, learningContext: null }],
  });
  const history = studentOverviewDtoSchema.parse((await app.inject(`${studentPath}/overview`)).json());
  expect(history.evidence.map(({ observationText }) => observationText)).toEqual(expect.arrayContaining([oldText, safeText]));
});

test.each(["all-skipped", "cancelled"] as const)(
  "approving evidence preserves %s target decisions and keeps the reassessment incomplete",
  async (state) => {
    const an = await issue(await student("An", "STU_001"));
    const path = await schedule([an.id]);
    if (state === "all-skipped") {
      expect((await post(`${path}/mark-performed`, { expectedVersion: 1 })).statusCode).toBe(200);
      expect((await post(`${path}/targets/${an.id}/skip`, { expectedVersion: 2, skipReason: "Absent" })).statusCode)
        .toBe(200);
    } else {
      expect((await post(`${path}/cancel`, { expectedVersion: 1 })).statusCode).toBe(200);
    }
    const before = await getReassessment(path);
    const { rawNote, processing } = await capture(path);
    const run = await structure(processing.jobId, [evidence(an, "evidence", "Work observed separately")]);
    const response = await post(`${run.url}/decisions`, {
      clientRequestId: randomUUID(), items: [run.decide("evidence", "APPROVE")],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await getReassessment(path)).toEqual(before);
    const saved = await db.selectFrom("evidence_events").select(["student_issue_id", "reassessment_id"])
      .where("raw_note_id", "=", rawNote.id).execute();
    expect(saved).toEqual([{ student_issue_id: an.id, reassessment_id: before.id }]);
  },
);

test.each(["approve first", "skip first"] as const)(
  "an outcome on a scheduled reassessment completes after the last target decision when teachers %s",
  async (order) => {
    const an = await issue(await student("An", "STU_001"));
    const binh = await issue(await student("Bình", "STU_002"));
    const path = await schedule([an.id, binh.id]);
    const note = await capture(path);
    const run = await structure(note.processing.jobId, [evidence(an, "evidence", "Worked independently")]);
    const approve = () => post(`${run.url}/decisions`, {
      clientRequestId: randomUUID(), items: [run.decide("evidence", "APPROVE")],
    });
    const skip = (expectedVersion: number) =>
      post(`${path}/targets/${binh.id}/skip`, { expectedVersion, skipReason: "Absent" });
    const first = order === "approve first" ? await approve() : await skip(1);
    expect(first.statusCode, first.body).toBe(200);
    expect(await getReassessment(path)).toMatchObject({ version: 2, status: "SCHEDULED", completedAt: null });
    const second = order === "approve first" ? await skip(2) : await approve();
    expect(second.statusCode, second.body).toBe(200);
    expect(await getReassessment(path)).toMatchObject({ version: 3, status: "COMPLETED" });
    expect(await db.selectFrom("student_issues").select(["state", "version"])
      .where("class_id", "=", classroom.id).execute()).toEqual(Array(2).fill({ state: "OPEN", version: 1 }));
  },
);

test("overlapping proposal runs serialize their target and parent changes", async () => {
  const an = await issue(await student("An", "STU_001"));
  const binh = await issue(await student("Bình", "STU_002"));
  const path = await schedule([an.id, binh.id]);
  const anNote = await capture(path);
  const anRun = await structure(anNote.processing.jobId, [evidence(an, "evidence", "Worked independently")]);
  const binhNote = await capture(path);
  const binhRun = await structure(binhNote.processing.jobId, [evidence(binh, "evidence", "Needed help")]);
  const results = await Promise.all([anRun, binhRun].map((run) => post(`${run.url}/decisions`, {
    clientRequestId: randomUUID(), items: [run.decide("evidence", "APPROVE")],
  })));
  for (const result of results) expect(result.statusCode, result.body).toBe(200);
  const completed = await getReassessment(path);
  expect(completed).toMatchObject({ status: "COMPLETED", version: 3 });
  expect(completed.targets.map(({ targetStatus }) => targetStatus)).toEqual(["EVIDENCED", "EVIDENCED"]);
  expect(await db.selectFrom("evidence_events").select("student_issue_id").where("reassessment_id", "=", completed.id)
    .orderBy("student_issue_id").execute()).toEqual([an.id, binh.id].sort().map((id) => ({ student_issue_id: id })));
});
