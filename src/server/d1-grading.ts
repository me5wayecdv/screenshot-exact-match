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
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { effectiveRole, notFound } from "@/server/d1-assessments";
import { appendAuditLog } from "@/server/d1-admin";
import { callTakeSession } from "@/server/d1-take";
import {
  invalidInput,
  optionalNumber,
  requireEnum,
  requireNumber,
  requireObject,
  requireString,
} from "@/server/validate";

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
  /**
   * Quick-settle metadata for the grading list: objectiveOnly is true
   * when EVERY question of the assessment is auto-gradable (keyed
   * mcq/true_false/short_answer — the same rule as isAutoGradable in
   * src/lib/auto-grade.ts), and unscoredCount counts questions still
   * lacking a final score (missing answer row or null final_score).
   * A row can be settled in one click when unscoredCount === 0
   * (publish) or when objectiveOnly (auto-grade + publish).
   */
  objectiveOnly: boolean;
  unscoredCount: number;
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
  /**
   * The AI suggestion persisted for this answer (answers.ai_suggestion),
   * parsed + validated server-side — or null when none was ever generated
   * or the stored JSON is unusable. AI-F4 display fix: the grading page
   * shows this after a reload instead of only the generate button. It is
   * advisory only (the teacher still has the last word) and is only ever
   * returned to the owning teacher through getGradingDetail.
   */
  aiSuggestion: PersistedAiSuggestion | null;
};

/** A parsed answers.ai_suggestion JSON payload. */
export type PersistedAiSuggestion = {
  suggestedScore: number;
  feedback: string;
  confidence: "high" | "medium" | "low";
  model?: string;
};

const AI_CONFIDENCES = new Set(["high", "medium", "low"]);

/**
 * parseAiSuggestion — defensive parse of a stored answers.ai_suggestion
 * JSON string. Returns null for anything unusable (missing, corrupt JSON,
 * non-finite or negative score, score above the question's marks, unknown
 * confidence) so a bad row can never break the grading page or surface a
 * score the teacher did not ask for. Never throws.
 */
export function parseAiSuggestion(
  raw: string | null | undefined,
  maxMarks: number,
): PersistedAiSuggestion | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const d = parsed as Record<string, unknown>;
  const score = typeof d["suggested_score"] === "number" ? d["suggested_score"] : Number.NaN;
  if (!Number.isFinite(score) || score < 0) return null;
  const max = Number(maxMarks);
  if (!Number.isFinite(max) || max <= 0 || score > max) return null;
  const confidence = d["confidence"];
  if (typeof confidence !== "string" || !AI_CONFIDENCES.has(confidence)) return null;
  const feedback = typeof d["feedback"] === "string" ? d["feedback"] : "";
  const model = typeof d["model"] === "string" ? d["model"] : undefined;
  return {
    suggestedScore: score,
    feedback,
    confidence: confidence as "high" | "medium" | "low",
    ...(model ? { model } : {}),
  };
}

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
  objective_only: number;
  unscored_count: number;
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

import { autoScoreFor } from "@/lib/auto-grade";

