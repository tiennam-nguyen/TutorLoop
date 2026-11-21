import type { ReassessmentTargetStatus } from "@tutorloop/contracts";

export function canCompleteReassessment(statuses: readonly ReassessmentTargetStatus[]): boolean {
  return statuses.includes("EVIDENCED") && !statuses.includes("PENDING");
}
