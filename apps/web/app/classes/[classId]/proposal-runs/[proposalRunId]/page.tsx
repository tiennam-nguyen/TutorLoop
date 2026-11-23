"use client";

import type { ProposalRunDetailDto } from "@tutorloop/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "../../../../../components/app-shell";
import { proposalPayload } from "../../../../../components/proposal-card";
import { ProposalReview } from "../../../../../components/proposal-review";
import { ProductViewEvent } from "../../../../../components/product-view-event";
import { getCanonicalIssue, getClassDetail, getProposalRun, listCanonicalIssues } from "../../../../../lib/api";
import { useWorkspaceError } from "../../../../../lib/session";

export default function ProposalRunPage() {
  const { classId, proposalRunId } = useParams<{ classId: string; proposalRunId: string }>();
  return (
    <AppShell>
      <ReviewWorkspace key={`${classId}/${proposalRunId}`} classId={classId} runId={proposalRunId} />
    </AppShell>
  );
}

async function loadReview(classId: string, runId: string, signal: AbortSignal) {
  const [classroom, run] = await Promise.all([getClassDetail(classId, signal), getProposalRun(classId, runId, signal)]);
  const payloads = run.items.map((item) => proposalPayload(item));
  const existingLinks = payloads.some((item) => "studentIssueRef" in item && item.studentIssueRef?.kind === "EXISTING");
  const issues = existingLinks || payloads.some((item) => item.type === "CREATE_STUDENT_ISSUE" || item.type === "MERGE_CANONICAL_ISSUE")
    ? await listCanonicalIssues(classId, signal) : [];
  const issueDetails = existingLinks ? await Promise.all(issues.map(({ id }) => getCanonicalIssue(classId, id, signal))) : [];
  return { classroom, run, issues, issueDetails };
}

function ReviewWorkspace({ classId, runId }: { classId: string; runId: string }) {
  const workspaceError = useWorkspaceError();
  const [review, setReview] = useState<Awaited<ReturnType<typeof loadReview>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loadReview(classId, runId, controller.signal).then((data) => {
      if (!controller.signal.aborted) setReview(data);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(workspaceError(failure));
    });
    return () => controller.abort();
  }, [attempt, classId, runId, workspaceError]);

  function updateRun(run: ProposalRunDetailDto) {
    setReview((previous) => previous && { ...previous, run });
  }

  return (
    <>
      {review && <ProductViewEvent eventName="proposal_review_opened" classId={classId} entityId={runId} />}
      <nav className="review-back" aria-label="Class navigation">
        <Link href={`/classes/${encodeURIComponent(classId)}`}>Back to class</Link>
      </nav>
      <div className="page-heading">
        <div>
          <h1>Review proposal</h1>
          {review && <p className="muted">{review.classroom.name}</p>}
        </div>
      </div>
      {review ? <ProposalReview {...review} onApplied={updateRun} /> : error ? (
        <>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => {
            setError(null);
            setAttempt((previous) => previous + 1);
          }}>Try again</button>
        </>
      ) : <p role="status">Loading proposal…</p>}
    </>
  );
}
