import type { NoteStructurer, StructureNoteInput } from "@tutorloop/ai/contract";
import type { ProposalDraftV1 } from "@tutorloop/contracts";

type DraftFixture =
  | ((input: StructureNoteInput) => ProposalDraftV1 | Promise<ProposalDraftV1>)
  | ReadonlyMap<string, ProposalDraftV1>;

export class FakeNoteStructurer implements NoteStructurer {
  private readonly fixture: DraftFixture;

  constructor(fixture: DraftFixture) {
    this.fixture = fixture;
  }

  async structureNote(input: StructureNoteInput): Promise<ProposalDraftV1> {
    if (typeof this.fixture === "function") return this.fixture(input);
    const draft = this.fixture.get(input.rawNoteId);
    if (!draft) throw new Error("No structuring fixture for this Raw Note.");
    return structuredClone(draft);
  }
}
