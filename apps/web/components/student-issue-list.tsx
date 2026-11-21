import type { StudentOverviewDto } from "@tutorloop/contracts";
import Link from "next/link";

type Issue = StudentOverviewDto["activeStudentIssues"][number];
const stateLabels = { OPEN: "Open", IMPROVING: "Improving", RESOLVED_FOR_NOW: "Resolved for now" } as const;

export function StudentIssueList({ classId, title, issues }: { classId: string; title: string; issues: Issue[] }) {
  return <section className="panel issue-list" aria-label={title}>
    <h2>{title}</h2>
    {issues.length ? <ul className="rows">{issues.map((issue) => <li key={issue.id}>
      <Link href={`/classes/${encodeURIComponent(classId)}/issues/${encodeURIComponent(issue.canonicalIssueId)}`}>
        {issue.canonicalIssue.label}
      </Link>{" · "}{stateLabels[issue.state]}
      {issue.manifestation && <p className="muted">{issue.manifestation}</p>}
    </li>)}</ul> : <p className="muted">None.</p>}
  </section>;
}
