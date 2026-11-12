/**
 * D1 students / enrollment (Phase 2 port of /students).
 *
 * NOTE ON PLACEMENT: the batch's enumerated server files had no home
 * for the enrollment roster, so this is a new file (no existing file
 * was touched to make room). It ports three old RPCs and one delete:
 * - my_student_roster: the teacher's rows from teacher_students,
 *   joined to profiles for the full name, pending first. A teacher
 *   reads the name of a pending student they are judging (the old
 *   RPC was security-definer for exactly this), plus parent_phone /
 *   whatsapp_consent for APPROVED students only — pending/rejected
 *   rows expose no contact data.
 * - decide_enrollment: teacher-only; approving a pending row, or
 *   reversing a rejection, sets status + decided_at; rejecting only
 *   ever applies to a pending row. Approving also assigns the
 *   teacher's published auto_all assessments that are not yet due
 *   (old RPC behaviour); rejecting deletes unsubmitted assignments
 *   for the teacher's assessments (submissions already answered
 *   stay for the teacher's records). A row that is not in a
 *   decidable state is NOT_FOUND, never silently "approved".
 * - SINGLE APPROVAL STATE (2026-11-04 fix): a teacher link and a
 *   group membership are two rows for one decision, so approving
 *   from the Students page also approves the student's PENDING
 *   memberships in this teacher's groups (via decideGroupMembership,
 *   i.e. exactly the group-card path: link + membership +
 *   published linked group exams assigned). Approving from either
 *   place therefore lands the student in the group; both views read
 *   the same rows afterwards. REJECTED memberships are deliberately
 *   NOT touched by a Students-page approval — a group rejection
 *   stands until the student re-applies (which resets it to
 *   pending). Reject paths are unchanged on both pages.
 * - approve_all_enrollments: approves every pending row for the
 *   teacher, assigns the same auto_all audience, audits the count,
 *   and returns the count.
 * - remove: deletes the teacher_students row for the caller's own
 *   teacher id only (teacher_id = caller in the WHERE clause).
 *
 * "Linked" means status = 'approved' everywhere; pending/rejected
 * rows grant nothing.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { decideGroupMembership } from "@/server/d1-groups";
import { appendAuditLog } from "@/server/d1-admin";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export function isTeacherCaller(caller: Caller): boolean {
  const role = normalizeRole(caller.role);
  return role === "school_teacher" || role === "tutor";
}

export class StudentError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "StudentError";
  }
}

function requireTeacher(caller: Caller): void {
  if (!isTeacherCaller(caller)) {
    throw new StudentError("FORBIDDEN");
  }
}

export type RosterRow = {
  student_id: string;
  full_name: string;
  status: string;
  requested_at: string;
  joined_at: string;
  parent_phone: string | null;
  whatsapp_consent: boolean;
};

type RosterDbRow = {
  student_id: string;
  full_name: string | null;
  status: string;
  requested_at: string;
  created_at: string;
  parent_phone: string | null;
  whatsapp_consent: number | null;
};

export async function listStudentRoster(db: D1Database, caller: Caller): Promise<RosterRow[]> {
  requireTeacher(caller);
  const { results } = await db
    .prepare(
      "SELECT ts.student_id, p.full_name, ts.status, ts.requested_at, ts.created_at, " +
        "CASE WHEN ts.status = 'approved' THEN p.parent_phone ELSE NULL END AS parent_phone, " +
        "CASE WHEN ts.status = 'approved' THEN p.whatsapp_consent ELSE 0 END AS whatsapp_consent " +
        "FROM teacher_students ts LEFT JOIN profiles p ON p.id = ts.student_id " +
        "WHERE ts.teacher_id = ? " +
        "ORDER BY (ts.status = 'pending') DESC, ts.requested_at DESC, ts.created_at DESC",
    )
    .bind(caller.id)
    .all<RosterDbRow>();
  return (results ?? []).map((r) => ({
    student_id: r.student_id,
    full_name: r.full_name ?? "",
    status: r.status,
    requested_at: r.requested_at,
    joined_at: r.created_at,
    parent_phone: r.parent_phone,
    whatsapp_consent: r.whatsapp_consent === 1,
  }));
}

async function assignAutoAll(
  db: D1Database,
  teacherId: string,
  studentId: string,
  nowIso: string,
): Promise<void> {
  const { results } = await db
    .prepare(
      "SELECT id FROM assessments WHERE teacher_id = ? AND status = 'published' " +
        "AND audience_mode = 'auto_all' AND (due_at IS NULL OR due_at > ?)",
    )
    .bind(teacherId, nowIso)
    .all<{ id: string }>();
  const stmts = (results ?? []).map((a) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO assessment_assignments (assessment_id, student_id) VALUES (?, ?)",
      )
      .bind(a.id, studentId),
  );
  if (stmts.length > 0) {
    if (db.batch) await db.batch(stmts);
    else for (const s of stmts) await s.run();
  }
}

/**
 * Approve the student's PENDING memberships in this teacher's groups
 * through the group-card path, so a Students-page approval and a
 * group-card approval converge on the same state (link + membership
 * + published linked group exams). Rejected memberships are left
 * alone: a group rejection stands until the student re-applies.
 * Scoped to this teacher's groups only, never another teacher's.
 */
