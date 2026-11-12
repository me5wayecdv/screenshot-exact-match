/**
 * Teacher groups on D1 (Phase 2 migration of the /groups route).
 *
 * D1 equivalents of the Supabase RPCs from
 * supabase/migrations/20261103210000_teacher_groups.sql (group CRUD,
 * join, decisions, reads) plus the group-exam approval inserts from
 * 20261104090000_group_exams.sql. Group-exam linking/reading itself
 * lives in src/server/d1-group-exams.ts.
 *
 * THE SECURITY RULE, enforced here in code (D1 has no RLS):
 * session -> role -> ownership/membership -> only then query.
 * - A group is managed ONLY by its owning teacher
 *   (teacher_groups.teacher_id = session user id). Every teacher
 *   mutation first proves ownership with an explicit query; a
 *   non-owner teacher gets `not_owner`, never a row.
 * - Students join by group code into PENDING and see nothing until
 *   approval: no assignment rows are created on join, and the
 *   student read paths filter on status = 'approved' / 'pending'
 *   for the CALLER's own id in the SQL WHERE clause, never by
 *   fetching all rows and filtering in JS.
 * - A teacher's per-group roster exposes ONLY the full_name of
 *   members/requesters of their own group (the name they judge) —
 *   nothing else about those students.
 * - Approving a group request also approves the teacher link and
 *   assigns the teacher's open published auto_all exams AND this
 *   group's published linked exams. Rejecting a group request
 *   rejects a still-pending teacher link ONLY when the student has
 *   no approved group left with this teacher — a rejection never
 *   unlinks an approved student.
 * - The client never supplies a user id, teacher id, or actor id:
 *   every server-function wrapper below passes ONLY the session's
 *   user id and role. Legacy role 'teacher' maps to 'school_teacher'.
 * - Error messages are the old RPC codes (not_owner, not_teacher,
 *   only_students, name_required, invalid_code, invalid_student,
 *   no_pending_request) so the existing translateError map in
 *   src/lib/i18n.tsx keeps translating them; no new i18n key needed.
 * - NO unassign in v1 (same limit as the Supabase version): deleting
 *   a group deletes its group_members and group_exams rows explicitly
 *   in code — the schema's ON DELETE CASCADE is dead at runtime
 *   (D1 enforces FKs only with PRAGMA foreign_keys = ON, which no
 *   code path enables), so it must never be relied on.
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
import { appendAuditLog } from "@/server/d1-admin";

export type TeacherRole = "school_teacher" | "tutor";

export class GroupError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "GroupError";
  }
}

export function normalizeGroupRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export function isTeacherRole(role: string): boolean {
  const r = normalizeGroupRole(role);
  return r === "school_teacher" || r === "tutor";
}

function assertTeacher(role: string): void {
  if (!isTeacherRole(role)) throw new GroupError("not_teacher");
}

export type GroupInput = {
  name: string;
  year: string;
  days: string[];
  time: string;
  notes: string;
};

export type TeacherGroup = {
  groupId: string;
  name: string;
  schoolYear: string;
  days: string[];
  timeText: string;
  notes: string;
  joinCode: string;
  approvedCount: number;
  pendingCount: number;
  createdAt: string;
};

export type RosterRow = {
  studentId: string;
  fullName: string;
  status: string;
  requestedAt: string | null;
};

export type StudentGroup = {
  groupId: string;
  groupName: string;
  schoolYear: string;
  days: string[];
  timeText: string;
  teacherId: string;
  teacherName: string;
};

export type PendingGroupRequest = {
  groupId: string;
  groupName: string;
  teacherId: string;
  teacherName: string;
  requestedAt: string;
};

type GroupRow = {
  group_id: string;
  name: string;
  school_year: string;
  days: string;
  time_text: string;
  notes: string;
  join_code: string;
  approved_count: number;
  pending_count: number;
  created_at: string;
};

type RosterDbRow = {
  student_id: string;
  full_name: string | null;
  status: string;
  requested_at: string | null;
};

type StudentGroupRow = {
  group_id: string;
  group_name: string;
  school_year: string;
  days: string;
  time_text: string;
  teacher_id: string;
  teacher_name: string | null;
};

type PendingGroupRow = {
  group_id: string;
  group_name: string;
  teacher_id: string;
  teacher_name: string | null;
  requested_at: string;
};

function parseDays(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function newGroupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function clean(input: GroupInput): GroupInput {
  return {
    name: input.name.trim(),
    year: input.year.trim(),
    days: input.days ?? [],
    time: input.time.trim(),
    notes: input.notes.trim(),
  };
}

export async function isGroupOwner(
  db: D1Database,
  groupId: string,
  teacherId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM teacher_groups WHERE id = ? AND teacher_id = ?")
    .bind(groupId, teacherId)
    .first<{ one: number }>();
  return row !== null;
}

async function assertOwner(db: D1Database, groupId: string, teacherId: string): Promise<void> {
  if (!(await isGroupOwner(db, groupId, teacherId))) throw new GroupError("not_owner");
}

/** Old RPC: my_teacher_groups. Owner only; counts are computed in SQL. */
export async function listTeacherGroups(
  db: D1Database,
  teacherId: string,
  role: string,
): Promise<TeacherGroup[]> {
  assertTeacher(role);
  const { results } = await db
    .prepare(
      "SELECT g.id AS group_id, g.name, g.school_year, g.days, g.time_text, g.notes, " +
        "g.join_code, g.created_at, " +
        "SUM(CASE WHEN gm.status = 'approved' THEN 1 ELSE 0 END) AS approved_count, " +
        "SUM(CASE WHEN gm.status = 'pending' THEN 1 ELSE 0 END) AS pending_count " +
        "FROM teacher_groups g LEFT JOIN group_members gm ON gm.group_id = g.id " +
        "WHERE g.teacher_id = ? GROUP BY g.id ORDER BY g.created_at DESC",
    )
    .bind(teacherId)
    .all<GroupRow>();
  return (results ?? []).map((r) => ({
    groupId: r.group_id,
    name: r.name,
    schoolYear: r.school_year,
    days: parseDays(r.days),
    timeText: r.time_text,
    notes: r.notes,
    joinCode: r.join_code,
    approvedCount: r.approved_count ?? 0,
    pendingCount: r.pending_count ?? 0,
    createdAt: r.created_at,
  }));
}

