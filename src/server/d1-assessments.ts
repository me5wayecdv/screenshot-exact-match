/**
 * D1 server functions for assessments: list, builder (create/edit/
 * publish/questions/assignments), and the dashboard homes.
 *
 * SECURITY — every function here follows session -> role -> ownership
 * -> query, because D1 has no RLS:
 * - Teacher paths select only rows where assessments.teacher_id (or the
 *   owning join) equals the session user. A non-owner teacher gets
 *   NOT_FOUND, never another teacher's row.
 * - Student paths (getStudentHome) select only the caller's own
 *   assignments, submissions, enrollments, profile rows, and
 *   handwritten grades linked to the caller by student_id. Drafts
 *   are never returned to students: the student assessment list is
 *   restricted to status IN ('published', 'closed') — the old
 *   `assigned_published` RLS rule — AND the group rule: when an exam
 *   has any group_exams link, the student must be an APPROVED member
 *   of at least one linked group (an assignment row alone is not
 *   sufficient).
 * - No server function accepts a teacher id, student id, or actor id
 *   from the client. The wrappers below pass ONLY session.userId.
 * - Student-facing queries NEVER touch question_keys. Keys are
 *   selected only by getBuilderData / getGradingDetail-equivalents
 *   after an ownership check (see d1-grading.ts).
 *
 * PUBLISH RULE (preserved from the Supabase set_assessment_status +
 * src/lib/audience.ts): publishing with no audience selection
 * auto-assigns ALL currently approved linked students
 * (audience_mode 'auto_all'); a strict subset stays exactly that
 * subset ('explicit', never widened). Publishing is blocked when the
 * teacher has no approved linked students at all.
 *
 * KNOWN V1 GROUP-EXAM EDGE (preserved as-is, not fixed here): the
 * publish widening above looks only at teacher_students, NOT at
 * group_exams links. Linking a draft to a group with ZERO approved
 * members and then publishing with no selection still auto-assigns
 * every approved linked student — the group link does not restrict
 * publish. The take gate (d1-take-gate.ts) separately blocks
 * non-members at take time, so the edge is a publish-audience
 * widening, not a take-time leak.
 *
 * DASHBOARD NOTE: the dashboard server functions live here (there is
 * no separate dashboard server file in this batch) because
 * teacher_dashboard_summary / tutor_dashboard_summary /
 * tutor_lesson_enrollment_counts are assessment-dashboard RPCs, and
 * the student home is an assessment list. join_teacher, enroll_lesson
 * and the own-name update are the dashboard's own forms, so they
 * live here too; the approval side (decide_enrollment) belongs to
 * the students workstream and is NOT implemented here.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import { appendAuditLog } from "@/server/d1-admin";
import { listStudentHandwrittenGrades, type StudentHwGrade } from "@/server/d1-handwritten";
import { missingAssignments, modeFromCoverage, type AudienceMode } from "@/lib/audience";
import type { AuthSession } from "@/lib/cloudflare-auth";

export type AssessmentStatus = "draft" | "published" | "closed" | "archived";
export type QuestionType = "mcq" | "true_false" | "short_answer" | "written";

export type AssessmentListRow = {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  created_at: string;
  subjectName: string | null;
};

export type SubjectRow = { id: string; name: string };

export type BuilderQuestion = {
  id: string;
  assessment_id: string;
  prompt: string;
  type: QuestionType;
  options: string[];
  difficulty: string;
  marks: number;
  position: number;
  objective: string;
  key: {
    correct_answer: string;
    accepted_alternatives: string[];
    rubric: string;
    explanation: string;
  } | null;
};

export type RosterStudent = {
  student_id: string;
  full_name: string;
  status: string;
  requested_at: string | null;
};

export type BuilderAssessment = {
  id: string;
  teacher_id: string;
  subject_id: string | null;
  title: string;
  grade_level: string;
  instructions: string;
  status: AssessmentStatus;
  audience_mode: string;
  duration_minutes: number | null;
  max_attempts: number;
  starts_at: string | null;
  due_at: string | null;
  auto_whatsapp_send: number;
  created_at: string;
};

export type BuilderData = {
  assessment: BuilderAssessment;
  questions: BuilderQuestion[];
  subjects: SubjectRow[];
  students: RosterStudent[];
  assignedIds: string[];
  submissionCount: number;
};

export type BankQuestion = {
  id: string;
  prompt: string;
  type: string;
  marks: number;
  objective: string;
  difficulty: string;
  options: string[];
  assessment_id: string;
  assessmentTitle: string;
};

type AssessmentRow = {
  id: string;
  teacher_id: string;
  subject_id: string | null;
  title: string;
  grade_level: string;
  instructions: string;
  status: AssessmentStatus;
  audience_mode: string;
  duration_minutes: number | null;
  max_attempts: number;
  starts_at: string | null;
  due_at: string | null;
  auto_whatsapp_send: number;
  created_at: string;
};

type QuestionRow = {
  id: string;
  assessment_id: string;
  prompt: string;
  type: string;
  options: string;
  difficulty: string;
  marks: number;
  position: number;
  objective: string;
  correct_answer: string | null;
  accepted_alternatives: string | null;
  rubric: string | null;
  explanation: string | null;
};

export function notFound(): Error {
  return new Error("NOT_FOUND");
}

/** Legacy 'teacher' role maps to school_teacher on read (frozen rule). */
export function effectiveRole(session: AuthSession): AuthSession["role"] {
  return session.role === ("teacher" as string) ? "school_teacher" : session.role;
}

