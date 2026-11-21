import type { ApiErrorCode, ProposalDecisionInput, ProposalItemStatus } from "@tutorloop/contracts";

export interface ProposalDecisionNode {
  readonly id: string;
  readonly status: ProposalItemStatus;
  readonly dependencyIds: readonly string[];
  readonly decision?: ProposalDecisionInput["decision"];
}

interface BatchApproval {
  readonly id: string;
  readonly dependencyIds: readonly string[];
  readonly dependents: BatchApproval[];
  remainingPrerequisites: number;
}

/**
 * Pass one node per item ID with its persisted status and optional decision for
 * this batch. Callers validate decision conflicts before ordering.
 * Earlier APPROVED items satisfy dependencies. The result contains only IDs
 * for PENDING items receiving APPROVE or EDIT_AND_APPROVE in this batch.
 */
export function orderApprovedProposalItems(items: readonly ProposalDecisionNode[]): readonly string[] {
  const alreadyApplied = new Set<string>();
  const approvals = new Map<string, BatchApproval>();

  for (const { id, status, dependencyIds, decision } of items) {
    if (status === "APPROVED") {
      alreadyApplied.add(id);
    } else if (status === "PENDING" && (decision === "APPROVE" || decision === "EDIT_AND_APPROVE")) {
      approvals.set(id, { id, dependencyIds, dependents: [], remainingPrerequisites: 0 });
    }
  }

  const ready: BatchApproval[] = [];
  for (const approval of approvals.values()) {
    for (const dependencyId of approval.dependencyIds) {
      if (alreadyApplied.has(dependencyId)) {
        continue;
      }
      const prerequisite = approvals.get(dependencyId);
      if (!prerequisite) {
        throw dependencyError(`Proposal item ${approval.id} requires approval of item ${dependencyId}.`);
      }
      prerequisite.dependents.push(approval);
      approval.remainingPrerequisites++;
    }
    if (approval.remainingPrerequisites === 0) {
      ready.push(approval);
    }
  }

  // As approvals are visited, append those whose final prerequisite was just visited.
  for (const approval of ready) {
    for (const dependent of approval.dependents) {
      dependent.remainingPrerequisites--;
      if (dependent.remainingPrerequisites === 0) {
        ready.push(dependent);
      }
    }
  }

  if (ready.length !== approvals.size) {
    throw dependencyError("The approved proposal items contain a dependency cycle.");
  }

  return ready.map(({ id }) => id);
}

function dependencyError(message: string) {
  return Object.assign(new Error(message), {
    code: "PROPOSAL_DEPENDENCY_UNSATISFIED" satisfies ApiErrorCode,
  });
}