/** Old RPC: create_teacher_group. Returns the new group id. */
export async function createTeacherGroup(
  db: D1Database,
  teacherId: string,
  role: string,
  input: GroupInput,
): Promise<string> {
  assertTeacher(role);
  const data = clean(input);
  if (data.name === "") throw new GroupError("invalid_student");
  const groupId = crypto.randomUUID();
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = newGroupCode();
    const clash = await db
      .prepare("SELECT 1 AS one FROM teacher_groups WHERE join_code = ?")
      .bind(code)
      .first<{ one: number }>();
    if (clash) continue;
    try {
      await db
        .prepare(
          "INSERT INTO teacher_groups (id, teacher_id, name, school_year, days, time_text, notes, join_code) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          groupId,
          teacherId,
          data.name,
          data.year,
          JSON.stringify(data.days),
          data.time,
          data.notes,
          code,
        )
        .run();
      // Activity feed: group created (label = group name, never a join code).
      await appendAuditLog(db, teacherId, "group_created", groupId, {
        target_label: data.name,
      });
      return groupId;
    } catch {
      // UNIQUE clash racing the check above: retry with a fresh code.
      continue;
    }
  }
  throw new GroupError("group_code_unavailable");
}

/** Old RPC: update_teacher_group. Owner only; empty name rejected. */
export async function updateTeacherGroup(
  db: D1Database,
  teacherId: string,
  role: string,
  groupId: string,
  input: GroupInput,
): Promise<boolean> {
  assertTeacher(role);
  const data = clean(input);
  if (data.name === "") throw new GroupError("invalid_student");
  await assertOwner(db, groupId, teacherId);
  await db
    .prepare(
      "UPDATE teacher_groups SET name = ?, school_year = ?, days = ?, time_text = ?, notes = ? " +
        "WHERE id = ? AND teacher_id = ?",
    )
    .bind(
      data.name,
      data.year,
      JSON.stringify(data.days),
      data.time,
      data.notes,
      groupId,
      teacherId,
    )
    .run();
  // Activity feed: group edited (label = new name).
  await appendAuditLog(db, teacherId, "group_updated", groupId, {
    target_label: data.name,
  });
  return true;
}

