import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { STRUCTURE_NOTE_VERSIONS } from "../router.ts";
import { rankCandidates, SCORE_WEIGHTS } from "./score.ts";
import type { BenchmarkRevision, CandidateResult } from "./types.ts";

const ARTIFACT_ROOT = fileURLToPath(new URL("../../../../artifacts/ai-benchmarks/", import.meta.url));

function isAlreadyPresent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export async function writeReport(
  dataset: { revision: BenchmarkRevision; sha256: string; cases: readonly unknown[] },
  results: readonly CandidateResult[],
  startedAt: Date,
): Promise<string> {
  const iso = startedAt.toISOString();
  const metadata = {
    datasetRevision: dataset.revision,
    datasetSha256: dataset.sha256,
    caseCount: dataset.cases.length,
    ...STRUCTURE_NOTE_VERSIONS,
    startedAt: iso,
    finishedAt: new Date().toISOString(),
  };
  const ranked = rankCandidates(results);
  const [first, second] = ranked.filter(({ eligible }) => eligible);
  const pin = (score: typeof first) => score ? { provider: score.candidate.provider, model: score.candidate.model } : null;
  const recommendation = { ...metadata, weights: SCORE_WEIGHTS, ranked, primary: pin(first), fallback: pin(second) };
  const raw = { ...metadata, results };
  const summary = [
    "# TutorLoop AI benchmark",
    "",
    `Synthetic dataset ${dataset.revision} · ${metadata.caseCount} cases · ${iso}`,
    "",
    `Prompt ${metadata.promptVersion} · schema ${metadata.schemaVersion} · redaction ${metadata.redactionVersion}`,
    "",
    "| Provider/model | Total / 100 | Semantic / 60 | Reliability / 25 | Latency / 10 | Availability / 5 | Valid cases | Matched cases | Flagged cases | Recommendation eligibility |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...ranked.map(({ candidate, points, total, validCases, matchedCases, unsafeCases, eligible, exclusions }) => [
      `\`${candidate.provider}/${candidate.model}\``, total?.toFixed(2) ?? "Unmeasured", points?.semantic.toFixed(2) ?? "—",
      points?.reliability.toFixed(2) ?? "—", points?.latency.toFixed(2) ?? "—", points?.availability.toFixed(2) ?? "—",
      validCases, matchedCases, unsafeCases, eligible ? "Eligible" : exclusions.join(", "),
    ].join(" | ")).map((line) => `| ${line} |`),
    "",
    `Primary — ${first ? `\`${first.candidate.provider}/${first.candidate.model}\`` : "No eligible candidate"}`,
    "",
    `Fallback — ${second ? `\`${second.candidate.provider}/${second.candidate.model}\`` : "No second eligible candidate"}`,
    "",
    "The results describe this synthetic run. See raw.json for per-case outcomes and provider attempt metadata.",
    "",
  ].join("\n");

  await mkdir(ARTIFACT_ROOT, { recursive: true });
  let directory = join(ARTIFACT_ROOT, iso.slice(0, 10));
  try {
    await mkdir(directory);
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error;
    directory = join(ARTIFACT_ROOT, iso.replaceAll(":", "-"));
    await mkdir(directory);
  }
  await writeFile(join(directory, "raw.json"), `${JSON.stringify(raw, null, 2)}\n`, { flag: "wx" });
  await writeFile(join(directory, "summary.md"), summary, { flag: "wx" });
  await writeFile(join(directory, "recommendation.json"), `${JSON.stringify(recommendation, null, 2)}\n`, { flag: "wx" });
  return directory;
}
