import { describe, expect, it } from "vitest";
import type { ProposalItemStatus } from "@tutorloop/contracts";
import { orderApprovedProposalItems } from "../src/index.ts";

describe("orderApprovedProposalItems", () => {
  const unsatisfied = expect.objectContaining({ code: "PROPOSAL_DEPENDENCY_UNSATISFIED" });

  it("orders new approvals by their dependencies regardless of input order", () => {
    expect(orderApprovedProposalItems([
      { id: "evidence", status: "PENDING", decision: "APPROVE", dependencyIds: ["student", "issue"] },
      { id: "student", status: "PENDING", decision: "EDIT_AND_APPROVE", dependencyIds: ["issue"] },
      { id: "issue", status: "PENDING", decision: "APPROVE", dependencyIds: [] },
    ])).toEqual(["issue", "student", "evidence"]);
  });

  it("satisfies dependencies from earlier approvals without returning those IDs", () => {
    expect(orderApprovedProposalItems([
      { id: "evidence", status: "PENDING", decision: "EDIT_AND_APPROVE", dependencyIds: ["student"] },
      { id: "student", status: "PENDING", decision: "APPROVE", dependencyIds: ["issue"] },
      { id: "issue", status: "APPROVED", dependencyIds: ["earlier-root"] },
      { id: "earlier-root", status: "APPROVED", dependencyIds: [] },
    ])).toEqual(["student", "evidence"]);
  });

  it.each<ProposalItemStatus>(["PENDING", "REJECTED", "SUPERSEDED"])(
    "rejects a dependency whose existing status is %s",
    (status) => {
      expect(() => orderApprovedProposalItems([
        { id: "evidence", status: "PENDING", decision: "APPROVE", dependencyIds: ["issue"] },
        { id: "issue", status, dependencyIds: [] },
      ])).toThrow(unsatisfied);
    },
  );

  it("rejects a dependency rejected in the same batch", () => {
    expect(() => orderApprovedProposalItems([
      { id: "evidence", status: "PENDING", decision: "EDIT_AND_APPROVE", dependencyIds: ["issue"] },
      { id: "issue", status: "PENDING", decision: "REJECT", dependencyIds: [] },
    ])).toThrow(unsatisfied);
  });

  it("rejects a missing dependency", () => {
    expect(() => orderApprovedProposalItems([
      { id: "student", status: "PENDING", decision: "APPROVE", dependencyIds: ["missing"] },
    ])).toThrow(unsatisfied);
  });

  it("rejects a cycle among new approvals", () => {
    expect(() => orderApprovedProposalItems([
      { id: "a", status: "PENDING", decision: "APPROVE", dependencyIds: ["b"] },
      { id: "b", status: "PENDING", decision: "EDIT_AND_APPROVE", dependencyIds: ["a"] },
    ])).toThrow(unsatisfied);
  });

  it("rejects an approval that depends on itself", () => {
    expect(() => orderApprovedProposalItems([
      { id: "a", status: "PENDING", decision: "APPROVE", dependencyIds: ["a"] },
    ])).toThrow(unsatisfied);
  });

  it("orders independent approvals when unrelated items are rejected or unreviewed", () => {
    expect(orderApprovedProposalItems([
      { id: "old-rejection", status: "REJECTED", dependencyIds: ["missing"] },
      { id: "new-rejection", status: "PENDING", decision: "REJECT", dependencyIds: ["missing"] },
      { id: "unreviewed", status: "PENDING", dependencyIds: ["missing"] },
      { id: "evidence", status: "PENDING", decision: "APPROVE", dependencyIds: [] },
    ])).toEqual(["evidence"]);
  });

  it("returns an empty order for a batch containing only rejections", () => {
    expect(orderApprovedProposalItems([
      { id: "issue", status: "APPROVED", dependencyIds: [] },
      { id: "student", status: "PENDING", decision: "REJECT", dependencyIds: ["issue"] },
    ])).toEqual([]);
  });
});
