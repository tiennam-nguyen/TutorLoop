import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Asia/Bangkok" });

test.describe("class roster", () => {
  test("a teacher manages a class and its active roster", async ({ baseURL, context, page }) => {
    if (!baseURL) throw new Error("Set the Playwright baseURL.");
    await context.addCookies([{ name: "tutorloop-e2e", value: "teacher", url: baseURL }]);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Classes" })).toBeVisible();
    await expect(page).toHaveURL("/classes");

    await page.getByLabel("Class name").fill("Fractions");
    await expect(page.getByLabel("Timezone")).toHaveValue("Asia/Bangkok");
    await page.getByLabel("Timezone").fill("UTC");
    await page.getByRole("button", { name: "Create class" }).click();
    await page.getByRole("link", { name: "Fractions" }).click();
    await expect(page.getByRole("heading", { name: "Fractions" })).toBeVisible();
    await expect(page.getByText("UTC", { exact: true })).toBeVisible();
    const classUrl = page.url();

    const label = page.getByLabel("Student name", { exact: true });
    const add = page.getByRole("button", { name: "Add student" });
    for (let count = 1; count <= 2; count++) {
      await label.fill("Minh");
      await add.click();
      await expect(page.getByText("Minh", { exact: true })).toHaveCount(count);
    }

    const roster = page.getByRole("list", { name: "Active students" });
    const firstMinh = roster.getByRole("listitem").filter({ hasText: "Minh" }).first();
    await firstMinh.getByRole("button", { name: "Rename" }).click();
    await firstMinh.getByLabel("New name").fill("Minh Anh");
    await firstMinh.getByRole("button", { name: "Save name" }).click();
    await expect(roster.getByText("Minh Anh", { exact: true })).toBeVisible();
    await expect(roster.getByText("Minh", { exact: true })).toHaveCount(1);

    const renamed = roster.getByRole("listitem").filter({ hasText: "Minh Anh" });
    await renamed.getByRole("button", { name: "Archive" }).click();
    await expect(roster.getByText("Minh Anh", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(roster.getByText("Minh", { exact: true })).toHaveCount(1);
    await expect(roster.getByText("Minh Anh", { exact: true })).toHaveCount(0);

    const archiveClass = page.getByRole("button", { name: "Archive class" });
    page.once("dialog", (dialog) => dialog.dismiss());
    await archiveClass.click();
    await expect(page.getByRole("heading", { name: "Fractions" })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await archiveClass.click();
    await expect(page).toHaveURL("/classes");
    await expect(page.getByText("No classes yet.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Fractions" })).toHaveCount(0);

    await page.goto(classUrl);
    await expect(page.getByRole("heading", { name: "Fractions" })).toBeVisible();
    await expect(page.getByText("Archived class")).toBeVisible();
    await expect(roster.getByText("Minh", { exact: true })).toHaveCount(1);
  });

  test("an anonymous visitor starts Google sign-in from the app origin", async ({ baseURL, page }) => {
    await page.goto("/classes");
    await expect(page).toHaveURL("/login");
    await page.route("https://accounts.google.com/**", (route) => route.fulfill({ body: "Google OAuth" }));

    const signIn = page.waitForRequest((request) => request.url() === `${baseURL}/api/auth/sign-in/social`);
    const authorize = page.waitForURL("https://accounts.google.com/**");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    const request = await signIn;
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toMatchObject({ provider: "google" });

    await authorize;
    const url = new URL(page.url());
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/google`);
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});
