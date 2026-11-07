/**
 * D1 analytics (Phase 2 port of /analytics).
 *
 * NOTE ON PLACEMENT: the batch's enumerated server files had no home
 * for analytics, so this is a new file (no existing file touched).
 * It ports the four old teacher_analytics_* RPCs plus the
 * practice-draft creation the analytics page performs:
 * - All queries are scoped by assessments.teacher_id = caller in
 *   SQL. A teacher sees only their own assessments, their own
 *   students' released aggregates, and their own lessons' groups.
 * - Released-only: student/question/group stats count released
 *   submissions only, exactly as the old RPCs did. Draft and
 *   unreleased work never appears in a stat.
 * - question_keys are selected ONLY for the practice-draft copy,
 *   and only after the source assessment's owner check passes.
 *   The stats queries never touch question_keys.
 * - Practice drafts are created with status = 'draft' only, copying
 *   the teacher's own questions and their keys into the new draft.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export function isTeacherCaller(caller: Caller): boolean {
  const role = normalizeRole(caller.role);
  return role === "school_teacher" || role === "tutor";
}

export class AnalyticsError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AnalyticsError";
  }
}

function requireTeacher(caller: Caller): void {
  if (!isTeacherCaller(caller)) {
    throw new AnalyticsError("FORBIDDEN", "Analytics are teacher-only.");
  }
}

async function assertOwnsAssessment(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT teacher_id FROM assessments WHERE id = ?")
    .bind(assessmentId)
    .first<{ teacher_id: string }>();
  if (!row) throw new AnalyticsError("NOT_FOUND", "Assessment not found.");
  if (row.teacher_id !== caller.id) {
    throw new AnalyticsError("FORBIDDEN", "Assessment belongs to another teacher.");
  }
}

export type AnalyticsAssessment = {
  id: string;
  title: string;
  subject_id: string | null;
  grade_level: string;
  status: string;
  created_at: string;
};

export async function listAnalyticsAssessments(
  db: D1Database,
  caller: Caller,
  page: number,
  pageSize: number = 100,
): Promise<{ assessments: AnalyticsAssessment[]; hasNext: boolean }> {
  requireTeacher(caller);
  const safePage = Math.max(0, Math.floor(page) || 0);
  const { results } = await db
    .prepare(
      "SELECT id, title, subject_id, grade_level, status, created_at FROM assessments " +
        "WHERE teacher_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(caller.id, pageSize + 1, safePage * pageSize)
    .all<AnalyticsAssessment>();
  const rows = results ?? [];
  return { assessments: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

export type AnalyticsQuestion = {
  id: string;
  position: number;
  type: string;
  prompt: string;
  marks: number;
  objective: string;
  difficulty: string;
  options: string[];
};

export type QuestionStat = {
  questionId: string;
  answered: number;
  graded: number;
  avgPct: number | null;
  fullCreditPct: number | null;
};

export type StudentStat = {
  studentId: string;
  name: string;
  released: number;
  avgPct: number | null;
};

export type GroupStat = { groupId: string; name: string; students: number; avgPct: number | null };

export type AnalyticsDetail = {
  questions: AnalyticsQuestion[];
  questionStats: QuestionStat[];
  students: StudentStat[];
  hasMoreStudents: boolean;
  groups: GroupStat[];
  hasMoreGroups: boolean;
};

type QuestionAggRow = {
  question_id: string;
  answered: number;
  graded: number;
  pct_sum: number | null;
  full_count: number;
};

export async function getAnalyticsDetail(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
  studentPage: number,
  groupPage: number,
): Promise<AnalyticsDetail> {
  requireTeacher(caller);
  await assertOwnsAssessment(db, caller, assessmentId);
  const [questionsRes, aggRes, studentsRes, groupsRes] = await Promise.all([
    db
      .prepare(
        "SELECT q.id, q.position, q.type, q.prompt, q.marks, q.objective, q.difficulty, q.options " +
          "FROM questions q JOIN assessments own ON own.id = q.assessment_id " +
          "WHERE q.assessment_id = ? AND own.teacher_id = ? ORDER BY q.position LIMIT 200",
      )
      .bind(assessmentId, caller.id)
      .all<Omit<AnalyticsQuestion, "options"> & { options: string }>(),
    db
      .prepare(
        "SELECT q.id AS question_id, " +
          "SUM(CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END) AS answered, " +
          "SUM(CASE WHEN s.id IS NOT NULL AND COALESCE(a.final_score, a.auto_score) IS NOT NULL THEN 1 ELSE 0 END) AS graded, " +
          "SUM(CASE WHEN s.id IS NOT NULL AND COALESCE(a.final_score, a.auto_score) IS NOT NULL AND q.marks > 0 " +
          "THEN COALESCE(a.final_score, a.auto_score) / q.marks * 100 ELSE 0 END) AS pct_sum, " +
          "SUM(CASE WHEN s.id IS NOT NULL AND COALESCE(a.final_score, a.auto_score) >= q.marks THEN 1 ELSE 0 END) AS full_count " +
          "FROM questions q JOIN assessments own ON own.id = q.assessment_id AND own.teacher_id = ? " +
          "LEFT JOIN answers a ON a.question_id = q.id " +
          "LEFT JOIN submissions s ON s.id = a.submission_id AND s.assessment_id = q.assessment_id AND s.status = 'released' " +
          "WHERE q.assessment_id = ? GROUP BY q.id",
      )
      .bind(caller.id, assessmentId)
      .all<QuestionAggRow>(),
    db
      .prepare(
        "SELECT s.student_id AS student_id, p.full_name AS full_name, COUNT(*) AS released, " +
          "AVG(s.final_score / s.total_possible * 100) AS avg_pct " +
          "FROM submissions s JOIN assessments own ON own.id = s.assessment_id AND own.teacher_id = ? " +
          "JOIN profiles p ON p.id = s.student_id " +
          "WHERE s.assessment_id = ? AND s.status = 'released' " +
          "AND s.final_score IS NOT NULL AND s.total_possible > 0 " +
          "GROUP BY s.student_id, p.full_name ORDER BY p.full_name, s.student_id LIMIT 51 OFFSET ?",
      )
      .bind(caller.id, assessmentId, Math.max(0, studentPage) * 50)
      .all<{
        student_id: string;
        full_name: string | null;
        released: number;
        avg_pct: number | null;
      }>(),
    db
      .prepare(
        "SELECT l.id AS group_id, l.title AS name, COUNT(DISTINCT s.student_id) AS students, " +
          "AVG(s.final_score / s.total_possible * 100) AS avg_pct " +
          "FROM lessons l LEFT JOIN lesson_enrollments e ON e.lesson_id = l.id " +
          "LEFT JOIN submissions s ON s.assessment_id = ? AND s.student_id = e.student_id " +
          "AND s.status = 'released' AND s.final_score IS NOT NULL AND s.total_possible > 0 " +
          "WHERE l.tutor_id = ? AND EXISTS " +
          "(SELECT 1 FROM assessments a WHERE a.id = ? AND a.teacher_id = ?) " +
          "GROUP BY l.id ORDER BY l.created_at DESC, l.id DESC LIMIT 51 OFFSET ?",
      )
      .bind(assessmentId, caller.id, assessmentId, caller.id, Math.max(0, groupPage) * 50)
      .all<{ group_id: string; name: string; students: number; avg_pct: number | null }>(),
  ]);
  const questions: AnalyticsQuestion[] = (questionsRes.results ?? []).map((q) => {
    let options: string[] = [];
    try {
      const parsed: unknown = JSON.parse(q.options);
      if (Array.isArray(parsed)) options = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      options = [];
    }
    return { ...q, options };
  });
  const agg = new Map((aggRes.results ?? []).map((r) => [r.question_id, r]));
  const questionStats: QuestionStat[] = questions.map((q) => {
    const a = agg.get(q.id);
    const graded = a?.graded ?? 0;
    return {
      questionId: q.id,
      answered: a?.answered ?? 0,
      graded,
      avgPct: graded > 0 ? (a?.pct_sum ?? 0) / graded : null,
      fullCreditPct: graded > 0 ? (100 * (a?.full_count ?? 0)) / graded : null,
    };
  });
  const studentRows = studentsRes.results ?? [];
  const groupRows = groupsRes.results ?? [];
  return {
    questions,
    questionStats,
    students: studentRows.slice(0, 50).map((r) => ({
      studentId: r.student_id,
      name: r.full_name || "—",
      released: r.released,
      avgPct: r.avg_pct,
    })),
    hasMoreStudents: studentRows.length > 50,
    groups: groupRows.slice(0, 50).map((r) => ({
      groupId: r.group_id,
      name: r.name,
      students: r.students,
      avgPct: r.avg_pct,
    })),
    hasMoreGroups: groupRows.length > 50,
  };
}

export type OverviewRow = { assessment_id: string; released: number; avg_pct: number | null };

export async function getAnalyticsOverview(
  db: D1Database,
  caller: Caller,
  assessmentIds: string[],
): Promise<OverviewRow[]> {
  requireTeacher(caller);
  const ids = assessmentIds.slice(0, 100);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      "SELECT a.id AS assessment_id, " +
        "SUM(CASE WHEN s.status = 'released' AND s.final_score IS NOT NULL AND s.total_possible > 0 THEN 1 ELSE 0 END) AS released, " +
        "AVG(CASE WHEN s.status = 'released' AND s.final_score IS NOT NULL AND s.total_possible > 0 " +
        "THEN s.final_score / s.total_possible * 100 END) AS avg_pct " +
        "FROM assessments a LEFT JOIN submissions s ON s.assessment_id = a.id " +
        `WHERE a.teacher_id = ? AND a.id IN (${placeholders}) GROUP BY a.id`,
    )
    .bind(caller.id, ...ids)
    .all<OverviewRow>();
  return results ?? [];
}

export async function listAnalyticsStudentPage(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
  offset: number,
): Promise<StudentStat[]> {
  requireTeacher(caller);
  await assertOwnsAssessment(db, caller, assessmentId);
  const { results } = await db
    .prepare(
      "SELECT s.student_id AS student_id, p.full_name AS full_name, COUNT(*) AS released, " +
        "AVG(s.final_score / s.total_possible * 100) AS avg_pct " +
        "FROM submissions s JOIN assessments own ON own.id = s.assessment_id AND own.teacher_id = ? " +
        "JOIN profiles p ON p.id = s.student_id " +
        "WHERE s.assessment_id = ? AND s.status = 'released' " +
        "AND s.final_score IS NOT NULL AND s.total_possible > 0 " +
        "GROUP BY s.student_id, p.full_name ORDER BY p.full_name, s.student_id LIMIT 51 OFFSET ?",
    )
    .bind(caller.id, assessmentId, Math.max(0, offset))
    .all<{
      student_id: string;
      full_name: string | null;
      released: number;
      avg_pct: number | null;
    }>();
  return (results ?? []).map((r) => ({
    studentId: r.student_id,
    name: r.full_name || "—",
    released: r.released,
    avgPct: r.avg_pct,
  }));
}

export type PracticeQuestionInput = {
  id: string;
  type: string;
  prompt: string;
  marks: number;
  objective: string;
  options: string[];
  difficulty: string;
  key: {
    correct_answer: string;
    accepted_alternatives: string[];
    rubric: string;
    explanation: string;
  };
};

/**
 * Practice-draft source: the teacher's own questions for an
 * assessment, WITH their keys (teacher-only, owner-checked).
 */
