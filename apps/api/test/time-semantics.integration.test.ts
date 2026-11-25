import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRawNoteResponseSchema, type ProposalDraftItemV1, proposalRunDetailDtoSchema, reassessmentDtoSchema, reassessmentDueQueueDtoSchema,
  studentOverviewDtoSchema } from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { FakeNoteStructurer } from "@tutorloop/testkit/fake-note-structurer";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { runNextJob } from "../../worker/src/worker.ts";
import { createApp } from "../src/app.ts";
import { fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
let clock = new Date("2026-11-20T07:00:00Z");
const teacherId = randomUUID();
beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherId), now: () => clock });
}, 120_000);
beforeEach(async () => {
  await sql`truncate classes, jobs cascade`.execute(db);
  clock = new Date("2026-11-20T07:00:00Z");
});
afterAll(async () => {
  try { await app?.close(); await db?.destroy(); } finally { await postgres?.stop(); }
});

async function seed(timezone = "Asia/Bangkok") {
  const classroom = { ...buildClass(), owner_user_id: teacherId, timezone };
  const student = buildStudent(classroom.id);
  const canonical = buildCanonicalIssue(classroom.id);
  const issueId = randomUUID();
  await db.insertInto("classes").values(classroom).execute();
  await db.insertInto("students").values(student).execute();
  await db.insertInto("canonical_issues").values(canonical).execute();
  await db.insertInto("student_issues").values({ id: issueId, class_id: classroom.id, student_id: student.id,
    canonical_issue_id: canonical.id, state: "OPEN", created_at: new Date(), updated_at: new Date() }).execute();
  return { classroom, student, issueId, root: `/api/v1/classes/${classroom.id}` };
}

async function capture(f: Awaited<ReturnType<typeof seed>>, observedAt: string) {
  const response = await app.inject({ method: "POST", url: `${f.root}/raw-notes`, payload: {
    body: "Synthetic observation", observedAt, noteType: "OBSERVATION", clientRequestId: randomUUID(),
  } });
  expect(response.statusCode, response.body).toBe(201);
  return createRawNoteResponseSchema.parse(response.json());
}

async function approveEvidence(f: Awaited<ReturnType<typeof seed>>, noteId: string, transition = false) {
  const drafts: ProposalDraftItemV1[] = [{ key: "e", type: "CREATE_EVIDENCE", observationText: "Synthetic evidence",
    studentRef: { kind: "RESOLVED", studentAlias: f.student.ai_alias },
    studentIssueRef: { kind: "EXISTING", studentIssueId: f.issueId } }];
  if (transition) drafts.push({ key: "t", type: "TRANSITION_STUDENT_ISSUE", toState: "IMPROVING", expectedVersion: 1,
    studentIssueRef: { kind: "EXISTING", studentIssueId: f.issueId }, supportingEvidenceKey: "e",
    reason: "Synthetic decision after late evidence" });
  expect(await runNextJob({ db, now: () => new Date(), structurer: new FakeNoteStructurer(() => ({
    schemaVersion: "1", items: drafts,
  })) })).toBe(true);
  const run = await db.selectFrom("proposal_runs").select("id").where("raw_note_id", "=", noteId).executeTakeFirstOrThrow();
  const items = await db.selectFrom("proposal_items").select("id").where("proposal_run_id", "=", run.id).execute();
  const response = await app.inject({ method: "POST", url: `${f.root}/proposal-runs/${run.id}/decisions`, payload: {
    clientRequestId: randomUUID(), items: items.map(({ id }) => ({ proposalItemId: id, decision: "APPROVE" })),
  } });
  expect(response.statusCode, response.body).toBe(200);
  return proposalRunDetailDtoSchema.parse(response.json()).items.find(({ itemType }) => itemType === "CREATE_EVIDENCE")!.resultEntityId!;
}

test("late-entered RawNotes retain educational time and their Evidence timeline sorts by observed_at", async () => {
  const f = await seed();
  const recent = await capture(f, "2026-11-20T07:00:00.123456Z");
  const recentEvidence = await approveEvidence(f, recent.rawNote.id);
  const late = await capture(f, "2026-11-18T14:00:00.654321+07:00");
  const lateEvidence = await approveEvidence(f, late.rawNote.id);
  // Distinct controlled operational times make a created_at ordering regression unambiguous.
  await db.updateTable("raw_notes").set({ created_at: new Date("2026-11-22T01:00:00Z") }).where("id", "=", recent.rawNote.id).execute();
  await db.updateTable("raw_notes").set({ created_at: new Date("2026-11-23T01:00:00Z") }).where("id", "=", late.rawNote.id).execute();
  await db.updateTable("evidence_events").set({ created_at: new Date("2026-11-22T02:00:00Z") }).where("id", "=", recentEvidence).execute();
  await db.updateTable("evidence_events").set({ created_at: new Date("2026-11-23T02:00:00Z") }).where("id", "=", lateEvidence).execute();
  const response = await app.inject(`${f.root}/students/${f.student.id}/overview`);
  expect(response.statusCode, response.body).toBe(200);
  const timeline = studentOverviewDtoSchema.parse(response.json()).evidence;
  expect(timeline.map(({ id, observedAt }) => ({ id, observedAt }))).toEqual([
    { id: lateEvidence, observedAt: "2026-11-18T07:00:00.654321Z" },
    { id: recentEvidence, observedAt: "2026-11-20T07:00:00.123456Z" },
  ]);
  const exact = await db.selectFrom("evidence_events as e").innerJoin("raw_notes as n", "n.id", "e.raw_note_id")
    .select(["e.id", sql<boolean>`e.observed_at = n.observed_at and e.observed_at < e.created_at
      and n.observed_at < n.created_at`.as("preserved")]).where("e.class_id", "=", f.classroom.id).execute();
  expect(exact).toHaveLength(2);
  expect(exact.every(({ preserved }) => preserved)).toBe(true);
});