function requireRoleNormalized(session: AuthSession, allowed: AuthSession["role"][]): void {
  if (!allowed.includes(effectiveRole(session))) throw new Error("FORBIDDEN");
}

function requireTeacher(session: AuthSession): void {
  const role = effectiveRole(session);
  if (role !== "school_teacher" && role !== "tutor") {
    throw new Error("FORBIDDEN");
  }
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toBuilderQuestion(row: QuestionRow): BuilderQuestion {
  return {
    id: row.id,
    assessment_id: row.assessment_id,
    prompt: row.prompt,
    type: row.type as QuestionType,
    options: parseJsonArray(row.options),
    difficulty: row.difficulty,
    marks: row.marks,
    position: row.position,
    objective: row.objective,
    key:
      row.correct_answer === null &&
      row.accepted_alternatives === null &&
      row.rubric === null &&
      row.explanation === null
        ? null
        : {
            correct_answer: row.correct_answer ?? "",
            accepted_alternatives: parseJsonArray(row.accepted_alternatives),
            rubric: row.rubric ?? "",
            explanation: row.explanation ?? "",
          },
  };
}

async function ownAssessment(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
): Promise<AssessmentRow> {
  const row = await db
    .prepare("SELECT * FROM assessments WHERE id = ? AND teacher_id = ?")
    .bind(assessmentId, teacherId)
    .first<AssessmentRow>();
  if (!row) throw notFound();
  return row;
}

async function approvedLinkedIds(db: D1Database, teacherId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT student_id FROM teacher_students " +
        "WHERE teacher_id = ? AND status = 'approved' ORDER BY requested_at DESC",
    )
    .bind(teacherId)
    .all<{ student_id: string }>();
  return (results ?? []).map((r) => r.student_id);
}

async function assignedIdsFor(db: D1Database, assessmentId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT student_id FROM assessment_assignments WHERE assessment_id = ?")
    .bind(assessmentId)
    .all<{ student_id: string }>();
  return (results ?? []).map((r) => r.student_id);
}

async function assignmentCount(db: D1Database, assessmentId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM assessment_assignments WHERE assessment_id = ?")
    .bind(assessmentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ list */

export async function listTeacherAssessments(
  db: D1Database,
  teacherId: string,
  page: number,
  pageSize = 20,
): Promise<{ rows: AssessmentListRow[]; hasNext: boolean }> {
  const offset = Math.max(0, page) * pageSize;
  const { results } = await db
    .prepare(
      "SELECT a.id, a.title, a.status, a.due_at, a.created_at, s.name AS subject_name " +
        "FROM assessments a LEFT JOIN subjects s ON s.id = a.subject_id AND s.teacher_id = ? " +
        "WHERE a.teacher_id = ? ORDER BY a.created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(teacherId, teacherId, pageSize + 1, offset)
    .all<{
      id: string;
      title: string;
      status: string;
      due_at: string | null;
      created_at: string;
      subject_name: string | null;
    }>();
  const all = results ?? [];
  return {
    rows: all.slice(0, pageSize).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      due_at: r.due_at,
      created_at: r.created_at,
      subjectName: r.subject_name,
    })),
    hasNext: all.length > pageSize,
  };
}

export async function createAssessment(
  db: D1Database,
  teacherId: string,
  title: string,
): Promise<{ id: string }> {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 200) throw new Error("INVALID_TITLE");
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO assessments (id, teacher_id, title) VALUES (?, ?, ?)")
    .bind(id, teacherId, trimmed)
    .run();
  // Activity feed: exam created (label = exam title).
  await appendAuditLog(db, teacherId, "exam_created", id, { target_label: trimmed });
  return { id };
}

/* --------------------------------------------------------------- builder */

