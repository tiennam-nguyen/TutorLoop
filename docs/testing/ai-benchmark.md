# TutorLoop AI benchmark

The v1 dataset contains 32 entirely synthetic notes, two for each of the 16 scenarios in the implementation plan. Scenario 16 combines Vietnamese, English math vocabulary, and fragmented teacher shorthand. The runner uses the worker's prompt, minimized payload, provider adapters, and local draft validation. The command accepts only the bundled dataset.

## Validate offline

From the repository root with Node 26 and the project's pnpm version installed, run:

```sh
pnpm --filter @tutorloop/ai test
pnpm benchmark:ai -- --dry-run
```

Dry run checks the case counts, distinct inputs, roster and issue references, expected drafts, scoring anchors, and all four pinned routes. It exits before constructing adapters or creating artifacts.

## Run with provider credentials

Supply the relevant variables in the command's process environment. The CLI itself does not load a dotenv file. Use all four credentials to collect evidence for all four candidates. With a subset of credentials, omitted candidates appear as `MISSING_CREDENTIAL`. A live invocation requires at least one credential.

| Credential variable | Candidate | Structured output |
| --- | --- | --- |
| `GEMINI_API_KEY` | `GEMINI/gemini-3.8-flash` | Native JSON Schema |
| `OPENROUTER_API_KEY` | `OPENROUTER/z-ai/glm-5.3-flash:free` | Prompt JSON |
| `GROQ_API_KEY` | `GROQ/openai/gpt-oss-120b` | Strict JSON Schema |
| `NVIDIA_NIM_API_KEY` | `NVIDIA_NIM/nvidia/nemotron-3-ultra-550b-a55b` | Prompt JSON |

```sh
pnpm benchmark:ai
```

Each provider runs the same cases in order and uses the registry timeout and one allowed retry. Providers can run concurrently. A retry or failed proposal is attributed only to its candidate. One complete run can make up to 64 requests per provider.

## Score and read the results

| Points | Calculation |
| ---: | --- |
| 60 semantic | Match expected proposal items one-to-one by type, student or ambiguity, issue linkage, state and version when applicable, and case-specific text anchors. Divide matched items by expected plus extra items, then average across all 32 cases. A failed case or a recognized forbidden claim earns zero. |
| 25 reliability | Divide locally valid drafts by total attempts. Both schema failures and provider failures consume attempts, including retries. |
| 10 latency | Award each valid case `10 / (1 + attemptMilliseconds / 5000)` using the sum of its attempt latencies. Failed cases earn zero. Average across all 32 cases. |
| 5 availability | Divide attempts that returned a valid draft or an invalid structured response by all attempts. Rate limits, timeouts, network failures, rejected requests, and provider errors lower availability. |

The rubric checks English and Vietnamese text anchors, including specific relationships such as an axis and its actual label, the sign of a reported result, and whether an issue attribution is uncertain. Selected cases also check for explicit contradictions. Evidence anchors apply to the observation itself. The forbidden-claim check examines descriptive fields individually, including learning context. It recognizes common diagnosis and mastery terms and a bounded set of direct denials. These checks can miss unlisted paraphrases or more complex negation, and the anchors can miss correct paraphrases. The benchmark measures the supplied keys, routes, and runtime conditions for one synthetic run. Replaying the same captured outcomes produces the same ordering by score, then by provider/model identifier.

The first run started on a UTC date writes these files beneath `artifacts/ai-benchmarks/YYYY-MM-DD/`. A same-day rerun uses a UTC timestamp directory, with colons replaced by hyphens for Windows, to preserve the earlier artifact.

- `raw.json` contains the synthetic case IDs, semantic check outcomes, and per-attempt statuses, error codes, latency, and minimized input hashes. It excludes credentials, prompt text, and provider response bodies.
- `summary.md` shows weighted scores, outcome counts, and recommendation eligibility.
- `recommendation.json` records the ranking, dataset revision and digest, prompt/schema/redaction versions, and the first two eligible provider/model pairs. A candidate needs a valid draft with some semantic credit and zero flagged diagnosis or mastery claims. `primary` or `fallback` is `null` when there are fewer qualifying routes. The files are locally ignored by Git.

Review the live artifact before pinning `AI_PRIMARY_PROVIDER`, `AI_PRIMARY_MODEL`, `AI_FALLBACK_PROVIDER`, and `AI_FALLBACK_MODEL`. The benchmark leaves runtime configuration to the operator. A real-data pilot requires both evidence-backed pins. Fake AI remains available for development while that gate is open.


## Canonical merge extension

The runtime now uses `structure-note-v2`. ProposalDraftV1 still has `schemaVersion: "1"` and accepts all saved five-type v1 drafts; its additive sixth type is `MERGE_CANONICAL_ISSUE`, with source/target IDs and expected versions. Active canonical candidates now carry versions and exclude merged sources. Historical Student Issue IDs remain available for evidence and reassessment updates, with their canonical candidate reference resolved to the current root. Remote IDs are still pseudonymous and restored locally.

The provider JSON schema and prompt have therefore changed. Earlier `structure-note-v1` benchmark artifacts remain evidence only for their recorded prompt/schema/payload, and do not validate merge proposal quality or the v2 transport. The unchanged 32-case dataset has no merge scenario. Before relying on v2 live-provider routing for a real-data pilot, rerun the credential-gated benchmark and assess merge proposals separately. The canonical merge change uses deterministic fake-provider tests only and does not alter provider pins or historical benchmark artifacts.
