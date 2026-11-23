import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import type {
  CanonicalIssueDetailDto, CanonicalIssueSummaryDto, ClassDto, CreateRawNoteResponse, InterventionDto,
  ProposalRunDetailDto, RawNoteDetailDto, ReassessmentDto, ReassessmentDueQueueDto, StudentDto,
} from "../../packages/contracts/src/index.ts";
import { notes } from "./support/capture-fixtures.ts";

test.use({ timezoneId: "UTC" });

async function body<T>(response: Pick<APIResponse, "ok" | "status" | "url" | "json">): Promise<T> {
  expect(response.ok(), `${response.status()} ${response.url()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("reassessment loop: open Home reflects newly due and externally completed work", async ({ baseURL, page }) => {
  if (!baseURL) throw new Error("Set the Playwright baseURL.");
  await page.context().addCookies([{ name: "tutorloop-e2e", value: `capture-${randomUUID()}`, url: baseURL }]);
  const classroom = await body<ClassDto>(await page.request.post("/api/v1/classes", {
    data: { name: "Queue refresh class", timezone: "UTC", clientRequestId: randomUUID() },
  }));
  const api = `/api/v1/classes/${classroom.id}`;
  const student = await body<StudentDto>(await page.request.post(`${api}/students`, {
    data: { displayLabel: "An", clientRequestId: randomUUID() },
  }));
  const sameNameStudent = await body<StudentDto>(await page.request.post(`${api}/students`, {
    data: { displayLabel: "An", clientRequestId: randomUUID() },
  }));
  const [signs, negatives] = ["Signs", "Negative numbers"].map((label) => ({ id: randomUUID(), label }));
  const scheduledAt = "2026-11-20T14:00:00.000Z";
  const entry: ReassessmentDueQueueDto["due"][number] = {
    id: randomUUID(), classId: classroom.id, class: classroom, title: "Timed recheck", notes: null,
    dueAt: scheduledAt, status: "SCHEDULED", performedAt: null, completedAt: null, version: 1, createdAt: scheduledAt,
    targets: [
      { student, canonicalIssue: signs }, { student, canonicalIssue: negatives },
      { student: sameNameStudent, canonicalIssue: signs },
    ].map((target) => ({
      ...target,
      studentIssueId: randomUUID(), interventionId: null, targetStatus: "PENDING", skipReason: null,
      intervention: null,
    })),
  };
  const pending: ReassessmentDueQueueDto["needsResults"][number] = {
    ...entry, status: "PERFORMED_PENDING_EVIDENCE", version: 2, performedAt: scheduledAt,
  };
  let snapshot: ReassessmentDueQueueDto = { due: [], needsResults: [] };
  const rosterResponse = Promise.withResolvers<void>();
  await page.route(`${baseURL}${api}`, async (route) => {
    await rosterResponse.promise;
    await route.fulfill({ status: 503, json: {} });
  });
  await page.route(`**${api}/reassessments/due`, (route) => route.fulfill({ json: snapshot }));
  await page.clock.install();
  await page.goto("/");
  const due = page.getByRole("region", { name: "Due", exact: true });
  const needs = page.getByRole("region", { name: "Needs results" });
  const dueItem = due.getByRole("article", { name: entry.title! });
  const pendingItem = needs.getByRole("article", { name: entry.title! });
  await expect(due.getByText("No reassessments are due.")).toBeVisible();

  try {
    const rosterRequested = page.waitForRequest(`${baseURL}${api}`);
    snapshot = { due: [entry], needsResults: [] };
    await page.clock.fastForward(31_000);
    await rosterRequested;
    await expect(dueItem).toBeVisible();
    const affected = dueItem.getByRole("list", { name: "Affected students" });
    await expect(affected.getByRole("link")).toHaveCount(2);
    for (const { id } of [student, sameNameStudent]) {
      await expect(affected.getByRole("link", { name: `An (student ID ${id})`, exact: true }))
        .toHaveAttribute("href", `/classes/${classroom.id}/students/${id}#timeline`);
    }
    await expect(dueItem.getByRole("list", { name: "Issue history" }).getByRole("link")).toHaveCount(2);

    snapshot = { due: [], needsResults: [pending] };
    await page.clock.fastForward(31_000);
    await expect(dueItem).toHaveCount(0);
    await expect(pendingItem).toBeVisible();
    snapshot = { due: [], needsResults: [] };
    await page.clock.fastForward(31_000);
    await expect(needs.getByText("No reassessments need results.")).toBeVisible();
  } finally {
    rosterResponse.resolve();
  }

  snapshot = { due: [], needsResults: [pending] };
  await page.clock.fastForward(31_000);
  await pendingItem.getByRole("button", { name: "Record outcome" }).click();
  const outcome = page.getByRole("region", { name: "Outcome note" });
  const note = outcome.getByLabel("What happened during the reassessment?");
  await note.fill("An used the two methods independently.");
  snapshot = { due: [], needsResults: [] };
  await page.clock.fastForward(31_000);
  await expect(note).toHaveValue("An used the two methods independently.");
  await outcome.getByRole("button", { name: "Cancel" }).click();
  await expect(needs.getByText("No reassessments need results.")).toBeVisible();
  await expect(page).toHaveURL("/");
});