export { autoScoreFor };

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
      ? // partially_released still has essays waiting for the teacher,
        // so it belongs on the open tab, not the released tab.
        "s.status IN ('awaiting_review', 'approved')"
      : "s.status = 'released'";
  const { results } = await db
    .prepare(
      "SELECT s.id, s.assessment_id, s.student_id, s.status, s.attempt_number, s.submitted_at, " +
        "s.final_score, s.total_possible, a.title AS assessment_title, " +
        "COALESCE(p.full_name, '—') AS student_name, " +
        // Quick-settle metadata: questions still lacking a final score.
        "(SELECT COUNT(*) FROM questions q LEFT JOIN answers an " +
        "ON an.question_id = q.id AND an.submission_id = s.id " +
        "WHERE q.assessment_id = s.assessment_id " +
        "AND (an.id IS NULL OR an.final_score IS NULL)) AS unscored_count, " +
        // 1 when every question mirrors isAutoGradable (keyed objective
        // or short answer with a key/usable alternative), else 0.
        "CASE WHEN NOT EXISTS (" +
        "SELECT 1 FROM questions q LEFT JOIN question_keys k ON k.question_id = q.id " +
        "WHERE q.assessment_id = s.assessment_id AND NOT (" +
        "(q.type IN ('mcq', 'true_false') AND TRIM(COALESCE(k.correct_answer, '')) <> '') OR " +
        "(q.type = 'short_answer' AND (TRIM(COALESCE(k.correct_answer, '')) <> '' OR EXISTS (" +
        "SELECT 1 FROM json_each(COALESCE(k.accepted_alternatives, '[]')) je " +
        "WHERE TRIM(je.value) <> '')))" +
        ")" +
        ") AND EXISTS (SELECT 1 FROM questions q2 WHERE q2.assessment_id = s.assessment_id) " +
        "THEN 1 ELSE 0 END AS objective_only " +
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
      status:
        r.status === "awaiting_review" && r.final_score != null ? "partially_released" : r.status,
      attempt_number: r.attempt_number,
      submitted_at: r.submitted_at,
      final_score: r.final_score,
      total_possible: r.total_possible,
      assessmentTitle: r.assessment_title,
      studentName: r.student_name,
      objectiveOnly: r.objective_only === 1,
      unscoredCount: Number(r.unscored_count ?? 0),
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
      "SELECT s.id, s.assessment_id, s.status, s.final_score FROM submissions s " +
        "JOIN assessments a ON a.id = s.assessment_id " +
        "WHERE s.id = ? AND a.teacher_id = ?",
    )
    .bind(submissionId, teacherId)
    .first<{ id: string; assessment_id: string; status: string; final_score: number | null }>();
  if (!row) throw notFound();
  return {
    ...row,
    status:
      row.status === "awaiting_review" && row.final_score != null
        ? "partially_released"
        : row.status,
  };
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
      .all<GradingAnswer & { ai_suggestion: string | null }>(),
  ]);
  const marksByQuestion = new Map((questionsRes.results ?? []).map((q) => [q.id, Number(q.marks)]));
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
    // The raw ai_suggestion JSON string never leaves the server: each
    // answer carries the parsed, validated suggestion (or null).
    answers: (answersRes.results ?? []).map((a) => ({
      id: a.id,
      question_id: a.question_id,
      response: a.response,
      max_marks: a.max_marks,
      auto_score: a.auto_score,
      final_score: a.final_score,
      feedback: a.feedback,
      review_status: a.review_status,
      aiSuggestion: parseAiSuggestion(
        a.ai_suggestion,
        marksByQuestion.get(a.question_id) ?? a.max_marks,
      ),
    })),
  };
}