export async function getBuilderData(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
): Promise<BuilderData> {
  const assessment = await ownAssessment(db, teacherId, assessmentId);
  const [questionsRes, subjectsRes, rosterRes, assigned, countRow] = await Promise.all([
    db
      .prepare(
        "SELECT q.*, k.correct_answer, k.accepted_alternatives, k.rubric, k.explanation " +
          "FROM questions q LEFT JOIN question_keys k ON k.question_id = q.id " +
          "WHERE q.assessment_id = ? ORDER BY q.position",
      )
      .bind(assessmentId)
      .all<QuestionRow>(),
    db
      .prepare("SELECT id, name FROM subjects WHERE teacher_id = ? ORDER BY name")
      .bind(teacherId)
      .all<SubjectRow>(),
    db
      .prepare(
        "SELECT ts.student_id, COALESCE(p.full_name, '') AS full_name, ts.status, ts.requested_at " +
          "FROM teacher_students ts LEFT JOIN profiles p ON p.id = ts.student_id " +
          "WHERE ts.teacher_id = ? ORDER BY ts.requested_at DESC",
      )
      .bind(teacherId)
      .all<RosterStudent>(),
    assignedIdsFor(db, assessmentId),
    db
      .prepare("SELECT COUNT(*) AS n FROM submissions WHERE assessment_id = ?")
      .bind(assessmentId)
      .first<{ n: number }>(),
  ]);
  return {
    assessment: {
      id: assessment.id,
      teacher_id: assessment.teacher_id,
      subject_id: assessment.subject_id,
      title: assessment.title,
      grade_level: assessment.grade_level,
      instructions: assessment.instructions,
      status: assessment.status as AssessmentStatus,
      audience_mode: assessment.audience_mode,
      duration_minutes: assessment.duration_minutes,
      max_attempts: assessment.max_attempts,
      starts_at: assessment.starts_at,
      due_at: assessment.due_at,
      auto_whatsapp_send: assessment.auto_whatsapp_send,
      created_at: assessment.created_at,
    },
    questions: (questionsRes.results ?? []).map(toBuilderQuestion),
    subjects: subjectsRes.results ?? [],
    // The builder UI shows approved students only; pending requests are
    // not an audience. The full roster stays in the students workstream.
    students: (rosterRes.results ?? []).filter((r) => r.status === "approved"),
    assignedIds: assigned,
    submissionCount: countRow?.n ?? 0,
  };
}

export type AssessmentMetaInput = {
  title: string;
  instructions: string;
  gradeLevel: string;
  subjectId: string | null;
  newSubjectName: string | null;
  dueAt: string | null;
  startsAt: string | null;
  durationMinutes: number | null;
  maxAttempts: number;
};

export async function updateAssessmentMeta(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
  input: AssessmentMetaInput,
): Promise<void> {
  await ownAssessment(db, teacherId, assessmentId);
  let subjectId = input.subjectId;
  if (input.newSubjectName && input.newSubjectName.trim()) {
    const name = input.newSubjectName.trim().slice(0, 80);
    const subjectRowId = crypto.randomUUID();
    await db
      .prepare("INSERT INTO subjects (id, name, teacher_id) VALUES (?, ?, ?)")
      .bind(subjectRowId, name, teacherId)
      .run();
    subjectId = subjectRowId;
  } else if (subjectId) {
    // A teacher may only attach their own subjects.
    const subject = await db
      .prepare("SELECT id FROM subjects WHERE id = ? AND teacher_id = ?")
      .bind(subjectId, teacherId)
      .first<{ id: string }>();
    if (!subject) throw notFound();
  }
  const title = input.title.trim();
  if (!title || title.length > 200) throw new Error("INVALID_TITLE");
  await db
    .prepare(
      "UPDATE assessments SET title = ?, instructions = ?, grade_level = ?, subject_id = ?, " +
        "due_at = ?, starts_at = ?, duration_minutes = ?, max_attempts = ?, updated_at = ? " +
        "WHERE id = ? AND teacher_id = ?",
    )
    .bind(
      title,
      input.instructions,
      input.gradeLevel,
      subjectId,
      input.dueAt,
      input.startsAt,
      input.durationMinutes,
      Math.max(1, input.maxAttempts || 1),
      new Date().toISOString(),
      assessmentId,
      teacherId,
    )
    .run();
}

const TRANSITIONS: Record<string, string[]> = {
  draft: ["published"],
  published: ["closed", "draft"],
  closed: ["published", "archived"],
  archived: ["closed"],
};

export async function setAssessmentStatus(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
  status: AssessmentStatus,
): Promise<{ reach: number; mode: AudienceMode | null }> {
  const current = await ownAssessment(db, teacherId, assessmentId);
  const allowed = TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(status)) throw new Error("INVALID_TRANSITION");
  if (status === "draft") {
    const subs = await db
      .prepare("SELECT COUNT(*) AS n FROM submissions WHERE assessment_id = ?")
      .bind(assessmentId)
      .first<{ n: number }>();
    if ((subs?.n ?? 0) > 0) throw new Error("HAS_SUBMISSIONS");
  }
  let mode: AudienceMode | null = null;
  if (status === "published") {
    const { results } = await db
      .prepare(
        "SELECT q.id, q.prompt, q.type, q.options, k.correct_answer, k.rubric " +
          "FROM questions q LEFT JOIN question_keys k ON k.question_id = q.id " +
          "WHERE q.assessment_id = ?",
      )
      .bind(assessmentId)
      .all<{
        id: string;
        prompt: string;
        type: string;
        options: string;
        correct_answer: string | null;
        rubric: string | null;
      }>();
    const questions = results ?? [];
    if (questions.length === 0) throw new Error("PUBLISH_NO_QUESTIONS");
    const incomplete = questions.some((q) => {
      if (!q.prompt.trim()) return true;
      if (q.type === "mcq") {
        if (parseJsonArray(q.options).length < 2) return true;
        if (!(q.correct_answer ?? "").trim()) return true;
      } else if (q.type === "true_false" || q.type === "short_answer") {
        if (!(q.correct_answer ?? "").trim()) return true;
      } else if (q.type === "written") {
        if (!(q.rubric ?? "").trim()) return true;
      }
      return false;
    });
    if (incomplete) throw new Error("PUBLISH_INCOMPLETE");
    const linked = await approvedLinkedIds(db, teacherId);
    if (linked.length === 0) throw new Error("PUBLISH_NO_STUDENTS");
    const assigned = await assignedIdsFor(db, assessmentId);
    mode = modeFromCoverage(linked, assigned);
    if (mode === "auto_all") {
      // GROUP-EXAM EDGE (see header): this widening ignores group_exams
      // links by design, exactly as the old RPC did.
      const missing = missingAssignments(linked, assigned);
      for (const studentId of missing) {
        await db
          .prepare(
            "INSERT OR IGNORE INTO assessment_assignments (assessment_id, student_id) VALUES (?, ?)",
          )
          .bind(assessmentId, studentId)
          .run();
      }
    }
  }
  await db
    .prepare(
      "UPDATE assessments SET status = ?, updated_at = ?, audience_mode = COALESCE(?, audience_mode) " +
        "WHERE id = ? AND teacher_id = ?",
    )
    .bind(status, new Date().toISOString(), mode, assessmentId, teacherId)
    .run();
  await db
    .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
    .bind(
      teacherId,
      "assessment_status",
      assessmentId,
      // Feed label = exam title; the feed renders a publish as "exam
      // published" when to === 'published', else a status change.
      JSON.stringify({
        from: current.status,
        to: status,
        audience: mode,
        target_label: current.title,
      }),
    )
    .run();
  const reach = await assignmentCount(db, assessmentId);
  return { reach, mode };
}

