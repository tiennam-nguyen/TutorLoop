import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { notes } from "./support/capture-fixtures.ts";

test("merge: teacher edits, rejects an AI merge, then approves without losing source history", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("Missing base URL");
  await page.context().addCookies([{ name: "tutorloop-e2e", value: `capture-${randomUUID()}`, url: baseURL }]);
  const classroom = await (await page.request.post("/api/v1/classes", { data: {
    name: "Merge class", timezone: "UTC", clientRequestId: randomUUID(),
  } })).json() as { id: string };
  const api = `/api/v1/classes/${classroom.id}`;
  await page.request.post(`${api}/students`, { data: { displayLabel: "An", clientRequestId: randomUUID() } });
  async function capture(body: string) {
    await page.goto(`/classes/${classroom.id}`);
    await page.getByLabel("What did you notice?").fill(body);
    const saved = page.waitForResponse((response) => response.url().endsWith(`${api}/raw-notes`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save note" }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const created = await response.json() as { rawNote: { id: string } };
    let runId = "";
    await expect.poll(async () => {
      const note = await (await page.request.get(`${api}/raw-notes/${created.rawNote.id}`)).json() as {
        processing: { status: string; proposalRunId?: string };
      };
      runId = note.processing.proposalRunId ?? "";
      return note.processing.status;
    }).toBe("READY");
    await page.locator(`a[href="/classes/${classroom.id}/proposal-runs/${runId}"]`).click();
  }
  await capture(notes.mergeSeed);
  await expect(page.getByRole("article", { name: "Canonical Issue", exact: true })).toHaveCount(2);
  for (const button of await page.getByRole("button", { name: "Approve", exact: true }).all()) await button.click();
  await page.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(page.getByRole("status", { name: "Review result" })).toBeVisible();
  const list = await (await page.request.get(`${api}/issues`)).json() as { id: string; label: string }[];
  const source = list.find(({ label }) => label === "Source sign issue")!;
  const target = list.find(({ label }) => label === "Target sign issue")!;
  await page.goto(`/classes/${classroom.id}/issues/${source.id}`);
  await page.getByRole("textbox", { name: "Issue label", exact: true }).fill("Teacher source label");
  await page.getByRole("button", { name: "Save issue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Teacher source label", exact: true })).toBeVisible();
  await capture(notes.merge);
  await page.getByRole("article", { name: "Merge Canonical Issues", exact: true }).getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(page.getByRole("status", { name: "Review result" })).toBeVisible();
  expect((await (await page.request.get(`${api}/issues`)).json() as unknown[]).length).toBe(2);
  await capture(notes.merge);
  const card = page.getByRole("article", { name: "Merge Canonical Issues", exact: true });
  await expect(card).toContainText("Teacher source label");
  await expect(card).toContainText("Target sign issue");
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(page.getByRole("status", { name: "Review result" })).toBeVisible();
  await page.reload();
  const historicalMerge = page.getByRole("article", { name: "Merge Canonical Issues", exact: true });
  await expect(historicalMerge).toContainText("Teacher source label");
  await expect(historicalMerge).toContainText("Target sign issue");
  const merged = await (await page.request.get(`${api}/issues`)).json() as { id: string; affectedStudents: number }[];
  expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject({ id: target.id, affectedStudents: 1 });
  await page.goto(`/classes/${classroom.id}/issues/${source.id}`);
  await expect(page.getByRole("heading", { name: "Target sign issue", exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /An.*Source manifestation/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /An.*Target manifestation/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /An.*Source manifestation/ })).toContainText("Source evidence");
  await expect(page.getByRole("row", { name: /An.*Target manifestation/ })).toContainText("Target evidence");
  const detail = await (await page.request.get(`${api}/issues/${target.id}`)).json() as {
    studentIssues: { id: string; manifestation: string }[];
  };
  const sourceBranch = detail.studentIssues.find(({ manifestation }) => manifestation === "Source manifestation")!;
  const intervention = page.getByRole("region", { name: "Record intervention" });
  await expect(intervention.getByRole("checkbox", { name: "An · Source manifestation", exact: true })).toHaveCount(1);
  await intervention.getByRole("checkbox", { name: "An · Source manifestation", exact: true }).check();
  await expect(intervention.getByRole("checkbox", { name: "An · Target manifestation", exact: true })).not.toBeChecked();
  await intervention.getByLabel("What did you try?").fill("Practice the source branch only");
  const interventionSaved = page.waitForResponse((response) => response.url().endsWith(`${api}/interventions`) && response.request().method() === "POST");
  await intervention.getByRole("button", { name: "Save intervention" }).click();
  const activityResponse = await interventionSaved;
  expect(activityResponse.status()).toBe(201);
  expect(await activityResponse.json()).toMatchObject({ studentIssueIds: [sourceBranch.id] });
  const schedule = page.getByRole("region", { name: "Schedule reassessment" });
  await schedule.getByRole("checkbox", { name: "An · Source manifestation", exact: true }).check();
  await schedule.getByLabel(/Due at/).fill("2026-11-24T07:00");
  const reassessmentSaved = page.waitForResponse((response) => response.url().endsWith(`${api}/reassessments`) && response.request().method() === "POST");
  await schedule.getByRole("button", { name: "Schedule reassessment" }).click();
  const scheduleResponse = await reassessmentSaved;
  expect(scheduleResponse.status()).toBe(201);
  expect(await scheduleResponse.json()).toMatchObject({ targets: [{ studentIssueId: sourceBranch.id }] });
});
