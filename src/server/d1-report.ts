/**
 * D1 report + WhatsApp-contact + integrity-read server functions
 * (Phase 2b port of the report route and its components).
 *
 * Security rules (never drop one to make a page pass):
 * - Report reads are owner-only: every query joins or filters on
 *   assessments.teacher_id = caller. A non-owner gets NOT_FOUND
 *   (never a distinguishable "forbidden" for a missing assessment),
 *   so existence is never leaked to a non-owner.
 * - question_keys is NEVER selected here. The per-question breakdown
 *   uses answers (effective score = final_score ?? auto_score) only.
 * - Integrity reads are owner-only too: the submission's assessment
 *   must belong to the caller. The panel is supplementary and never
 *   blocks grading/report on a read failure (the component renders
 *   nothing on error, same as before).
 * - Parent contact writes: the caller must be the student themself
 *   OR an approved linked teacher (teacher_students status =
 *   'approved') — the D1 equivalent of the old RLS policies. The
 *   phone is re-validated server-side (Egyptian mobile, E.164).
 * - Auto-send toggle: owner-only UPDATE (teacher_id = caller in the
 *   WHERE clause); 0 rows changed means not the owner.
 * - WhatsApp SENDING STAYS OFF in the pilot: this module contains no
 *   WhatsApp API call and no phone-number handling for sending.
 *   getWhatsAppConfiguredD1 returns configured: false, and
 *   sendWhatsAppReportD1 returns a skipped result without claiming
 *   or sending anything. The claim/audit bookkeeping in
 *   d1-whatsapp.ts stays ready for when sending is switched on.
 *   The audit rows read here (whatsapp_sends) are history only.
 * - Integrity flush (student take path): the caller must be a
 *   student and the submission must be their own (student_id =
 *   caller). Event types are allow-listed; anything else is dropped
 *   as INVALID_INPUT, never stored.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { isValidEgyptianMobile, normalizePhoneInput } from "@/lib/whatsapp";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export class ReportError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ReportError";
  }
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

function requireTeacher(caller: Caller): void {
  const role = normalizeRole(caller.role);
  if (role !== "school_teacher" && role !== "tutor" && role !== "admin") {
    throw new ReportError("FORBIDDEN", "Report pages are teacher-only.");
  }
}

/** The assessment, or null when it does not exist OR is not the caller's (admins exempt). */
async function loadOwnedAssessment(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
): Promise<{
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  teacher_id: string;
} | null> {
  const row = await db
    .prepare("SELECT id, title, status, due_at, teacher_id FROM assessments WHERE id = ?")
    .bind(assessmentId)
    .first<{
      id: string;
      title: string;
      status: string;
      due_at: string | null;
      teacher_id: string;
    }>();
  if (!row) return null;
  if (normalizeRole(caller.role) !== "admin" && row.teacher_id !== caller.id) return null;
  return row;
}

export type ReportSubmissionRow = {
  id: string;
  student_id: string;
  status: string;
  final_score: number | null;
  total_possible: number | null;
  attempt_number: number;
};

export type AssessmentReport = {
  assessment: {
    id: string;
    title: string;
    status: string;
    due_at: string | null;
    teacher_id: string;
  };
  assignments: { student_id: string }[];
  submissions: ReportSubmissionRow[];
  names: Record<string, string>;
};

/**
 * Report stats: assessments / assessment_assignments / submissions,
 * plus student names for the submitting students. Latest-attempt
 * selection stays in the client (latestSubmittedPerStudent), same as
 * before — this function returns every attempt.
 */
