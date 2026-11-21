import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ProposalDecisionInput, type ProposalDraftItemV1, type StudentIssueState,
  proposalRunDetailDtoSchema, studentIssueDtoSchema, studentOverviewDtoSchema,
} from "@tutorloop/contracts";
import { createDb } from "@tutorloop/db/client";
import { runMigrations } from "@tutorloop/db/migrate";
import { insertProposalItemDependency } from "@tutorloop/db/repositories/proposals";
import { buildCanonicalIssue, buildClass, buildStudent } from "@tutorloop/testkit/builders";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { anonymousAuthVerifier, fixedUserAuthVerifier } from "./support/auth.ts";

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
let teacherId: string;

const observedAt = "2026-11-20T07:00:00.123456Z";
const studentRef = { kind: "RESOLVED", studentAlias: "STU_001" } as const;

beforeAll(async () => {
  postgres = await startPostgres();
  db = createDb(postgres.getConnectionUri());
  await runMigrations(db);
}, 120_000);

beforeEach(async () => {
  teacherId = randomUUID();
  app = await createApp({ db, authVerifier: fixedUserAuthVerifier(teacherId) });
});

afterEach(async () => { await app?.close(); });
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await postgres?.stop();
  }
});

async function addClass(owner = teacherId) {
  const row = { ...buildClass(), owner_user_id: owner };
  await db.insertInto("classes").values(row).execute();
  return row.id;
}

async function addStudent(classId: string, alias?: string) {
  const row = buildStudent(classId, alias);
  await db.insertInto("students").values(row).execute();
  return row.id;
}

async function addIssue(classId: string, studentId: string, state: StudentIssueState = "OPEN", version = 1) {
  const canonical = buildCanonicalIssue(classId);
  const now = new Date();
  const id = randomUUID();
  await db.insertInto("canonical_issues").values(canonical).execute();
  await db.insertInto("student_issues").values({
    id, class_id: classId, student_id: studentId, canonical_issue_id: canonical.id, state, version,
    manifestation: "Initial", created_at: now, updated_at: now,
  }).execute();
  return { id, canonicalId: canonical.id };
}

