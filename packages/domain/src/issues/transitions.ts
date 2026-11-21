import type { ApiErrorCode, StudentIssueState } from "@tutorloop/contracts";

const allowedTransitions: Record<StudentIssueState, readonly StudentIssueState[]> = {
  OPEN: ["IMPROVING", "RESOLVED_FOR_NOW"],
  IMPROVING: ["OPEN", "RESOLVED_FOR_NOW"],
  RESOLVED_FOR_NOW: ["OPEN"],
};

export function assertIssueTransition(from: StudentIssueState, to: StudentIssueState): void {
  if (!allowedTransitions[from].includes(to)) {
    throw Object.assign(new Error(`Cannot transition a student issue from ${from} to ${to}.`), {
      code: "INVALID_ISSUE_TRANSITION" satisfies ApiErrorCode,
    });
  }
}