export async function getAssessmentReport(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
): Promise<AssessmentReport> {
  requireTeacher(caller);
  const assessment = await loadOwnedAssessment(db, caller, assessmentId);
  if (!assessment) throw new ReportError("NOT_FOUND", "Assessment not found.");
  const [assignmentsRes, submissionsRes] = await Promise.all([
    db
      .prepare("SELECT student_id FROM assessment_assignments WHERE assessment_id = ?")
      .bind(assessmentId)
      .all<{ student_id: string }>(),
    db
      .prepare(
        "SELECT id, student_id, status, final_score, total_possible, attempt_number " +
          "FROM submissions WHERE assessment_id = ?",
      )
      .bind(assessmentId)
      .all<ReportSubmissionRow>(),
  ]);
  const submissions = submissionsRes.results ?? [];
  const studentIds = [...new Set(submissions.map((s) => s.student_id))];
  const names: Record<string, string> = {};
  if (studentIds.length > 0) {
    // One query per name would be N+1; D1 has no array binding, so
    // fetch via a single IN list built from already-validated ids
    // (ids come from the caller's own submissions, never raw input).
    const placeholders = studentIds.map(() => "?").join(",");
    const profiles = await db
      .prepare(`SELECT id, full_name FROM profiles WHERE id IN (${placeholders})`)
      .bind(...studentIds)
      .all<{ id: string; full_name: string | null }>();
    for (const p of profiles.results ?? []) names[p.id] = p.full_name || "—";
  }
  return {
    assessment,
    assignments: assignmentsRes.results ?? [],
    submissions,
    names,
  };
}

export type ReportQuestionRow = {
  id: string;
  position: number;
  type: string;
  prompt: string;
  marks: number;
  objective: string;
  options: string[];
  difficulty: string;
};

export type ReportAnswerRow = {
  question_id: string;
  auto_score: number | null;
  final_score: number | null;
};

export type ReportQuestionsData = {
  questions: ReportQuestionRow[];
  answers: ReportAnswerRow[];
  /** Submissions for the assessment (drives the empty state, same as before). */
  submissionCount: number;
};

/** Per-question breakdown + LMS question export, owner-only, no keys. */
export async function listReportQuestions(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
): Promise<ReportQuestionsData> {
  requireTeacher(caller);
  const assessment = await loadOwnedAssessment(db, caller, assessmentId);
  if (!assessment) throw new ReportError("NOT_FOUND", "Assessment not found.");
  const submissions = await db
    .prepare("SELECT id FROM submissions WHERE assessment_id = ?")
    .bind(assessmentId)
    .all<{ id: string }>();
  const submissionIds = (submissions.results ?? []).map((s) => s.id);
  const questionsRes = await db
    .prepare(
      "SELECT id, position, type, prompt, marks, objective, options, difficulty " +
        "FROM questions WHERE assessment_id = ? ORDER BY position",
    )
    .bind(assessmentId)
    .all<{
      id: string;
      position: number;
      type: string;
      prompt: string;
      marks: number;
      objective: string | null;
      options: string | null;
      difficulty: string | null;
    }>();
  let answers: ReportAnswerRow[] = [];
  if (submissionIds.length > 0) {
    const placeholders = submissionIds.map(() => "?").join(",");
    const answersRes = await db
      .prepare(
        `SELECT question_id, auto_score, final_score FROM answers WHERE submission_id IN (${placeholders})`,
      )
      .bind(...submissionIds)
      .all<ReportAnswerRow>();
    answers = answersRes.results ?? [];
  }
  const questions: ReportQuestionRow[] = (questionsRes.results ?? []).map((q) => {
    let options: string[] = [];
    try {
      const parsed = q.options ? JSON.parse(q.options) : [];
      options = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      options = [];
    }
    return {
      id: q.id,
      position: q.position,
      type: q.type,
      prompt: q.prompt,
      marks: Number(q.marks) || 0,
      objective: q.objective ?? "",
      options,
      difficulty: q.difficulty ?? "medium",
    };
  });
  return { questions, answers, submissionCount: submissionIds.length };
}

export type IntegritySummaryData = {
  tabSwitches: number;
  windowBlurs: number;
  totalTimeSeconds: number;
  perQuestion: { question_id: string; seconds: number }[];
  hasData: boolean;
};

