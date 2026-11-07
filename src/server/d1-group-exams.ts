/**
 * Group exams on D1 (Phase 2 migration of the group-exams part of
 * the /groups route).
 *
 * D1 equivalents of the Supabase RPCs from
 * supabase/migrations/20261104090000_group_exams.sql:
 * assign_group_exam and my_group_exams, plus the teacher's own
 * assessment list that feeds the route's assign dropdown (the old
 * route read assessments directly with teacher_id = caller).
 *
 * THE VISIBILITY RULE, enforced here in code (D1 has no RLS):
 * - assign_group_exam: the caller must own BOTH the group and the
 *   assessment. The link insert is on-conflict-do-nothing
 *   (re-assigning is idempotent) and assignment rows are created
 *   ONLY for APPROVED members of that group — never for pending,
 *   rejected, or outside students, whatever the exam's
 *   audience_mode says. The returned count is the number of NEWLY
 *   assigned students (0 on a re-assign).
 * - my_group_exams: the owning teacher sees every linked exam
 *   (draft or published); an APPROVED member sees only PUBLISHED
 *   linked exams; anyone else — pending, rejected, non-member,
 *   non-owner teacher — gets NO rows at all, so exam titles never
 *   leak to non-members. Both branches put the check in the SQL
 *   WHERE clause; titles are never fetched-then-filtered in JS.
 * - Student paths NEVER touch question_keys, answers, or
 *   submissions: this module selects only assessment id/title/
 *   status for linked exams.
 * - NO unassign in v1 (same limit as the Supabase version):
 *   deleting the group cascades its group_exams rows.
 *
 * Pure functions take (db, actor...) and are unit-tested with a
 * dispatch fake in src/test/d1-groups.test.ts — no live D1 needed.
 * Server-function wrappers resolve the session via the frozen
 * requireCloudflareAuth middleware (src/server/d1-session.ts).
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { requireCloudflareAuth } from "@/server/d1-session";
import { GroupError, isGroupOwner, isTeacherRole } from "@/server/d1-groups";
import { appendAuditLog } from "@/server/d1-admin";

export type GroupExam = {
  assessmentId: string;
  title: string;
  published: boolean;
};

export type TeacherAssessment = {
  id: string;
  title: string;
  status: string;
};

type GroupExamRow = {
  assessment_id: string;
  title: string;
  published: number;
};

type AssessmentRow = {
  id: string;
  title: string;
  status: string;
};

/** Old RPC: my_group_exams. Visibility is decided by the SQL below. */
export async function listGroupExams(
  db: D1Database,
  callerId: string,
  groupId: string,
): Promise<GroupExam[]> {
  if (await isGroupOwner(db, groupId, callerId)) {
    // Owning teacher: every linked exam, draft or published.
    const { results } = await db
      .prepare(
        "SELECT ge.assessment_id, a.title, (a.status = 'published') AS published " +
          "FROM group_exams ge JOIN assessments a ON a.id = ge.assessment_id " +
          "WHERE ge.group_id = ? ORDER BY ge.created_at DESC",
      )
      .bind(groupId)
      .all<GroupExamRow>();
    return (results ?? []).map((r) => ({
      assessmentId: r.assessment_id,
      title: r.title,
      published: r.published === 1,
    }));
  }
  // Anyone else: only an APPROVED member sees anything, and only
  // published exams. Pending / rejected / non-members get [].
  const { results } = await db
    .prepare(
      "SELECT ge.assessment_id, a.title, (a.status = 'published') AS published " +
        "FROM group_exams ge JOIN assessments a ON a.id = ge.assessment_id " +
        "WHERE ge.group_id = ? AND a.status = 'published' AND EXISTS ( " +
        "SELECT 1 FROM group_members " +
        "WHERE group_id = ? AND student_id = ? AND status = 'approved') " +
        "ORDER BY ge.created_at DESC",
    )
    .bind(groupId, groupId, callerId)
    .all<GroupExamRow>();
  return (results ?? []).map((r) => ({
    assessmentId: r.assessment_id,
    title: r.title,
    published: r.published === 1,
  }));
}

