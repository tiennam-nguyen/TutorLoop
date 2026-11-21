import {
  apiErrorBodySchema,
  canonicalIssueDetailDtoSchema,
  canonicalIssueListDtoSchema,
  classDetailDtoSchema,
  classDtoSchema,
  classListDtoSchema,
  createRawNoteResponseSchema,
  meDtoSchema,
  proposalRunDetailDtoSchema,
  rawNoteDetailDtoSchema,
  studentDtoSchema,
  type AddStudentInput,
  type ApiErrorCode,
  type CreateClassInput,
  type CreateRawNoteInput,
  type ProposalDecisionBatchInput,
  type ReprocessRawNoteInput,
  type UpdateStudentInput,
} from "@tutorloop/contracts";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: ApiErrorCode) {
    super(message);
  }
}

type ResponseSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const body = apiErrorBodySchema.safeParse(await response.json().catch(() => null));
    throw new ApiError(
      body.success ? body.data.error.message : "The request failed. Try again.",
      response.status,
      body.success ? body.data.error.code : undefined,
    );
  }
  return response;
}

async function read<T>(path: string, schema: ResponseSchema<T>, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  const result = schema.safeParse(await response.json().catch(() => null));
  if (!result.success) throw new ApiError("The server returned an invalid response.", response.status);
  return result.data;
}

function json(method: "POST" | "PATCH", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function classPath(classId: string) {
  return `/classes/${encodeURIComponent(classId)}`;
}

function studentPath(classId: string, studentId: string) {
  return `${classPath(classId)}/students/${encodeURIComponent(studentId)}`;
}

async function archive(path: string, expectedVersion: number): Promise<void> {
  const response = await request(`${path}/archive`, json("POST", { expectedVersion }));
  if (response.status !== 204) {
    throw new ApiError("The server returned an invalid response.", response.status);
  }
}

export function getMe(signal?: AbortSignal) {
  return read("/me", meDtoSchema, { signal });
}

export function listClasses(signal?: AbortSignal) {
  return read("/classes", classListDtoSchema, { signal });
}

export function getClassDetail(classId: string, signal?: AbortSignal) {
  return read(classPath(classId), classDetailDtoSchema, { signal });
}

export function createClass(input: CreateClassInput) {
  return read("/classes", classDtoSchema, json("POST", input));
}

export function archiveClass(classId: string, expectedVersion: number) {
  return archive(classPath(classId), expectedVersion);
}

export function addStudent(classId: string, input: AddStudentInput) {
  return read(`${classPath(classId)}/students`, studentDtoSchema, json("POST", input));
}

export function renameStudent(classId: string, studentId: string, input: UpdateStudentInput) {
  return read(studentPath(classId, studentId), studentDtoSchema, json("PATCH", input));
}

export function archiveStudent(classId: string, studentId: string, expectedVersion: number) {
  return archive(studentPath(classId, studentId), expectedVersion);
}

function rawNotePath(classId: string, rawNoteId: string) {
  return `${classPath(classId)}/raw-notes/${encodeURIComponent(rawNoteId)}`;
}

function proposalPath(classId: string, runId: string) {
  return `${classPath(classId)}/proposal-runs/${encodeURIComponent(runId)}`;
}

export function createRawNote(classId: string, input: CreateRawNoteInput) {
  return read(`${classPath(classId)}/raw-notes`, createRawNoteResponseSchema, json("POST", input));
}

export function getRawNote(classId: string, rawNoteId: string, signal?: AbortSignal) {
  return read(rawNotePath(classId, rawNoteId), rawNoteDetailDtoSchema, { signal });
}

export function reprocessRawNote(classId: string, rawNoteId: string, input: ReprocessRawNoteInput) {
  return read(`${rawNotePath(classId, rawNoteId)}/reprocess`, createRawNoteResponseSchema, json("POST", input));
}

export function getProposalRun(classId: string, runId: string, signal?: AbortSignal) {
  return read(proposalPath(classId, runId), proposalRunDetailDtoSchema, { signal });
}

export function applyProposalDecisions(classId: string, runId: string, input: ProposalDecisionBatchInput) {
  return read(`${proposalPath(classId, runId)}/decisions`, proposalRunDetailDtoSchema, json("POST", input));
}

export function listCanonicalIssues(classId: string, signal?: AbortSignal) {
  return read(`${classPath(classId)}/issues`, canonicalIssueListDtoSchema, { signal });
}

export function getCanonicalIssue(classId: string, issueId: string, signal?: AbortSignal) {
  return read(`${classPath(classId)}/issues/${encodeURIComponent(issueId)}`, canonicalIssueDetailDtoSchema, { signal });
}
