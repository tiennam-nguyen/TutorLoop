import { z } from "zod";
import { nonblankTextSchema, timestampSchema, versionSchema } from "./common.ts";
import { studentIssueStateSchema } from "./issues.ts";

export const aiTaskSchema = z.enum(["STRUCTURE_OBSERVATION_NOTE", "RECONCILE_REASSESSMENT_OUTCOME"]);
export type AiTask = z.infer<typeof aiTaskSchema>;

export const studentRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("RESOLVED"), studentAlias: nonblankTextSchema }),
  z.strictObject({
    kind: z.literal("AMBIGUOUS"),
    token: nonblankTextSchema,
    candidateAliases: z.array(nonblankTextSchema),
  }),
  z.strictObject({ kind: z.literal("UNKNOWN"), token: nonblankTextSchema }),
]);
export type StudentRef = z.infer<typeof studentRefSchema>;

export const existingCanonicalIssueRefSchema = z.strictObject({
  kind: z.literal("EXISTING"),
  canonicalIssueId: nonblankTextSchema,
});
export type ExistingCanonicalIssueRef = z.infer<typeof existingCanonicalIssueRefSchema>;

export const proposedCanonicalIssueRefSchema = z.strictObject({
  kind: z.literal("PROPOSED"),
  proposalKey: nonblankTextSchema,
});
export type ProposedCanonicalIssueRef = z.infer<typeof proposedCanonicalIssueRefSchema>;

export const ambiguousCanonicalIssueRefSchema = z.strictObject({
  kind: z.literal("AMBIGUOUS"),
  candidateIds: z.array(nonblankTextSchema),
});
export type AmbiguousCanonicalIssueRef = z.infer<typeof ambiguousCanonicalIssueRefSchema>;

export const canonicalIssueRefSchema = z.discriminatedUnion("kind", [
  existingCanonicalIssueRefSchema,
  proposedCanonicalIssueRefSchema,
  ambiguousCanonicalIssueRefSchema,
]);
export type CanonicalIssueRef = z.infer<typeof canonicalIssueRefSchema>;

export const studentIssueRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("EXISTING"), studentIssueId: nonblankTextSchema }),
  z.strictObject({ kind: z.literal("PROPOSED"), proposalKey: nonblankTextSchema }),
]);
export type StudentIssueRef = z.infer<typeof studentIssueRefSchema>;

const draftItemSchema = z.strictObject({ key: nonblankTextSchema });
const versionedStudentIssueDraftItemSchema = draftItemSchema.extend({
  studentIssueRef: studentIssueRefSchema,
  expectedVersion: versionSchema,
});

export const proposalDraftItemV1Schema = z.discriminatedUnion("type", [
  draftItemSchema.extend({
    type: z.literal("CREATE_CANONICAL_ISSUE"),
    label: nonblankTextSchema,
    description: z.string().nullish(),
  }),
  draftItemSchema.extend({
    type: z.literal("CREATE_STUDENT_ISSUE"),
    studentRef: studentRefSchema,
    canonicalIssueRef: canonicalIssueRefSchema,
    manifestation: z.string().nullish(),
  }),
  draftItemSchema.extend({
    type: z.literal("CREATE_EVIDENCE"),
    studentRef: studentRefSchema,
    studentIssueRef: studentIssueRefSchema.nullish(),
    observationText: nonblankTextSchema,
    learningContext: z.string().nullish(),
    observedAt: timestampSchema.optional(),
  }),
  versionedStudentIssueDraftItemSchema.extend({
    type: z.literal("UPDATE_MANIFESTATION"),
    manifestation: z.string().nullable(),
  }),
  versionedStudentIssueDraftItemSchema.extend({
    type: z.literal("TRANSITION_STUDENT_ISSUE"),
    toState: studentIssueStateSchema,
    reason: z.string().nullish(),
  }),
]);
export type ProposalDraftItemV1 = z.infer<typeof proposalDraftItemV1Schema>;

export const proposalDraftV1Schema = z.strictObject({
  schemaVersion: z.literal("1"),
  items: z.array(proposalDraftItemV1Schema).refine(
    (items) => new Set(items.map(({ key }) => key)).size === items.length,
    "Draft item keys must be unique",
  ),
});
export type ProposalDraftV1 = z.infer<typeof proposalDraftV1Schema>;
