/**
 * D1 smart tutor data (Phase 2 port of /tutor's data queries).
 *
 * NOTE ON PLACEMENT: the batch's enumerated server files had no home
 * for the student tutor page, so this is a new file (no existing
 * file touched).
 *
 * Hints-first, no answer keys, no other students' data:
 * - listTutorReleased: the caller's own released submissions only
 *   (student_id = caller, status = 'released').
 * - listTutorAssessments: assessments for those submissions only —
 *   the caller-supplied id list is intersected with the caller's
 *   own released submissions in SQL, so a forged assessment id
 *   yields nothing.
 * - getTutorDetail: for one assessment, the questions (prompt,
 *   options, objective — NEVER question_keys; this query does not
 *   mention that table) plus the caller's OWN answers for their
 *   own released submission for that assessment. Another student's
 *   submission id is refused: the submission must have
 *   student_id = caller and status = 'released', otherwise the
 *   detail is empty (NOT_FOUND for a foreign submission id passed
 *   explicitly, so a student cannot probe another student's work).
 * - Chat state stays in browser state and vanishes on leaving the
 *   page (unchanged); this module persists nothing about chats.
 *
 * NOT migrated here (owned by another workstream, left on its old
 * path): the AI tutor calls themselves (src/server/tutor.ts) still
 * validate a Supabase token. The tutor route's data queries are
 * migrated to the wrappers below; its AI calls keep passing the
 * legacy token until that file migrates.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export class TutorError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TutorError";
  }
}

function requireStudent(caller: Caller): void {
  if (normalizeRole(caller.role) !== "student") {
    throw new TutorError("FORBIDDEN");
  }
}

export type TutorReleased = {
  id: string;
  assessment_id: string;
  final_score: number | null;
  total_possible: number;
};

export async function listTutorReleased(db: D1Database, caller: Caller): Promise<TutorReleased[]> {
  requireStudent(caller);
  const { results } = await db
    .prepare(
      "SELECT id, assessment_id, final_score, total_possible FROM submissions " +
        "WHERE student_id = ? AND status = 'released' ORDER BY id DESC",
    )
    .bind(caller.id)
    .all<TutorReleased>();
  return results ?? [];
}

export type TutorAssessment = { id: string; title: string; subject_id: string | null };

export async function listTutorAssessments(
  db: D1Database,
  caller: Caller,
  assessmentIds: string[],
): Promise<TutorAssessment[]> {
  requireStudent(caller);
  if (assessmentIds.length === 0) return [];
  const placeholders = assessmentIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      "SELECT a.id, a.title, a.subject_id FROM assessments a " +
        "WHERE a.id IN (" +
        placeholders +
        ") AND EXISTS (SELECT 1 FROM submissions s WHERE s.assessment_id = a.id " +
        "AND s.student_id = ? AND s.status = 'released')",
    )
    .bind(...assessmentIds, caller.id)
    .all<TutorAssessment>();
  return results ?? [];
}

export type TutorQuestion = {
  id: string;
  position: number;
  type: string;
  prompt: string;
  marks: number;
  objective: string;
  options: string;
};

export type TutorAnswer = {
  question_id: string;
  response: string;
  final_score: number | null;
  auto_score: number | null;
  feedback: string;
};

export type TutorDetail = { questions: TutorQuestion[]; answers: TutorAnswer[] };

export async function getTutorDetail(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
  submissionId: string,
): Promise<TutorDetail> {
  requireStudent(caller);
  const sub = await db
    .prepare("SELECT assessment_id, student_id, status FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<{ assessment_id: string; student_id: string; status: string }>();
  if (!sub) throw new TutorError("NOT_FOUND");
  if (
    sub.student_id !== caller.id ||
    sub.status !== "released" ||
    sub.assessment_id !== assessmentId
  ) {
    throw new TutorError("FORBIDDEN");
  }
  const [questionsRes, answersRes] = await Promise.all([
    db
      .prepare(
        "SELECT id, position, type, prompt, marks, objective, options FROM questions " +
          "WHERE assessment_id = ? ORDER BY position",
      )
      .bind(assessmentId)
      .all<TutorQuestion>(),
    db
      .prepare(
        "SELECT question_id, response, final_score, auto_score, feedback FROM answers " +
          "WHERE submission_id = ?",
      )
      .bind(submissionId)
      .all<TutorAnswer>(),
  ]);
  return { questions: questionsRes.results ?? [], answers: answersRes.results ?? [] };
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

export const listTutorReleasedD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listTutorReleased(ctxDb(context), ctxCaller(context)));

export const listTutorAssessmentsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentIds: string[] })
  .handler(async ({ data, context }) =>
    listTutorAssessments(ctxDb(context), ctxCaller(context), data.assessmentIds),
  );

export const getTutorDetailD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string; submissionId: string })
  .handler(async ({ data, context }) =>
    getTutorDetail(ctxDb(context), ctxCaller(context), data.assessmentId, data.submissionId),
  );
