/**
 * D1 server functions for grading + release (/grading).
 *
 * SECURITY — school_teacher ONLY (frozen pre-existing gate: tutors
 * are barred from /grading, even though the old page's client gate
 * also admitted tutors; the server now enforces school_teacher).
 * Every function below additionally checks ownership in SQL:
 * submissions are joined to assessments with
 * assessments.teacher_id = session user, so a non-owner teacher
 * gets NOT_FOUND for another teacher's assessment, submission,
 * question, or answer — never the row.
 *
 * RELEASE GATE (preserved verbatim): release is blocked until
 * EVERY question of the assessment has a teacher score
 * (final_score, within the question's marks). Auto scores alone
 * never release a submission: release requires the submission to
 * be in 'approved' status, which review_answer only reaches once
 * no valid answer lacks a final_score. The handwritten exception
 * (AI grade FINAL on save) lives in the handwritten workstream
 * (handwritten_grades table), NOT in this page, so it does not
 * weaken this gate.
 *
 * GRADE REVIEW REQUESTS stay teacher-visible only for their own
 * students — that page (reviews.tsx) is a separate workstream and
 * is not implemented here.
 *
 * Objective auto-grade mirrors the old score_objective rule:
 * exact trimmed match for mcq/true_false, normalised match
 * against the correct answer or an accepted alternative for
 * short answers, null for written questions. The teacher always
 * has the final word via final_score.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { effectiveRole, notFound } from "@/server/d1-assessments";
import { appendAuditLog } from "@/server/d1-admin";

export type GradingSubmission = {
  id: string;
  assessment_id: string;
  student_id: string;
  status: string;
  attempt_number: number;
  submitted_at: string | null;
  final_score: number | null;
  total_possible: number | null;
  assessmentTitle: string;
  studentName: string;
};

export type GradingQuestion = {
  id: string;
  prompt: string;
  type: string;
  marks: number;
  position: number;
  key: {
    correct_answer: string;
    accepted_alternatives: string[];
    rubric: string;
    explanation: string;
  } | null;
};

export type GradingAnswer = {
  id: string;
  question_id: string;
  response: string;
  max_marks: number;
  auto_score: number | null;
  final_score: number | null;
  feedback: string;
  review_status: string;
};

export type GradingDetail = {
  questions: GradingQuestion[];
  answers: GradingAnswer[];
};

type SubmissionRow = {
  id: string;
  assessment_id: string;
  student_id: string;
  status: string;
  attempt_number: number;
  submitted_at: string | null;
  final_score: number | null;
  total_possible: number | null;
  assessment_title: string;
  student_name: string;
};

type QuestionRow = {
  id: string;
  prompt: string;
  type: string;
  marks: number;
  position: number;
  correct_answer: string | null;
  accepted_alternatives: string | null;
  rubric: string | null;
  explanation: string | null;
};

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function requireSchoolTeacher(session: AuthSession): void {
  if (effectiveRole(session) !== "school_teacher") throw new Error("FORBIDDEN");
}

/** Deterministic objective auto-grade (old score_objective rule). */
export function autoScoreFor(
  question: { type: string; marks: number },
  key: GradingQuestion["key"],
  answerText: string,
): number | null {
  if (!key) return null;
  const marks = Number(question.marks);
  if (question.type === "mcq" || question.type === "true_false") {
    return (answerText ?? "").trim() === (key.correct_answer ?? "").trim() ? marks : 0;
  }
  if (question.type === "short_answer") {
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const norm = normalize(answerText ?? "");
    if (!norm) return 0;
    if (norm === normalize(key.correct_answer ?? "")) return marks;
    if (key.accepted_alternatives.some((a) => normalize(a) === norm)) return marks;
    return 0;
  }
  return null;
}

export async function listGradingPage(
  db: D1Database,
  teacherId: string,
  status: "awaiting_review" | "released",
  offset: number,
  limit: number,
): Promise<{ submissions: GradingSubmission[]; hasMore: boolean }> {
  const capped = Math.max(1, Math.min(limit, 51));
  const safeOffset = Math.max(0, offset);
  const statusSql =
    status === "awaiting_review"
      ? "s.status IN ('awaiting_review', 'approved')"
      : "s.status = 'released'";
  const { results } = await db
    .prepare(
      "SELECT s.id, s.assessment_id, s.student_id, s.status, s.attempt_number, s.submitted_at, " +
        "s.final_score, s.total_possible, a.title AS assessment_title, " +
        "COALESCE(p.full_name, '—') AS student_name " +
        "FROM submissions s JOIN assessments a ON a.id = s.assessment_id " +
        "LEFT JOIN profiles p ON p.id = s.student_id " +
        `WHERE a.teacher_id = ? AND ${statusSql} ` +
        "ORDER BY s.submitted_at DESC, s.id DESC LIMIT ? OFFSET ?",
    )
    .bind(teacherId, capped + 1, safeOffset)
    .all<SubmissionRow>();
  const all = results ?? [];
  return {
    submissions: all.slice(0, capped).map((r) => ({
      id: r.id,
      assessment_id: r.assessment_id,
      student_id: r.student_id,
      status: r.status,
      attempt_number: r.attempt_number,
      submitted_at: r.submitted_at,
      final_score: r.final_score,
      total_possible: r.total_possible,
      assessmentTitle: r.assessment_title,
      studentName: r.student_name,
    })),
    hasMore: all.length > capped,
  };
}

