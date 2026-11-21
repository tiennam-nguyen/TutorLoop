import { setTimeout } from "node:timers/promises";
import type { StructureJobDeps } from "./jobs/structure-raw-note.ts";
import { runNextJob } from "./runner.ts";

export { type StructureJobDeps } from "./jobs/structure-raw-note.ts";
export { JOB_MAX_ATTEMPTS, runNextJob } from "./runner.ts";

export async function runWorker(
  deps: StructureJobDeps, { signal, pollIntervalMs = 1_000 }: { signal: AbortSignal; pollIntervalMs?: number },
): Promise<void> {
  while (!signal.aborted) {
    if (await runNextJob(deps) || signal.aborted) continue;
    try {
      await setTimeout(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