async function addRun(classId: string, drafts: ProposalDraftItemV1[], dependencies: Array<[number, number]> = []) {
  const now = new Date();
  const noteId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  const ids = drafts.map(() => randomUUID());
  await db.insertInto("raw_notes").values({
    id: noteId, class_id: classId, author_user_id: teacherId, note_type: "OBSERVATION", body: "Original teacher note",
    observed_at: sql<Date>`${observedAt}::timestamptz`, created_at: now,
  }).execute();
  await db.insertInto("jobs").values({
    id: jobId, dedupe_key: jobId, kind: "STRUCTURE_RAW_NOTE", payload: {}, status: "SUCCEEDED",
    run_after: now, created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("proposal_runs").values({
    id: runId, class_id: classId, raw_note_id: noteId, source_job_id: jobId,
    status: "READY", schema_version: "1", created_at: now, updated_at: now,
  }).execute();
  if (drafts.length) {
    await db.insertInto("proposal_items").values(drafts.map((draft, index) => {
      const target = "expectedVersion" in draft && draft.studentIssueRef.kind === "EXISTING"
        ? draft.studentIssueRef.studentIssueId : null;
      return {
        id: ids[index], class_id: classId, proposal_run_id: runId, item_type: draft.type,
        original_payload: draft, status: "PENDING",
        base_version: "expectedVersion" in draft ? draft.expectedVersion : null,
        target_entity_id: target, target_entity_type: target ? "STUDENT_ISSUE" : null,
        created_at: new Date(now.getTime() + index),
      };
    })).execute();
  }
  for (const [item, dependency] of dependencies) {
    await insertProposalItemDependency(db, ids[item], ids[dependency]);
  }
  return { classId, runId, noteId, ids, url: `/api/v1/classes/${classId}/proposal-runs/${runId}` };
}

function evidence(overrides: Partial<Extract<ProposalDraftItemV1, { type: "CREATE_EVIDENCE" }>> = {}): ProposalDraftItemV1 {
  return { key: "evidence", type: "CREATE_EVIDENCE", studentRef, observationText: "Compared fractions", ...overrides };
}

function transition(studentIssueId: string, toState: StudentIssueState = "IMPROVING"): ProposalDraftItemV1 {
  return {
    key: "state", type: "TRANSITION_STUDENT_ISSUE", toState, expectedVersion: 1,
    studentIssueRef: { kind: "EXISTING", studentIssueId },
  };
}

function approve(proposalItemId: string): ProposalDecisionInput {
  return { proposalItemId, decision: "APPROVE" };
}

function reject(proposalItemId: string): ProposalDecisionInput {
  return { proposalItemId, decision: "REJECT" };
}

function edit(proposalItemId: string, patch: Record<string, unknown>): ProposalDecisionInput {
  return { proposalItemId, decision: "EDIT_AND_APPROVE", patch };
}

function decisions(run: { url: string }, items: ProposalDecisionInput[], clientRequestId = randomUUID()) {
  return app.inject({ method: "POST", url: `${run.url}/decisions`, payload: { items, clientRequestId } });
}

function patchIssue(classId: string, issueId: string, action: "state" | "manifestation", payload: object) {
  return app.inject({ method: "PATCH", url: `/api/v1/classes/${classId}/student-issues/${issueId}/${action}`, payload });
}

function readEvidence(classId: string) {
  return db.selectFrom("evidence_events").selectAll().where("class_id", "=", classId).execute();
}

function readIssue(id: string) {
  return db.selectFrom("student_issues").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

test("approves unrelated issue-free evidence and rejects a state transition without changing its issue or Raw Note", async () => {
  const classId = await addClass();
  const studentId = await addStudent(classId);
  const issue = await addIssue(classId, studentId);
  const originalEvidence = evidence({ observedAt: "2026-11-21T09:00:00Z" });
  const run = await addRun(classId, [originalEvidence, transition(issue.id)]);
  const initial = await app.inject(run.url);
  expect(initial.statusCode, initial.body).toBe(200);
  const before = proposalRunDetailDtoSchema.parse(initial.json());
  expect(before.status).toBe("READY");
  expect((await app.inject({ method: "HEAD", url: run.url })).statusCode).toBe(404);
  const saved = await decisions(run, [approve(run.ids[0]), reject(run.ids[1])]);
  expect(saved.statusCode, saved.body).toBe(200);
  const detail = proposalRunDetailDtoSchema.parse(saved.json());
  expect(detail.rawNote).toEqual(before.rawNote);
  expect(detail.rawNote.observedAt).toBe(observedAt);
  expect(detail.status).toBe("APPLIED");
  expect(detail.items).toMatchObject([
    { status: "APPROVED", originalPayload: originalEvidence, teacherPatch: null, resultEntityType: "EVIDENCE_EVENT" },
    { status: "REJECTED", resultEntityId: null, resultEntityType: null, decidedAt: expect.any(String) },
  ]);
  expect(await readIssue(issue.id)).toMatchObject({ state: "OPEN", version: 1 });
  const events = await readEvidence(classId);
  expect(events).toMatchObject([{
    id: detail.items[0].resultEntityId, student_id: studentId, student_issue_id: null, raw_note_id: run.noteId,
    proposal_item_id: run.ids[0], provenance: "AI_PROPOSED_TEACHER_APPROVED", approved_by_user_id: teacherId,
  }]);
  const time = await db.selectFrom("evidence_events")
    .innerJoin("raw_notes", "raw_notes.id", "evidence_events.raw_note_id")
    .select(sql<boolean>`evidence_events.observed_at = raw_notes.observed_at`.as("same"))
    .where("evidence_events.id", "=", events[0].id).executeTakeFirstOrThrow();
  expect(time.same).toBe(true);
  expect(await db.selectFrom("student_issue_transitions").selectAll().where("class_id", "=", classId).execute())
    .toEqual([]);
});

test("orders dependent writes and can use an earlier approved prerequisite after partial review", async () => {
  const classId = await addClass();
  const studentId = await addStudent(classId);
  const run = await addRun(classId, [
    evidence({ studentIssueRef: { kind: "PROPOSED", proposalKey: "issue" } }),
    { key: "issue", type: "CREATE_STUDENT_ISSUE", studentRef, canonicalIssueRef: { kind: "PROPOSED", proposalKey: "canonical" } },
    { key: "canonical", type: "CREATE_CANONICAL_ISSUE", label: "Compare denominators" },
  ], [[0, 1], [1, 2]]);
  const first = await decisions(run, [approve(run.ids[2])]);
  expect(first.statusCode, first.body).toBe(200);
  const partial = proposalRunDetailDtoSchema.parse(first.json());
  expect(partial.status).toBe("PARTIALLY_REVIEWED");
  expect(partial.items.map(({ status, dependencyIds }) => ({ status, dependencyIds }))).toEqual([
    { status: "PENDING", dependencyIds: [run.ids[1]] },
    { status: "PENDING", dependencyIds: [run.ids[2]] },
    { status: "APPROVED", dependencyIds: [] },
  ]);
  const last = await decisions(run, [approve(run.ids[0]), approve(run.ids[1])]);
  expect(last.statusCode, last.body).toBe(200);
  const applied = proposalRunDetailDtoSchema.parse(last.json());
  expect(applied.status).toBe("APPLIED");
  const issueId = applied.items[1].resultEntityId!;
  expect(await readIssue(issueId)).toMatchObject({
    state: "OPEN", version: 1, student_id: studentId, canonical_issue_id: partial.items[2].resultEntityId,
  });
  expect(await readEvidence(classId)).toMatchObject([{ student_issue_id: issueId }]);
  expect(await db.selectFrom("student_issue_transitions").selectAll().where("student_issue_id", "=", issueId).execute())
    .toEqual([]);
  expect((await app.inject(run.url)).json()).toEqual(applied);
});

test("overlapping Student Issue creates in opposite order return a duplicate conflict without deadlocking", async () => {
  const classId = await addClass();
  const firstStudent = await addStudent(classId);
  const secondStudent = await addStudent(classId, "STU_002");
  await addStudent(classId, "STU_003");
  const canonical = buildCanonicalIssue(classId);
  await db.insertInto("canonical_issues").values(canonical).execute();
  const draft = (alias: string): ProposalDraftItemV1 => ({
    key: alias, type: "CREATE_STUDENT_ISSUE", studentRef: { kind: "RESOLVED", studentAlias: alias },
    canonicalIssueRef: { kind: "EXISTING", canonicalIssueId: canonical.id },
  });
  const first = await addRun(classId, [draft("STU_001"), draft("STU_002")]);
  const second = await addRun(classId, [draft("STU_002"), draft("STU_001")]);
  const unrelated = await addRun(classId, [draft("STU_003")]);

  // Hold the two requests after their first insert, or hold the second request behind the first row lock.
  await sql`
    CREATE FUNCTION hold_test_student_issue_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.class_id = ${sql.lit(classId)}::uuid AND
        NEW.student_id IN (${sql.lit(firstStudent)}::uuid, ${sql.lit(secondStudent)}::uuid) THEN
        PERFORM pg_advisory_xact_lock_shared(1010);
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER hold_test_student_issue_insert AFTER INSERT ON student_issues
      FOR EACH ROW EXECUTE FUNCTION hold_test_student_issue_insert();
  `.execute(db);
  try {
    const responses = await db.connection().execute(async (connection) => {
      await sql`SELECT pg_advisory_lock(1010)`.execute(connection);
      const competing = Promise.all([first, second].map((run) => decisions(run, run.ids.map(approve))));
      let unrelatedAttempt: ReturnType<typeof decisions> | undefined;
      try {
        const deadline = Date.now() + 3_000;
        let waiting: number;
        do {
          const result = await sql<{ waiting: number }>`
            WITH RECURSIVE blocked(pid) AS (
              SELECT pg_backend_pid()
              UNION
              SELECT activity.pid FROM pg_stat_activity AS activity
              JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
              WHERE activity.datname = current_database()
            )
            SELECT count(*)::int - 1 AS waiting FROM blocked
          `.execute(connection);
          waiting = result.rows[0].waiting;
          if (waiting < 2) await delay(20);
        } while (waiting < 2 && Date.now() < deadline);
        expect(waiting).toBe(2);
        unrelatedAttempt = decisions(unrelated, unrelated.ids.map(approve));
        const third = await Promise.race([unrelatedAttempt, delay(3_000, null)]);
        expect(third?.statusCode, "Unrelated Student's approval should complete while the others are blocked").toBe(200);
      } finally {
        await sql`SELECT pg_advisory_unlock(1010)`.execute(connection);
        await Promise.allSettled([competing, unrelatedAttempt]);
      }
      return competing;
    });

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 400]);
    expect(responses.find(({ statusCode }) => statusCode === 400)?.json().error.code).toBe("VALIDATION_ERROR");
    const failed = responses[0].statusCode === 400 ? first : second;
    expect((await app.inject(failed.url)).json()).toMatchObject({
      status: "READY", items: [{ status: "PENDING" }, { status: "PENDING" }],
    });
    const created = await db.selectFrom("student_issues").select("student_id").where("class_id", "=", classId).execute();
    expect(created).toHaveLength(3);
    expect(created).toEqual(expect.arrayContaining([{ student_id: firstStudent }, { student_id: secondStudent }]));
  } finally {
    await sql`
      DROP TRIGGER hold_test_student_issue_insert ON student_issues;
      DROP FUNCTION hold_test_student_issue_insert();
    `.execute(db);
  }
}, 12_000);

test("rejected prerequisite rolls back the whole submitted batch", async () => {
  const classId = await addClass();
  await addStudent(classId);
  const run = await addRun(classId, [
    evidence(),
    { key: "canonical", type: "CREATE_CANONICAL_ISSUE", label: "Compare denominators" },
    { key: "issue", type: "CREATE_STUDENT_ISSUE", studentRef, canonicalIssueRef: { kind: "PROPOSED", proposalKey: "canonical" } },
  ], [[2, 1]]);
  const response = await decisions(run, [approve(run.ids[0]), reject(run.ids[1]), approve(run.ids[2])]);
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json().error.code).toBe("PROPOSAL_DEPENDENCY_UNSATISFIED");
  expect(await readEvidence(classId)).toEqual([]);
  expect((await app.inject(run.url)).json()).toMatchObject({
    status: "READY", items: Array.from({ length: 3 }, () => ({ status: "PENDING" })),
  });
});

