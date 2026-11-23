import { writeLog, type LogFields, type LogSink } from "@tutorloop/observability/logger";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest { privacyLog: LogFields | null }
}

// Only the registered route template selects an operation. Never use request.url.
function operation(route: string | undefined): string {
  if (route === "/health") return "health";
  if (route?.startsWith("/api/auth")) return "auth_request";
  if (route === "/api/v1/product-events") return "product_event";
  for (const [segment, name] of [["raw-notes", "raw_note"], ["proposal-runs", "proposal_review"],
    ["reassessments", "reassessment"], ["interventions", "intervention"], ["students", "student"],
    ["canonical-issues", "issue"], ["student-issues", "issue"], ["classes", "class"]]) {
    if (route?.split("/").includes(segment)) return name;
  }
  return "api_request";
}

export function registerPrivacyLogging(app: FastifyInstance, sink?: LogSink): void {
  app.decorateRequest("privacyLog", null);
  app.addHook("onRequest", async (request) => { request.privacyLog = { requestId: request.id }; });
  app.addHook("onResponse", async (request, reply) => {
    const params = request.params as Record<string, string> | undefined;
    const entityId = params && Object.entries(params).find(([key]) => key !== "classId" && key.endsWith("Id"))?.[1];
    writeLog({ ...request.privacyLog, classId: params?.classId, entityId,
      operation: operation(request.routeOptions.url), status: reply.statusCode, latency: reply.elapsedTime,
      ...(reply.statusCode === 404 && !request.privacyLog?.errorCode ? { errorCode: "NOT_FOUND" } : {}),
    }, sink);
  });
}
