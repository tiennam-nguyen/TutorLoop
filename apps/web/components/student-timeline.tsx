import type { StudentOverviewDto } from "@tutorloop/contracts";
import { EvidenceEntry } from "./evidence-entry";
import { formatObservedTime } from "../lib/observed-time";

type TimelineEvent =
  | { kind: "evidence"; at: string; ordinal: number; value: StudentOverviewDto["evidence"][number] }
  | { kind: "intervention"; at: string; ordinal: number; value: StudentOverviewDto["interventions"][number] }
  | { kind: "due" | "performed"; at: string; ordinal: number; value: StudentOverviewDto["reassessments"][number] }
  | { kind: "transition"; at: string; ordinal: number; value: StudentOverviewDto["transitions"][number] };

const tieOrder = { evidence: 0, intervention: 1, due: 2, performed: 3, transition: 4 };

// The API orders each stream at PostgreSQL precision. Compare full UTC fractions as text,
// preserving the server's order within a stream when instants tie.
function sortableInstant(value: string) {
  const match = /^(.*?)(?:\.(\d+))?Z$/.exec(value);
  return match ? `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z` : value;
}

export function StudentTimeline({ overview, timeZone }: { overview: StudentOverviewDto; timeZone: string }) {
  const issues = [...overview.activeStudentIssues, ...overview.resolvedStudentIssues];
  const labels = new Map(issues.map((issue) => [issue.id, issue.canonicalIssue.label]));
  const events: TimelineEvent[] = [
    ...overview.evidence.map((value, ordinal) => ({ kind: "evidence" as const, at: value.observedAt, ordinal, value })),
    ...overview.interventions.map((value, ordinal) => ({ kind: "intervention" as const, at: value.occurredAt, ordinal, value })),
    ...overview.reassessments.flatMap((value, ordinal): TimelineEvent[] => {
      const due: TimelineEvent = { kind: "due", at: value.dueAt, ordinal, value };
      return value.performedAt ? [due, { kind: "performed", at: value.performedAt, ordinal, value }] : [due];
    }),
    ...overview.transitions.map((value, ordinal) => ({ kind: "transition" as const, at: value.createdAt, ordinal, value })),
  ];
  events.sort((a, b) => {
    const left = sortableInstant(a.at);
    const right = sortableInstant(b.at);
    if (left !== right) return left < right ? -1 : 1;
    return tieOrder[a.kind] - tieOrder[b.kind] || a.ordinal - b.ordinal;
  });
  return <section className="panel" id="timeline" aria-label="Timeline">
    <h2>Timeline</h2>
    {events.length ? <ol className="timeline">{events.map((event) => <li key={`${event.kind}-${event.value.id}`}>
      {event.kind === "evidence" ? <EvidenceEntry evidence={event.value} timeZone={timeZone} /> : <>
        <time dateTime={event.at}>{formatObservedTime(event.at, timeZone)}</time>
        {event.kind === "intervention" && <>{" · Intervention: "}<span className="note-text">{event.value.description}</span></>}
        {(event.kind === "due" || event.kind === "performed") && <>
          {event.kind === "due" ? " · Reassessment due" : " · Reassessment performed"}
          {event.value.title && ` · ${event.value.title}`}
          {event.kind === "due" && event.value.status === "CANCELLED" && " · Cancelled"}
        </>}
        {event.kind === "transition" && <>
          {" · Teacher → "}{event.value.toState === "RESOLVED_FOR_NOW" ? "Resolved for now" :
            event.value.toState === "IMPROVING" ? "Improving" : "Open"}
          {labels.get(event.value.studentIssueId) && ` · ${labels.get(event.value.studentIssueId)}`}
          {event.value.reason && ` · ${event.value.reason}`}
        </>}
      </>}
    </li>)}</ol> : <p className="muted">No history yet.</p>}
  </section>;
}