test("an edited proposed reference must use an approved explicit dependency", async () => {
  const classId = await addClass();
  await addStudent(classId);
  const run = await addRun(classId, [
    { key: "first", type: "CREATE_CANONICAL_ISSUE", label: "First" },
    { key: "second", type: "CREATE_CANONICAL_ISSUE", label: "Second" },
    { key: "issue", type: "CREATE_STUDENT_ISSUE", studentRef, canonicalIssueRef: { kind: "PROPOSED", proposalKey: "first" } },
  ], [[2, 0]]);
  const response = await decisions(run, [
    approve(run.ids[0]), approve(run.ids[1]),
    edit(run.ids[2], { canonicalIssueRef: { kind: "PROPOSED", proposalKey: "second" } }),
  ]);
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json().error.code).toBe("PROPOSAL_DEPENDENCY_UNSATISFIED");
  expect(await db.selectFrom("canonical_issues").selectAll().where("class_id", "=", classId).execute()).toEqual([]);
});

test("independent simultaneous approvals yield one canonical mutation and one already-decided conflict", async () => {
  const classId = await addClass();
  await addStudent(classId);
  const run = await addRun(classId, [evidence()]);
  const input = [approve(run.ids[0])];
  const responses = await Promise.all([decisions(run, input), decisions(run, input)]);
  expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  expect(responses.find(({ statusCode }) => statusCode === 409)?.json().error.code).toBe("PROPOSAL_ITEM_ALREADY_DECIDED");
  expect(await readEvidence(classId)).toHaveLength(1);
});

