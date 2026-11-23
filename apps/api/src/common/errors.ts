import type { ApiErrorBody, ApiErrorCode } from "@tutorloop/contracts";
import type { FastifyInstance } from "fastify";

const errorStatuses = {
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  STALE_VERSION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_ISSUE_TRANSITION: 422,
  PROPOSAL_DEPENDENCY_UNSATISFIED: 422,
  PROPOSAL_ITEM_ALREADY_DECIDED: 409,
  REASSESSMENT_NOT_COMPLETABLE: 422,
  AI_PROCESSING_FAILED: 502,
  INTERNAL_ERROR: 500,
} satisfies Record<ApiErrorCode, number>;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function registerApiErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  app.setErrorHandler((error, request, reply) => {
    let failure: ApiError;
    if (error instanceof ApiError) {
      failure = error;
    } else if (
      error && typeof error === "object" && "statusCode" in error &&
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
    ) {
      failure = new ApiError("VALIDATION_ERROR", "Invalid request.");
    } else {
      failure = new ApiError("INTERNAL_ERROR", "An internal error occurred.");
    }

    const { code, message, details } = failure;
    if (request.privacyLog) request.privacyLog.errorCode = code;
    const body: ApiErrorBody = {
      error: { code, message, ...(details === undefined ? {} : { details }) },
    };
    reply.code(errorStatuses[code]).send(body);
  });
}
