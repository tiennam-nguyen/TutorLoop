import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type {
  CanonicalIssueDetailDto, CanonicalIssueListDto, ClassDto, CreateRawNoteResponse, InterventionDto,
  ProposalRunDetailDto, RawNoteDetailDto, ReassessmentDto, ReassessmentDueQueueDto, StudentDto, StudentOverviewDto,
} from "../../packages/contracts/src/index.ts";
import { notes } from "./support/capture-fixtures.ts";
import { json, posted } from "./support/http.ts";

test.use({ timezoneId: "UTC" });

const issueLabel = "Sai dấu khi chuyển vế";
const editedManifestation = "Lost the minus sign while moving a term.";
const interventionDescription = "Practised contrasting sign examples together.";
const checkTitle = "Sign check after practice";

test("classroom follow-up from capture to later recurrence", { tag: "@mvp" }, async ({ baseURL, page }) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Set the Playwright baseURL.");
  await page.context().addCookies([{ name: "tutorloop-e2e", value: `capture-${randomUUID()}`, url: baseURL }]);

  const card = (name: string) => page.getByRole("article", { name, exact: true });
  const approve = (name: string) => card(name).getByRole("button", { name: "Approve", exact: true }).click();
  const capture = (text: string) => page.getByRole("region", { name: "Recent captures" })
    .getByRole("listitem").filter({ hasText: text });
  async function openReview(text: string) {
    await capture(text).getByRole("link", { name: "Review proposal" }).click();
    await expect(page.getByRole("region", { name: "Source note" }).getByText(text, { exact: true })).toBeVisible();
    return `/api/v1${new URL(page.url()).pathname}`;
  }
  async function applyReview(runPath: string) {
    const applied = posted(page, `${runPath}/decisions`);
    await page.getByRole("button", { name: "Apply reviewed changes" }).click();
    const run = await json<ProposalRunDetailDto>(await applied);
    await expect(page.getByRole("status", { name: "Review result" })).toHaveText("Reviewed changes applied.");
    return run;
  }

  const { classroom, students } = await test.step("Create a class and its roster in the browser", async () => {
    await page.goto("/classes");
    await page.getByLabel("Class name").fill("Golden sign practice");
    await page.getByLabel("Timezone").fill("UTC");
    const createdClass = posted(page, "/api/v1/classes");
    await page.getByRole("button", { name: "Create class" }).click();
    const classroom = await json<ClassDto>(await createdClass);
    await page.getByRole("link", { name: classroom.name, exact: true }).click();
    const students: StudentDto[] = [];
    for (const name of ["An", "Bình"]) {
      await page.getByLabel("Student name", { exact: true }).fill(name);
      const createdStudent = posted(page, `/api/v1/classes/${classroom.id}/students`);
      await page.getByRole("button", { name: "Add student" }).click();
      students.push(await json<StudentDto>(await createdStudent));
      await expect(page.getByRole("list", { name: "Active students" }).getByText(name, { exact: true })).toBeVisible();
    }
    return { classroom, students };
  });
  const [an, binh] = students;
  const classPath = `/classes/${classroom.id}`;
  const api = `/api/v1${classPath}`;
  const overview = async (student: StudentDto) =>
    json<StudentOverviewDto>(await page.request.get(`${api}/students/${student.id}/overview`));
  async function saveObservation(text: string, observedAt: string) {
    await page.getByLabel("What did you notice?").fill(text);
    await page.getByLabel(/Observed at/).fill(observedAt);
    const saved = posted(page, `${api}/raw-notes`);
    await page.getByRole("button", { name: "Save note" }).click();
    const { rawNote } = await json<CreateRawNoteResponse>(await saved);
    expect(rawNote).toMatchObject({ body: text, observedAt: `${observedAt}:00.000Z`, noteType: "OBSERVATION" });
    return rawNote;
  }

  const { firstRun, issuePath, studentIssues } = await test.step("Capture, persist, edit, approve and reject independently", async () => {
    const raw = await saveObservation(notes.projection, "2020-11-20T14:00");
    await page.reload();
    await expect(capture(notes.projection)).toBeVisible();
    const runPath = await openReview(notes.projection);
    const stored = await json<RawNoteDetailDto>(await page.request.get(`${api}/raw-notes/${raw.id}`));
    expect(stored.rawNote).toEqual(raw);
    expect(stored.processing).toMatchObject({ status: "READY" });
    expect(await json(await page.request.get(`${api}/issues`))).toEqual([]);
    const pending = await json<ProposalRunDetailDto>(await page.request.get(runPath));
    expect(pending.rawNote.id).toBe(raw.id);
    expect(pending.items.map(({ status }) => status)).toEqual(Array(6).fill("PENDING"));

    await approve("Canonical Issue");
    const edited = card("Student Issue · An");
    await edited.getByRole("button", { name: "Edit", exact: true }).click();
    await edited.getByRole("textbox", { name: "Manifestation" }).fill(editedManifestation);
    await edited.getByRole("button", { name: "Approve", exact: true }).click();
    await approve("Student Issue · Bình");
    for (const { displayLabel } of students) {
      await card(`Evidence · ${displayLabel}`).filter({ hasText: `${displayLabel} sai dấu khi chuyển vế.` })
        .getByRole("button", { name: "Approve", exact: true }).click();
    }
    await card("Evidence · An").filter({ hasText: "Rejected fixture observation" })
      .getByRole("button", { name: "Reject", exact: true }).click();
    const firstRun = await applyReview(runPath);
    expect(firstRun.items.find(({ originalPayload }) => originalPayload.key === "An-issue"))
      .toMatchObject({ status: "APPROVED", teacherPatch: { manifestation: editedManifestation } });
    expect(firstRun.items.find(({ originalPayload }) => originalPayload.key === "rejected-observation"))
      .toMatchObject({ status: "REJECTED", resultEntityId: null });

    await page.getByRole("link", { name: "Back to class" }).click();
    await page.getByRole("link", { name: "Class issues" }).click();
    const row = page.getByRole("table", { name: "Class issues" }).getByRole("row", { name: new RegExp(issueLabel) });
    await expect(row.getByRole("cell")).toHaveText([issueLabel, "2", "0", "0", "0"]);
    await row.getByRole("link", { name: issueLabel }).click();
    await page.waitForURL(/\/issues\/[a-f0-9-]+$/);
    const issuePath = new URL(page.url()).pathname;
    const list = await json<CanonicalIssueListDto>(await page.request.get(`${api}/issues`));
    expect(list).toMatchObject([{ id: issuePath.split("/").at(-1), label: issueLabel, affectedStudents: 2 }]);
    const detail = await json<CanonicalIssueDetailDto>(await page.request.get(`/api/v1${issuePath}`));
    expect(detail.studentIssues).toHaveLength(2);
    expect(firstRun.items.find(({ originalPayload }) => originalPayload.key === "signs"))
      .toMatchObject({ status: "APPROVED", resultEntityId: detail.id });
    const studentIssues = new Map(detail.studentIssues.map((issue) => [issue.studentId, issue]));
    for (const student of students) {
      const { activeStudentIssues, evidence } = await overview(student);
      const issue = studentIssues.get(student.id)!;
      const manifestation = student.id === an.id ? editedManifestation : null;
      expect(issue.manifestation).toBe(manifestation);
      expect(activeStudentIssues).toMatchObject([{ id: issue.id, canonicalIssueId: detail.id, state: "OPEN", manifestation }]);
      expect(evidence).toMatchObject([{ id: issue.evidenceIds[0], studentIssueId: issue.id, rawNoteId: raw.id }]);
      expect(firstRun.items.find(({ originalPayload }) => originalPayload.key === `${student.displayLabel}-issue`))
        .toMatchObject({ status: "APPROVED", resultEntityId: issue.id });
      expect(firstRun.items.find(({ originalPayload }) => originalPayload.key === `${student.displayLabel}-evidence`))
        .toMatchObject({ status: "APPROVED", resultEntityId: evidence[0].id });
    }
    await page.getByRole("link", { name: "An", exact: true }).click();
    await expect(page.getByRole("region", { name: "Active issues" }).getByRole("link", { name: issueLabel })).toBeVisible();
    await page.getByRole("region", { name: "Active issues" }).getByRole("link", { name: issueLabel }).click();
    return { firstRun, issuePath, studentIssues };
  });

  const { outcomeRun, reassessment } = await test.step("Record group practice and schedule a due reassessment with a shared outcome", async () => {
    const targets = [...studentIssues.values()].map(({ id }) => id).sort();
    const intervention = page.getByRole("region", { name: "Record intervention" });
    await intervention.getByLabel("What did you try?").fill(interventionDescription);
    await intervention.getByLabel(/Occurred at/).fill("2020-11-21T14:00");
    for (const { displayLabel } of students) await intervention.getByRole("checkbox", { name: displayLabel, exact: true }).check();
    const interventionResponse = posted(page, `${api}/interventions`);
    await intervention.getByRole("button", { name: "Save intervention" }).click();
    const saved = await json<InterventionDto>(await interventionResponse);
    expect(saved.studentIssueIds.toSorted()).toEqual(targets);
    await expect(page.getByRole("region", { name: "Interventions" }).getByText(interventionDescription)).toBeVisible();

    const schedule = page.getByRole("region", { name: "Schedule reassessment" });
    await schedule.getByLabel("Title").fill(checkTitle);
    await schedule.getByLabel(/Due at/).fill("2020-11-22T14:00");
    for (const { displayLabel } of students) await schedule.getByRole("checkbox", { name: displayLabel, exact: true }).check();
    await schedule.getByLabel("Prior intervention").selectOption(saved.id);
    const scheduleResponse = posted(page, `${api}/reassessments`);
    await schedule.getByRole("button", { name: "Schedule reassessment" }).click();
    const reassessment = await json<ReassessmentDto>(await scheduleResponse);
    expect(reassessment.status).toBe("SCHEDULED");
    expect(reassessment.targets.map(({ studentIssueId }) => studentIssueId).sort()).toEqual(targets);
    for (const target of reassessment.targets) expect(target.interventionId).toBe(saved.id);
    await expect(page.getByRole("region", { name: "Reassessments" }).getByText(checkTitle, { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "TutorLoop" }).click();
    const due = page.getByRole("region", { name: "Due", exact: true }).getByRole("article", { name: checkTitle });
    await expect(due.getByRole("link", { name: issueLabel })).toHaveAttribute("href", issuePath);
    for (const student of students) {
      await expect(due.getByRole("link", { name: student.displayLabel })).toHaveAttribute("href", `${classPath}/students/${student.id}#timeline`);
    }
    const dueQueue = await json<ReassessmentDueQueueDto>(await page.request.get(`${api}/reassessments/due`));
    expect(dueQueue.due).toMatchObject([{ id: reassessment.id, status: "SCHEDULED" }]);
    await due.getByRole("button", { name: "Record outcome" }).click();
    const outcome = page.getByRole("region", { name: "Outcome note" });
    await outcome.getByLabel("What happened during the reassessment?").fill(notes.reassessmentOutcome);
    await outcome.getByLabel(/Observed at/).fill("2020-11-23T14:00");
    const outcomeResponse = posted(page, `${api}/reassessments/${reassessment.id}/outcome-note`);
    await outcome.getByRole("button", { name: "Save outcome note" }).click();
    const { rawNote } = await json<CreateRawNoteResponse>(await outcomeResponse);
    expect(rawNote).toMatchObject({ body: notes.reassessmentOutcome, noteType: "REASSESSMENT_OUTCOME", reassessmentId: reassessment.id });
    await expect(page.getByRole("region", { name: "Needs results" }).getByRole("article", { name: checkTitle })).toBeVisible();
    const runPath = await openReview(notes.reassessmentOutcome);
    for (const student of students) {
      const { activeStudentIssues, evidence, transitions } = await overview(student);
      expect(activeStudentIssues).toMatchObject([{ state: "OPEN" }]);
      expect(evidence).toHaveLength(1);
      expect(transitions).toEqual([]);
    }

    // Evidence decisions and teaching decisions are independent.
    await approve("Evidence · An");
    await approve("Evidence · Bình");
    const transition = (name: string) => card("State transition").filter({ hasText: `${name} · ${issueLabel}` });
    await transition("An").getByRole("button", { name: "Approve", exact: true }).click();
    await transition("Bình").getByRole("button", { name: "Reject", exact: true }).click();
    const outcomeRun = await applyReview(runPath);
    expect(outcomeRun.rawNote.id).toBe(rawNote.id);
    expect(outcomeRun.items.find(({ originalPayload }) => originalPayload.key === "Bình-transition"))
      .toMatchObject({ status: "REJECTED", resultEntityId: null });
    const detail = await json<CanonicalIssueDetailDto>(await page.request.get(`/api/v1${issuePath}`));
    expect(detail.countsByState).toEqual({ OPEN: 1, IMPROVING: 0, RESOLVED_FOR_NOW: 1 });
    expect(detail.reassessments).toMatchObject([{ id: reassessment.id, status: "COMPLETED",
      targets: [{ targetStatus: "EVIDENCED" }, { targetStatus: "EVIDENCED" }] }]);
    expect((await overview(an)).resolvedStudentIssues).toMatchObject([{ id: studentIssues.get(an.id)!.id, state: "RESOLVED_FOR_NOW" }]);
    expect((await overview(binh)).activeStudentIssues).toMatchObject([{ id: studentIssues.get(binh.id)!.id, state: "OPEN" }]);
    return { outcomeRun, reassessment };
  });

  await test.step("Approve a recurrence and trace each recorded decision to its supporting note", async () => {
    await page.getByRole("link", { name: "Back to class" }).click();
    const recurrence = await saveObservation(notes.recurrence, "2020-11-24T14:00");
    const runPath = await openReview(notes.recurrence);
    await approve("Evidence · An");
    await approve("State transition");
    const reopenRun = await applyReview(runPath);
    expect(reopenRun.rawNote.id).toBe(recurrence.id);
    const detail = await json<CanonicalIssueDetailDto>(await page.request.get(`/api/v1${issuePath}`));
    expect(detail.countsByState).toEqual({ OPEN: 2, IMPROVING: 0, RESOLVED_FOR_NOW: 0 });

    for (const student of students) {
      const { activeStudentIssues, resolvedStudentIssues, evidence, transitions } = await overview(student);
      const issue = studentIssues.get(student.id)!;
      expect(activeStudentIssues).toMatchObject([{ id: issue.id, canonicalIssueId: detail.id, state: "OPEN" }]);
      expect(resolvedStudentIssues).toEqual([]);
      expect(detail.studentIssues.find(({ id }) => id === issue.id)).toMatchObject({ state: "OPEN", evidenceIds: expect.arrayContaining(evidence.map(({ id }) => id)) });
      const trail = student.id === an.id ? [firstRun, outcomeRun, reopenRun] : [firstRun, outcomeRun];
      expect(evidence.map(({ rawNoteId }) => rawNoteId)).toEqual(trail.map(({ rawNote }) => rawNote.id));
      if (student.id === an.id) {
        const approvedTransitions = [outcomeRun, reopenRun].map((run) =>
          run.items.find(({ originalPayload }) => originalPayload.key === "An-transition")!);
        expect(approvedTransitions.map(({ status, resultEntityId }) => ({ status, resultEntityId }))).toEqual([
          { status: "APPROVED", resultEntityId: issue.id }, { status: "APPROVED", resultEntityId: issue.id },
        ]);
        expect(transitions).toMatchObject([
          { studentIssueId: issue.id, fromState: "OPEN", toState: "RESOLVED_FOR_NOW", proposalItemId: approvedTransitions[0].id },
          { studentIssueId: issue.id, fromState: "RESOLVED_FOR_NOW", toState: "OPEN", proposalItemId: approvedTransitions[1].id },
        ]);
      } else {
        expect(transitions).toEqual([]);
      }

      await page.goto(`${classPath}/students/${student.id}`);
      const timeline = page.getByRole("region", { name: "Timeline" });
      await expect(timeline.getByText(interventionDescription)).toBeVisible();
      await expect(timeline.getByText(/Reassessment performed.*Sign check after practice/)).toBeVisible();
      const decisions = timeline.getByRole("listitem").filter({ hasText: "Teacher →" });
      if (student.id === an.id) await expect(decisions).toHaveText([/Teacher → Resolved for now/, /Teacher → Open/]);
      else await expect(decisions).toHaveCount(0);
      for (const [index, item] of evidence.entries()) {
        const run = trail[index];
        const approved = run.items.find(({ itemType, resultEntityId }) => itemType === "CREATE_EVIDENCE" && resultEntityId === item.id);
        expect(approved).toMatchObject({ status: "APPROVED", id: item.proposalItemId });
        expect(item).toMatchObject({ studentIssueId: issue.id, rawNoteId: run.rawNote.id,
          reassessmentId: run.id === outcomeRun.id ? reassessment.id : null });
        const event = timeline.getByRole("listitem").filter({ hasText: item.observationText });
        await event.getByRole("button", { name: "Show source note" }).click();
        await expect(event.getByText(run.rawNote.body)).toBeVisible();
      }
    }
  });
});