export async function setAudienceEveryone(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
): Promise<{ count: number }> {
  await ownAssessment(db, teacherId, assessmentId);
  const linked = await approvedLinkedIds(db, teacherId);
  const assigned = await assignedIdsFor(db, assessmentId);
  const missing = missingAssignments(linked, assigned);
  for (const studentId of missing) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO assessment_assignments (assessment_id, student_id) VALUES (?, ?)",
      )
      .bind(assessmentId, studentId)
      .run();
  }
  await db
    .prepare("UPDATE assessments SET audience_mode = 'auto_all' WHERE id = ? AND teacher_id = ?")
    .bind(assessmentId, teacherId)
    .run();
  return { count: linked.length };
}

export async function toggleAssignment(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
  studentId: string,
  on: boolean,
): Promise<void> {
  await ownAssessment(db, teacherId, assessmentId);
  // Only an approved linked student may be assigned at all.
  const link = await db
    .prepare(
      "SELECT 1 AS one FROM teacher_students " +
        "WHERE teacher_id = ? AND student_id = ? AND status = 'approved'",
    )
    .bind(teacherId, studentId)
    .first<{ one: number }>();
  if (!link) throw notFound();
  if (on) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO assessment_assignments (assessment_id, student_id) VALUES (?, ?)",
      )
      .bind(assessmentId, studentId)
      .run();
  } else {
    await db
      .prepare("DELETE FROM assessment_assignments WHERE assessment_id = ? AND student_id = ?")
      .bind(assessmentId, studentId)
      .run();
  }
  // Keep the audience marker honest with the boxes (same rule as the
  // builder UI: full coverage means "everyone" again).
  const linked = await approvedLinkedIds(db, teacherId);
  const assigned = await assignedIdsFor(db, assessmentId);
  const mode = modeFromCoverage(linked, assigned);
  await db
    .prepare("UPDATE assessments SET audience_mode = ? WHERE id = ? AND teacher_id = ?")
    .bind(mode, assessmentId, teacherId)
    .run();
}

/* -------------------------------------------------------------- questions */

export async function addQuestion(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
  type: QuestionType,
): Promise<{ id: string }> {
  await ownAssessment(db, teacherId, assessmentId);
  const countRow = await db
    .prepare("SELECT COUNT(*) AS n FROM questions WHERE assessment_id = ?")
    .bind(assessmentId)
    .first<{ n: number }>();
  const id = crypto.randomUUID();
  // D1 has no column defaults for prompt/marks, so explicit defaults:
  // prompt '' and marks 1. Publish completeness blocks publishing until
  // the teacher fills them, exactly as the old incomplete check did.
  await db
    .prepare(
      "INSERT INTO questions (id, assessment_id, prompt, type, options, difficulty, marks, position, objective) " +
        "VALUES (?, ?, '', ?, ?, 'medium', 1, ?, '')",
    )
    .bind(id, assessmentId, type, JSON.stringify(type === "mcq" ? ["", ""] : []), countRow?.n ?? 0)
    .run();
  await db
    .prepare("INSERT INTO question_keys (question_id, correct_answer) VALUES (?, ?)")
    .bind(id, type === "true_false" ? "true" : "")
    .run();
  return { id };
}

async function ownQuestion(
  db: D1Database,
  teacherId: string,
  questionId: string,
): Promise<{ id: string; assessment_id: string; position: number }> {
  const row = await db
    .prepare(
      "SELECT q.id, q.assessment_id, q.position FROM questions q " +
        "JOIN assessments a ON a.id = q.assessment_id " +
        "WHERE q.id = ? AND a.teacher_id = ?",
    )
    .bind(questionId, teacherId)
    .first<{ id: string; assessment_id: string; position: number }>();
  if (!row) throw notFound();
  return row;
}