test("reassessment loop: students with the same name stay distinct from target selection through outcome", async ({ baseURL, page }) => {
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("Set the Playwright baseURL.");
  await page.context().addCookies([{ name: "tutorloop-e2e", value: `capture-${randomUUID()}`, url: baseURL }]);
  const classroom = await body<ClassDto>(await page.request.post("/api/v1/classes", {
    data: { name: "Same-name reassessment class", timezone: "Asia/Bangkok", clientRequestId: randomUUID() },
  }));
  const classPath = `/classes/${classroom.id}`;
  const api = `/api/v1${classPath}`;
  const students: StudentDto[] = [];
  for (const displayLabel of ["An", "Bình"]) {
    students.push(await body(await page.request.post(`${api}/students`, {
      data: { displayLabel, clientRequestId: randomUUID() },
    })));
  }
  const capture = await body<CreateRawNoteResponse>(await page.request.post(`${api}/raw-notes`, {
    data: { body: notes.projection, observedAt: "2020-11-20T07:00:00.000Z", noteType: "OBSERVATION", clientRequestId: randomUUID() },
  }));
  let runPath = "";
  await expect.poll(async () => {
    const { processing } = await body<RawNoteDetailDto>(await page.request.get(`${api}/raw-notes/${capture.rawNote.id}`));
    if (processing.status === "READY") runPath = `${api}/proposal-runs/${processing.proposalRunId}`;
    return processing.status;
  }).toBe("READY");
  const run = await body<ProposalRunDetailDto>(await page.request.get(runPath));
  await body(await page.request.post(`${runPath}/decisions`, {
    data: { clientRequestId: randomUUID(), items: run.items.map(({ id, originalPayload }) => ({
      proposalItemId: id, decision: originalPayload.key === "rejected-observation" ? "REJECT" : "APPROVE",
    })) },
  }));
  for (const student of students) {
    await body(await page.request.patch(`${api}/students/${student.id}`, {
      data: { displayLabel: "Minh", expectedVersion: student.version },
    }));
  }
  const [issue] = await body<CanonicalIssueSummaryDto[]>(await page.request.get(`${api}/issues`));
  const issuePath = `${classPath}/issues/${issue.id}`;
  const detail = await body<CanonicalIssueDetailDto>(await page.request.get(`/api/v1${issuePath}`));
  const studentIssues = students.map(({ id }) => detail.studentIssues.find(({ studentId }) => studentId === id)!.id);

  await page.goto(issuePath);
  const intervention = page.getByRole("region", { name: "Record intervention" });
  await expect(intervention.getByRole("checkbox", { name: "Minh (roster #1)", exact: true })).toBeVisible();
  await intervention.getByRole("checkbox", { name: "Minh (roster #2)", exact: true }).check();
  await intervention.getByLabel("What did you try?").fill("Contrasting examples with the second student.");
  const savedIntervention = page.waitForResponse((response) =>
    response.url().endsWith(`${api}/interventions`) && response.request().method() === "POST");
  await intervention.getByRole("button", { name: "Save intervention" }).click();
  const interventionResult = await body<InterventionDto>(await savedIntervention);
  expect(interventionResult.studentIssueIds).toEqual([studentIssues[1]]);

  const schedule = page.getByRole("region", { name: "Schedule reassessment" });
  await schedule.getByLabel("Title").fill("Same-name recheck");
  await schedule.getByLabel(/Due at/).fill("2020-11-21T14:00");
  for (const position of [1, 2]) await schedule.getByRole("checkbox", { name: `Minh (roster #${position})`, exact: true }).check();
  const savedSchedule = page.waitForResponse((response) =>
    response.url().endsWith(`${api}/reassessments`) && response.request().method() === "POST");
  await schedule.getByRole("button", { name: "Schedule reassessment" }).click();
  const scheduled = await body<ReassessmentDto>(await savedSchedule);
  expect(scheduled.targets.map(({ studentIssueId }) => studentIssueId).sort()).toEqual(studentIssues.toSorted());

  await page.getByRole("link", { name: "TutorLoop" }).click();
  const due = page.getByRole("region", { name: "Due", exact: true }).getByRole("article", { name: "Same-name recheck" });
  for (const [index, student] of students.entries()) {
    await expect(due.getByRole("link", { name: `Minh (roster #${index + 1})`, exact: true }))
      .toHaveAttribute("href", `${classPath}/students/${student.id}#timeline`);
  }
  await due.getByRole("button", { name: "Record outcome" }).click();
  const outcome = page.getByRole("region", { name: "Outcome note" });
  await expect(outcome.getByText("Awaiting evidence for Minh (roster #1), Minh (roster #2).")).toBeVisible();
});