/** Per-submission integrity summary, owner-only. Never blocks on error upstream. */
export async function getIntegritySummary(
  db: D1Database,
  caller: Caller,
  submissionId: string,
  assessmentId?: string,
): Promise<IntegritySummaryData> {
  requireTeacher(caller);
  const sub = await db
    .prepare(
      "SELECT s.assessment_id AS assessment_id, a.teacher_id AS teacher_id " +
        "FROM submissions s JOIN assessments a ON a.id = s.assessment_id WHERE s.id = ?",
    )
    .bind(submissionId)
    .first<{ assessment_id: string; teacher_id: string }>();
  if (!sub) throw new ReportError("NOT_FOUND", "Submission not found.");
  if (normalizeRole(caller.role) !== "admin" && sub.teacher_id !== caller.id) {
    throw new ReportError("FORBIDDEN", "Submission belongs to another teacher.");
  }
  if (assessmentId && assessmentId !== sub.assessment_id) {
    throw new ReportError("NOT_FOUND", "Submission not found.");
  }
  const [eventsRes, answersRes, questionsRes] = await Promise.all([
    db
      .prepare(
        "SELECT event_type, question_id, created_at FROM integrity_events " +
          "WHERE submission_id = ? ORDER BY created_at",
      )
      .bind(submissionId)
      .all<{ event_type: string; question_id: string | null; created_at: string }>(),
    db
      .prepare("SELECT question_id, time_spent_seconds FROM answers WHERE submission_id = ?")
      .bind(submissionId)
      .all<{ question_id: string; time_spent_seconds: number | null }>(),
    assessmentId
      ? db
          .prepare("SELECT id FROM questions WHERE assessment_id = ? ORDER BY position")
          .bind(assessmentId)
          .all<{ id: string }>()
      : Promise.resolve({ results: [] as { id: string }[] }),
  ]);
  const events = eventsRes.results ?? [];
  const tabSwitches = events.filter((e) => e.event_type === "tab_hidden").length;
  const windowBlurs = events.filter((e) => e.event_type === "window_blur").length;
  const questionIds = (questionsRes.results ?? []).map((q) => q.id);
  const positionOf = new Map(questionIds.map((id, i) => [id, i]));
  const perQuestion = (answersRes.results ?? [])
    .map((a) => ({
      question_id: a.question_id,
      seconds: Math.max(0, Number(a.time_spent_seconds ?? 0)),
    }))
    .sort(
      (x, y) => (positionOf.get(x.question_id) ?? 9999) - (positionOf.get(y.question_id) ?? 9999),
    );
  const totalTimeSeconds = perQuestion.reduce((s, p) => s + p.seconds, 0);
  return {
    tabSwitches,
    windowBlurs,
    totalTimeSeconds,
    perQuestion,
    hasData: events.length > 0 || totalTimeSeconds > 0,
  };
}

export type ParentContact = {
  parent_phone: string | null;
  whatsapp_consent: boolean;
};

/** Parent contact for one student: self, or an approved linked teacher. */
export async function getParentContact(
  db: D1Database,
  caller: Caller,
  studentId: string,
): Promise<ParentContact> {
  if (caller.id !== studentId) {
    const role = normalizeRole(caller.role);
    if (role !== "school_teacher" && role !== "tutor" && role !== "admin") {
      throw new ReportError("FORBIDDEN", "Only the student or a linked teacher may read this.");
    }
    if (role !== "admin") {
      const link = await db
        .prepare("SELECT status FROM teacher_students WHERE teacher_id = ? AND student_id = ?")
        .bind(caller.id, studentId)
        .first<{ status: string }>();
      if (!link || link.status !== "approved") {
        throw new ReportError("FORBIDDEN", "Student is not linked to the caller.");
      }
    }
  }
  const profile = await db
    .prepare("SELECT parent_phone, whatsapp_consent FROM profiles WHERE id = ?")
    .bind(studentId)
    .first<{ parent_phone: string | null; whatsapp_consent: number | null }>();
  if (!profile) throw new ReportError("NOT_FOUND", "Student not found.");
  return {
    parent_phone: profile.parent_phone,
    whatsapp_consent: profile.whatsapp_consent === 1,
  };
}

/** Save parent phone + WhatsApp consent: self, or an approved linked teacher. */
export async function updateParentContact(
  db: D1Database,
  caller: Caller,
  studentId: string,
  phone: string,
  consent: boolean,
): Promise<void> {
  const cleaned = normalizePhoneInput(phone);
  if (cleaned === "" || !isValidEgyptianMobile(cleaned)) {
    throw new ReportError("INVALID_INPUT", "Parent phone must be a valid Egyptian mobile.");
  }
  // Reuses the same authorization as the read: self or approved link.
  await getParentContact(db, caller, studentId);
  const changes = await db
    .prepare("UPDATE profiles SET parent_phone = ?, whatsapp_consent = ? WHERE id = ?")
    .bind(cleaned, consent ? 1 : 0, studentId)
    .run();
  const changed = (changes as unknown as { meta?: { changes?: number } }).meta?.changes ?? 1;
  if (changed === 0) throw new ReportError("NOT_FOUND", "Student not found.");
}

