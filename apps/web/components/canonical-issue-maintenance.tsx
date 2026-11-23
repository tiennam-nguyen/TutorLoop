"use client";

import { useState, type FormEvent } from "react";
import type { CanonicalIssueDetailDto, CanonicalIssueSummaryDto } from "@tutorloop/contracts";
import { mergeCanonicalIssue, updateCanonicalIssue } from "../lib/api";
import { useWorkspaceError } from "../lib/session";

export function CanonicalIssueMaintenance({ classId, issue, candidates, onSaved }: {
  classId: string; issue: CanonicalIssueDetailDto; candidates: CanonicalIssueSummaryDto[]; onSaved: () => void;
}) {
  const workspaceError = useWorkspaceError();
  const [label, setLabel] = useState(issue.label), [description, setDescription] = useState(issue.description ?? "");
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const targets = candidates.filter((target) => target.id !== issue.id && !target.mergedIntoId && !target.archivedAt);
  function targetLabel(target: CanonicalIssueSummaryDto) {
    return candidates.some((other) => other.id !== target.id && other.label === target.label)
      ? `${target.label} · ${target.description ? `${target.description} · ` : ""}${target.id.slice(0, 8)}` : target.label;
  }
  async function save(event: FormEvent<HTMLFormElement>, merging: boolean) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (merging) {
        const target = targets.find(({ id }) => id === targetId);
        if (!target) return;
        await mergeCanonicalIssue(classId, issue.id, { targetCanonicalIssueId: target.id,
          expectedSourceVersion: issue.version, expectedTargetVersion: target.version });
      } else {
        await updateCanonicalIssue(classId, issue.id, { label: label.trim(), description: description || null, expectedVersion: issue.version });
      }
      onSaved();
    } catch (failure) { setError(workspaceError(failure)); }
    finally { setBusy(false); }
  }
  return <section className="panel stack" aria-label="Maintain Canonical Issue">
    <h2>Edit Canonical Issue</h2>
    <form className="stack" onSubmit={(event) => void save(event, false)}>
      <label>Issue label<input required disabled={busy} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label>Issue description<textarea disabled={busy} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <button type="submit" disabled={busy || !label.trim()}>Save issue</button>
    </form>
    {targets.length > 0 && <form className="stack" onSubmit={(event) => void save(event, true)}>
      <h2>Merge Canonical Issues</h2>
      <p>Merge this issue into another issue. Both issues and all student history are preserved.</p>
      <label>Merge target<select disabled={busy} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
        <option value="">Choose an issue</option>{targets.map((target) => <option key={target.id} value={target.id}>{targetLabel(target)}</option>)}
      </select></label>
      <button type="submit" disabled={busy || !targetId}>Merge into selected issue</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
