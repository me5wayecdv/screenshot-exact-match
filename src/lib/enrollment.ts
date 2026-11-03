/**
 * Enrollment approval, as pure decisions.
 *
 * A join code proves a student has the code; it does not prove the teacher
 * knows them. So a link starts `pending` and only the teacher's decision makes
 * it `approved`. These helpers exist so that rule is stated once, testable
 * without a database, and shared by the roster UI, the publish audience and
 * the student's home screen.
 */

export type EnrollmentStatus = "pending" | "approved" | "rejected";

export type EnrollmentRow = {
  student_id: string;
  full_name: string;
  status: string;
  requested_at?: string | null;
  joined_at?: string | null;
};

export type EnrollmentSplit<T extends EnrollmentRow = EnrollmentRow> = {
  /** Waiting for a decision, newest request first. */
  pending: T[];
  /** Linked for real: in the roster, in the audience, gradeable. */
  approved: T[];
  /** Turned down, kept visible so the teacher can change their mind. */
  rejected: T[];
};

function norm(status: string): EnrollmentStatus {
  return status === "approved" || status === "rejected" ? status : "pending";
}

export function splitRoster<T extends EnrollmentRow>(
  rows: T[] | null | undefined,
): EnrollmentSplit<T> {
  const out: EnrollmentSplit<T> = { pending: [], approved: [], rejected: [] };
  for (const row of rows ?? []) out[norm(row.status)].push(row);
  return out;
}

/** Students who may see published work: approved only. */
export function approvedIds(rows: EnrollmentRow[] | null | undefined): string[] {
  return splitRoster(rows).approved.map((r) => r.student_id);
}

export function pendingCount(rows: EnrollmentRow[] | null | undefined): number {
  return splitRoster(rows).pending.length;
}

/**
 * A name a teacher can actually recognise. Falls back to a neutral label so a
 * nameless request is never silently dropped from the list — it just cannot be
 * joined without a name, which is enforced by the database.
 */
export function displayName(row: { full_name?: string | null }): string {
  const name = (row.full_name ?? "").trim();
  return name.length > 0 ? name : "—";
}

/** The student's own view of a pending request. */
export type PendingEnrollment = {
  teacher_id: string;
  teacher_name: string;
  requested_at: string;
};

export function pendingTeacherNames(rows: PendingEnrollment[] | null | undefined): string[] {
  return (rows ?? []).map((r) => (r.teacher_name ?? "").trim()).filter((name) => name.length > 0);
}

/** One sentence for the student: how many teachers are still deciding. */
export function waitingOn(rows: PendingEnrollment[] | null | undefined): number {
  return (rows ?? []).length;
}