/** Per-assessment auto-send toggle, owner-only. */
export async function setAutoWhatsAppSend(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
  on: boolean,
): Promise<void> {
  requireTeacher(caller);
  const assessment = await loadOwnedAssessment(db, caller, assessmentId);
  if (!assessment) throw new ReportError("NOT_FOUND", "Assessment not found.");
  await db
    .prepare("UPDATE assessments SET auto_whatsapp_send = ? WHERE id = ? AND teacher_id = ?")
    .bind(on ? 1 : 0, assessmentId, assessment.teacher_id)
    .run();
}

export type WhatsAppSendAuditRow = {
  id: string;
  submission_id: string;
  sent_at: string | null;
  status: string;
  trigger: string;
  message_id: string | null;
  error: string | null;
};

/** Latest whatsapp_sends audit row for one submission, owner-only. */
export async function listWhatsAppSends(
  db: D1Database,
  caller: Caller,
  submissionId: string,
): Promise<WhatsAppSendAuditRow[]> {
  requireTeacher(caller);
  const sub = await db
    .prepare(
      "SELECT a.teacher_id AS teacher_id FROM submissions s " +
        "JOIN assessments a ON a.id = s.assessment_id WHERE s.id = ?",
    )
    .bind(submissionId)
    .first<{ teacher_id: string }>();
  if (!sub) throw new ReportError("NOT_FOUND", "Submission not found.");
  if (normalizeRole(caller.role) !== "admin" && sub.teacher_id !== caller.id) {
    throw new ReportError("FORBIDDEN", "Submission belongs to another teacher.");
  }
  const res = await db
    .prepare(
      "SELECT id, submission_id, sent_at, status, trigger, message_id, error " +
        "FROM whatsapp_sends WHERE submission_id = ? ORDER BY sent_at DESC LIMIT 1",
    )
    .bind(submissionId)
    .all<WhatsAppSendAuditRow>();
  return res.results ?? [];
}

/** Student names for the report's WhatsApp rows: approved linked students only. */
export async function listWhatsAppStudentNames(
  db: D1Database,
  caller: Caller,
  studentIds: string[],
): Promise<Record<string, string>> {
  requireTeacher(caller);
  if (studentIds.length === 0) return {};
  const unique = [...new Set(studentIds)];
  const placeholders = unique.map(() => "?").join(",");
  const links = await db
    .prepare(
      `SELECT student_id FROM teacher_students WHERE teacher_id = ? AND status = 'approved' AND student_id IN (${placeholders})`,
    )
    .bind(caller.id, ...unique)
    .all<{ student_id: string }>();
  const allowed = new Set((links.results ?? []).map((r) => r.student_id));
  if (normalizeRole(caller.role) === "admin") {
    for (const id of unique) allowed.add(id);
  }
  const visible = unique.filter((id) => allowed.has(id));
  if (visible.length === 0) return {};
  const ph = visible.map(() => "?").join(",");
  const profiles = await db
    .prepare(`SELECT id, full_name FROM profiles WHERE id IN (${ph})`)
    .bind(...visible)
    .all<{ id: string; full_name: string | null }>();
  return Object.fromEntries((profiles.results ?? []).map((p) => [p.id, p.full_name || "—"]));
}

export type BufferedIntegrityEventInput = {
  event_type: string;
  question_id: string | null;
  created_at: string;
};

const INTEGRITY_EVENT_TYPES = new Set(["tab_hidden", "tab_visible", "window_blur", "window_focus"]);

/**
 * Buffered-flush path for the take page: insert the student's buffered
 * integrity events for their OWN submission. Throws (so the caller can
 * warn non-fatally) when the submission is not the caller's.
 */