export async function setAutoScores(
  db: D1Database,
  teacherId: string,
  submissionId: string,
  scores: { answerId: string; score: number }[],
): Promise<void> {
  const submission = await ownSubmission(db, teacherId, submissionId);
  // Released needs no promotion, and a partially released submission
  // already had every auto-gradable answer promoted at submit time —
  // re-promoting here would also mis-flip its status below.
  if (submission.status === "released" || submission.status === "partially_released") return;
  let promoted = false;
  for (const { answerId, score } of scores) {
    if (!Number.isFinite(score) || score < 0) continue;
    const answer = await db
      .prepare(
        "SELECT auto_score, final_score, review_status FROM answers WHERE id = ? AND submission_id = ?",
      )
      .bind(answerId, submissionId)
      .first<{
        auto_score: number | null;
        final_score: number | null;
        review_status: string;
      }>();
    if (!answer) continue;
    // The auto-grade IS the grade for an objective answer the teacher
    // has not scored yet: promote it to final_score (review_status
    // 'auto_graded') so release needs no per-question retyping, exactly
    // as the grading-page header announces. A teacher score always
    // wins — promotion never touches a set final_score, and
    // reviewAnswer stays the override path.
    const promote =
      answer.final_score === null &&
      (answer.review_status === "not_graded" || answer.review_status === "auto_graded");
    const autoStale = answer.auto_score === null || Number(answer.auto_score) !== score;
    if (promote) {
      promoted = true;
      await db
        .prepare(
          "UPDATE answers SET auto_score = ?, final_score = ?, review_status = 'auto_graded' " +
            "WHERE id = ? AND submission_id = ?",
        )
        .bind(score, score, answerId, submissionId)
        .run();
    } else if (autoStale) {
      await db
        .prepare("UPDATE answers SET auto_score = ? WHERE id = ? AND submission_id = ?")
        .bind(score, answerId, submissionId)
        .run();
    }
  }
  if (promoted) {
    // Recompute the submission status exactly like reviewAnswer:
    // approved only when no valid answer still lacks a final score,
    // so a fully objective exam is release-ready the moment the
    // teacher opens it.
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
  // Released submissions stay re-gradable (grade-review flow): the
  // teacher can correct scores after publication and the student's
  // published result updates in place below. A partially released
  // submission is likewise re-gradable: correcting an objective score
  // updates the published objective totals in place, while grading an
  // essay stays invisible to the student until the release click.
  if (
    submission.status !== "awaiting_review" &&
    submission.status !== "approved" &&
    submission.status !== "released" &&
    submission.status !== "partially_released"
  ) {
    throw new Error("NOT_READY_FOR_REVIEW");
  }
  if (decision !== "approve" && decision !== "reject") {
    throw new Error("INVALID_DECISION");
  }
  if ((feedback ?? "").length > 5000) throw new Error("FEEDBACK_TOO_LONG");
  // Canonical marks come from the question, never the answer row.
  const question = await db
    .prepare("SELECT marks FROM questions WHERE id = ? AND assessment_id = ?")
    .bind(answer.question_id, submission.assessment_id)
    .first<{ marks: number }>();
  if (!question) throw notFound();
  if (
    decision === "approve" &&
    (score === null || !Number.isFinite(score) || score < 0 || score > question.marks)
  ) {
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
  if (submission.status === "released") {
    // Re-grading after publication: the submission stays released and
    // its canonical totals refresh in place, so the student's published
    // result reflects the corrected scores immediately — the same row
    // updates, never a duplicate, and released_at keeps the first
    // publication time.
    const totals = await db
      .prepare(
        "SELECT COALESCE(SUM(an.final_score), 0) AS total, COALESCE(SUM(q.marks), 0) AS possible " +
          "FROM questions q LEFT JOIN answers an ON an.question_id = q.id AND an.submission_id = ? " +
          "WHERE q.assessment_id = ?",
      )
      .bind(submission.id, submission.assessment_id)
      .first<{ total: number; possible: number }>();
    await db
      .prepare("UPDATE submissions SET final_score = ?, total_possible = ? WHERE id = ?")
      .bind(totals?.total ?? 0, totals?.possible ?? 0, submission.id)
      .run();
  } else if (submission.status === "partially_released") {
    // Partial publication: the published line covers the auto-gradable
    // (objective) questions only, so a teacher correction to one of
    // them refreshes those objective totals in place (teacher's score
    // always wins), while an essay score stays out of the published
    // line until the release click publishes the full canonical total.
    const partialTotals = await db
      .prepare(
        "SELECT COALESCE(SUM(an.final_score), 0) AS total, COALESCE(SUM(q.marks), 0) AS possible " +
          "FROM questions q LEFT JOIN answers an ON an.question_id = q.id AND an.submission_id = ? " +
          "WHERE q.assessment_id = ? AND an.auto_score IS NOT NULL",
      )
      .bind(submission.id, submission.assessment_id)
      .first<{ total: number; possible: number }>();
    await db
      .prepare("UPDATE submissions SET final_score = ?, total_possible = ? WHERE id = ?")
      .bind(partialTotals?.total ?? 0, partialTotals?.possible ?? 0, submission.id)
      .run();
  } else {
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
  }
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
): Promise<{
  finalScore: number;
  totalPossible: number;
  assessmentId: string;
  studentId: string;
}> {
  const submission = await ownSubmission(db, teacherId, submissionId);
  // Re-release of an already-released submission recomputes the
  // canonical totals and updates the same row in place (grade-review
  // corrections) — the student's result is replaced, never duplicated.
  // Releasing a partially released submission is the same row update:
  // the objective part was published at submit, and this click adds
  // the teacher-graded essay scores to the canonical full totals.
  if (
    submission.status !== "approved" &&
    submission.status !== "released" &&
    submission.status !== "partially_released"
  ) {
    throw new Error("NOT_APPROVED");
  }
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
  // released_at is the FIRST publication time: a partially released
  // submission already published its objective part at submit.
  let releasedAt = new Date().toISOString();
  if (submission.status === "partially_released" || submission.status === "released") {
    const prior = await db
      .prepare("SELECT released_at FROM submissions WHERE id = ?")
      .bind(submissionId)
      .first<{ released_at: string | null }>();
    if (prior?.released_at) releasedAt = prior.released_at;
  }
  await db
    .prepare(
      "UPDATE submissions SET final_score = ?, total_possible = ?, teacher_feedback = ?, " +
        "status = 'released', released_at = ? WHERE id = ?",
    )
    .bind(total, possible, feedback ?? "", releasedAt, submissionId)
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
  return {
    finalScore: total,
    totalPossible: possible,
    assessmentId: submission.assessment_id,
    studentId: released?.student_id ?? "",
  };
}

/**
 * Quick settle from the grading list: the teacher settles an unsettled
 * submission in one click without opening it. Every question that still
 * lacks a teacher score must be auto-gradable (the deterministic rule
 * in src/lib/auto-grade.ts — keyed objective/short-answer questions);
 * its auto score becomes the final score with review_status
 * 'auto_graded', exactly like the submit-time auto-release and the
 * grading-page auto-apply. A question the rule cannot grade (written,
 * or no teacher key) throws NOT_FULLY_GRADABLE and nothing is written:
 * the teacher must open the submission and grade it by hand. Once every
 * question has a final score the submission flips to approved and goes
 * through the normal audited releaseSubmission path (canonical totals,
 * released status, release audit row).
 */
export async function quickSettleSubmission(
  db: D1Database,
  teacherId: string,
  submissionId: string,
): Promise<{
  finalScore: number;
  totalPossible: number;
  assessmentId: string;
  studentId: string;
}> {
  const submission = await ownSubmission(db, teacherId, submissionId);
  // partially_released is settle-able too: its essay part still fails
  // NOT_FULLY_GRADABLE below, but a question keyed after submit can be
  // settled and released in one click like any other.
  if (
    submission.status !== "awaiting_review" &&
    submission.status !== "approved" &&
    submission.status !== "partially_released"
  ) {
    throw new Error("NOT_READY_FOR_REVIEW");
  }
  const qres = await db
    .prepare(
      "SELECT q.id, q.type, q.marks, k.correct_answer, k.accepted_alternatives " +
        "FROM questions q LEFT JOIN question_keys k ON k.question_id = q.id " +
        "WHERE q.assessment_id = ?",
    )
    .bind(submission.assessment_id)
    .all<{
      id: string;
      type: string;
      marks: number;
      correct_answer: string | null;
      accepted_alternatives: string | null;
    }>();
  const questions = qres.results ?? [];
  const ares = await db
    .prepare("SELECT id, question_id, response, final_score FROM answers WHERE submission_id = ?")
    .bind(submissionId)
    .all<{ id: string; question_id: string; response: string; final_score: number | null }>();
  const byQuestion = new Map((ares.results ?? []).map((a) => [a.question_id, a]));
  const writes: D1Statement[] = [];
  for (const q of questions) {
    const answer = byQuestion.get(q.id);
    // A score the teacher already set always stands.
    if (answer && answer.final_score !== null) continue;
    const key =
      q.correct_answer === null && q.accepted_alternatives === null
        ? null
        : {
            correct_answer: q.correct_answer ?? "",
            accepted_alternatives: parseJsonArray(q.accepted_alternatives),
            rubric: "",
            explanation: "",
          };
    const marks = Number(q.marks);
    const auto = autoScoreFor({ type: q.type, marks }, key, answer?.response ?? "");
    if (auto === null) throw new Error("NOT_FULLY_GRADABLE");
    if (answer) {
      writes.push(
        db
          .prepare(
            "UPDATE answers SET auto_score = ?, final_score = ?, review_status = 'auto_graded' " +
              "WHERE id = ? AND submission_id = ?",
          )
          .bind(auto, auto, answer.id, submissionId),
      );
    } else {
      // No answer row at all: the student never touched a keyed
      // question, which the deterministic rule scores as zero.
      writes.push(
        db
          .prepare(
            "INSERT INTO answers (id, submission_id, question_id, response, max_marks, " +
              "auto_score, final_score, review_status, time_spent_seconds) " +
              "VALUES (?, ?, ?, '', ?, ?, ?, 'auto_graded', 0)",
          )
          .bind(crypto.randomUUID(), submissionId, q.id, marks, auto, auto),
      );
    }
  }
  if (writes.length > 0) {
    if (db.batch) await db.batch(writes);
    else for (const statement of writes) await statement.run();
  }
  // Every question now has a final score: mark approved so the release
  // goes through the same gate + audit path as the manual flow. A
  // partially released submission keeps its status instead — flipping
  // it to approved would hide the already-published objective part
  // from the student, and releaseSubmission accepts it as is.
  if (submission.status !== "approved" && submission.status !== "partially_released") {
    await db
      .prepare("UPDATE submissions SET status = 'approved' WHERE id = ?")
      .bind(submissionId)
      .run();
  }
  return releaseSubmission(db, teacherId, submissionId, "");
}

/* ------------------------------------------------------- server wrappers */

function ctx(context: unknown): { session: AuthSession; db: D1Database } {
  return context as { session: AuthSession; db: D1Database };
}

export const listGradingPageD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    return {
      status: requireEnum(input["status"], ["awaiting_review", "released"] as const),
      offset: requireNumber(input["offset"], { integer: true, min: 0 }),
      limit: requireNumber(input["limit"], { integer: true, min: 1, max: 200 }),
    };
  })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    return listGradingPage(db, session.userId, data.status, data.offset, data.limit);
  });

