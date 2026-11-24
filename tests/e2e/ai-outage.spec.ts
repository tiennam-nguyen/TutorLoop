import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type {
  CanonicalIssueDetailDto, CanonicalIssueListDto, ClassDto, CreateRawNoteResponse, RawNoteDetailDto, StudentDto, StudentOverviewDto,
} from "../../packages/contracts/src/index.ts";
import { notes } from "./support/capture-fixtures.ts";
import { json, posted } from "./support/http.ts";

test("AI outage preserves capture and manual recovery applies a single set of records", async ({ baseURL, page }) => {
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("Set the Playwright baseURL.");
  await page.context().addCookies([{ name: "tutorloop-e2e", value: `capture-${randomUUID()}`, url: baseURL }]);
  const classroom = await json<ClassDto>(await page.request.post("/api/v1/classes", {
    data: { name: "Outage sign practice", timezone: "UTC", clientRequestId: randomUUID() },
  }));
  const classPath = `/classes/${classroom.id}`;
  const api = `/api/v1${classPath}`;
  const student = await json<StudentDto>(await page.request.post(`${api}/students`, {
    data: { displayLabel: "An", clientRequestId: randomUUID() },
  }));
  const listIssues = async () => json<CanonicalIssueListDto>(await page.request.get(`${api}/issues`));
  const overview = async () => json<StudentOverviewDto>(await page.request.get(`${api}/students/${student.id}/overview`));

  await page.goto(classPath);
  await page.getByLabel("What did you notice?").fill(notes.retry);
  const save = posted(page, `${api}/raw-notes`);
  await page.getByRole("button", { name: "Save note" }).click();
  const { rawNote, processing } = await json<CreateRawNoteResponse>(await save);
  expect(rawNote.body).toBe(notes.retry);
  expect(processing.status).toBe("QUEUED");
  const notePath = `${api}/raw-notes/${rawNote.id}`;
  const getNote = async () => json<RawNoteDetailDto>(await page.request.get(notePath));
  const entry = page.getByRole("region", { name: "Recent captures" }).getByRole("listitem").filter({ hasText: notes.retry });
  await expect(entry.getByText(notes.retry, { exact: true })).toBeVisible();
  await expect(entry.getByText("Structuring failed")).toBeVisible({ timeout: 25_000 });
  expect(await getNote()).toMatchObject({ rawNote, processing: { status: "FAILED" } });
  expect(await listIssues()).toEqual([]);
  expect((await overview()).evidence).toEqual([]);

  await page.reload();
  await expect(entry.getByText(notes.retry, { exact: true })).toBeVisible();
  await expect(entry.getByText("Structuring failed")).toBeVisible();
  await expect(entry.getByRole("link", { name: "Review proposal" })).toHaveCount(0);

  // The fake rejects all three automatic attempts and recovers on the manual request.
  const manual = posted(page, `${notePath}/reprocess`);
  await entry.getByRole("button", { name: "Retry structuring" }).click();
  const response = await manual;
  const retried = await json<CreateRawNoteResponse>(response);
  expect(retried.rawNote).toEqual(rawNote);
  expect(retried.processing.jobId).not.toBe(processing.jobId);
  expect(await json<CreateRawNoteResponse>(await page.request.post(`${notePath}/reprocess`, {
    data: response.request().postDataJSON(),
  }))).toEqual(retried);

  await entry.getByRole("link", { name: "Review proposal" }).click();
  await expect(page.getByRole("region", { name: "Source note" }).getByText(notes.retry, { exact: true })).toBeVisible();
  const ready = await getNote();
  const runId = new URL(page.url()).pathname.split("/").at(-1);
  expect(ready).toMatchObject({ rawNote, processing: { status: "READY", proposalRunId: runId } });
  expect(await listIssues()).toEqual([]);

  for (const name of ["Canonical Issue", "Student Issue · An", "Evidence · An"]) {
    await page.getByRole("article", { name, exact: true }).getByRole("button", { name: "Approve", exact: true }).click();
  }
  await page.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(page.getByRole("status", { name: "Review result" })).toHaveText("Reviewed changes applied.");
  const issues = await listIssues();
  expect(issues).toMatchObject([{ label: "Lỗi dấu trong bài kiểm tra", affectedStudents: 1 }]);
  const detail = await json<CanonicalIssueDetailDto>(await page.request.get(`${api}/issues/${issues[0].id}`));
  expect(detail.studentIssues).toMatchObject([{ studentId: student.id, state: "OPEN" }]);
  const [issue] = detail.studentIssues;
  const history = await overview();
  expect(history.activeStudentIssues).toMatchObject([{ id: issue.id, canonicalIssueId: detail.id }]);
  expect(history.evidence).toMatchObject([{ rawNoteId: rawNote.id, studentIssueId: issue.id, observationText: notes.retry }]);
  expect(issue.evidenceIds).toEqual([history.evidence[0].id]);
});
