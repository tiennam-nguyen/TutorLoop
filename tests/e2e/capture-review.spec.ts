import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { notes } from "./support/capture-fixtures.ts";

test.use({ timezoneId: "UTC" });

async function body<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()} ${response.url()}`).toBe(true);
  return response.json() as Promise<T>;
}

type Student = { id: string; displayLabel: string; aiAlias: string };

async function openClass(page: Page, baseURL: string | undefined, name: string, labels: string[]) {
  if (!baseURL) throw new Error("Set the Playwright baseURL.");
  await page.context().addCookies([{ name: "tutorloop-e2e", value: `capture-${randomUUID()}`, url: baseURL }]);
  const classroom = await body<{ id: string }>(await page.request.post("/api/v1/classes", {
    data: { name, timezone: "Asia/Bangkok", clientRequestId: randomUUID() },
  }));
  const url = `/classes/${classroom.id}`;
  const api = `/api/v1${url}`;
  const students = [];
  for (const displayLabel of labels) {
    students.push(await body<Student>(await page.request.post(`${api}/students`, {
      data: { displayLabel, clientRequestId: randomUUID() },
    })));
  }
  await page.goto(url);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return { api, students };
}

async function saveNote(page: Page, note: string) {
  await page.getByLabel("What did you notice?").fill(note);
  await page.getByRole("button", { name: "Save note" }).click();
}

const reviewLink = (page: Page) => page.getByRole("link", { name: "Review proposal", exact: true });
const card = (page: Page, name: string) => page.getByRole("article", { name, exact: true });
const approve = (page: Page, name: string) => card(page, name).getByRole("button", { name: "Approve", exact: true });

async function apply(page: Page) {
  await page.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(page.getByRole("status", { name: "Review result" })).toHaveText("Reviewed changes applied.");
}

async function roster(page: Page, api: string) {
  return (await body<{ students: Student[] }>(await page.request.get(api))).students;
}

async function seedCanonicalIssues(page: Page, api: string) {
  const captured = await body<{ rawNote: { id: string } }>(await page.request.post(`${api}/raw-notes`, {
    data: { body: notes.seedIssues, observedAt: "2026-11-20T07:00:00Z", noteType: "OBSERVATION", clientRequestId: randomUUID() },
  }));
  const notePath = `${api}/raw-notes/${captured.rawNote.id}`;
  let runId: string | undefined;
  await expect.poll(async () => {
    const { processing } = await body<{ processing: { status: string; proposalRunId?: string } }>(await page.request.get(notePath));
    runId = processing.proposalRunId;
    return processing.status;
  }).toBe("READY");
  const runPath = `${api}/proposal-runs/${runId}`;
  const run = await body<{ items: { id: string }[] }>(await page.request.get(runPath));
  await body(await page.request.post(`${runPath}/decisions`, {
    data: { clientRequestId: randomUUID(), items: run.items.map(({ id }) => ({ proposalItemId: id, decision: "APPROVE" })) },
  }));
}

test.describe("capture review", () => {
  test("shows the saved note immediately and applies only a dependency-valid path", async ({ baseURL, page }) => {
    test.setTimeout(60_000);
    const { api, students: [an, binh] } = await openClass(page, baseURL, "Shared sign error", ["An", "Bình"]);
    const time = page.getByLabel(/Observed at/);
    const defaultTime = Date.parse(`${await time.inputValue()}+07:00`);
    expect(Math.abs(Date.now() - defaultTime)).toBeLessThan(60_000);
    await time.fill("2026-11-20T14:00");

    const recent = page.getByRole("region", { name: "Recent captures" });
    const pollTimes: number[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname.startsWith(`${api}/raw-notes/`)) {
        pollTimes.push(performance.now());
      }
    });
    await saveNote(page, notes.shared);
    await expect(recent.getByText(notes.shared, { exact: true })).toBeVisible({ timeout: 1_500 });
    await expect(reviewLink(page)).toHaveCount(0);
    await expect(recent.getByText("Saved · Structuring…")).toBeVisible();
    await expect(reviewLink(page)).toBeVisible();
    expect(pollTimes.length).toBeGreaterThanOrEqual(2);
    expect(pollTimes[1] - pollTimes[0]).toBeGreaterThanOrEqual(1_850);
    const terminalPollCount = pollTimes.length;
    await new Promise((resolve) => setTimeout(resolve, 2_150));
    expect(pollTimes).toHaveLength(terminalPollCount);

    await reviewLink(page).click();
    const source = page.getByRole("region", { name: "Source note" });
    await expect(source.getByText(notes.shared, { exact: true })).toBeVisible();
    await expect(source.locator("time")).toHaveAttribute("datetime", "2026-11-20T07:00:00.000Z");
    await expect(source.locator("time")).toContainText("14:00");
    await expect(approve(page, "Student Issue · An")).toBeDisabled();
    await approve(page, "Canonical Issue").click();
    await approve(page, "Student Issue · An").click();
    await approve(page, "Evidence · An").click();
    await approve(page, "Student Issue · Bình").click();
    await approve(page, "Evidence · Bình").click();
    await card(page, "Student Issue · Bình").getByRole("button", { name: "Reject" }).click();
    await expect(approve(page, "Evidence · Bình")).toBeDisabled();
    await expect(approve(page, "Evidence · Bình")).toHaveAttribute("aria-pressed", "false");

    const submitted: string[] = [];
    await page.route("**/proposal-runs/*/decisions", async (route) => {
      submitted.push(route.request().postDataJSON().clientRequestId);
      if (submitted.length > 1) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort("failed");
    });
    await page.getByRole("button", { name: "Apply reviewed changes" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await apply(page);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toBe(submitted[0]);
    await page.unroute("**/proposal-runs/*/decisions");

    const anOverview = await body<{ evidence: unknown[]; activeStudentIssues: unknown[] }>(
      await page.request.get(`${api}/students/${an.id}/overview`));
    expect(anOverview.activeStudentIssues).toMatchObject([{ canonicalIssue: { label: "Sai dấu khi chuyển vế" }, state: "OPEN" }]);
    expect(anOverview.evidence).toMatchObject([{ observationText: "An sai dấu khi chuyển vế.", observedAt: "2026-11-20T07:00:00.000Z" }]);
    const binhOverview = await body<{ evidence: unknown[]; activeStudentIssues: unknown[] }>(
      await page.request.get(`${api}/students/${binh.id}/overview`));
    expect(binhOverview.activeStudentIssues).toEqual([]);
    expect(binhOverview.evidence).toEqual([]);

    await page.getByRole("link", { name: "Back to class" }).click();
    await expect(recent.getByText(notes.shared, { exact: true })).toBeVisible();
    await saveNote(page, notes.followUp);
    await recent.getByRole("listitem").filter({ hasText: notes.followUp }).getByRole("link", { name: "Review proposal" }).click();
    await approve(page, "Evidence · An").click();
    await card(page, "Manifestation").getByRole("button", { name: "Edit", exact: true }).click();
    await card(page, "Manifestation").getByRole("textbox", { name: "Manifestation", exact: true }).fill("An còn sai dấu ở bước cuối.");
    await card(page, "State transition").getByRole("button", { name: "Reject" }).click();
    await expect(approve(page, "Evidence · An")).toHaveAttribute("aria-pressed", "true");
    await apply(page);
    const followUp = await body<{ evidence: { observationText: string }[]; activeStudentIssues: unknown[] }>(
      await page.request.get(`${api}/students/${an.id}/overview`));
    expect(followUp.activeStudentIssues).toMatchObject([{ state: "OPEN", manifestation: "An còn sai dấu ở bước cuối." }]);
    expect(followUp.evidence.map(({ observationText }) => observationText)).toContain(notes.followUp);
  });

  test("requires an explicit choice between two students named Minh", async ({ baseURL, page }) => {
    const { api, students: [first, second] } = await openClass(page, baseURL, "Duplicate names", ["Minh", "Minh"]);
    await saveNote(page, notes.ambiguousStudent);
    await reviewLink(page).click();
    const student = page.getByRole("combobox", { name: "Choose student", exact: true });
    await expect(student).toHaveValue("");
    await expect(student.getByRole("option", { name: /Minh/ })).toHaveText(["Minh (roster #1)", "Minh (roster #2)"]);
    await expect(approve(page, "Evidence · Minh")).toBeDisabled();
    await student.selectOption(second.aiAlias);
    await card(page, "Evidence · Minh").getByRole("button", { name: "Approve", exact: true }).click();
    await apply(page);
    expect(await body(await page.request.get(`${api}/students/${first.id}/overview`))).toMatchObject({ evidence: [] });
    expect(await body(await page.request.get(`${api}/students/${second.id}/overview`))).toMatchObject({
      evidence: [{ observationText: notes.ambiguousStudent }],
    });
  });

  test("keeps one saved note on transport retry and requires explicit student creation", async ({ baseURL, page }) => {
    const { api } = await openClass(page, baseURL, "New roster entry", ["An"]);
    const submitted: string[] = [];
    await page.route(`**${api}/raw-notes`, async (route) => {
      submitted.push(route.request().postDataJSON().clientRequestId);
      if (submitted.length > 1) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      return route.abort("failed");
    });
    await saveNote(page, notes.unknownStudent);
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText(notes.unknownStudent, { exact: true })).toHaveCount(1);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toBe(submitted[0]);

    await reviewLink(page).click();
    const evidence = card(page, "Evidence · Lan");
    await expect(evidence.getByRole("combobox", { name: "Choose existing student", exact: true })).toHaveValue("");
    await expect(approve(page, "Evidence · Lan")).toBeDisabled();
    expect((await roster(page, api)).map(({ displayLabel }) => displayLabel)).toEqual(["An"]);
    await evidence.getByRole("button", { name: "Add student to class" }).click();
    await expect(evidence.getByLabel("Student name")).toHaveValue("Lan");
    expect((await roster(page, api)).map(({ displayLabel }) => displayLabel)).toEqual(["An"]);
    await evidence.getByRole("button", { name: "Add student", exact: true }).click();
    const approveLan = approve(page, "Evidence · Lan");
    await expect(approveLan).toBeEnabled();
    const added = (await roster(page, api)).filter(({ displayLabel }) => displayLabel === "Lan");
    expect(added).toHaveLength(1);
    const [lan] = added;
    await expect(evidence.getByRole("combobox", { name: "Choose existing student", exact: true })).toHaveValue(lan.aiAlias);
    await approveLan.click();
    await apply(page);
    expect(await body(await page.request.get(`${api}/students/${lan.id}/overview`))).toMatchObject({
      evidence: [{ observationText: notes.unknownStudent }],
    });
  });

  test("requires an explicit Canonical Issue selection", async ({ baseURL, page }) => {
    const { api, students: [an] } = await openClass(page, baseURL, "Ambiguous issue", ["An"]);
    await seedCanonicalIssues(page, api);
    await saveNote(page, notes.ambiguousIssue);
    await reviewLink(page).click();
    const issue = page.getByRole("combobox", { name: "Choose Canonical Issue", exact: true });
    await expect(issue).toHaveValue("");
    await expect(issue.getByRole("option", { name: "Sai dấu khi chuyển vế" })).toBeAttached();
    await expect(issue.getByRole("option", { name: "Nhầm dấu số âm" })).toBeAttached();
    await expect(approve(page, "Student Issue · An")).toBeDisabled();
    await issue.selectOption({ label: "Nhầm dấu số âm" });
    await approve(page, "Student Issue · An").click();
    await apply(page);
    expect(await body(await page.request.get(`${api}/students/${an.id}/overview`))).toMatchObject({
      activeStudentIssues: [{ canonicalIssue: { label: "Nhầm dấu số âm" } }],
    });
  });

  test("offers manual retry only after a final failure", async ({ baseURL, page }) => {
    test.setTimeout(45_000);
    const { api } = await openClass(page, baseURL, "Structuring retry", ["An"]);
    let pollRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname.startsWith(`${api}/raw-notes/`)) pollRequests++;
    });
    await saveNote(page, notes.retry);
    const retry = page.getByRole("button", { name: "Retry structuring" });
    await expect(page.getByText(notes.retry, { exact: true })).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(page.getByText("Saved · Structuring…")).toBeVisible();
    await page.getByRole("link", { name: "Classes", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Classes", exact: true })).toBeVisible();
    const departedPollCount = pollRequests;
    await new Promise((resolve) => setTimeout(resolve, 2_150));
    expect(pollRequests).toBe(departedPollCount);
    await page.goBack();
    await expect(page.getByText(notes.retry, { exact: true })).toBeVisible();
    await expect(retry).toBeVisible({ timeout: 20_000 });
    const failedPollCount = pollRequests;
    await new Promise((resolve) => setTimeout(resolve, 2_150));
    expect(pollRequests).toBe(failedPollCount);
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(reviewLink(page)).toBeVisible();
    await page.reload();
    await expect(page.getByText(notes.retry, { exact: true })).toBeVisible();
    await expect(reviewLink(page)).toBeVisible();
  });
});