export const getGradingDetailD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    return { submissionId: requireString(input["submissionId"]) };
  })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    return getGradingDetail(db, session.userId, data.submissionId);
  });

export const setAutoScoresD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    const rawScores = input["scores"];
    if (!Array.isArray(rawScores) || rawScores.length > 200) invalidInput();
    const scores = rawScores.map((raw) => {
      const row = requireObject(raw);
      return {
        answerId: requireString(row["answerId"]),
        score: requireNumber(row["score"]),
      };
    });
    return { submissionId: requireString(input["submissionId"]), scores };
  })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    await setAutoScores(db, session.userId, data.submissionId, data.scores);
    return { ok: true };
  });

export const reviewAnswerD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    return {
      answerId: requireString(input["answerId"]),
      score: optionalNumber(input["score"]) ?? null,
      feedback: requireString(input["feedback"], 5000),
      decision: requireEnum(input["decision"], ["approve", "reject"] as const),
    };
  })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    await reviewAnswer(db, session.userId, data.answerId, data.score, data.feedback, data.decision);
    // Published objective corrections must reach the student's cache too.
    try {
      const owner = await db
        .prepare(
          "SELECT s.assessment_id, s.student_id FROM submissions s JOIN answers an ON an.submission_id = s.id " +
            "WHERE an.id = ? AND s.final_score IS NOT NULL",
        )
        .bind(data.answerId)
        .first<{ assessment_id: string; student_id: string }>();
      if (owner)
        await callTakeSession(owner.assessment_id, "/score-refresh", {
          studentId: owner.student_id,
          assessmentId: owner.assessment_id,
        });
    } catch {
      /* The normal score TTL remains the fallback. */
    }
    return { ok: true };
  });

