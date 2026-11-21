import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { anonymousAuthVerifier } from "./support/auth.ts";

test("GET /health returns status ok without authentication", async () => {
  const app = await createApp({ authVerifier: anonymousAuthVerifier });

  try {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  } finally {
    await app.close();
  }
});