export async function recordIntegrityEvents(
  db: D1Database,
  caller: Caller,
  submissionId: string,
  events: BufferedIntegrityEventInput[],
): Promise<void> {
  if (normalizeRole(caller.role) !== "student") {
    throw new ReportError("FORBIDDEN", "Integrity events are student-only.");
  }
  const sub = await db
    .prepare("SELECT student_id FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<{ student_id: string }>();
  if (!sub) throw new ReportError("NOT_FOUND", "Submission not found.");
  if (sub.student_id !== caller.id) {
    throw new ReportError("FORBIDDEN", "Submission belongs to another student.");
  }
  const valid = events.filter(
    (e) =>
      INTEGRITY_EVENT_TYPES.has(e.event_type) &&
      (e.question_id === null || typeof e.question_id === "string") &&
      typeof e.created_at === "string" &&
      e.created_at.length > 0,
  );
  if (valid.length === 0) return;
  if (db.batch) {
    await db.batch(
      valid.map((e) =>
        db
          .prepare(
            "INSERT INTO integrity_events (id, submission_id, event_type, question_id, created_at) " +
              "VALUES (?, ?, ?, ?, ?)",
          )
          .bind(crypto.randomUUID(), submissionId, e.event_type, e.question_id, e.created_at),
      ),
    );
  } else {
    for (const e of valid) {
      await db
        .prepare(
          "INSERT INTO integrity_events (id, submission_id, event_type, question_id, created_at) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), submissionId, e.event_type, e.question_id, e.created_at)
        .run();
    }
  }
}

// ---------------------------------------------------------------------------
// Server-function wrappers
// ---------------------------------------------------------------------------

export const getAssessmentReportD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ data, context }) =>
    getAssessmentReport(ctxDb(context), ctxCaller(context), data.assessmentId),
  );

export const listReportQuestionsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ data, context }) =>
    listReportQuestions(ctxDb(context), ctxCaller(context), data.assessmentId),
  );

export const getIntegritySummaryD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string; assessmentId?: string })
  .handler(async ({ data, context }) =>
    getIntegritySummary(ctxDb(context), ctxCaller(context), data.submissionId, data.assessmentId),
  );

export const getParentContactD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { studentId: string })
  .handler(async ({ data, context }) =>
    getParentContact(ctxDb(context), ctxCaller(context), data.studentId),
  );

export const updateParentContactD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { studentId: string; phone: string; consent: boolean })
  .handler(async ({ data, context }) =>
    updateParentContact(
      ctxDb(context),
      ctxCaller(context),
      data.studentId,
      data.phone,
      data.consent,
    ),
  );

export const setAutoWhatsAppSendD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string; on: boolean })
  .handler(async ({ data, context }) =>
    setAutoWhatsAppSend(ctxDb(context), ctxCaller(context), data.assessmentId, data.on),
  );

export const listWhatsAppSendsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string })
  .handler(async ({ data, context }) =>
    listWhatsAppSends(ctxDb(context), ctxCaller(context), data.submissionId),
  );

export const listWhatsAppStudentNamesD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { studentIds: string[] })
  .handler(async ({ data, context }) =>
    listWhatsAppStudentNames(ctxDb(context), ctxCaller(context), data.studentIds),
  );

/**
 * WhatsApp "configured" gate — sending stays OFF in the pilot, so this
 * is always false in the D1 copy, even if provider env vars exist.
 * The button therefore renders its "not connected" hint and never
 * reaches a send. Flip this only when sending is deliberately
 * switched on with a wired provider + claim flow.
 */
export const getWhatsAppConfiguredD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async (): Promise<{ configured: boolean }> => {
    return { configured: false };
  });

/**
 * Manual WhatsApp send — sending stays OFF in the pilot. This always
 * returns "skipped / not_configured" without claiming, auditing, or
 * contacting any provider, so a stale client can never send through
 * this path while the pilot switch is off.
 */
export const sendWhatsAppReportD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string; trigger: "manual" | "auto" })
  .handler(
    async (): Promise<{
      ok: boolean;
      status: "skipped";
      reason: "not_configured";
    }> => {
      return { ok: true, status: "skipped", reason: "not_configured" };
    },
  );

export const recordIntegrityEventsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) => data as { submissionId: string; events: BufferedIntegrityEventInput[] },
  )
  .handler(async ({ data, context }) =>
    recordIntegrityEvents(ctxDb(context), ctxCaller(context), data.submissionId, data.events),
  );