/**
 * Old RPC: delete_teacher_group. Owner only. D1/SQLite enforces the
 * schema's ON DELETE CASCADE only with PRAGMA foreign_keys = ON per
 * connection, and no code path enables it — the cascade is dead at
 * runtime. So the child rows are deleted explicitly first; there is
 * deliberately no unassign of a single exam in v1.
 */
export async function deleteTeacherGroup(
  db: D1Database,
  teacherId: string,
  role: string,
  groupId: string,
): Promise<boolean> {
  assertTeacher(role);
  await assertOwner(db, groupId, teacherId);
  // Name first: after the delete there is nothing left to label the feed row with.
  const doomed = await db
    .prepare("SELECT name FROM teacher_groups WHERE id = ? AND teacher_id = ?")
    .bind(groupId, teacherId)
    .first<{ name: string }>();
  // Explicit child deletes: without them the orphaned group_members /
  // group_exams rows would keep granting exam access via this group.
  await db.prepare("DELETE FROM group_members WHERE group_id = ?").bind(groupId).run();
  await db.prepare("DELETE FROM group_exams WHERE group_id = ?").bind(groupId).run();
  await db
    .prepare("DELETE FROM teacher_groups WHERE id = ? AND teacher_id = ?")
    .bind(groupId, teacherId)
    .run();
  // Activity feed: group deleted (label = name it had).
  await appendAuditLog(db, teacherId, "group_deleted", groupId, {
    target_label: doomed?.name ?? "",
  });
  return true;
}

/** Old RPC: my_group_roster. Owner only; pending requests first. */
export async function getGroupRoster(
  db: D1Database,
  teacherId: string,
  role: string,
  groupId: string,
): Promise<RosterRow[]> {
  assertTeacher(role);
  await assertOwner(db, groupId, teacherId);
  const { results } = await db
    .prepare(
      "SELECT gm.student_id, COALESCE(p.full_name, '') AS full_name, gm.status, gm.requested_at " +
        "FROM group_members gm LEFT JOIN profiles p ON p.id = gm.student_id " +
        "WHERE gm.group_id = ? " +
        "ORDER BY (gm.status = 'pending') DESC, gm.requested_at DESC",
    )
    .bind(groupId)
    .all<RosterDbRow>();
  return (results ?? []).map((r) => ({
    studentId: r.student_id,
    fullName: r.full_name ?? "",
    status: r.status,
    requestedAt: r.requested_at,
  }));
}

/**
 * Old RPC: my_groups. A student sees a group ONLY with an APPROVED
 * membership row for their own id — the check is in the WHERE clause.
 */
export async function listStudentGroups(
  db: D1Database,
  studentId: string,
): Promise<StudentGroup[]> {
  const { results } = await db
    .prepare(
      "SELECT g.id AS group_id, g.name AS group_name, g.school_year, " +
        "g.days, g.time_text, g.teacher_id, " +
        "COALESCE(NULLIF(TRIM(p.full_name), ''), '') AS teacher_name " +
        "FROM group_members gm " +
        "JOIN teacher_groups g ON g.id = gm.group_id " +
        "LEFT JOIN profiles p ON p.id = g.teacher_id " +
        "WHERE gm.student_id = ? AND gm.status = 'approved' " +
        "ORDER BY g.created_at DESC",
    )
    .bind(studentId)
    .all<StudentGroupRow>();
  return (results ?? []).map((r) => ({
    groupId: r.group_id,
    groupName: r.group_name,
    schoolYear: r.school_year,
    days: parseDays(r.days),
    timeText: r.time_text,
    teacherId: r.teacher_id,
    teacherName: r.teacher_name ?? "",
  }));
}