async function approvePendingGroupMemberships(
  db: D1Database,
  caller: Caller,
  studentId: string,
  nowIso: string,
): Promise<void> {
  const { results } = await db
    .prepare(
      "SELECT gm.group_id FROM group_members gm JOIN teacher_groups g ON g.id = gm.group_id " +
        "WHERE g.teacher_id = ? AND gm.student_id = ? AND gm.status = 'pending'",
    )
    .bind(caller.id, studentId)
    .all<{ group_id: string }>();
  for (const g of results ?? []) {
    await decideGroupMembership(
      db,
      caller.id,
      normalizeRole(caller.role),
      g.group_id,
      studentId,
      true,
      nowIso,
    );
  }
}

export async function decideEnrollment(
  db: D1Database,
  caller: Caller,
  studentId: string,
  approve: boolean,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  requireTeacher(caller);
  if (!studentId || studentId === caller.id) {
    throw new StudentError("INVALID_INPUT");
  }
  const decided = approve ? "approved" : "rejected";
  const row = await db
    .prepare("SELECT status FROM teacher_students WHERE teacher_id = ? AND student_id = ?")
    .bind(caller.id, studentId)
    .first<{ status: string }>();
  if (!row) throw new StudentError("NOT_FOUND");
  if (!(row.status === "pending" || (approve && row.status === "rejected"))) {
    throw new StudentError("NOT_FOUND");
  }
  await db
    .prepare(
      "UPDATE teacher_students SET status = ?, decided_at = ? " +
        "WHERE teacher_id = ? AND student_id = ?",
    )
    .bind(decided, nowIso, caller.id, studentId)
    .run();
  if (approve) {
    await assignAutoAll(db, caller.id, studentId, nowIso);
    await approvePendingGroupMemberships(db, caller, studentId, nowIso);
  } else {
    // Delete unsubmitted assignments for this teacher's assessments;
    // assessments the student already answered are kept.
    await db
      .prepare(
        "DELETE FROM assessment_assignments WHERE student_id = ? AND assessment_id IN (" +
          "SELECT a.id FROM assessments a WHERE a.teacher_id = ?" +
          ") AND NOT EXISTS (" +
          "SELECT 1 FROM submissions s WHERE s.assessment_id = assessment_assignments.assessment_id " +
          "AND s.student_id = ?)",
      )
      .bind(studentId, caller.id, studentId)
      .run();
  }
  // Activity feed: enrollment decision (label = student name).
  const student = await db
    .prepare("SELECT full_name FROM profiles WHERE id = ?")
    .bind(studentId)
    .first<{ full_name: string | null }>();
  await appendAuditLog(
    db,
    caller.id,
    approve ? "enrollment_approved" : "enrollment_rejected",
    studentId,
    { target_label: (student?.full_name ?? "").trim() },
  );
}

export async function approveAllEnrollments(
  db: D1Database,
  caller: Caller,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  requireTeacher(caller);
  const { results } = await db
    .prepare("SELECT student_id FROM teacher_students WHERE teacher_id = ? AND status = 'pending'")
    .bind(caller.id)
    .all<{ student_id: string }>();
  const pending = results ?? [];
  if (pending.length === 0) return 0;
  const stmts = pending.map((p) =>
    db
      .prepare(
        "UPDATE teacher_students SET status = 'approved', decided_at = ? " +
          "WHERE teacher_id = ? AND student_id = ?",
      )
      .bind(nowIso, caller.id, p.student_id),
  );
  stmts.push(
    db
      .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
      .bind(
        caller.id,
        "enrollment_approve_all",
        null,
        JSON.stringify({ approved: pending.length }),
      ),
  );
  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();
  for (const p of pending) {
    await assignAutoAll(db, caller.id, p.student_id, nowIso);
    await approvePendingGroupMemberships(db, caller, p.student_id, nowIso);
  }
  return pending.length;
}

export async function removeStudent(
  db: D1Database,
  caller: Caller,
  studentId: string,
): Promise<void> {
  requireTeacher(caller);
  await db
    .prepare("DELETE FROM teacher_students WHERE teacher_id = ? AND student_id = ?")
    .bind(caller.id, studentId)
    .run();
  // Revoke exam access too: the take gate checks group membership and
  // assignments, so both must go or a "removed" student keeps taking exams.
  // Scoped to this teacher's groups / assessments only. Submitted work and
  // handwritten grades are kept as record and are NOT deleted here.
  await db
    .prepare(
      "DELETE FROM group_members WHERE student_id = ? AND group_id IN (" +
        "SELECT id FROM teacher_groups WHERE teacher_id = ?" +
        ")",
    )
    .bind(studentId, caller.id)
    .run();
  await db
    .prepare(
      "DELETE FROM assessment_assignments WHERE student_id = ? AND assessment_id IN (" +
        "SELECT id FROM assessments WHERE teacher_id = ?" +
        ")",
    )
    .bind(studentId, caller.id)
    .run();
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

function ctxCaller(context: unknown): Caller {
  const s = ctxSession(context);
  return { id: s.userId, role: s.role };
}

export const listStudentRosterD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listStudentRoster(ctxDb(context), ctxCaller(context)));

export const decideEnrollmentD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { studentId: string; approve: boolean })
  .handler(async ({ data, context }) =>
    decideEnrollment(ctxDb(context), ctxCaller(context), data.studentId, data.approve),
  );

export const approveAllEnrollmentsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => approveAllEnrollments(ctxDb(context), ctxCaller(context)));

export const removeStudentD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { studentId: string })
  .handler(async ({ data, context }) =>
    removeStudent(ctxDb(context), ctxCaller(context), data.studentId),
  );