export async function moveQuestion(
  db: D1Database,
  teacherId: string,
  questionId: string,
  dir: -1 | 1,
): Promise<void> {
  const current = await ownQuestion(db, teacherId, questionId);
  const { results } = await db
    .prepare("SELECT id, position FROM questions WHERE assessment_id = ? ORDER BY position")
    .bind(current.assessment_id)
    .all<{ id: string; position: number }>();
  const ordered = results ?? [];
  const idx = ordered.findIndex((q) => q.id === questionId);
  const other = ordered[idx + dir];
  if (idx < 0 || !other) return;
  await db
    .prepare("UPDATE questions SET position = ? WHERE id = ?")
    .bind(other.position, questionId)
    .run();
  await db
    .prepare("UPDATE questions SET position = ? WHERE id = ?")
    .bind(current.position, other.id)
    .run();
}

export async function deleteQuestion(
  db: D1Database,
  teacherId: string,
  questionId: string,
): Promise<void> {
  await ownQuestion(db, teacherId, questionId);
  await db.prepare("DELETE FROM question_keys WHERE question_id = ?").bind(questionId).run();
  await db.prepare("DELETE FROM questions WHERE id = ?").bind(questionId).run();
}

export type QuestionUpdateInput = {
  prompt: string;
  marks: number;
  objective: string;
  options: string[];
  difficulty: string;
  correctAnswer: string;
  acceptedAlternatives: string[];
  rubric: string;
  explanation: string;
  type: QuestionType;
};

export async function updateQuestion(
  db: D1Database,
  teacherId: string,
  questionId: string,
  input: QuestionUpdateInput,
): Promise<void> {
  const current = await ownQuestion(db, teacherId, questionId);
  void current;
  if (!(input.marks > 0)) throw new Error("INVALID_MARKS");
  const cleanOptions = input.options.map((o) => o.trim()).filter(Boolean);
  if (input.type === "mcq") {
    if (
      cleanOptions.length < 2 ||
      !input.correctAnswer.trim() ||
      !cleanOptions.includes(input.correctAnswer.trim())
    ) {
      throw new Error("INVALID_QUESTION");
    }
  }
  await db
    .prepare(
      "UPDATE questions SET prompt = ?, marks = ?, objective = ?, options = ?, difficulty = ? WHERE id = ?",
    )
    .bind(
      input.prompt.trim(),
      input.marks,
      input.objective.trim(),
      JSON.stringify(cleanOptions),
      input.difficulty,
      questionId,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO question_keys (question_id, correct_answer, accepted_alternatives, rubric, explanation) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(question_id) DO UPDATE SET correct_answer = excluded.correct_answer, " +
        "accepted_alternatives = excluded.accepted_alternatives, rubric = excluded.rubric, " +
        "explanation = excluded.explanation",
    )
    .bind(
      questionId,
      input.correctAnswer.trim(),
      JSON.stringify(input.acceptedAlternatives),
      input.rubric.trim(),
      input.explanation.trim(),
    )
    .run();
}

export async function listQuestionBank(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
): Promise<BankQuestion[]> {
  await ownAssessment(db, teacherId, assessmentId);
  const { results } = await db
    .prepare(
      "SELECT q.id, q.prompt, q.type, q.marks, q.objective, q.difficulty, q.options, " +
        "q.assessment_id, a.title AS assessment_title " +
        "FROM questions q JOIN assessments a ON a.id = q.assessment_id " +
        "WHERE a.teacher_id = ? AND q.assessment_id != ? " +
        "ORDER BY q.created_at DESC LIMIT 50",
    )
    .bind(teacherId, assessmentId)
    .all<{
      id: string;
      prompt: string;
      type: string;
      marks: number;
      objective: string;
      difficulty: string;
      options: string;
      assessment_id: string;
      assessment_title: string;
    }>();
  return (results ?? []).map((r) => ({
    id: r.id,
    prompt: r.prompt,
    type: r.type,
    marks: r.marks,
    objective: r.objective,
    difficulty: r.difficulty,
    options: parseJsonArray(r.options),
    assessment_id: r.assessment_id,
    assessmentTitle: r.assessment_title,
  }));
}

export async function copyBankQuestion(
  db: D1Database,
  teacherId: string,
  assessmentId: string,
  sourceQuestionId: string,
  position: number,
): Promise<{ id: string }> {
  await ownAssessment(db, teacherId, assessmentId);
  // The source must also be the teacher's own question.
  const source = await ownQuestion(db, teacherId, sourceQuestionId);
  void source;
  const row = await db
    .prepare("SELECT * FROM questions WHERE id = ?")
    .bind(sourceQuestionId)
    .first<{
      prompt: string;
      type: string;
      marks: number;
      objective: string;
      options: string;
      difficulty: string;
    }>();
  if (!row) throw notFound();
  const key = await db
    .prepare("SELECT * FROM question_keys WHERE question_id = ?")
    .bind(sourceQuestionId)
    .first<{
      correct_answer: string;
      accepted_alternatives: string;
      rubric: string;
      explanation: string;
    }>();
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO questions (id, assessment_id, prompt, type, options, difficulty, marks, position, objective) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      assessmentId,
      row.prompt,
      row.type,
      row.options,
      row.difficulty,
      row.marks,
      position,
      row.objective,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO question_keys (question_id, correct_answer, accepted_alternatives, rubric, explanation) " +
        "VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      key?.correct_answer ?? "",
      key?.accepted_alternatives ?? "[]",
      key?.rubric ?? "",
      key?.explanation ?? "",
    )
    .run();
  return { id };
}

