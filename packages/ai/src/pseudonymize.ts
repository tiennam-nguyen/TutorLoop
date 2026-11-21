export type PseudonymizationResult = {
  text: string;
  ambiguousTokens: readonly {
    token: string;
    candidateAliases: readonly string[];
  }[];
  redactionVersion: "1";
};

const EMAIL_PATTERN = "[\\p{L}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?)+";
const EMAIL_CHAR = "[\\p{L}\\p{N}.!#$%&'*+/=?^_`{|}~-]";
const PHONE_PATTERN = "(?:\\+?\\d[\\d().\\s-]{5,}\\d)";
const WORD = "[\\p{L}\\p{M}\\p{N}_]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/** Deterministic local minimization; this is not a guarantee of anonymization. */
export function pseudonymizeNote(input: {
  body: string;
  students: readonly {
    displayLabel: string;
    aiAlias: string;
  }[];
}): PseudonymizationResult {
  const byLabel = new Map<string, string[]>();
  for (const student of input.students) {
    const key = labelKey(student.displayLabel);
    const aliases = byLabel.get(key) ?? [];
    aliases.push(student.aiAlias);
    byLabel.set(key, aliases);
  }

  const ambiguousTokens: { token: string; candidateAliases: readonly string[] }[] = [];
  const replacementByLabel = new Map<string, string>();
  const labelsByKey = new Map<string, string[]>();
  for (const student of input.students) {
    const key = labelKey(student.displayLabel);
    const labels = labelsByKey.get(key) ?? [];
    if (!labels.includes(student.displayLabel)) labels.push(student.displayLabel);
    labelsByKey.set(key, labels);
  }
  let ambiguityIndex = 0;
  for (const [key, aliases] of byLabel) {
    if (aliases.length === 1) {
      replacementByLabel.set(key, aliases[0]!);
    } else {
      const token = `AMBIG_${String(++ambiguityIndex).padStart(3, "0")}`;
      replacementByLabel.set(key, token);
      ambiguousTokens.push({ token, candidateAliases: [...aliases] });
    }
  }

  const labels = [...labelsByKey.values()].flat().map((label) => label.normalize("NFC"))
    .filter((label) => label.length > 0)
    .sort((left, right) => right.length - left.length);
  const labelAlternation = labels.map(escapeRegExp).join("|");
  const labelPattern = labelAlternation
    ? `(?<!${WORD})(?:${labelAlternation})(?!${WORD})`
    : "(?!)";
  const emailPattern = `(?<!${EMAIL_CHAR})${EMAIL_PATTERN}`;
  const pattern = new RegExp(`(${emailPattern})|(${PHONE_PATTERN})|(${labelPattern})`, "giu");

  const text = input.body.normalize("NFC").replace(pattern, (match, email: string | undefined, phone: string | undefined) => {
    if (email !== undefined) return "[EMAIL]";
    if (phone !== undefined) return "[PHONE]";
    // Unicode /iu folds (for example S matching ſ) can exceed lowercase-key equivalence.
    return replacementByLabel.get(labelKey(match)) ?? "[STUDENT]";
  });

  return { text, ambiguousTokens, redactionVersion: "1" };
}
