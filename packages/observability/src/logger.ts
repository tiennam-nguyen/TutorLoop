const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operations = new Set(["api_request", "health", "auth_request", "product_event", "raw_note", "proposal_review",
  "class", "student", "issue", "intervention", "reassessment"]);
const errorCodes = new Set(["UNAUTHENTICATED", "NOT_FOUND", "VALIDATION_ERROR", "STALE_VERSION", "IDEMPOTENCY_CONFLICT",
  "INVALID_ISSUE_TRANSITION", "PROPOSAL_DEPENDENCY_UNSATISFIED", "PROPOSAL_ITEM_ALREADY_DECIDED",
  "REASSESSMENT_NOT_COMPLETABLE", "AI_PROCESSING_FAILED", "INTERNAL_ERROR"]);

export type LogFields = {
  requestId?: string; userId?: string; classId?: string; entityId?: string; operation?: string;
  status?: number; latency?: number; errorCode?: string;
};

// Construct a new object: never spread, stringify, inspect, or forward unknown nested values.
export function serializeLog(value: unknown): string {
  if (!value || typeof value !== "object") return "{}";
  const input = value as Record<string, unknown>;
  const output: LogFields = {};
  for (const key of ["requestId", "classId", "entityId"] as const) {
    const item = input[key];
    if (typeof item === "string" && uuid.test(item)) output[key] = item;
  }
  if (typeof input.userId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(input.userId)) output.userId = input.userId;
  if (typeof input.operation === "string" && operations.has(input.operation)) output.operation = input.operation;
  if (typeof input.errorCode === "string" && errorCodes.has(input.errorCode)) output.errorCode = input.errorCode;
  if (typeof input.status === "number" && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599) {
    output.status = input.status;
  }
  if (typeof input.latency === "number" && Number.isFinite(input.latency) && input.latency >= 0) output.latency = input.latency;
  return JSON.stringify(output);
}

export type LogSink = (line: string) => void;
export function writeLog(fields: LogFields, sink: LogSink = (line) => { process.stdout.write(`${line}\n`); }): void {
  try { sink(serializeLog(fields)); } catch { /* Logging must not change request outcomes. */ }
}