test("one client request ID replays the operation and conflicts on changed input or run", async () => {
  const classId = await addClass();
  await addStudent(classId);
  const run = await addRun(classId, [evidence()]);
  const other = await addRun(classId, [evidence()]);
  const key = randomUUID();
  const input = [approve(run.ids[0])];
  const [first, retry] = await Promise.all([decisions(run, input, key), decisions(run, input, key)]);
  expect(first.statusCode, first.body).toBe(200);
  expect(retry.statusCode, retry.body).toBe(200);
  expect(retry.json()).toEqual(first.json());
  for (const response of [
    await decisions(run, [reject(run.ids[0])], key),
    await decisions(other, [approve(other.ids[0])], key),
  ]) {
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  }
  expect(await readEvidence(classId)).toHaveLength(1);
});

test("stale concurrent runs roll back unrelated evidence and their decision records", async () => {
  const classId = await addClass();
  const issue = await addIssue(classId, await addStudent(classId));
  const first = await addRun(classId, [evidence(), transition(issue.id)]);
  const second = await addRun(classId, [evidence(), transition(issue.id)]);
  const responses = await Promise.all([first, second].map((run) => decisions(run, run.ids.map(approve))));
  expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  const loser = responses[0].statusCode === 409 ? first : second;
  expect(responses.find(({ statusCode }) => statusCode === 409)?.json().error.code).toBe("STALE_VERSION");
  expect((await app.inject(loser.url)).json()).toMatchObject({
    status: "READY", items: [{ status: "PENDING" }, { status: "PENDING" }],
  });
  expect(await readEvidence(classId)).toHaveLength(1);
  expect(await readIssue(issue.id)).toMatchObject({ state: "IMPROVING", version: 2 });
});