/** The teacher's own assessments, for the route's assign dropdown. */
export async function listTeacherAssessments(
  db: D1Database,
  teacherId: string,
  role: string,
): Promise<TeacherAssessment[]> {
  if (!isTeacherRole(role)) throw new GroupError("not_teacher");
  const { results } = await db
    .prepare(
      "SELECT id, title, status FROM assessments WHERE teacher_id = ? ORDER BY created_at DESC",
    )
    .bind(teacherId)
    .all<AssessmentRow>();
  return (results ?? []).map((r) => ({ id: r.id, title: r.title, status: r.status }));
}

/**
 * Old RPC: assign_group_exam. Owner of group AND assessment only.
 * Returns the number of newly assigned (approved-member) students.
 */
export async function assignGroupExam(
  db: D1Database,
  teacherId: string,
  role: string,
  groupId: string,
  assessmentId: string,
): Promise<number> {
  if (!isTeacherRole(role)) throw new GroupError("not_teacher");
  if (!(await isGroupOwner(db, groupId, teacherId))) throw new GroupError("not_owner");
  const assessment = await db
    .prepare("SELECT 1 AS one FROM assessments WHERE id = ? AND teacher_id = ?")
    .bind(assessmentId, teacherId)
    .first<{ one: number }>();
  if (!assessment) throw new GroupError("not_owner");
  await db
    .prepare(
      "INSERT INTO group_exams (group_id, assessment_id) " +
        "VALUES (?, ?) ON CONFLICT(group_id, assessment_id) DO NOTHING",
    )
    .bind(groupId, assessmentId)
    .run();
  const { results: approved } = await db
    .prepare("SELECT student_id FROM group_members WHERE group_id = ? AND status = 'approved'")
    .bind(groupId)
    .all<{ student_id: string }>();
  const approvedIds = (approved ?? []).map((r) => r.student_id);
  if (approvedIds.length === 0) return 0;
  const { results: existing } = await db
    .prepare(
      "SELECT student_id FROM assessment_assignments WHERE assessment_id = ? " +
        "AND student_id IN (SELECT student_id FROM group_members " +
        "WHERE group_id = ? AND status = 'approved')",
    )
    .bind(assessmentId, groupId)
    .all<{ student_id: string }>();
  const already = new Set((existing ?? []).map((r) => r.student_id));
  let count = 0;
  for (const studentId of approvedIds) {
    if (already.has(studentId)) continue;
    await db
      .prepare(
        "INSERT INTO assessment_assignments (assessment_id, student_id) " +
          "VALUES (?, ?) ON CONFLICT(assessment_id, student_id) DO NOTHING",
      )
      .bind(assessmentId, studentId)
      .run();
    count++;
  }
  // Activity-feed labels: exam title + group name (ids alone are unreadable).
  const exam = await db
    .prepare("SELECT title FROM assessments WHERE id = ?")
    .bind(assessmentId)
    .first<{ title: string }>();
  const group = await db
    .prepare("SELECT name FROM teacher_groups WHERE id = ?")
    .bind(groupId)
    .first<{ name: string }>();
  await appendAuditLog(db, teacherId, "group_exam_assigned", assessmentId, {
    group_id: groupId,
    assigned: count,
    target_label: exam?.title ?? "",
    group_label: group?.name ?? "",
  });
  return count;
}

// ------------------------------------------------------- server functions ---

type Ctx = { session: AuthSession; db: D1Database };

export const getGroupExamsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { groupId: string })
  .handler(async ({ context, data }): Promise<GroupExam[]> => {
    const { session, db } = context as Ctx;
    return listGroupExams(db, session.userId, data.groupId);
  });

export const getTeacherAssessmentsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }): Promise<TeacherAssessment[]> => {
    const { session, db } = context as Ctx;
    if (!isTeacherRole(session.role)) throw new GroupError("not_teacher");
    return listTeacherAssessments(db, session.userId, session.role);
  });

export const assignGroupExamD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { groupId: string; assessmentId: string })
  .handler(async ({ context, data }): Promise<{ count: number }> => {
    const { session, db } = context as Ctx;
    if (!isTeacherRole(session.role)) throw new GroupError("not_teacher");
    return {
      count: await assignGroupExam(
        db,
        session.userId,
        session.role,
        data.groupId,
        data.assessmentId,
      ),
    };
  });