/** Old RPC: my_pending_group_requests. The caller's own pending rows only. */
export async function listPendingGroupRequests(
  db: D1Database,
  studentId: string,
): Promise<PendingGroupRequest[]> {
  const { results } = await db
    .prepare(
      "SELECT g.id AS group_id, g.name AS group_name, g.teacher_id, " +
        "COALESCE(NULLIF(TRIM(p.full_name), ''), '') AS teacher_name, gm.requested_at " +
        "FROM group_members gm " +
        "JOIN teacher_groups g ON g.id = gm.group_id " +
        "LEFT JOIN profiles p ON p.id = g.teacher_id " +
        "WHERE gm.student_id = ? AND gm.status = 'pending' " +
        "ORDER BY gm.requested_at DESC",
    )
    .bind(studentId)
    .all<PendingGroupRow>();
  return (results ?? []).map((r) => ({
    groupId: r.group_id,
    groupName: r.group_name,
    teacherId: r.teacher_id,
    teacherName: r.teacher_name ?? "",
    requestedAt: r.requested_at,
  }));
}

/**
 * Old RPC: join_group. Students only, with a name on file; the code
 * is matched case-insensitively (UPPER(TRIM(code))). A rejected
 * request may be re-sent; an approved membership is left untouched.
 * Deliberately NO assignment rows here: a pending student sees and
 * can take nothing — assignments appear on approval only.
 */
export async function joinGroup(
  db: D1Database,
  studentId: string,
  role: string,
  code: string,
): Promise<string> {
  if (normalizeGroupRole(role) !== "student") throw new GroupError("only_students");
  const profile = await db
    .prepare("SELECT full_name FROM profiles WHERE id = ?")
    .bind(studentId)
    .first<{ full_name: string | null }>();
  if (!profile || (profile.full_name ?? "").trim() === "") {
    throw new GroupError("name_required");
  }
  const group = await db
    .prepare("SELECT id, teacher_id, name FROM teacher_groups WHERE join_code = UPPER(TRIM(?))")
    .bind(code)
    .first<{ id: string; teacher_id: string; name: string }>();
  if (!group) throw new GroupError("invalid_code");
  const teacherRole = await db
    .prepare("SELECT role FROM user_roles WHERE user_id = ?")
    .bind(group.teacher_id)
    .first<{ role: string }>();
  if (!teacherRole || !isTeacherRole(teacherRole.role)) throw new GroupError("invalid_code");
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE teacher_students SET status = 'pending', requested_at = ?, decided_at = NULL " +
        "WHERE teacher_id = ? AND student_id = ? AND status = 'rejected'",
    )
    .bind(now, group.teacher_id, studentId)
    .run();
  await db
    .prepare(
      "INSERT INTO teacher_students (teacher_id, student_id, status, requested_at) " +
        "VALUES (?, ?, 'pending', ?) ON CONFLICT(teacher_id, student_id) DO NOTHING",
    )
    .bind(group.teacher_id, studentId, now)
    .run();
  await db
    .prepare(
      "UPDATE group_members SET status = 'pending', requested_at = ?, decided_at = NULL " +
        "WHERE group_id = ? AND student_id = ? AND status = 'rejected'",
    )
    .bind(now, group.id, studentId)
    .run();
  await db
    .prepare(
      "INSERT INTO group_members (group_id, student_id, status, requested_at) " +
        "VALUES (?, ?, 'pending', ?) ON CONFLICT(group_id, student_id) DO NOTHING",
    )
    .bind(group.id, studentId, now)
    .run();
  // Activity feed: student join request (actor = student, target = group).
  await appendAuditLog(db, studentId, "group_join_requested", group.id, {
    target_label: group.name,
  });
  return group.id;
}

async function assignOpenExamsToStudent(
  db: D1Database,
  teacherId: string,
  studentId: string,
  nowIso: string,
): Promise<void> {
  // The teacher's open published auto_all exams (same rule as the old RPC).
  const { results: autoAll } = await db
    .prepare(
      "SELECT id FROM assessments WHERE teacher_id = ? AND status = 'published' " +
        "AND audience_mode = 'auto_all' AND (due_at IS NULL OR due_at > ?)",
    )
    .bind(teacherId, nowIso)
    .all<{ id: string }>();
  for (const a of autoAll ?? []) {
    await db
      .prepare(
        "INSERT INTO assessment_assignments (assessment_id, student_id) " +
          "VALUES (?, ?) ON CONFLICT(assessment_id, student_id) DO NOTHING",
      )
      .bind(a.id, studentId)
      .run();
  }
}

