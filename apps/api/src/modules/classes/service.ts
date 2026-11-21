import { createHash, randomUUID } from "node:crypto";
import {
  type AddStudentInput, type ClassDetailDto, type ClassDto, type CreateClassInput, idSchema,
  type StudentDto, type UpdateClassInput, type UpdateStudentInput,
} from "@tutorloop/contracts";
import type { Database } from "@tutorloop/db/database";
import { insertClass, listActiveClasses, updateClassAtVersion } from "@tutorloop/db/repositories/classes";
import { findStudent, insertStudent, listActiveStudents, updateStudentAtVersion } from "@tutorloop/db/repositories/students";
import type { Kysely, Selectable } from "kysely";
import type { AuthPrincipal } from "../../auth/principal.ts";
import { ApiError } from "../../common/errors.ts";
import { type ClassRow, requireOwnedClass } from "../../common/ownership.ts";

type Db = Kysely<Database>;
type StudentRow = Selectable<Database["students"]>;

function toClassDto(row: ClassRow): ClassDto {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    archivedAt: row.archived_at?.toISOString() ?? null,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toStudentDto(row: Omit<StudentRow, "client_request_id" | "create_input_hash">): StudentDto {
  return {
    id: row.id,
    classId: row.class_id,
    displayLabel: row.display_label,
    aiAlias: row.ai_alias,
    archivedAt: row.archived_at?.toISOString() ?? null,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function hashCreateInput(...fields: string[]): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function verifyCreateReceipt(recorded: string | null, received: string): void {
  if (recorded !== received) {
    throw new ApiError("IDEMPOTENCY_CONFLICT", "The request ID was already used with different input.");
  }
}

export async function createClass(db: Db, principal: AuthPrincipal, input: CreateClassInput): Promise<ClassDto> {
  const now = new Date();
  const hash = hashCreateInput(input.name, input.timezone);
  const row = await insertClass(db, {
    id: randomUUID(), owner_user_id: principal.userId, name: input.name, timezone: input.timezone,
    client_request_id: input.clientRequestId, create_input_hash: hash, created_at: now, updated_at: now,
  });
  verifyCreateReceipt(row.create_input_hash, hash);
  return toClassDto(row);
}

export async function listClasses(db: Db, principal: AuthPrincipal): Promise<ClassDto[]> {
  return (await listActiveClasses(db, principal.userId)).map(toClassDto);
}

export async function getClass(db: Db, principal: AuthPrincipal, classId: string): Promise<ClassDto> {
  return toClassDto(await requireOwnedClass(db, principal, classId));
}

export async function getClassDetail(db: Db, principal: AuthPrincipal, classId: string): Promise<ClassDetailDto> {
  const classroom = await getClass(db, principal, classId);
  const students = await listActiveStudents(db, classroom.id);
  return { ...classroom, students: students.map(toStudentDto) };
}

async function changeClass(
  db: Db, principal: AuthPrincipal, classId: string, expectedVersion: number,
  changes: Parameters<typeof updateClassAtVersion>[4],
): Promise<ClassRow> {
  const classroom = await requireOwnedClass(db, principal, classId);
  const row = await updateClassAtVersion(db, principal.userId, classroom.id, expectedVersion, changes);
  if (!row) throw new ApiError("STALE_VERSION", "Class has changed.");
  return row;
}

export async function updateClass(
  db: Db, principal: AuthPrincipal, classId: string,
  input: Omit<UpdateClassInput, "expectedVersion">, expectedVersion: number,
): Promise<ClassDto> {
  return toClassDto(await changeClass(db, principal, classId, expectedVersion, {
    name: input.name, timezone: input.timezone,
  }));
}

export async function archiveClass(db: Db, principal: AuthPrincipal, classId: string, expectedVersion: number): Promise<void> {
  await changeClass(db, principal, classId, expectedVersion, { archived_at: new Date() });
}

export async function addStudent(
  db: Db, principal: AuthPrincipal, classId: string, input: AddStudentInput,
): Promise<StudentDto> {
  const classroom = await requireOwnedClass(db, principal, classId);
  const id = randomUUID();
  const now = new Date();
  const hash = hashCreateInput(input.displayLabel);
  const row = await insertStudent(db, {
    id, class_id: classroom.id, display_label: input.displayLabel, ai_alias: `STU_${id.replaceAll("-", "")}`,
    client_request_id: input.clientRequestId, create_input_hash: hash, created_at: now, updated_at: now,
  });
  verifyCreateReceipt(row.create_input_hash, hash);
  return toStudentDto(row);
}

async function changeStudent(
  db: Db, principal: AuthPrincipal, classId: string, studentId: string, expectedVersion: number,
  changes: Parameters<typeof updateStudentAtVersion>[4],
): Promise<StudentRow> {
  const classroom = await requireOwnedClass(db, principal, classId);
  if (idSchema.safeParse(studentId).success) {
    const row = await updateStudentAtVersion(db, classroom.id, studentId, expectedVersion, changes);
    if (row) return row;
    if (await findStudent(db, classroom.id, studentId)) {
      throw new ApiError("STALE_VERSION", "Student has changed.");
    }
  }
  throw new ApiError("NOT_FOUND", "Student not found.");
}

export async function updateStudent(
  db: Db, principal: AuthPrincipal, classId: string, studentId: string,
  input: Omit<UpdateStudentInput, "expectedVersion">, expectedVersion: number,
): Promise<StudentDto> {
  return toStudentDto(await changeStudent(db, principal, classId, studentId, expectedVersion, {
    display_label: input.displayLabel,
  }));
}

export async function archiveStudent(
  db: Db, principal: AuthPrincipal, classId: string, studentId: string, expectedVersion: number,
): Promise<void> {
  await changeStudent(db, principal, classId, studentId, expectedVersion, { archived_at: new Date() });
}
