import { expect, type APIResponse, type Page } from "@playwright/test";

export async function json<T>(response: Pick<APIResponse, "ok" | "status" | "url" | "json">): Promise<T> {
  expect(response.ok(), `${response.status()} ${response.url()}`).toBe(true);
  return response.json() as Promise<T>;
}

export function posted(page: Page, path: string) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === path && response.request().method() === "POST", { timeout: 15_000 });
}
