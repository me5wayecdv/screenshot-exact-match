/**
 * Take gate (Phase 2, defence in depth over the assignment row alone).
 *
 * A student may start an assessment only when ALL of these hold:
 * 1. The assessment exists and status = 'published' (drafts are
 *    invisible to students entirely).
 * 2. The availability window is open: starts_at is null or passed,
 *    and due_at is null or not yet passed for a NEW start (a started
 *    attempt is handled by the attempt logic, not this gate).
 * 3. An assessment_assignments row exists for (assessment, student).
 * 4. GROUP CHECK (the Phase 2 addition): if the assessment has ANY
 *    group_exams link, the student must be an APPROVED member of at
 *    least one linked group. A stale assignment row (e.g. from an
 *    earlier everyone-publish, or left behind after a group change)
 *    is NOT sufficient on its own once a group link exists.
 *
 * Every check is in the SQL WHERE clause or an explicit membership
 * query — never "fetch all rows and filter in JS", which would leak
 * titles/rows to a caller who inspects responses.
 */

import type { D1Database } from "@/server/d1-auth-store";

export type TakeGateResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "NOT_FOUND"
        | "NOT_PUBLISHED"
        | "NOT_STARTED"
        | "WINDOW_CLOSED"
        | "NOT_ASSIGNED"
        | "NOT_GROUP_MEMBER";
    };

export async function canTakeAssessment(
  db: D1Database,
  studentId: string,
  assessmentId: string,
  nowIso: string = new Date().toISOString(),
): Promise<TakeGateResult> {
  const assessment = await db
    .prepare("SELECT status, starts_at, due_at FROM assessments WHERE id = ?")
    .bind(assessmentId)
    .first<{ status: string; starts_at: string | null; due_at: string | null }>();
  if (!assessment) return { allowed: false, reason: "NOT_FOUND" };
  if (assessment.status !== "published") return { allowed: false, reason: "NOT_PUBLISHED" };
  if (assessment.starts_at && assessment.starts_at > nowIso) {
    return { allowed: false, reason: "NOT_STARTED" };
  }
  if (assessment.due_at && assessment.due_at <= nowIso) {
    return { allowed: false, reason: "WINDOW_CLOSED" };
  }
  const assignment = await db
    .prepare(
      "SELECT 1 AS one FROM assessment_assignments " + "WHERE assessment_id = ? AND student_id = ?",
    )
    .bind(assessmentId, studentId)
    .first<{ one: number }>();
  if (!assignment) return { allowed: false, reason: "NOT_ASSIGNED" };
  const links = await db
    .prepare("SELECT group_id FROM group_exams WHERE assessment_id = ?")
    .bind(assessmentId)
    .all<{ group_id: string }>();
  const groupIds = (links.results ?? []).map((r) => r.group_id);
  if (groupIds.length === 0) return { allowed: true };
  // At least one linked group must have this student as an APPROVED member.
  for (const groupId of groupIds) {
    const member = await db
      .prepare(
        "SELECT 1 AS one FROM group_members " +
          "WHERE group_id = ? AND student_id = ? AND status = 'approved'",
      )
      .bind(groupId, studentId)
      .first<{ one: number }>();
    if (member) return { allowed: true };
  }
  return { allowed: false, reason: "NOT_GROUP_MEMBER" };
}