test("reassessment loop: a group recheck stays in Needs results until both outcomes are reviewed", async ({ baseURL, page }) => {
  test.setTimeout(90_000);
  if (!baseURL) throw new Error("Set the Playwright baseURL.");
  await page.context().addCookies([{ name: "tutorloop-e2e", value: `capture-${randomUUID()}`, url: baseURL }]);
  const classroom = await body<ClassDto>(await page.request.post("/api/v1/classes", {
    data: { name: "Reassessment class", timezone: "Asia/Bangkok", clientRequestId: randomUUID() },
  }));
  const classPath = `/classes/${classroom.id}`;
  const api = `/api/v1${classPath}`;
  const students: StudentDto[] = [];
  for (const displayLabel of ["An", "Bình"]) {
    students.push(await body(await page.request.post(`${api}/students`, {
      data: { displayLabel, clientRequestId: randomUUID() },
    })));
  }
  const otherClass = await body<ClassDto>(await page.request.post("/api/v1/classes", {
    data: { name: "Another class", timezone: "UTC", clientRequestId: randomUUID() },
  }));

  const card = (name: string) => page.getByRole("article", { name, exact: true });
  const approve = (name: string) => card(name).getByRole("button", { name: "Approve", exact: true }).click();
  async function apply() {
    await page.getByRole("button", { name: "Apply reviewed changes" }).click();
    await expect(page.getByRole("status", { name: "Review result" })).toHaveText("Reviewed changes applied.");
  }

  await page.goto(classPath);
  await page.getByLabel("What did you notice?").fill(notes.projection);
  await page.getByLabel(/Observed at/).fill("2020-11-20T14:00");
  await page.getByRole("button", { name: "Save note" }).click();
  await page.getByRole("link", { name: "Review proposal", exact: true }).click();
  await approve("Canonical Issue");
  for (const name of ["An", "Bình"]) {
    await approve(`Student Issue · ${name}`);
    await card(`Evidence · ${name}`).filter({ hasText: `${name} sai dấu khi chuyển vế.` })
      .getByRole("button", { name: "Approve", exact: true }).click();
  }
  await card("Evidence · An").filter({ hasText: "Rejected fixture observation" })
    .getByRole("button", { name: "Reject", exact: true }).click();
  await apply();
  await page.getByRole("link", { name: "Back to class" }).click();
  await page.getByRole("link", { name: "Class issues" }).click();
  const issueLink = page.getByRole("link", { name: "Sai dấu khi chuyển vế" });
  const issuePath = await issueLink.getAttribute("href");
  if (!issuePath) throw new Error("Expected a Class Issue history link.");
  await issueLink.click();
  await expect(page).toHaveURL(issuePath);
  const table = page.getByRole("table", { name: "Students with this issue" });
  const expectStates = async (an: string, binh: string) => {
    for (const [student, state] of [["An", an], ["Bình", binh]]) {
      await expect(table.getByRole("row").filter({ has: page.getByRole("link", { name: student, exact: true }) })
        .getByRole("cell", { name: state, exact: true })).toBeVisible();
    }
  };
  await expectStates("Open", "Open");

  const intervention = page.getByRole("region", { name: "Record intervention" });
  await expect(intervention).toBeVisible();
  await intervention.getByLabel("What did you try?").fill("Practised contrasting sign examples together.");
  await intervention.getByLabel(/Occurred at/).fill("2020-11-20T14:00");
  for (const name of ["An", "Bình"]) await intervention.getByRole("checkbox", { name, exact: true }).check();
  await intervention.getByRole("button", { name: "Save intervention" }).click();
  const interventionHistory = page.getByRole("region", { name: "Interventions" });
  await expect(interventionHistory.getByText("Practised contrasting sign examples together.")).toBeVisible();
  await expectStates("Open", "Open");

  const schedule = page.getByRole("region", { name: "Schedule reassessment" });
  await schedule.getByLabel("Title").fill("Sign check");
  await schedule.getByLabel(/Due at/).fill("2020-11-21T14:00");
  for (const name of ["An", "Bình"]) await schedule.getByRole("checkbox", { name, exact: true }).check();
  const prior = schedule.getByLabel("Prior intervention");
  const priorId = await prior.getByRole("option", { name: /Practised contrasting sign examples together\./ }).getAttribute("value");
  expect(priorId).toBeTruthy();
  await prior.selectOption(priorId!);
  await schedule.getByRole("button", { name: "Schedule reassessment" }).click();
  await expect(page.getByRole("region", { name: "Reassessments" }).getByText("Sign check", { exact: true })).toBeVisible();
  await expectStates("Open", "Open");

  await page.getByRole("link", { name: "TutorLoop" }).click();
  const selector = page.getByRole("combobox", { name: "Class", exact: true });
  await selector.selectOption(otherClass.id);
  const due = page.getByRole("region", { name: "Due", exact: true });
  const needsResults = page.getByRole("region", { name: "Needs results", exact: true });
  await expect(due.getByText("No reassessments are due.")).toBeVisible();
  await selector.selectOption(classroom.id);
  await expect(page.getByRole("region", { name: "Quick capture" })).toBeVisible();
  const recent = page.getByRole("region", { name: "Recent captures" });
  await expect(recent.getByText(notes.projection)).toBeVisible();
  const dueItem = due.getByRole("article", { name: "Sign check" });
  await expect(dueItem.getByRole("link", { name: "Sai dấu khi chuyển vế" })).toHaveAttribute("href", issuePath);
  for (const student of students) {
    await expect(dueItem.getByRole("link", { name: student.displayLabel })).toHaveAttribute("href", `${classPath}/students/${student.id}#timeline`);
  }
  await expect(dueItem.getByText("Practised contrasting sign examples together.")).toBeVisible();
  await expect(dueItem.locator("time").first()).toHaveText(/14:00/);
  const markRequests: number[] = [];
  const markResults: ReassessmentDto[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/mark-performed")) markRequests.push(request.postDataJSON().expectedVersion);
  });
  await page.route(`${baseURL}${api}`, (route) => route.fulfill({ status: 503, json: {} }));
  await page.route(`**${api}/reassessments/*/mark-performed`, async (route) => {
    markResults.push(await body<ReassessmentDto>(await route.fetch()));
    await route.fulfill({ status: 503, json: {} });
  });
  await dueItem.getByRole("button", { name: "Record outcome" }).click();
  const pendingItem = needsResults.getByRole("article", { name: "Sign check" });
  const outcome = page.getByRole("region", { name: "Outcome note" });
  await expect.poll(() => markResults.map(({ status }) => status)).toEqual(["PERFORMED_PENDING_EVIDENCE"]);
  await expect(outcome.getByLabel("What happened during the reassessment?")).toBeVisible();
  await expect(dueItem).toHaveCount(0);
  await expect(pendingItem).toBeVisible();
  await page.unroute(`${baseURL}${api}`);
  const performed = (await body<ReassessmentDueQueueDto>(await page.request.get(`${api}/reassessments/due`))).needsResults[0];
  const beforeReview = await body<CanonicalIssueDetailDto>(await page.request.get(`/api/v1${issuePath}`));
  expect(beforeReview.studentIssues.map(({ state }) => state)).toEqual(["OPEN", "OPEN"]);

  const outcomeResponses: string[] = [];
  const outcomeUrl = `**${api}/reassessments/${performed.id}/outcome-note`;
  await page.route(outcomeUrl, async (route) => {
    const response = await route.fetch();
    const saved = await body<{ rawNote: { id: string } }>(response);
    outcomeResponses.push(saved.rawNote.id);
    if (outcomeResponses.length === 1) await route.fulfill({ status: 503, json: {} });
    else await route.fulfill({ response });
  });
  await outcome.getByLabel("What happened during the reassessment?").fill(notes.reassessmentOutcome);
  await outcome.getByLabel(/Observed at/).fill("2020-11-22T14:00");
  await outcome.getByRole("button", { name: "Save outcome note" }).click();
  await expect(outcome.getByRole("alert")).toBeVisible();
  await outcome.getByRole("button", { name: "Save outcome note" }).click();
  await expect(pendingItem).toBeVisible();
  const review = recent.getByRole("listitem").filter({ hasText: notes.reassessmentOutcome }).getByRole("link", { name: "Review proposal" });
  const reviewUrl = await review.getAttribute("href");
  if (!reviewUrl) throw new Error("Expected a proposal review link for the outcome note.");
  await review.click();
  await expect(page).toHaveURL(reviewUrl);
  expect(outcomeResponses).toHaveLength(2);
  expect(new Set(outcomeResponses).size).toBe(1);
  await approve("Evidence · An");
  await card("State transition").filter({ hasText: /An · Sai dấu/ })
    .getByRole("button", { name: "Approve", exact: true }).click();
  await apply();

  await page.getByRole("link", { name: "TutorLoop" }).click();
  await expect(pendingItem).toBeVisible();
  await expect(pendingItem.getByText("An · Evidence recorded")).toBeVisible();
  await expect(pendingItem.getByText("Bình · Awaiting evidence")).toBeVisible();
  await expect(recent.getByText(notes.reassessmentOutcome)).toBeVisible();
  await pendingItem.getByRole("button", { name: "Record outcome" }).click();
  await expect(outcome.getByText("Awaiting evidence for Bình.")).toBeVisible();
  await outcome.getByRole("button", { name: "Cancel" }).click();
  expect(markRequests).toEqual([performed.version - 1]);
  const [early, late] = students;
  const partial = await body<CanonicalIssueDetailDto>(await page.request.get(`/api/v1${issuePath}`));
  expect(partial.studentIssues.find(({ studentId }) => studentId === early.id)?.state).toBe("RESOLVED_FOR_NOW");
  expect(partial.studentIssues.find(({ studentId }) => studentId === late.id)?.state).toBe("OPEN");

  await page.goto(reviewUrl);
  const laterEvidence = card("Evidence · Bình");
  await laterEvidence.getByRole("button", { name: "Edit", exact: true }).click();
  await laterEvidence.getByLabel("Observation").fill("Bình corrected the sign with one prompt.");
  await laterEvidence.getByRole("button", { name: "Approve", exact: true }).click();
  await card("State transition").filter({ hasText: /Bình · Sai dấu/ })
    .getByRole("button", { name: "Approve", exact: true }).click();
  await apply();

  await page.getByRole("link", { name: "TutorLoop" }).click();
  await expect(needsResults.getByText("No reassessments need results.")).toBeVisible();
  const detail = await body<CanonicalIssueDetailDto>(await page.request.get(`/api/v1${issuePath}`));
  expect(detail.reassessments[0].status).toBe("COMPLETED");
  expect(detail.reassessments[0].targets.map(({ targetStatus }) => targetStatus)).toEqual(["EVIDENCED", "EVIDENCED"]);

  for (const [student, evidence, state] of [
    [early, "An independently changed the sign correctly.", "Resolved for now"],
    [late, "Bình corrected the sign with one prompt.", "Improving"],
  ] as const) {
    await page.goto(`${classPath}/students/${student.id}`);
    const timeline = page.getByRole("region", { name: "Timeline" });
    const events = timeline.getByRole("listitem");
    await expect(events).toHaveText([
      new RegExp(`Evidence: ${student.displayLabel} sai dấu`),
      /Intervention: Practised contrasting sign examples together/,
      /Reassessment due.*Sign check/,
      new RegExp(`Evidence: ${evidence}`),
      /Reassessment performed.*Sign check/,
      new RegExp(`Teacher → ${state}`),
    ]);
    await expect(events.nth(0).locator("time")).toHaveText(/14:00/);
    await expect(events.nth(1).locator("time")).toHaveText(/14:00/);
    await expect(events.nth(2).locator("time")).toHaveText(/14:00/);
    await expect(events.nth(3).locator("time")).toHaveText(/14:00/);
  }
});