async function assignGroupExamsToStudent(
  db: D1Database,
  groupId: string,
  studentId: string,
): Promise<void> {
  // This group's PUBLISHED linked exams only — never drafts, never
  // another group's exams.
  const { results: linked } = await db
    .prepare(
      "SELECT ge.assessment_id FROM group_exams ge JOIN assessments a ON a.id = ge.assessment_id " +
        "WHERE ge.group_id = ? AND a.status = 'published'",
    )
    .bind(groupId)
    .all<{ assessment_id: string }>();
  for (const l of linked ?? []) {
    await db
      .prepare(
        "INSERT INTO assessment_assignments (assessment_id, student_id) " +
          "VALUES (?, ?) ON CONFLICT(assessment_id, student_id) DO NOTHING",
      )
      .bind(l.assessment_id, studentId)
      .run();
  }
}

async function approveTeacherLink(
  db: D1Database,
  teacherId: string,
  studentId: string,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE teacher_students SET status = 'approved', decided_at = ? " +
        "WHERE teacher_id = ? AND student_id = ? AND status = 'pending'",
    )
    .bind(nowIso, teacherId, studentId)
    .run();
  await db
    .prepare(
      "INSERT INTO teacher_students (teacher_id, student_id, status, requested_at) " +
        "VALUES (?, ?, 'approved', ?) ON CONFLICT(teacher_id, student_id) DO NOTHING",
    )
    .bind(teacherId, studentId, nowIso)
    .run();
}

/**
 * Old RPC: decide_group_membership (20261104090000 body, incl. the
 * group-exam assignment on approval). Owner only; the student may
 * not be the teacher. Approving a REJECTED request re-opens it;
 * deciding anything else raises no_pending_request.
 */
export async function decideGroupMembership(
  db: D1Database,
  teacherId: string,
  role: string,
  groupId: string,
  studentId: string,
  approve: boolean,
  nowIso: string = new Date().toISOString(),
): Promise<string> {
  assertTeacher(role);
  await assertOwner(db, groupId, teacherId);
  if (!studentId || studentId === teacherId) throw new GroupError("invalid_student");
  const member = await db
    .prepare("SELECT status FROM group_members WHERE group_id = ? AND student_id = ?")
    .bind(groupId, studentId)
    .first<{ status: string }>();
  if (!member || (member.status !== "pending" && !(approve && member.status === "rejected"))) {
    throw new GroupError("no_pending_request");
  }
  const decided = approve ? "approved" : "rejected";
  await db
    .prepare(
      "UPDATE group_members SET status = ?, decided_at = ? WHERE group_id = ? AND student_id = ?",
    )
    .bind(decided, nowIso, groupId, studentId)
    .run();
  if (approve) {
    await approveTeacherLink(db, teacherId, studentId, nowIso);
    await assignOpenExamsToStudent(db, teacherId, studentId, nowIso);
    await assignGroupExamsToStudent(db, groupId, studentId);
  } else {
    // A rejection ends a still-pending teacher link ONLY when the
    // student has no approved group left with this teacher.
    const hasApproved = await db
      .prepare(
        "SELECT 1 AS one FROM group_members gm JOIN teacher_groups g ON g.id = gm.group_id " +
          "WHERE g.teacher_id = ? AND gm.student_id = ? AND gm.status = 'approved' LIMIT 1",
      )
      .bind(teacherId, studentId)
      .first<{ one: number }>();
    const linkPending = await db
      .prepare(
        "SELECT 1 AS one FROM teacher_students " +
          "WHERE teacher_id = ? AND student_id = ? AND status = 'pending'",
      )
      .bind(teacherId, studentId)
      .first<{ one: number }>();
    if (linkPending && !hasApproved) {
      await db
        .prepare(
          "UPDATE teacher_students SET status = 'rejected', decided_at = ? " +
            "WHERE teacher_id = ? AND student_id = ? AND status = 'pending'",
        )
        .bind(nowIso, teacherId, studentId)
        .run();
    }
  }
  await db
    .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
    .bind(
      teacherId,
      "group_membership_decision",
      studentId,
      JSON.stringify({ decision: decided, group_id: groupId }),
    )
    .run();
  return decided;
}

/**
 * Old RPC: approve_all_group_members (20261104090000 body).
 * Returns the number of pending members approved (0 when none).
 */
