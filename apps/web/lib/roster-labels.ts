import type { StudentDto } from "@tutorloop/contracts";

type StudentName = Pick<StudentDto, "id" | "displayLabel">;

export function rosterLabels(roster: readonly StudentName[], history: readonly StudentName[] = []) {
  const positions = new Map(roster.map(({ id }, index) => [id, index + 1]));
  const students = new Map([...history, ...roster].map((student) => [student.id, student.displayLabel]));
  const counts = new Map<string, number>();
  for (const name of students.values()) counts.set(name, (counts.get(name) ?? 0) + 1);

  return new Map([...students].map(([id, name]) => {
    const position = positions.get(id);
    const label = counts.get(name) === 1 ? name : position
      ? `${name} (roster #${position})`
      : `${name} (student ID ${id})`;
    return [id, label];
  }));
}
