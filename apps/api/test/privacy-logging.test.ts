import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { requirePrincipal } from "../src/auth/principal.ts";
import { fixedUserAuthVerifier } from "./support/auth.ts";

test("Fastify writes only allowed metadata for success, failures and unmatched routes", async () => {
  const lines: string[] = [];
  const app = await createApp({ authVerifier: fixedUserAuthVerifier("teacher_1"), logSink: (line) => lines.push(line) });
  app.post("/api/v1/synthetic", async (request) => {
    await requirePrincipal(request);
    throw new Error("SYNTHETIC_PROVIDER_BODY");
  });
  try {
    await app.inject({ method: "GET", url: "/api/v1/me?secret=SYNTHETIC_QUERY", headers: {
      "x-request-id": "SYNTHETIC_CLIENT_REQUEST_ID", cookie: "SYNTHETIC_COOKIE", authorization: "Bearer SYNTHETIC_TOKEN",
    } });
    await app.inject({ method: "POST", url: "/api/v1/synthetic", payload: { body: "SYNTHETIC_NOTE", displayLabel: "SYNTHETIC_STUDENT" } });
    await app.inject({ method: "GET", url: "/SYNTHETIC_URL?token=SYNTHETIC_TOKEN" });
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("SYNTHETIC");
    const keys = ["requestId", "userId", "classId", "entityId", "operation", "status", "latency", "errorCode"];
    for (const line of lines) {
      const record = JSON.parse(line);
      expect(Object.keys(record).every((key) => keys.includes(key))).toBe(true);
      expect(record.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(record.latency).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.parse(lines[0])).toMatchObject({ operation: "api_request", userId: "teacher_1", status: 200 });
    expect(JSON.parse(lines[1])).toMatchObject({ status: 500, errorCode: "INTERNAL_ERROR" });
    expect(JSON.parse(lines[2])).toMatchObject({ status: 404, errorCode: "NOT_FOUND" });
  } finally { await app.close(); }
});

test("a failed log sink does not fail the request", async () => {
  const app = await createApp({ authVerifier: fixedUserAuthVerifier("teacher_1"), logSink: () => { throw new Error("offline"); } });
  try { expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200); }
  finally { await app.close(); }
});
