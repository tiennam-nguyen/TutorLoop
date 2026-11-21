import { randomUUID } from "node:crypto";

export function buildClass() {
  const now = new Date();
  return {
    id: randomUUID(),
    owner_user_id: `test-user-${randomUUID()}`,
    name: "Test class",
    timezone: "UTC",
    created_at: now,
    updated_at: now,
  };
}

export function buildStudent(classId: string, aiAlias = "STU_001") {
  const now = new Date();
  return {
    id: randomUUID(),
    class_id: classId,
    display_label: "An",
    ai_alias: aiAlias,
    created_at: now,
    updated_at: now,
  };
}

export function buildCanonicalIssue(classId: string) {
  const now = new Date();
  return {
    id: randomUUID(),
    class_id: classId,
    label: "Comparing fractions",
    created_at: now,
    updated_at: now,
  };
}