test("manifestation and transition in the same batch can both use the original locked version", async () => {
  const classId = await addClass();
  const issue = await addIssue(classId, await addStudent(classId));
  const run = await addRun(classId, [
    {
      key: "manifestation", type: "UPDATE_MANIFESTATION", expectedVersion: 1, manifestation: "Less frequent",
      studentIssueRef: { kind: "EXISTING", studentIssueId: issue.id },
    },
    transition(issue.id),
  ]);
  const response = await decisions(run, run.ids.map(approve));
  expect(response.statusCode, response.body).toBe(200);
  expect(await readIssue(issue.id)).toMatchObject({ manifestation: "Less frequent", state: "IMPROVING", version: 3 });
});

test("a patch cannot refresh a stale recorded base version", async () => {
  const classId = await addClass();
  const issue = await addIssue(classId, await addStudent(classId), "OPEN", 2);
  const run = await addRun(classId, [evidence(), transition(issue.id)]);
  const response = await decisions(run, [approve(run.ids[0]), edit(run.ids[1], { expectedVersion: 2 })]);
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().error.code).toBe("STALE_VERSION");
  expect(await readEvidence(classId)).toEqual([]);
});

test.each([
  { kind: "AMBIGUOUS", token: "An", candidateAliases: ["STU_001", "STU_002"] },
  { kind: "UNKNOWN", token: "An" },
] as const)("requires a teacher to resolve $kind student identity and preserves the draft", async (unresolved) => {
  const classId = await addClass();
  const studentId = await addStudent(classId);
  const original = evidence({
    studentRef: unresolved.kind === "AMBIGUOUS" ? { ...unresolved, candidateAliases: [...unresolved.candidateAliases] } : unresolved,
  });
  const run = await addRun(classId, [original]);
  const key = randomUUID();
  const noGuess = await decisions(run, [approve(run.ids[0])], key);
  expect(noGuess.statusCode, noGuess.body).toBe(400);
  expect(noGuess.json().error.code).toBe("VALIDATION_ERROR");
  expect(await readEvidence(classId)).toEqual([]);
  const patch = { studentRef, observationText: "Teacher clarified", observedAt: "2026-11-21T14:00:00.876543+07:00" };
  const edited = await decisions(run, [edit(run.ids[0], patch)], key);
  expect(edited.statusCode, edited.body).toBe(200);
  expect(proposalRunDetailDtoSchema.parse(edited.json()).items).toMatchObject([
    { originalPayload: original, teacherPatch: patch, status: "APPROVED" },
  ]);
  expect(await readEvidence(classId)).toMatchObject([{ student_id: studentId, observation_text: "Teacher clarified" }]);
  const time = await db.selectFrom("evidence_events")
    .select(sql<boolean>`observed_at = timestamptz '2026-11-21 07:00:00.876543+00'`.as("exact"))
    .where("class_id", "=", classId).executeTakeFirstOrThrow();
  expect(time.exact).toBe(true);
});

