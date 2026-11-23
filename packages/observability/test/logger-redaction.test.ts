import { expect, test } from "vitest";
import { serializeLog } from "../src/logger.ts";

test("serializes only approved fields and discards nested secrets and content", () => {
  const serialized = serializeLog({
    requestId: "13ea0c50-4f1b-4db7-b672-a925dbfded10", userId: "teacher_1",
    classId: "c8cec0e0-8ff5-4617-8931-bd85660bc3bc", operation: "api_request", status: 201, latency: 2,
    body: "SYNTHETIC_RAW_NOTE", displayLabel: "SYNTHETIC_STUDENT", manifestation: "SYNTHETIC_MANIFESTATION",
    prompt: "SYNTHETIC_PROMPT", output: "SYNTHETIC_OUTPUT", cookie: "SYNTHETIC_COOKIE",
    authorization: "Bearer SYNTHETIC_TOKEN", providerKey: "SYNTHETIC_PROVIDER_KEY",
    err: new Error("SYNTHETIC_ERROR"), req: { headers: { cookie: "SYNTHETIC_COOKIE" } },
  });
  expect(JSON.parse(serialized)).toEqual({
    requestId: "13ea0c50-4f1b-4db7-b672-a925dbfded10", userId: "teacher_1",
    classId: "c8cec0e0-8ff5-4617-8931-bd85660bc3bc", operation: "api_request", status: 201, latency: 2,
  });
  expect(serialized).not.toContain("SYNTHETIC");
});

test("rejects untrusted values in approved keys", () => {
  const line = serializeLog({ requestId: "cookie=secret", classId: "student name", entityId: "raw note",
    operation: "/raw/url?token=secret", errorCode: "provider body", status: Infinity, latency: -1,
    userId: { token: "secret" } });
  expect(JSON.parse(line)).toEqual({});
});
