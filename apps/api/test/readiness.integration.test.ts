import { createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createDb } from "@tutorloop/db/client";
import { startPostgres } from "@tutorloop/testkit/postgres";
import { sql } from "kysely";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { anonymousAuthVerifier } from "./support/auth.ts";

async function startSilentDatabase(stage: "handshake" | "query") {
  const sockets = new Set<Socket>();
  const queryReceived = Promise.withResolvers<true>();
  let connections = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    connections++;
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); });
    if (stage === "query") {
      socket.once("data", () => {
        // AuthenticationOk and ReadyForQuery let pg start a real SQL read on this local socket.
        socket.write(Buffer.from("5200000008000000005a0000000549", "hex"));
        socket.once("data", () => queryReceived.resolve(true));
      });
    }
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test TCP port");
  return {
    url: `postgresql://fixture:synthetic@127.0.0.1:${address.port}/fixture`,
    connections: () => connections,
    openConnections: () => sockets.size,
    queryReceived: queryReceived.promise,
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

test("an unexpected disconnect rejects active application SQL without an unhandled error", async () => {
  const server = await startSilentDatabase("query");
  const db = createDb(server.url);
  const query = sql`select 1`.execute(db).then(() => "unexpected success", () => "connection lost");
  const timer = new AbortController();

  try {
    expect(await Promise.race([server.queryReceived, delay(2_800, false, { signal: timer.signal })])).toBe(true);
    server.disconnect();
    await expect(query).resolves.toBe("connection lost");
  } finally {
    timer.abort();
    await server.close();
    await db.destroy();
  }
});

test.each(["handshake", "query"] as const)("readiness bounds concurrent requests when the PostgreSQL %s stalls", async (stage) => {
  const server = await startSilentDatabase(stage);
  const db = createDb(server.url);
  const app = await createApp({ authVerifier: anonymousAuthVerifier, db, readinessDatabaseUrl: `${server.url}?query_timeout=30000` });
  const requests = Promise.all(Array.from({ length: 12 }, () => app.inject("/ready")));
  const timer = new AbortController();

  try {
    const deadline = delay(2_800, null, { signal: timer.signal });
    const result = await Promise.race([requests, deadline]);
    expect(result?.map(({ statusCode }) => statusCode)).toEqual(Array(12).fill(503));
    expect(result?.[0].json()).toEqual({ status: "unavailable" });
    expect(server.connections()).toBe(1);
    await expect.poll(server.openConnections).toBe(0);
    if (stage === "query") expect(await Promise.race([server.queryReceived, deadline])).toBe(true);
    const live = await app.inject("/health");
    expect(live.statusCode).toBe(200);
  } finally {
    timer.abort();
    await server.close();
    await requests;
    await app.close();
    await db.destroy();
  }
}, 15_000);

test("readiness follows PostgreSQL connectivity while liveness survives a database outage", async () => {
  const postgres = await startPostgres();
  const db = createDb(postgres.getConnectionUri());
  const app = await createApp({ authVerifier: anonymousAuthVerifier, db, readinessDatabaseUrl: postgres.getConnectionUri() });
  let stopped = false;

  try {
    const ready = await app.inject("/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });

    await postgres.stop();
    stopped = true;
    const outage = await app.inject("/ready");
    expect(outage.statusCode).toBe(503);
    expect(outage.json()).toEqual({ status: "unavailable" });
    const live = await app.inject("/health");
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });
  } finally {
    try {
      await app.close();
    } finally {
      try {
        await db.destroy();
      } finally {
        if (!stopped) await postgres.stop();
      }
    }
  }
}, 120_000);
