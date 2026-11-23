import { createDb } from "@tutorloop/db/client";
import { getValidationMetrics } from "@tutorloop/db/repositories/validation-metrics";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--owner-user-id" || !args[1].trim() || !process.env.DATABASE_URL?.trim()) {
    throw new Error("Invalid configuration.");
  }
  const db = createDb(process.env.DATABASE_URL);
  try {
    const metrics = await getValidationMetrics(db, args[1]);
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  } finally { await db.destroy(); }
}

try { await main(); } catch {
  process.stderr.write("Validation report failed.\n");
  process.exitCode = 1;
}