/* ------------------------------------------------------------- dashboard */

export type TeacherDashboard = {
  assessments: { id: string; title: string; status: string; created_at: string }[];
  activeCount: number;
  pendingCount: number;
  releasedCount: number;
  studentCount: number;
};

export async function getTeacherDashboard(
  db: D1Database,
  teacherId: string,
): Promise<TeacherDashboard> {
  const [recent, active, pending, released, students] = await Promise.all([
    db
      .prepare(
        "SELECT id, title, status, created_at FROM assessments " +
          "WHERE teacher_id = ? ORDER BY created_at DESC LIMIT 6",
      )
      .bind(teacherId)
      .all<{ id: string; title: string; status: string; created_at: string }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM assessments WHERE teacher_id = ? AND status = 'published'",
      )
      .bind(teacherId)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM submissions s JOIN assessments a ON a.id = s.assessment_id " +
          "WHERE a.teacher_id = ? AND s.status IN ('awaiting_review', 'approved')",
      )
      .bind(teacherId)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM submissions s JOIN assessments a ON a.id = s.assessment_id " +
          "WHERE a.teacher_id = ? AND s.status = 'released'",
      )
      .bind(teacherId)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM teacher_students WHERE teacher_id = ? AND status = 'approved'",
      )
      .bind(teacherId)
      .first<{ n: number }>(),
  ]);
  return {
    assessments: recent.results ?? [],
    activeCount: active?.n ?? 0,
    pendingCount: pending?.n ?? 0,
    releasedCount: released?.n ?? 0,
    studentCount: students?.n ?? 0,
  };
}

export type TutorDashboard = {
  lessons: {
    id: string;
    title: string;
    description: string;
    join_code: string;
    created_at: string;
  }[];
  enrollments: { lesson_id: string; student_count: number }[];
  lessonCount: number;
  studentCount: number;
  publishedAssessmentCount: number;
};

export async function getTutorDashboard(db: D1Database, tutorId: string): Promise<TutorDashboard> {
  const lessonsRes = await db
    .prepare(
      "SELECT id, title, description, join_code, created_at FROM lessons " +
        "WHERE tutor_id = ? ORDER BY created_at DESC LIMIT 6",
    )
    .bind(tutorId)
    .all<{
      id: string;
      title: string;
      description: string;
      join_code: string;
      created_at: string;
    }>();
  const lessons = lessonsRes.results ?? [];
  let enrollments: { lesson_id: string; student_count: number }[] = [];
  if (lessons.length > 0) {
    const placeholders = lessons.map(() => "?").join(", ");
    const counts = await db
      .prepare(
        `SELECT l.id AS lesson_id, COUNT(e.student_id) AS student_count FROM lessons l ` +
          `LEFT JOIN lesson_enrollments e ON e.lesson_id = l.id ` +
          `WHERE l.tutor_id = ? AND l.id IN (${placeholders}) GROUP BY l.id`,
      )
      .bind(tutorId, ...lessons.map((l) => l.id))
      .all<{ lesson_id: string; student_count: number }>();
    enrollments = counts.results ?? [];
  }
  const [lessonCount, studentCount, published] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM lessons WHERE tutor_id = ?")
      .bind(tutorId)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(DISTINCT e.student_id) AS n FROM lessons l " +
          "JOIN lesson_enrollments e ON e.lesson_id = l.id WHERE l.tutor_id = ?",
      )
      .bind(tutorId)
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM assessments WHERE teacher_id = ? AND status = 'published'",
      )
      .bind(tutorId)
      .first<{ n: number }>(),
  ]);
  return {
    lessons,
    enrollments,
    lessonCount: lessonCount?.n ?? 0,
    studentCount: studentCount?.n ?? 0,
    publishedAssessmentCount: published?.n ?? 0,
  };
}

export async function getAdminDashboard(
  db: D1Database,
): Promise<{ teachers: number; students: number }> {
  const [teachers, students] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role IN ('school_teacher', 'tutor')")
      .first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role = 'student'")
      .first<{ n: number }>(),
  ]);
  return { teachers: teachers?.n ?? 0, students: students?.n ?? 0 };
}

export type StudentHomeAssessment = {
  id: string;
  title: string;
  instructions: string;
  due_at: string | null;
  starts_at: string | null;
  status: string;
};

export type StudentHome = {
  assessments: StudentHomeAssessment[];
  hasMoreAssessments: boolean;
  submissions: {
    id: string;
    assessment_id: string;
    status: string;
    final_score: number | null;
    total_possible: number | null;
  }[];
  lessons: { id: string; title: string; description: string; join_code: string | null }[];
  hasMoreLessons: boolean;
  parentContact: {
    full_name: string | null;
    parent_phone: string | null;
    whatsapp_consent: number;
  } | null;
  teacherLinks: number;
  myName: string;
  pendingRows: { teacher_id: string; teacher_name: string; requested_at: string }[];
  /** Handwritten grades linked to this student — final on save, no release step. */
  handwrittenGrades: StudentHwGrade[];
};