test("requires an ambiguous canonical issue to be resolved without changing item identity", async () => {
  const classId = await addClass();
  const studentId = await addStudent(classId);
  const canonical = buildCanonicalIssue(classId);
  await db.insertInto("canonical_issues").values(canonical).execute();
  const run = await addRun(classId, [{
    key: "issue", type: "CREATE_STUDENT_ISSUE", studentRef,
    canonicalIssueRef: { kind: "AMBIGUOUS", candidateIds: [canonical.id] },
  }]);
  for (const attempt of [
    approve(run.ids[0]),
    edit(run.ids[0], { key: "renamed", canonicalIssueRef: { kind: "EXISTING", canonicalIssueId: canonical.id } }),
    edit(run.ids[0], { type: "CREATE_CANONICAL_ISSUE", label: "Unrelated" }),
  ]) {
    const response = await decisions(run, [attempt]);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  }
  const edited = await decisions(run, [edit(run.ids[0], {
    canonicalIssueRef: { kind: "EXISTING", canonicalIssueId: canonical.id },
  })]);
  expect(edited.statusCode, edited.body).toBe(200);
  expect(await readIssue(edited.json().items[0].resultEntityId)).toMatchObject({ student_id: studentId, canonical_issue_id: canonical.id });
});

test("rejects invalid, unrepresentable, or null patched observedAt before saving evidence", async () => {
  const classId = await addClass();
  await addStudent(classId);
  const run = await addRun(classId, [evidence()]);
  for (const invalid of ["yesterday", "2026-11-21T07:00:00.1234567Z", null]) {
    const response = await decisions(run, [edit(run.ids[0], { observedAt: invalid })]);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  }
  expect(await readEvidence(classId)).toEqual([]);
});

