import { createConfiguredNoteRouter } from "@tutorloop/ai/router";
import { createDb } from "@tutorloop/db/client";
import { runWorker } from "./worker.ts";

const route = createConfiguredNoteRouter(process.env);
const db = createDb(process.env.DATABASE_URL ?? "");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try {
  await runWorker({ db, route, now: () => new Date() }, { signal: controller.signal });
} finally {
  await db.destroy();
}