export async function getStudentHome(
  db: D1Database,
  studentId: string,
  assignmentPage: number,
  lessonPage: number,
  pageSize = 20,
): Promise<StudentHome> {
  const aOffset = Math.max(0, assignmentPage) * pageSize;
  const lOffset = Math.max(0, lessonPage) * pageSize;
  const [assessmentsRes, lessonsRes, profileRow, linksRow, pendingRes, handwrittenGrades] =
    await Promise.all([
      db
        .prepare(
          "SELECT a.id, a.title, a.instructions, a.due_at, a.starts_at, a.status " +
            "FROM assessment_assignments aa JOIN assessments a ON a.id = aa.assessment_id " +
            "WHERE aa.student_id = ? AND a.status IN ('published', 'closed') " +
            "AND (NOT EXISTS (SELECT 1 FROM group_exams ge WHERE ge.assessment_id = a.id) " +
            "OR EXISTS (SELECT 1 FROM group_exams ge JOIN group_members gm ON gm.group_id = ge.group_id " +
            "WHERE ge.assessment_id = a.id AND gm.student_id = ? AND gm.status = 'approved')) " +
            "ORDER BY a.created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(studentId, studentId, pageSize + 1, aOffset)
        .all<StudentHomeAssessment>(),
      db
        .prepare(
          "SELECT l.id, l.title, l.description, l.join_code FROM lesson_enrollments e " +
            "JOIN lessons l ON l.id = e.lesson_id WHERE e.student_id = ? " +
            "ORDER BY e.enrolled_at DESC LIMIT ? OFFSET ?",
        )
        .bind(studentId, pageSize + 1, lOffset)
        .all<{ id: string; title: string; description: string; join_code: string | null }>(),
      db
        .prepare("SELECT full_name, parent_phone, whatsapp_consent FROM profiles WHERE id = ?")
        .bind(studentId)
        .first<{
          full_name: string | null;
          parent_phone: string | null;
          whatsapp_consent: number;
        }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM teacher_students WHERE student_id = ? AND status = 'approved'",
        )
        .bind(studentId)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT ts.teacher_id, COALESCE(NULLIF(TRIM(p.full_name), ''), '') AS teacher_name, ts.requested_at " +
            "FROM teacher_students ts LEFT JOIN profiles p ON p.id = ts.teacher_id " +
            "WHERE ts.student_id = ? AND ts.status = 'pending' ORDER BY ts.requested_at DESC",
        )
        .bind(studentId)
        .all<{ teacher_id: string; teacher_name: string; requested_at: string }>(),
      listStudentHandwrittenGrades(db, studentId),
    ]);
  const assessmentPageRows = (assessmentsRes.results ?? []).slice(0, pageSize);
  const assessmentIds = assessmentPageRows.map((a) => a.id);
  let submissions: StudentHome["submissions"] = [];
  if (assessmentIds.length > 0) {
    const placeholders = assessmentIds.map(() => "?").join(", ");
    const subs = await db
      .prepare(
        `SELECT id, assessment_id, status, final_score, total_possible FROM submissions ` +
          `WHERE student_id = ? AND assessment_id IN (${placeholders})`,
      )
      .bind(studentId, ...assessmentIds)
      .all<StudentHome["submissions"][number]>();
    submissions = subs.results ?? [];
  }
  const lessonRows = lessonsRes.results ?? [];
  return {
    assessments: assessmentPageRows,
    hasMoreAssessments: (assessmentsRes.results ?? []).length > pageSize,
    submissions,
    lessons: lessonRows.slice(0, pageSize),
    hasMoreLessons: lessonRows.length > pageSize,
    parentContact: profileRow ?? null,
    teacherLinks: linksRow?.n ?? 0,
    myName: (profileRow?.full_name ?? "").trim(),
    pendingRows: pendingRes.results ?? [],
    handwrittenGrades,
  };
}

export async function joinTeacher(
  db: D1Database,
  studentId: string,
  code: string,
): Promise<{ teacherId: string }> {
  const nameRow = await db
    .prepare("SELECT full_name FROM profiles WHERE id = ?")
    .bind(studentId)
    .first<{ full_name: string | null }>();
  if (!(nameRow?.full_name ?? "").trim()) throw new Error("NAME_REQUIRED");
  const teacher = await db
    .prepare("SELECT id FROM profiles WHERE join_code = ?")
    .bind(code.trim().toUpperCase())
    .first<{ id: string }>();
  if (!teacher) throw new Error("INVALID_CODE");
  const roleRow = await db
    .prepare("SELECT role FROM user_roles WHERE user_id = ?")
    .bind(teacher.id)
    .first<{ role: string }>();
  if (!roleRow || !["school_teacher", "tutor", "teacher"].includes(roleRow.role)) {
    throw new Error("INVALID_CODE");
  }
  const now = new Date().toISOString();
  // Re-asking after a rejection re-opens the request; an approved link
  // is never downgraded by re-joining.
  await db
    .prepare(
      "UPDATE teacher_students SET status = 'pending', requested_at = ?, decided_at = NULL " +
        "WHERE teacher_id = ? AND student_id = ? AND status = 'rejected'",
    )
    .bind(now, teacher.id, studentId)
    .run();
  await db
    .prepare(
      "INSERT OR IGNORE INTO teacher_students (teacher_id, student_id, status, requested_at) " +
        "VALUES (?, ?, 'pending', ?)",
    )
    .bind(teacher.id, studentId, now)
    .run();
  // Deliberately NO assignment rows here: they appear on approval
  // (students workstream), which is what stops a pending student
  // from seeing anything.
  return { teacherId: teacher.id };
}