test("rejects other-Class IDs and rejects a same-Class student issue belonging to a different student", async () => {
  const classId = await addClass();
  await addStudent(classId);
  const otherClassId = await addClass();
  const otherClassIssue = await addIssue(otherClassId, await addStudent(otherClassId));
  const sameClassWrongIssue = await addIssue(classId, await addStudent(classId, "STU_002"));
  const run = await addRun(classId, [evidence({
    studentIssueRef: { kind: "EXISTING", studentIssueId: otherClassIssue.id },
  }), {
    key: "student-issue", type: "CREATE_STUDENT_ISSUE", studentRef,
    canonicalIssueRef: { kind: "EXISTING", canonicalIssueId: otherClassIssue.canonicalId },
  }]);
  for (const decision of [
    approve(run.ids[0]),
    approve(run.ids[1]),
    edit(run.ids[0], { studentIssueRef: { kind: "EXISTING", studentIssueId: sameClassWrongIssue.id } }),
  ]) {
    const response = await decisions(run, [decision]);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  }
  expect((await patchIssue(classId, otherClassIssue.id, "state", { expectedVersion: 1, toState: "IMPROVING" })).statusCode).toBe(404);
  expect(await readEvidence(classId)).toEqual([]);
});

test("reopening a resolved issue appends a transition and leaves earlier history intact", async () => {
  const classId = await addClass();
  const issue = await addIssue(classId, await addStudent(classId));
  const resolved = await patchIssue(classId, issue.id, "state", {
    expectedVersion: 1, toState: "RESOLVED_FOR_NOW", reason: "Correct on recheck",
  });
  expect(resolved.statusCode, resolved.body).toBe(200);
  expect(studentIssueDtoSchema.parse(resolved.json())).toMatchObject({ version: 2, state: "RESOLVED_FOR_NOW" });
  const run = await addRun(classId, [{ ...transition(issue.id, "OPEN"), expectedVersion: 2 } as ProposalDraftItemV1]);
  const reopened = await decisions(run, [approve(run.ids[0])]);
  expect(reopened.statusCode, reopened.body).toBe(200);
  expect(await readIssue(issue.id)).toMatchObject({ state: "OPEN", version: 3 });
  const history = await db.selectFrom("student_issue_transitions").selectAll().where("student_issue_id", "=", issue.id)
    .orderBy("created_at").execute();
  expect(history).toMatchObject([
    { from_state: "OPEN", to_state: "RESOLVED_FOR_NOW", proposal_item_id: null, reason: "Correct on recheck", actor_user_id: teacherId },
    { from_state: "RESOLVED_FOR_NOW", to_state: "OPEN", proposal_item_id: run.ids[0], actor_user_id: teacherId },
  ]);
});

test("Student overview preserves the application order of two transitions from one approved batch", async () => {
  const classId = await addClass();
  const studentId = await addStudent(classId);
  const issue = await addIssue(classId, studentId);
  const run = await addRun(classId, [
    { ...transition(issue.id, "IMPROVING"), key: "improve" },
    { ...transition(issue.id, "RESOLVED_FOR_NOW"), key: "resolve" },
  ], [[1, 0]]);
  const firstId = "00000000-0000-4000-8000-000000000002";
  const secondId = "00000000-0000-4000-8000-000000000001";
  await sql`
    CREATE FUNCTION use_reverse_transition_ids() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      NEW.id := CASE WHEN NEW.to_state = 'IMPROVING'
        THEN '00000000-0000-4000-8000-000000000002'::uuid ELSE '00000000-0000-4000-8000-000000000001'::uuid END;
      RETURN NEW;
    END
    $function$;
    CREATE TRIGGER use_reverse_transition_ids BEFORE INSERT ON student_issue_transitions
      FOR EACH ROW EXECUTE FUNCTION use_reverse_transition_ids();
  `.execute(db);
  try {
    const applied = await decisions(run, [approve(run.ids[1]), approve(run.ids[0])]);
    expect(applied.statusCode, applied.body).toBe(200);
  } finally {
    await sql`
      DROP TRIGGER use_reverse_transition_ids ON student_issue_transitions;
      DROP FUNCTION use_reverse_transition_ids();
    `.execute(db);
  }
  expect(await readIssue(issue.id)).toMatchObject({ state: "RESOLVED_FOR_NOW", version: 3 });
  const response = await app.inject(`/api/v1/classes/${classId}/students/${studentId}/overview`);
  expect(response.statusCode, response.body).toBe(200);
  const { transitions } = studentOverviewDtoSchema.parse(response.json());
  expect(transitions).toHaveLength(2);
  expect(transitions[0].createdAt).toBe(transitions[1].createdAt);
  expect(transitions.map(({ id, fromState, toState }) => [id, fromState, toState])).toEqual([
    [firstId, "OPEN", "IMPROVING"], [secondId, "IMPROVING", "RESOLVED_FOR_NOW"],
  ]);
});

