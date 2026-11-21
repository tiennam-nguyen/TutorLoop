import type { CanonicalIssueListDto } from "@tutorloop/contracts";
import Link from "next/link";

export function IssueTable({ classId, issues }: { classId: string; issues: CanonicalIssueListDto }) {
  return (
    <div className="table-scroll panel">
      <table aria-label="Class issues" className="issue-table">
        <thead><tr><th scope="col">Issue</th><th scope="col">Open</th><th scope="col">Improving</th><th scope="col">Resolved</th><th scope="col">Due</th></tr></thead>
        <tbody>{issues.map((issue) => (
          <tr key={issue.id}>
            <td><Link href={`/classes/${encodeURIComponent(classId)}/issues/${encodeURIComponent(issue.id)}`}>{issue.label}</Link></td>
            <td>{issue.countsByState.OPEN}</td>
            <td>{issue.countsByState.IMPROVING}</td>
            <td>{issue.countsByState.RESOLVED_FOR_NOW}</td>
            <td>{issue.dueCount}</td>
          </tr>
        ))}</tbody>
      </table>
      {!issues.length && <p className="muted">No issues yet.</p>}
    </div>
  );
}