export async function enrollLesson(db: D1Database, studentId: string, code: string): Promise<void> {
  const lesson = await db
    .prepare("SELECT id FROM lessons WHERE join_code = ?")
    .bind(code.trim().toUpperCase())
    .first<{ id: string }>();
  if (!lesson) throw new Error("INVALID_CODE");
  await db
    .prepare(
      "INSERT OR IGNORE INTO lesson_enrollments (lesson_id, student_id, enrolled_at) VALUES (?, ?, ?)",
    )
    .bind(lesson.id, studentId, new Date().toISOString())
    .run();
}

export async function updateOwnName(
  db: D1Database,
  studentId: string,
  fullName: string,
): Promise<void> {
  const trimmed = fullName.trim();
  if (!trimmed || trimmed.length > 80) throw new Error("INVALID_NAME");
  await db.prepare("UPDATE profiles SET full_name = ? WHERE id = ?").bind(trimmed, studentId).run();
}

/* ------------------------------------------------------- server wrappers */

function ctx(context: unknown): { session: AuthSession; db: D1Database } {
  return context as { session: AuthSession; db: D1Database };
}

export const listTeacherAssessmentsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { page: number })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    return listTeacherAssessments(db, session.userId, data.page);
  });

export const createAssessmentD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { title: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    return createAssessment(db, session.userId, data.title);
  });

export const getBuilderDataD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    return getBuilderData(db, session.userId, data.assessmentId);
  });

export const updateAssessmentMetaD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string } & AssessmentMetaInput)
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    const { assessmentId, ...input } = data;
    await updateAssessmentMeta(db, session.userId, assessmentId, input);
    return { ok: true };
  });

export const setAssessmentStatusD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string; status: AssessmentStatus })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    return setAssessmentStatus(db, session.userId, data.assessmentId, data.status);
  });

export const setAudienceEveryoneD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    return setAudienceEveryone(db, session.userId, data.assessmentId);
  });

export const toggleAssignmentD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string; studentId: string; on: boolean })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    await toggleAssignment(db, session.userId, data.assessmentId, data.studentId, data.on);
    return { ok: true };
  });

export const addQuestionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string; type: QuestionType })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    return addQuestion(db, session.userId, data.assessmentId, data.type);
  });

export const moveQuestionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { questionId: string; dir: -1 | 1 })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    await moveQuestion(db, session.userId, data.questionId, data.dir);
    return { ok: true };
  });

export const deleteQuestionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { questionId: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    await deleteQuestion(db, session.userId, data.questionId);
    return { ok: true };
  });

export const updateQuestionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { questionId: string } & QuestionUpdateInput)
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    const { questionId, ...input } = data;
    await updateQuestion(db, session.userId, questionId, input);
    return { ok: true };
  });

export const listQuestionBankD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    return listQuestionBank(db, session.userId, data.assessmentId);
  });

export const copyBankQuestionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) => data as { assessmentId: string; sourceQuestionId: string; position: number },
  )
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireTeacher(session);
    return copyBankQuestion(
      db,
      session.userId,
      data.assessmentId,
      data.sourceQuestionId,
      data.position,
    );
  });

export const getTeacherDashboardD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => {
    const { session, db } = ctx(context);
    requireRoleNormalized(session, ["school_teacher"]);
    return getTeacherDashboard(db, session.userId);
  });

export const getTutorDashboardD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => {
    const { session, db } = ctx(context);
    requireRoleNormalized(session, ["tutor"]);
    return getTutorDashboard(db, session.userId);
  });

export const getAdminDashboardD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => {
    const { session, db } = ctx(context);
    requireRoleNormalized(session, ["admin"]);
    return getAdminDashboard(db);
  });

export const getStudentHomeD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assignmentPage: number; lessonPage: number })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireRoleNormalized(session, ["student"]);
    return getStudentHome(db, session.userId, data.assignmentPage, data.lessonPage);
  });

export const joinTeacherD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { code: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireRoleNormalized(session, ["student"]);
    return joinTeacher(db, session.userId, data.code);
  });

export const enrollLessonD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { code: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireRoleNormalized(session, ["student"]);
    await enrollLesson(db, session.userId, data.code);
    return { ok: true };
  });

export const updateOwnNameD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { fullName: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireRoleNormalized(session, ["student"]);
    await updateOwnName(db, session.userId, data.fullName);
    return { ok: true };
  });