/** Ownership check: the submission must belong to the teacher's own assessment. */
async function ownSubmission(
  db: D1Database,
  teacherId: string,
  submissionId: string,
): Promise<{ id: string; assessment_id: string; status: string }> {
  const row = await db
    .prepare(
      "SELECT s.id, s.assessment_id, s.status FROM submissions s " +
        "JOIN assessments a ON a.id = s.assessment_id " +
        "WHERE s.id = ? AND a.teacher_id = ?",
    )
    .bind(submissionId, teacherId)
    .first<{ id: string; assessment_id: string; status: string }>();
  if (!row) throw notFound();
  return row;
}

export async function getGradingDetail(
  db: D1Database,
  teacherId: string,
  submissionId: string,
): Promise<GradingDetail> {
  const submission = await ownSubmission(db, teacherId, submissionId);
  const [questionsRes, answersRes] = await Promise.all([
    db
      .prepare(
        "SELECT q.id, q.prompt, q.type, q.marks, q.position, " +
          "k.correct_answer, k.accepted_alternatives, k.rubric, k.explanation " +
          "FROM questions q LEFT JOIN question_keys k ON k.question_id = q.id " +
          "WHERE q.assessment_id = ? ORDER BY q.position",
      )
      .bind(submission.assessment_id)
      .all<QuestionRow>(),
    db
      .prepare("SELECT * FROM answers WHERE submission_id = ?")
      .bind(submissionId)
      .all<GradingAnswer>(),
  ]);
  return {
    questions: (questionsRes.results ?? []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      type: q.type,
      marks: q.marks,
      position: q.position,
      key:
        q.correct_answer === null &&
        q.accepted_alternatives === null &&
        q.rubric === null &&
        q.explanation === null
          ? null
          : {
              correct_answer: q.correct_answer ?? "",
              accepted_alternatives: parseJsonArray(q.accepted_alternatives),
              rubric: q.rubric ?? "",
              explanation: q.explanation ?? "",
            },
    })),
    answers: answersRes.results ?? [],
  };
}

export async function setAutoScores(
  db: D1Database,
  teacherId: string,
  submissionId: string,
  scores: { answerId: string; score: number }[],
): Promise<void> {
  const submission = await ownSubmission(db, teacherId, submissionId);
  if (submission.status === "released") return;
  for (const { answerId, score } of scores) {
    const answer = await db
      .prepare("SELECT auto_score FROM answers WHERE id = ? AND submission_id = ?")
      .bind(answerId, submissionId)
      .first<{ auto_score: number | null }>();
    if (!answer || Number(answer.auto_score) === score) continue;
    await db
      .prepare("UPDATE answers SET auto_score = ? WHERE id = ? AND submission_id = ?")
      .bind(score, answerId, submissionId)
      .run();
  }
}

export async function reviewAnswer(
  db: D1Database,
  teacherId: string,
  answerId: string,
  score: number | null,
  feedback: string,
  decision: "approve" | "reject",
): Promise<void> {
  const answer = await db.prepare("SELECT * FROM answers WHERE id = ?").bind(answerId).first<{
    id: string;
    submission_id: string;
    question_id: string;
    final_score: number | null;
    ai_suggestion: string | null;
  }>();
  if (!answer) throw notFound();
  const submission = await ownSubmission(db, teacherId, answer.submission_id);
  if (submission.status !== "awaiting_review" && submission.status !== "approved") {
    throw new Error("NOT_READY_FOR_REVIEW");
  }
  if ((feedback ?? "").length > 5000) throw new Error("FEEDBACK_TOO_LONG");
  // Canonical marks come from the question, never the answer row.
  const question = await db
    .prepare("SELECT marks FROM questions WHERE id = ? AND assessment_id = ?")
    .bind(answer.question_id, submission.assessment_id)
    .first<{ marks: number }>();
  if (!question) throw notFound();
  if (decision === "approve" && (score === null || score < 0 || score > question.marks)) {
    throw new Error("SCORE_OUT_OF_RANGE");
  }
  await db
    .prepare(
      "UPDATE answers SET max_marks = ?, final_score = ?, feedback = ?, review_status = ? WHERE id = ?",
    )
    .bind(
      question.marks,
      decision === "approve" ? score : null,
      feedback ?? "",
      decision === "approve" ? "approved" : "rejected",
      answerId,
    )
    .run();
  // Recompute the submission status: approved only when no valid
  // answer (question in this assessment) still lacks a final score.
  const pending = await db
    .prepare(
      "SELECT 1 AS one FROM answers an JOIN questions q ON q.id = an.question_id " +
        "AND q.assessment_id = ? WHERE an.submission_id = ? AND an.final_score IS NULL LIMIT 1",
    )
    .bind(submission.assessment_id, submission.id)
    .first<{ one: number }>();
  await db
    .prepare("UPDATE submissions SET status = ? WHERE id = ?")
    .bind(pending ? "awaiting_review" : "approved", submission.id)
    .run();
  // Activity-feed labels: student name + exam title (never answer text).
  const graded = await db
    .prepare(
      "SELECT s.student_id, a.title FROM submissions s " +
        "JOIN assessments a ON a.id = s.assessment_id WHERE s.id = ?",
    )
    .bind(submission.id)
    .first<{ student_id: string; title: string }>();
  const gradedStudent = graded
    ? await db
        .prepare("SELECT full_name FROM profiles WHERE id = ?")
        .bind(graded.student_id)
        .first<{ full_name: string | null }>()
    : null;
  await appendAuditLog(db, teacherId, "review_answer", answerId, {
    decision,
    score,
    previous_final: answer.final_score,
    target_label: (gradedStudent?.full_name ?? "").trim(),
    exam_label: graded?.title ?? "",
  });
}