test("a direct manifestation edit uses versioning, writes audit history, and leaves issue state and evidence alone", async () => {
  const classId = await addClass();
  const issue = await addIssue(classId, await addStudent(classId));
  const saved = await patchIssue(classId, issue.id, "manifestation", { expectedVersion: 1, manifestation: "Teacher edit" });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(studentIssueDtoSchema.parse(saved.json())).toMatchObject({ version: 2, state: "OPEN", manifestation: "Teacher edit" });
  const stale = await patchIssue(classId, issue.id, "manifestation", { expectedVersion: 1, manifestation: null });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.json().error.code).toBe("STALE_VERSION");
  const invalid = await patchIssue(classId, issue.id, "state", { expectedVersion: 2, toState: "OPEN" });
  expect(invalid.statusCode, invalid.body).toBe(422);
  expect(invalid.json().error.code).toBe("INVALID_ISSUE_TRANSITION");
  expect(await readIssue(issue.id)).toMatchObject({ version: 2, state: "OPEN", manifestation: "Teacher edit" });
  expect(await db.selectFrom("audit_log").selectAll().where("entity_id", "=", issue.id).execute()).toMatchObject([
    { actor_user_id: teacherId, class_id: classId, entity_type: "STUDENT_ISSUE", action: "UPDATE_MANIFESTATION" },
  ]);
  expect(await readEvidence(classId)).toEqual([]);
  expect(await db.selectFrom("student_issue_transitions").selectAll().where("student_issue_id", "=", issue.id).execute())
    .toEqual([]);
});

test("all-rejected batches become applied and a repeated independent decision conflicts", async () => {
  const classId = await addClass();
  const run = await addRun(classId, [evidence()]);
  const response = await decisions(run, [reject(run.ids[0])]);
  expect(response.statusCode, response.body).toBe(200);
  expect(proposalRunDetailDtoSchema.parse(response.json())).toMatchObject({
    status: "APPLIED", items: [{ status: "REJECTED", resultEntityId: null }],
  });
  expect(await readEvidence(classId)).toEqual([]);
  const conflicting = await decisions(run, [approve(run.ids[0])]);
  expect(conflicting.statusCode, conflicting.body).toBe(409);
  expect(conflicting.json().error.code).toBe("PROPOSAL_ITEM_ALREADY_DECIDED");
});

test("requires authentication and Class ownership on review and direct edits", async () => {
  const foreignClass = await addClass(randomUUID());
  const foreignRun = await addRun(foreignClass, [evidence()]);
  const owned = await addClass();
  const ownedRun = await addRun(owned, [evidence()]);
  const issue = await addIssue(foreignClass, await addStudent(foreignClass));
  expect((await app.inject(foreignRun.url)).statusCode).toBe(404);
  expect((await decisions(foreignRun, [approve(foreignRun.ids[0])])).statusCode).toBe(404);
  expect((await decisions(ownedRun, [approve(foreignRun.ids[0])])).statusCode).toBe(404);
  expect((await patchIssue(foreignClass, issue.id, "manifestation", { expectedVersion: 1, manifestation: null })).statusCode)
    .toBe(404);
  const anonymous = await createApp({ db, authVerifier: anonymousAuthVerifier });
  try {
    expect((await anonymous.inject(ownedRun.url)).statusCode).toBe(401);
  } finally {
    await anonymous.close();
  }
});
