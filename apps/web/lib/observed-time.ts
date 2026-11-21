export function classLocalTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

export function resolveClassLocalTime(value: string, timeZone: string): string | null {
  const local = value.length === 16 ? `${value}:00` : value;
  const wallTime = Date.parse(`${local}Z`);
  if (!Number.isFinite(wallTime)) return null;

  // Sample the offsets on either side of a possible clock change and round-trip each candidate.
  // For a repeated hour, the first occurrence wins. A skipped time has no matching instant.
  const dayMs = 86_400_000;
  const matches = [wallTime - dayMs, wallTime, wallTime + dayMs].map((probe) => {
    const offset = Date.parse(`${classLocalTime(new Date(probe), timeZone)}Z`) - probe;
    return wallTime - offset;
  }).filter((candidate) => Number.isFinite(candidate) && classLocalTime(new Date(candidate), timeZone) === local);
  return matches.length ? new Date(Math.min(...matches)).toISOString() : null;
}

export function formatObservedTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(instant));
}
