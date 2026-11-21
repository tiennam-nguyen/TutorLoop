import { defineConfig } from "@playwright/test";

const webOrigin = "http://127.0.0.1:3210";
const apiPort = 3211;
const apiOrigin = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: webOrigin,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/e2e/support/test-api.ts",
      env: { TEST_WEB_ORIGIN: webOrigin, TEST_API_PORT: String(apiPort) },
      url: `${apiOrigin}/health`,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command: "node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3210",
      cwd: "./apps/web",
      env: { API_INTERNAL_URL: apiOrigin, NEXT_TELEMETRY_DISABLED: "1" },
      url: `${webOrigin}/api/v1/me`,
      timeout: 120_000,
    },
  ],
});