export async function getPracticeSource(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
): Promise<PracticeQuestionInput[]> {
  requireTeacher(caller);
  await assertOwnsAssessment(db, caller, assessmentId);
  const { results } = await db
    .prepare(
      "SELECT q.id, q.type, q.prompt, q.marks, q.objective, q.options, q.difficulty, " +
        "k.correct_answer, k.accepted_alternatives, k.rubric, k.explanation " +
        "FROM questions q LEFT JOIN question_keys k ON k.question_id = q.id " +
        "WHERE q.assessment_id = ? ORDER BY q.position",
    )
    .bind(assessmentId)
    .all<{
      id: string;
      type: string;
      prompt: string;
      marks: number;
      objective: string;
      options: string;
      difficulty: string;
      correct_answer: string | null;
      accepted_alternatives: string | null;
      rubric: string | null;
      explanation: string | null;
    }>();
  return (results ?? []).map((r) => {
    let options: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.options);
      if (Array.isArray(parsed)) options = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      options = [];
    }
    let alternatives: string[] = [];
    try {
      const parsed: unknown = r.accepted_alternatives ? JSON.parse(r.accepted_alternatives) : [];
      if (Array.isArray(parsed)) {
        alternatives = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      alternatives = [];
    }
    return {
      id: r.id,
      type: r.type,
      prompt: r.prompt,
      marks: r.marks,
      objective: r.objective ?? "",
      options,
      difficulty: r.difficulty ?? "medium",
      key: {
        correct_answer: r.correct_answer ?? "",
        accepted_alternatives: alternatives,
        rubric: r.rubric ?? "",
        explanation: r.explanation ?? "",
      },
    };
  });
}

