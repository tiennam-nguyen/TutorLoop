import { describe, expect, it } from "vitest";
import type { ReassessmentTargetStatus } from "@tutorloop/contracts";
import { canCompleteReassessment } from "../src/index.ts";

describe("canCompleteReassessment", () => {
  it.each<[string, readonly ReassessmentTargetStatus[], boolean]>([
    ["an empty list", [], false],
    ["all targets skipped", ["SKIPPED", "SKIPPED"], false],
    ["all targets pending", ["PENDING"], false],
    ["evidenced plus pending", ["EVIDENCED", "PENDING"], false],
    ["evidenced plus skipped", ["EVIDENCED", "SKIPPED"], true],
    ["all targets evidenced", ["EVIDENCED", "EVIDENCED"], true],
  ])("handles %s", (_name, statuses, expected) => {
    expect(canCompleteReassessment(statuses)).toBe(expected);
  });
});