export async function releaseSubmission(
  db: D1Database,
  teacherId: string,
  submissionId: string,
  feedback: string,
): Promise<{ finalScore: number; totalPossible: number }> {
  const submission = await ownSubmission(db, teacherId, submissionId);
  if (submission.status !== "approved") throw new Error("NOT_APPROVED");
  if ((feedback ?? "").length > 5000) throw new Error("FEEDBACK_TOO_LONG");
  // RELEASE GATE: every question needs an answer row with a teacher
  // score inside the question's marks. A missing row blocks release.
  const ungated = await db
    .prepare(
      "SELECT 1 AS one FROM questions q LEFT JOIN answers an " +
        "ON an.question_id = q.id AND an.submission_id = ? " +
        "WHERE q.assessment_id = ? " +
        "AND (an.id IS NULL OR an.final_score IS NULL OR an.final_score < 0 OR an.final_score > q.marks) " +
        "LIMIT 1",
    )
    .bind(submissionId, submission.assessment_id)
    .first<{ one: number }>();
  if (ungated) throw new Error("NOT_FULLY_GRADED");
  // Canonical totals: questions define the maximum, answers the score.
  const totals = await db
    .prepare(
      "SELECT COALESCE(SUM(an.final_score), 0) AS total, COALESCE(SUM(q.marks), 0) AS possible " +
        "FROM questions q LEFT JOIN answers an ON an.question_id = q.id AND an.submission_id = ? " +
        "WHERE q.assessment_id = ?",
    )
    .bind(submissionId, submission.assessment_id)
    .first<{ total: number; possible: number }>();
  const total = totals?.total ?? 0;
  const possible = totals?.possible ?? 0;
  await db
    .prepare(
      "UPDATE submissions SET final_score = ?, total_possible = ?, teacher_feedback = ?, " +
        "status = 'released', released_at = ? WHERE id = ?",
    )
    .bind(total, possible, feedback ?? "", new Date().toISOString(), submissionId)
    .run();
  // Activity-feed labels: student name + exam title (never answer text).
  const released = await db
    .prepare(
      "SELECT s.student_id, a.title FROM submissions s " +
        "JOIN assessments a ON a.id = s.assessment_id WHERE s.id = ?",
    )
    .bind(submissionId)
    .first<{ student_id: string; title: string }>();
  const releasedStudent = released
    ? await db
        .prepare("SELECT full_name FROM profiles WHERE id = ?")
        .bind(released.student_id)
        .first<{ full_name: string | null }>()
    : null;
  await appendAuditLog(db, teacherId, "release", submissionId, {
    score: total,
    target_label: (releasedStudent?.full_name ?? "").trim(),
    exam_label: released?.title ?? "",
  });
  return { finalScore: total, totalPossible: possible };
}

/* ------------------------------------------------------- server wrappers */

function ctx(context: unknown): { session: AuthSession; db: D1Database } {
  return context as { session: AuthSession; db: D1Database };
}

export const listGradingPageD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) =>
      data as { status: "awaiting_review" | "released"; offset: number; limit: number },
  )
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    return listGradingPage(db, session.userId, data.status, data.offset, data.limit);
  });

export const getGradingDetailD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    return getGradingDetail(db, session.userId, data.submissionId);
  });

export const setAutoScoresD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) =>
      data as { submissionId: string; scores: { answerId: string; score: number }[] },
  )
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    await setAutoScores(db, session.userId, data.submissionId, data.scores);
    return { ok: true };
  });

export const reviewAnswerD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator(
    (data: unknown) =>
      data as {
        answerId: string;
        score: number | null;
        feedback: string;
        decision: "approve" | "reject";
      },
  )
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    await reviewAnswer(db, session.userId, data.answerId, data.score, data.feedback, data.decision);
    return { ok: true };
  });

export const releaseSubmissionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { submissionId: string; feedback: string })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    return releaseSubmission(db, session.userId, data.submissionId, data.feedback);
  });