/** Create a practice DRAFT (never published) from copied questions. */
export async function createPracticeDraft(
  db: D1Database,
  caller: Caller,
  input: {
    title: string;
    subjectId: string | null;
    gradeLevel: string;
    questions: PracticeQuestionInput[];
  },
): Promise<{ id: string }> {
  requireTeacher(caller);
  if (input.questions.length === 0) {
    throw new AnalyticsError("INVALID_INPUT", "No questions to copy.");
  }
  const id = crypto.randomUUID();
  const stmts = [
    db
      .prepare(
        "INSERT INTO assessments " +
          "(id, teacher_id, subject_id, title, grade_level, instructions, status) " +
          "VALUES (?, ?, ?, ?, ?, '', 'draft')",
      )
      .bind(id, caller.id, input.subjectId, input.title, input.gradeLevel),
  ];
  input.questions.forEach((q, i) => {
    const questionId = crypto.randomUUID();
    stmts.push(
      db
        .prepare(
          "INSERT INTO questions " +
            "(id, assessment_id, type, position, prompt, marks, objective, options, difficulty) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          questionId,
          id,
          q.type,
          i,
          q.prompt,
          q.marks,
          q.objective,
          JSON.stringify(q.options ?? []),
          q.difficulty ?? "medium",
        ),
      db
        .prepare(
          "INSERT INTO question_keys (question_id, correct_answer, accepted_alternatives, rubric, explanation) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          questionId,
          q.key.correct_answer,
          JSON.stringify(q.key.accepted_alternatives ?? []),
          q.key.rubric,
          q.key.explanation,
        ),
    );
  });
  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();
  return { id };
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

export const listAnalyticsAssessmentsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { page: number })
  .handler(async ({ data, context }) =>
    listAnalyticsAssessments(ctxDb(context), ctxCaller(context), data.page),
  );

export const getAnalyticsDetailD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) => data as { assessmentId: string; studentPage: number; groupPage: number },
  )
  .handler(async ({ data, context }) =>
    getAnalyticsDetail(
      ctxDb(context),
      ctxCaller(context),
      data.assessmentId,
      data.studentPage,
      data.groupPage,
    ),
  );

export const getAnalyticsOverviewD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentIds: string[] })
  .handler(async ({ data, context }) =>
    getAnalyticsOverview(ctxDb(context), ctxCaller(context), data.assessmentIds),
  );

export const listAnalyticsStudentPageD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string; offset: number })
  .handler(async ({ data, context }) =>
    listAnalyticsStudentPage(ctxDb(context), ctxCaller(context), data.assessmentId, data.offset),
  );

export const getPracticeSourceD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ data, context }) =>
    getPracticeSource(ctxDb(context), ctxCaller(context), data.assessmentId),
  );

export const createPracticeDraftD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) =>
      data as {
        title: string;
        subjectId: string | null;
        gradeLevel: string;
        questions: PracticeQuestionInput[];
      },
  )
  .handler(async ({ data, context }) =>
    createPracticeDraft(ctxDb(context), ctxCaller(context), data),
  );