export async function approveAllGroupMembers(
  db: D1Database,
  teacherId: string,
  role: string,
  groupId: string,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  assertTeacher(role);
  await assertOwner(db, groupId, teacherId);
  const { results: pending } = await db
    .prepare("SELECT student_id FROM group_members WHERE group_id = ? AND status = 'pending'")
    .bind(groupId)
    .all<{ student_id: string }>();
  const students = (pending ?? []).map((r) => r.student_id);
  if (students.length === 0) return 0;
  await db
    .prepare(
      "UPDATE group_members SET status = 'approved', decided_at = ? WHERE group_id = ? AND status = 'pending'",
    )
    .bind(nowIso, groupId)
    .run();
  for (const studentId of students) {
    await approveTeacherLink(db, teacherId, studentId, nowIso);
    await assignOpenExamsToStudent(db, teacherId, studentId, nowIso);
    await assignGroupExamsToStudent(db, groupId, studentId);
  }
  await db
    .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
    .bind(
      teacherId,
      "group_membership_approve_all",
      null,
      JSON.stringify({ approved: students.length, group_id: groupId }),
    )
    .run();
  return students.length;
}

// ------------------------------------------------------- server functions ---

type Ctx = { session: AuthSession; db: D1Database };

function teacherCtx(context: unknown): { teacherId: string; role: string; db: D1Database } {
  const { session, db } = context as Ctx;
  assertTeacher(session.role);
  return { teacherId: session.userId, role: session.role, db };
}

export const getTeacherGroupsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }): Promise<TeacherGroup[]> => {
    const { teacherId, role, db } = teacherCtx(context);
    return listTeacherGroups(db, teacherId, role);
  });

export const getGroupRosterD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { groupId: string })
  .handler(async ({ context, data }): Promise<RosterRow[]> => {
    const { teacherId, role, db } = teacherCtx(context);
    return getGroupRoster(db, teacherId, role, data.groupId);
  });

export const createTeacherGroupD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as GroupInput)
  .handler(async ({ context, data }): Promise<{ groupId: string }> => {
    const { teacherId, role, db } = teacherCtx(context);
    return { groupId: await createTeacherGroup(db, teacherId, role, data) };
  });

export const updateTeacherGroupD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as GroupInput & { groupId: string })
  .handler(async ({ context, data }): Promise<{ ok: boolean }> => {
    const { teacherId, role, db } = teacherCtx(context);
    await updateTeacherGroup(db, teacherId, role, data.groupId, data);
    return { ok: true };
  });

export const deleteTeacherGroupD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { groupId: string })
  .handler(async ({ context, data }): Promise<{ ok: boolean }> => {
    const { teacherId, role, db } = teacherCtx(context);
    await deleteTeacherGroup(db, teacherId, role, data.groupId);
    return { ok: true };
  });

export const getStudentGroupsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }): Promise<StudentGroup[]> => {
    const { session, db } = context as Ctx;
    // Mirrors the Phase 1 PoC: teachers use getTeacherGroupsD1;
    // this list is the student's approved groups only.
    if (normalizeGroupRole(session.role) !== "student") return [];
    return listStudentGroups(db, session.userId);
  });

export const getPendingGroupRequestsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }): Promise<PendingGroupRequest[]> => {
    const { session, db } = context as Ctx;
    if (normalizeGroupRole(session.role) !== "student") return [];
    return listPendingGroupRequests(db, session.userId);
  });

export const joinGroupD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { code: string })
  .handler(async ({ context, data }): Promise<{ groupId: string }> => {
    const { session, db } = context as Ctx;
    return { groupId: await joinGroup(db, session.userId, session.role, data.code) };
  });

export const decideGroupMembershipD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { groupId: string; studentId: string; approve: boolean })
  .handler(async ({ context, data }): Promise<{ decision: string }> => {
    const { teacherId, role, db } = teacherCtx(context);
    return {
      decision: await decideGroupMembership(
        db,
        teacherId,
        role,
        data.groupId,
        data.studentId,
        data.approve,
      ),
    };
  });

export const approveAllGroupMembersD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { groupId: string })
  .handler(async ({ context, data }): Promise<{ count: number }> => {
    const { teacherId, role, db } = teacherCtx(context);
    return { count: await approveAllGroupMembers(db, teacherId, role, data.groupId) };
  });
