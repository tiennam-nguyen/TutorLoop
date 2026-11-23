import { sql, type Kysely } from "kysely";
import { productViewEventNameSchema } from "@tutorloop/contracts";
import type { Database } from "../database.ts";

export type ValidationMetrics = {
  rawNotesByClassAndDay: Array<{ classId: string; day: string; count: number }>;
  proposalDecisions: { approved: number; edited: number; rejected: number };
  viewEvents: Record<string, number>;
  closedLoopStudentIssueCount: number;
  reassessmentFollowThroughCount: number;
  historyOpenCount: number;
};

// See docs/validation-metrics.md for the predicate and counting units.
export function getValidationMetrics(db: Kysely<Database>, ownerUserId: string): Promise<ValidationMetrics> {
  return db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    const { rows: notes } = await sql<{ classId: string; day: string; count: number }>`
      SELECT n.class_id AS "classId", to_char(n.observed_at AT TIME ZONE c.timezone, 'YYYY-MM-DD') AS day,
        count(*)::integer AS count
      FROM raw_notes n JOIN classes c ON c.id = n.class_id
      WHERE c.owner_user_id = ${ownerUserId}
      GROUP BY n.class_id, day ORDER BY n.class_id, day
    `.execute(trx);
    const { rows: decisions } = await sql<ValidationMetrics["proposalDecisions"]>`
      SELECT count(*) FILTER (WHERE p.status = 'APPROVED' AND p.teacher_patch IS NULL)::integer AS approved,
        count(*) FILTER (WHERE p.status = 'APPROVED' AND p.teacher_patch IS NOT NULL)::integer AS edited,
        count(*) FILTER (WHERE p.status = 'REJECTED')::integer AS rejected
      FROM proposal_items p JOIN classes c ON c.id = p.class_id
      WHERE c.owner_user_id = ${ownerUserId} AND p.decided_by_user_id = ${ownerUserId}
    `.execute(trx);
    const viewEvents: Record<string, number> = Object.fromEntries(productViewEventNameSchema.options.map((name) => [name, 0]));
    const { rows: views } = await sql<{ eventName: string; count: number }>`
      SELECT e.event_name AS "eventName", count(*)::integer AS count
      FROM product_events e JOIN classes c ON c.id = e.class_id
      WHERE c.owner_user_id = ${ownerUserId} AND e.actor_user_id = ${ownerUserId}
      GROUP BY e.event_name
    `.execute(trx);
    for (const row of views) if (Object.hasOwn(viewEvents, row.eventName)) viewEvents[row.eventName] = row.count;

    const { rows: loops } = await sql<{ closedLoopStudentIssueCount: number; reassessmentFollowThroughCount: number }>`
      WITH outcome AS (
        SELECT e.id, e.class_id, e.student_id, e.student_issue_id, e.observed_at, e.created_at, r.id AS reassessment_id,
          r.due_at, rt.intervention_id
        FROM evidence_events e
        JOIN classes c ON c.id = e.class_id
        JOIN student_issues si ON si.id = e.student_issue_id AND si.class_id = e.class_id AND si.student_id = e.student_id
        JOIN reassessments r ON r.id = e.reassessment_id AND r.class_id = e.class_id
        JOIN reassessment_targets rt ON rt.reassessment_id = r.id AND rt.class_id = r.class_id AND rt.student_issue_id = si.id
        JOIN raw_notes n ON n.id = e.raw_note_id AND n.class_id = e.class_id AND n.reassessment_id = r.id
        WHERE c.owner_user_id = ${ownerUserId} AND e.approved_by_user_id = ${ownerUserId}
          AND r.created_by_user_id = ${ownerUserId} AND r.status <> 'CANCELLED'
          AND rt.target_status = 'EVIDENCED'
      ), closed AS (
        SELECT DISTINCT o.student_issue_id
        FROM outcome o
        JOIN intervention_targets it ON it.class_id = o.class_id AND it.student_issue_id = o.student_issue_id
          AND (o.intervention_id IS NULL OR it.intervention_id = o.intervention_id)
        JOIN interventions i ON i.id = it.intervention_id AND i.class_id = it.class_id
        WHERE i.created_by_user_id = ${ownerUserId} AND i.occurred_at < o.observed_at
          AND EXISTS (
            SELECT 1 FROM evidence_events initial
            JOIN raw_notes n ON n.id = initial.raw_note_id AND n.class_id = initial.class_id
            WHERE initial.class_id = o.class_id AND initial.student_issue_id = o.student_issue_id
              AND initial.id <> o.id AND initial.approved_by_user_id = ${ownerUserId}
              AND initial.student_id = o.student_id
              AND initial.observed_at <= i.occurred_at AND initial.observed_at < o.observed_at
          )
          AND EXISTS (
            SELECT 1 FROM student_issue_transitions t
            WHERE t.class_id = o.class_id AND t.student_issue_id = o.student_issue_id
              AND t.actor_user_id = ${ownerUserId} AND t.from_state IS NOT NULL AND t.from_state <> t.to_state
              AND t.created_at >= o.created_at AND (t.evidence_event_id IS NULL OR t.evidence_event_id = o.id)
          )
      )
      SELECT (SELECT count(*)::integer FROM closed) AS "closedLoopStudentIssueCount",
        (SELECT count(DISTINCT reassessment_id)::integer FROM outcome
          WHERE due_at <= CURRENT_TIMESTAMP AND observed_at >= due_at) AS "reassessmentFollowThroughCount"
    `.execute(trx);
    return { rawNotesByClassAndDay: notes, proposalDecisions: decisions[0], viewEvents,
      ...loops[0], historyOpenCount: viewEvents.history_opened };
  });
}
