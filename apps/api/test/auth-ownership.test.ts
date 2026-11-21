import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { registerAuthRoutes } from "../src/auth/routes.ts";
import { anonymousAuthVerifier, fixedUserAuthVerifier } from "./support/auth.ts";

test("GET /api/v1/me rejects an anonymous request", async () => {
  const app = await createApp({ authVerifier: anonymousAuthVerifier });
  try {
    const response = await app.inject("/api/v1/me");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication is required." },
    });
  } finally {
    await app.close();
  }
});

test("GET /api/v1/me returns the authenticated user ID", async () => {
  const app = await createApp({ authVerifier: fixedUserAuthVerifier("teacher-a") });
  try {
    const response = await app.inject("/api/v1/me");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: "teacher-a" });
  } finally {
    await app.close();
  }
});

test("the auth proxy forwards the public URL, redirect, and individual cookies", async () => {
  const app = await createApp({ authVerifier: anonymousAuthVerifier });
  const cookies = ["first=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "second=2; HttpOnly"];

  try {
    registerAuthRoutes(app, "https://tutorloop.example", async (request) => {
      expect(request.url).toBe("https://tutorloop.example/api/auth/callback/google?code=example");
      expect(request.headers.get("cookie")).toBe("state=example");
      expect(request.body).toBeNull();
      const headers = new Headers({ location: "https://tutorloop.example/" });
      for (const cookie of cookies) headers.append("set-cookie", cookie);
      return new Response(null, { status: 302, headers });
    });
    const response = await app.inject({
      url: "/api/auth/callback/google?code=example",
      headers: { host: "internal-api:3001", cookie: "state=example" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://tutorloop.example/");
    expect(response.headers["set-cookie"]).toEqual(cookies);
  } finally {
    await app.close();
  }
});

test.each([
  {
    path: "/api/auth/callback/google",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    payload: "state=a%2Bb&code=x+y&state=a%2bb",
  },
  {
    path: "/api/auth/sign-in/social",
    contentType: "application/json; charset=utf-8",
    payload: '{ "callbackURL": "/café", "provider": "google" }',
  },
])("POST $path forwards the original content type and body bytes", async ({ path, contentType, payload }) => {
  const app = await createApp({ authVerifier: anonymousAuthVerifier });
  const bytes = Buffer.from(payload);

  try {
    registerAuthRoutes(app, "https://tutorloop.example", async (request) => {
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe(contentType);
      expect(Buffer.from(await request.arrayBuffer())).toEqual(bytes);
      return new Response(null, { status: 204 });
    });

    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": contentType },
      payload: bytes,
    });
    expect(response.statusCode).toBe(204);
  } finally {
    await app.close();
  }
});

test("auth body parsing leaves the domain JSON parser in place", async () => {
  const app = await createApp({ authVerifier: anonymousAuthVerifier });

  try {
    registerAuthRoutes(app, "https://tutorloop.example", async () => new Response(null));
    app.post<{ Body: { name: string } }>("/api/v1/test", async ({ body }) => ({ name: body.name }));
    const request = {
      method: "POST",
      url: "/api/v1/test",
      headers: { "content-type": "application/json" },
    } as const;
    const valid = await app.inject({ ...request, payload: '{"name":"Class"}' });
    expect(valid.json()).toEqual({ name: "Class" });
    const invalid = await app.inject({ ...request, payload: "{" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
  } finally {
    await app.close();
  }
});
