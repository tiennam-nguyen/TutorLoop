import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import { notes } from "./support/capture-fixtures.ts";

test.use({ timezoneId: "UTC" });

async function body<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()} ${response.url()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("projection: reviewed capture connects class aggregate, student history, and exact source note", async ({ baseURL, page }) => {
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("Set the Playwright baseURL.");
  const viewEvents: Array<Record<string, unknown>> = [];
  // Analytics failures must never prevent the educational workflow.
  await page.route("**/api/v1/product-events", async (route) => {
    viewEvents.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.context().addCookies([{ name: "tutorloop-e2e", value: `capture-${randomUUID()}`, url: baseURL }]);
  const classroom = await body<{ id: string }>(await page.request.post("/api/v1/classes", {
    data: { name: "Projection class", timezone: "Asia/Bangkok", clientRequestId: randomUUID() },
  }));
  const api = `/api/v1/classes/${classroom.id}`;
  const students: { id: string; displayLabel: string }[] = [];
  for (const displayLabel of ["An", "Bình"]) {
    students.push(await body(await page.request.post(`${api}/students`, {
      data: { displayLabel, clientRequestId: randomUUID() },
    })));
  }
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Due", exact: true })).toBeVisible();
  await expect.poll(() => viewEvents.filter(({ eventName }) => eventName === "reassessment_due_opened").length).toBe(1);
  await page.goto(`/classes/${classroom.id}`);
  await page.getByLabel("What did you notice?").fill(notes.projection);
  await page.getByLabel(/Observed at/).fill("2026-11-20T14:00");
  await page.getByRole("button", { name: "Save note" }).click();
  await page.getByRole("link", { name: "Review proposal", exact: true }).click();

  const card = (name: string) => page.getByRole("article", { name, exact: true });
  await card("Canonical Issue").getByRole("button", { name: "Approve", exact: true }).click();
  for (const [name, manifestation] of [["An", "moving negative terms"], ["Bình", "after parentheses"]]) {
    const issue = card(`Student Issue · ${name}`);
    await issue.getByRole("button", { name: "Edit", exact: true }).click();
    await issue.getByRole("textbox", { name: "Manifestation" }).fill(manifestation);
    await issue.getByRole("button", { name: "Approve", exact: true }).click();
    await card(`Evidence · ${name}`).filter({ hasText: `${name} sai dấu khi chuyển vế.` })
      .getByRole("button", { name: "Approve", exact: true }).click();
  }
  await card("Evidence · An").filter({ hasText: "Rejected fixture observation" })
    .getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(page.getByRole("status", { name: "Review result" })).toHaveText("Reviewed changes applied.");
  await page.getByRole("link", { name: "Back to class" }).click();
  await page.getByRole("link", { name: "Class issues" }).click();
  const table = page.getByRole("table", { name: "Class issues" });
  await expect(table.getByRole("columnheader")).toHaveText(["Issue", "Open", "Improving", "Resolved", "Due"]);
  const row = table.getByRole("row", { name: /Sai dấu khi chuyển vế/ });
  await expect(row.getByRole("cell")).toHaveText(["Sai dấu khi chuyển vế", "2", "0", "0", "0"]);
  await row.getByRole("link", { name: "Sai dấu khi chuyển vế" }).click();
  await expect(page.getByRole("row", { name: /An.*moving negative terms/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Bình.*after parentheses/ })).toBeVisible();
  await expect(page.getByText("An sai dấu khi chuyển vế.")).toBeVisible();
  await expect(page.getByText("Bình sai dấu khi chuyển vế.")).toBeVisible();
  await expect(page.getByText("Rejected fixture observation")).toHaveCount(0);

  const overview = await body<{ activeStudentIssues: { id: string; version: number }[] }>(
    await page.request.get(`${api}/students/${students[0].id}/overview`));
  await body(await page.request.patch(`${api}/student-issues/${overview.activeStudentIssues[0].id}/state`, {
    data: { expectedVersion: overview.activeStudentIssues[0].version, toState: "IMPROVING", reason: "Teacher follow-up" },
  }));

  await page.getByRole("link", { name: "An" }).click();
  await expect(page.getByRole("heading", { name: "Active issues" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sai dấu khi chuyển vế" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Resolved for now" })).toBeVisible();
  const evidence = page.getByRole("listitem").filter({ hasText: "An sai dấu khi chuyển vế." });
  await evidence.getByRole("button", { name: "Show source note" }).click();
  await expect(evidence.getByText(notes.projection)).toBeVisible();
  await expect.poll(() => [...new Set(viewEvents.map(({ eventName }) => eventName))].sort()).toEqual([
    "class_issue_view_opened", "history_opened", "proposal_review_opened", "reassessment_due_opened", "student_view_opened",
  ]);
  for (const event of viewEvents) {
    expect(Object.keys(event).sort()).toEqual(event.entityId ? ["classId", "entityId", "eventName"] : ["classId", "eventName"]);
    expect(event.classId).toBe(classroom.id);
  }
  expect(JSON.stringify(viewEvents)).not.toContain(notes.projection);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByRole("listitem")).toHaveText([/Evidence: An sai dấu/, /Teacher → Improving.*Teacher follow-up/]);
  await expect(page.getByText("Rejected fixture observation")).toHaveCount(0);
  const improving = await body<{ activeStudentIssues: { id: string; version: number }[] }>(
    await page.request.get(`${api}/students/${students[0].id}/overview`));
  await body(await page.request.patch(`${api}/student-issues/${improving.activeStudentIssues[0].id}/state`, {
    data: { expectedVersion: improving.activeStudentIssues[0].version, toState: "RESOLVED_FOR_NOW" },
  }));
  await page.reload();
  await expect(page.getByRole("region", { name: "Active issues" }).getByText("None.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Resolved for now" }).getByRole("link", { name: "Sai dấu khi chuyển vế" })).toBeVisible();
});