export const quickSettleSubmissionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    return { submissionId: requireString(input["submissionId"]) };
  })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    const result = await quickSettleSubmission(db, session.userId, data.submissionId);
    // Same prompt-delivery poke as a manual release: the student's
    // cached take data reflects the score on their next read.
    // Best-effort — the score-refresh TTL remains the fallback.
    if (result.studentId) {
      try {
        await callTakeSession(result.assessmentId, "/score-refresh", {
          studentId: result.studentId,
          assessmentId: result.assessmentId,
        });
      } catch {
        // Deliberately silent: the TTL refresh stays correct.
      }
    }
    return { finalScore: result.finalScore, totalPossible: result.totalPossible };
  });

export const releaseSubmissionD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    return {
      submissionId: requireString(input["submissionId"]),
      feedback: requireString(input["feedback"], 5000),
    };
  })
  .handler(async ({ context, data }) => {
    const { session, db } = ctx(context);
    requireSchoolTeacher(session);
    const result = await releaseSubmission(db, session.userId, data.submissionId, data.feedback);
    // Prompt result delivery: poke the exam's TakeSession DO so the
    // student's cached take data reflects the release on their next
    // read instead of waiting out the 5-minute score-refresh TTL.
    // Best-effort: a DO hiccup must never fail a release — the TTL
    // refresh remains the fallback.
    if (result.studentId) {
      try {
        await callTakeSession(result.assessmentId, "/score-refresh", {
          studentId: result.studentId,
          assessmentId: result.assessmentId,
        });
      } catch {
        // Deliberately silent: the TTL refresh stays correct.
      }
    }
    return { finalScore: result.finalScore, totalPossible: result.totalPossible };
  });
