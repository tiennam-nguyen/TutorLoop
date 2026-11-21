import { describe, expect, it } from "vitest";
import type { StudentIssueState } from "@tutorloop/contracts";
import { assertIssueTransition } from "../src/index.ts";

describe("assertIssueTransition", () => {
  it.each<[StudentIssueState, StudentIssueState]>([
    ["OPEN", "IMPROVING"],
    ["OPEN", "RESOLVED_FOR_NOW"],
    ["IMPROVING", "OPEN"],
    ["IMPROVING", "RESOLVED_FOR_NOW"],
    ["RESOLVED_FOR_NOW", "OPEN"],
  ])("allows %s to %s", (from, to) => {
    expect(() => assertIssueTransition(from, to)).not.toThrow();
  });

  it.each<[StudentIssueState, StudentIssueState]>([
    ["OPEN", "OPEN"],
    ["IMPROVING", "IMPROVING"],
    ["RESOLVED_FOR_NOW", "RESOLVED_FOR_NOW"],
    ["RESOLVED_FOR_NOW", "IMPROVING"],
  ])("rejects %s to %s", (from, to) => {
    expect(() => assertIssueTransition(from, to)).toThrow(
      expect.objectContaining({ code: "INVALID_ISSUE_TRANSITION" }),
    );
  });
});
