import { describe, expect, it } from "vitest";
import { pseudonymizeNote } from "../src/pseudonymize.js";

describe("pseudonymizeNote", () => {
  it("replaces Vietnamese names with diacritics as Unicode tokens", () => {
    const result = pseudonymizeNote({
      body: "Hôm nay Nguyễn Thị Ánh tiến bộ.",
      students: [{ displayLabel: "Nguyễn Thị Ánh", aiAlias: "Student A" }],
    });

    expect(result.text).toBe("Hôm nay Student A tiến bộ.");
  });

  it("replaces canonically equivalent decomposed Vietnamese spelling", () => {
    const result = pseudonymizeNote({
      body: "Ánh and A\u0301nh made progress.",
      students: [{ displayLabel: "Ánh", aiAlias: "Student A" }],
    });

    expect(result.text).toBe("Student A and Student A made progress.");
    expect(result.text).not.toContain("Ánh");
  });

  it("replaces case variants of unique labels without leaking the matched spelling", () => {
    const result = pseudonymizeNote({
      body: "minh và MINH cùng học.",
      students: [{ displayLabel: "Minh", aiAlias: "Student A" }],
    });

    expect(result.text).toBe("Student A và Student A cùng học.");
    expect(result.text).not.toMatch(/minh/i);
  });

  it("does not leak Unicode case-fold variants the lowercase key cannot resolve", () => {
    const result = pseudonymizeNote({
      body: "ſ arrived.",
      students: [{ displayLabel: "S", aiAlias: "Student A" }],
    });

    expect(result.text).not.toContain("ſ");
    expect(result.text).not.toContain("S ");
  });

  it("replaces duplicate names with a local ambiguity token and aliases", () => {
    const result = pseudonymizeNote({
      body: "Minh đã hoàn thành bài.",
      students: [
        { displayLabel: "Minh", aiAlias: "Student A" },
        { displayLabel: "Minh", aiAlias: "Student B" },
      ],
    });

    expect(result.text).toBe("AMBIG_001 đã hoàn thành bài.");
    expect(result.ambiguousTokens).toEqual([
      { token: "AMBIG_001", candidateAliases: ["Student A", "Student B"] },
    ]);
    expect(result.text).not.toContain("Minh");
  });

  it("matches overlapping labels longest first without replacing inside words", () => {
    const result = pseudonymizeNote({
      body: "An và Anh học cùng Lananh.",
      students: [
        { displayLabel: "An", aiAlias: "Student A" },
        { displayLabel: "Anh", aiAlias: "Student B" },
      ],
    });

    expect(result.text).toBe("Student A và Student B học cùng Lananh.");
  });

  it("removes email and phone patterns while preserving surrounding fragments", () => {
    const result = pseudonymizeNote({
      body: "Liên hệ linh.nguyen@example.vn hoặc +84 912-345-678; ghi chú: cần ôn tập.",
      students: [],
    });

    expect(result.text).toBe("Liên hệ [EMAIL] hoặc [PHONE]; ghi chú: cần ôn tập.");
    expect(result.text).not.toContain("example.vn");
    expect(result.text).not.toContain("912-345-678");
  });

  it("keeps arithmetic and ISO dates while masking formatted phone numbers", () => {
    const result = pseudonymizeNote({
      body: "An calculated 123 - 456 on 2026-11-20. Then 1,234 - 5,678. Contact (415) 555-2671 or +84 912-345-678.",
      students: [{ displayLabel: "An", aiAlias: "STU_1" }],
    });
    expect(result.text).toBe(
      "STU_1 calculated 123 - 456 on 2026-11-20. Then 1,234 - 5,678. Contact [PHONE] or [PHONE].",
    );
  });

  it("redacts a multi-segment email at sentence end without consuming punctuation", () => {
    const result = pseudonymizeNote({
      body: "Send it to jane.doe@school.example.co.uk.",
      students: [],
    });

    expect(result.text).toBe("Send it to [EMAIL].");
    expect(result.text).not.toContain("example.co.uk");
    expect(result.text).not.toContain("jane.doe");
  });

  it("redacts UUIDs inside an email as part of the email and elsewhere as IDs", () => {
    const id = "e25ec666-221f-47ac-825e-b31eea04cffe";
    const result = pseudonymizeNote({ body: `Student ref ${id}; contact parent+${id}@school.example.`, students: [] });
    expect(result.text).toBe("Student ref [ID]; contact [EMAIL].");
  });

  it("assigns deterministic ambiguity tokens for the same student order", () => {
    const students = [
      { displayLabel: "Minh", aiAlias: "Student A" },
      { displayLabel: "Minh", aiAlias: "Student B" },
      { displayLabel: "Lan", aiAlias: "Student C" },
      { displayLabel: "Lan", aiAlias: "Student D" },
    ];

    const first = pseudonymizeNote({ body: "Minh gặp Lan.", students });
    const second = pseudonymizeNote({ body: "Minh gặp Lan.", students });

    expect(first).toEqual(second);
    expect(first.text).toBe("AMBIG_001 gặp AMBIG_002.");
  });

  it("maps case variants of an ambiguous label to its token and aliases", () => {
    const result = pseudonymizeNote({
      body: "minh and MINH are different students.",
      students: [
        { displayLabel: "Minh", aiAlias: "Student A" },
        { displayLabel: "MINH", aiAlias: "Student B" },
      ],
    });

    expect(result.text).toBe("AMBIG_001 and AMBIG_001 are different students.");
    expect(result.ambiguousTokens).toEqual([
      { token: "AMBIG_001", candidateAliases: ["Student A", "Student B"] },
    ]);
    expect(result.text).not.toMatch(/minh/i);
  });
});
