export { productViewEventNameSchema, recordProductEventInputSchema } from "@tutorloop/contracts";
export type { ProductViewEventName, RecordProductEventInput } from "@tutorloop/contracts";

export const serverProductEvents = {
  APPROVE: "proposal_item_approved", EDIT_AND_APPROVE: "proposal_item_edited", REJECT: "proposal_item_rejected",
} as const;