test("the existing web Class-local converter stores the same UTC instant across different default timezones", async () => {
  const f = await seed("Asia/Bangkok");
  const moduleUrl = new URL("../../web/lib/observed-time.ts", import.meta.url).href;
  // Separate runtimes avoid leaking TZ changes into Vitest. Exercise the actual web input conversion,
  // rather than a test-local date conversion or an offset added by the API.
  for (const timezone of ["America/Los_Angeles", "Asia/Tokyo"]) {
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { resolveClassLocalTime } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        instant: resolveClassLocalTime("2026-11-20T14:30", "Asia/Bangkok") }));
    `], { encoding: "utf8", env: { ...process.env, TZ: timezone }, timeout: 10_000 }));
    expect(result.timezone).toBe(timezone);
    expect(result.instant).toBe("2026-11-20T07:30:00.000Z");
    const saved = await capture(f, result.instant);
    expect(saved.rawNote.observedAt).toBe("2026-11-20T07:30:00.000Z");
    const exact = await db.selectFrom("raw_notes")
      .select(sql<boolean>`observed_at = timestamptz '2026-11-20 07:30:00+00'`.as("matches"))
      .where("id", "=", saved.rawNote.id).executeTakeFirstOrThrow();
    expect(exact.matches).toBe(true);
  }
});

test("the exact due instant is included and one microsecond after the boundary is excluded", async () => {
  const f = await seed();
  const dueAt = "2026-11-20T07:00:00.123Z";
  const ids: string[] = [];
  for (const instant of [dueAt, "2026-11-20T07:00:00.123001Z"]) {
    const response = await app.inject({ method: "POST", url: `${f.root}/reassessments`, payload: {
      studentIssueIds: [f.issueId], dueAt: instant, clientRequestId: randomUUID(),
    } });
    expect(response.statusCode, response.body).toBe(201);
    ids.push(reassessmentDtoSchema.parse(response.json()).id);
  }
  async function due() {
    const response = await app.inject(`${f.root}/reassessments/due`);
    expect(response.statusCode, response.body).toBe(200);
    return reassessmentDueQueueDtoSchema.parse(response.json());
  }
  clock = new Date("2026-11-20T07:00:00.122Z");
  expect(await due()).toEqual({ due: [], needsResults: [] });
  clock = new Date(dueAt);
  expect((await due()).due.map(({ id }) => id)).toEqual([ids[0]]);
  clock = new Date("2026-11-20T07:00:00.124Z");
  expect((await due()).due.map(({ id }) => id)).toEqual(ids);
  expect(await db.selectFrom("reassessments").select(["status", "version"]).where("class_id", "=", f.classroom.id).execute())
    .toEqual([{ status: "SCHEDULED", version: 1 }, { status: "SCHEDULED", version: 1 }]);
});

test("a teacher transition uses its created_at decision time rather than its linked Evidence observed_at", async () => {
  const f = await seed();
  const captured = await capture(f, "2026-11-18T07:00:00Z");
  const before = Date.now();
  const evidenceId = await approveEvidence(f, captured.rawNote.id, true);
  const after = Date.now();
  const [transition] = await db.selectFrom("student_issue_transitions").selectAll().where("student_issue_id", "=", f.issueId).execute();
  expect(transition).toMatchObject({
    from_state: "OPEN", to_state: "IMPROVING", actor_user_id: teacherId, evidence_event_id: evidenceId,
  });
  expect(transition.proposal_item_id).not.toBeNull();
  expect(transition.created_at.getTime()).toBeGreaterThanOrEqual(before);
  expect(transition.created_at.getTime()).toBeLessThanOrEqual(after);
  const overview = await app.inject(`${f.root}/students/${f.student.id}/overview`);
  expect(overview.statusCode, overview.body).toBe(200);
  const dto = studentOverviewDtoSchema.parse(overview.json());
  expect(dto.transitions).toMatchObject([{ id: transition.id, createdAt: transition.created_at.toISOString(), evidenceEventId: evidenceId }]);
  expect(dto.transitions[0].createdAt).not.toBe(dto.evidence[0].observedAt);
});
