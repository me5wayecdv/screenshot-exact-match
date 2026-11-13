/**
 * D1 handwritten grading (Phase 2 port of /handwritten's persistence).
 *
 * Security rules (never drop one to make a route pass):
 * - Teacher-only: every function below takes the session teacher's id
 *   from the server-function context, never from the client. Students
 *   have no path here at all — a student session is rejected by the
 *   wrapper before any query runs, and the pure functions throw
 *   FORBIDDEN for a non-teacher caller.
 * - Ownership in the SQL WHERE clause: assessments, questions and
 *   history rows are filtered by teacher_id = caller. A question's
 *   question_keys row is joined ONLY after the assessment's owner
 *   check passes, and only for that teacher — a student path must
 *   never select question_keys, and none exists in this module.
 * - Papers: one photo per question (the route's single-grade form);
 *   the paper MUST be persisted to the private handwritten-papers
 *   R2 bucket FIRST via src/server/d1-r2.ts mediation, and the
 *   saved grade stores that R2 key. A failed upload blocks the
 *   save — the route refuses to save when imagePath is empty, and
 *   saveHandwrittenGrade re-validates any supplied key with
 *   validateR2Key(teacherId, key) (first segment == teacher id,
 *   {teacher_id}/{uuid}/{name}, no traversal). A key that fails
 *   validation blocks the save; it is never silently cleaned.
 * - AI grade is FINAL on save (user-directed exception to the
 *   teacher-final-word rule that applies on /grading) — but the
 *   final score is NEVER a client-supplied value. On save the
 *   server re-grades the submitted corrected text against the
 *   linked question's own keys (correct answer, accepted
 *   alternatives, rubric) via suggestGradeWithAi, and the server's
 *   fresh suggestion is what is stored as ai_suggested_score,
 *   ai_feedback and final_score. The client-sent score, feedback
 *   and model are accepted in the input type only and ignored for
 *   grading, so a stale suggestion (text edited after Suggest) or
 *   a tampered client can never become a final grade. A save needs
 *   either a linked question WITH keys, or — for an ad-hoc paper
 *   with no linked question — the teacher-supplied prompt/rubric
 *   (validated with suggestGrade's bounds); the ad-hoc criteria
 *   are recorded in the audit row. An AI failure (not configured,
 *   provider error, quota spent) refuses the save and stores
 *   nothing — no handwritten grade without independent server
 *   verification. The teacher's control
 *   point is reviewing/correcting the extracted text BEFORE
 *   grading. A wrong record is deleted from history and re-graded.
 *   Quota: the server re-grade consumes 1 AI quota unit, so one
 *   Suggest + Save paper costs 2 units in total.
 * - History papers are viewed through the Worker (session-checked
 *   R2 download returning a data URL), never through a public or
 *   signed R2 URL.
 * - Student link (2026-11-04): a saved grade MAY carry student_id,
 *   set only to an APPROVED student of the saving teacher
 *   (teacher_students status = 'approved', checked server-side;
 *   anything else is refused). A linked grade is visible to that
 *   student immediately on save — handwritten grades are FINAL on
 *   save, so there is no release step. NULL student_id keeps the
 *   old behavior: paper name only, visible to the teacher alone.
 *   The student surface query (listStudentHandwrittenGrades) selects
 *   only the caller's own rows by student_id and never touches
 *   question_keys — and never selects ai_feedback either: AI
 *   feedback is teacher-only by product decision (2026-11-04), so
 *   the student view shows score + teacher feedback, never the AI
 *   feedback text.
 *
 * NOT migrated here (owned by other workstreams, left on their old
 * path): OCR (src/server/handwritten.ts), AI grading suggestions
 * (src/server/ai-grade.ts) and page matching (src/server/paper-
 * matching.ts) still validate a Supabase token. This module migrates
 * persistence only; those AI calls are unchanged by this file.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import type { R2BucketLike } from "@/server/d1";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { suggestGradeWithAi } from "./ai-client";
import { consumeAiQuota, logAiUsageEvent, refundAiQuota } from "@/server/d1-quota";
import {
  buildR2Key,
  papersBucket,
  r2Delete,
  r2Get,
  r2Put,
  validateR2Key,
  R2Error,
} from "@/server/d1-r2";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export function isTeacherCaller(caller: Caller): boolean {
  const role = normalizeRole(caller.role);
  return role === "school_teacher" || role === "tutor" || role === "admin";
}

export class HandwrittenError extends Error {
  constructor(
    public readonly code:
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "INVALID_INPUT"
      | "INVALID_KEY"
      | "AI_NOT_CONFIGURED"
      | "AI_ERROR"
      | "AI_RATE_LIMIT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "HandwrittenError";
  }
}

function requireTeacher(caller: Caller): void {
  if (!isTeacherCaller(caller)) {
    throw new HandwrittenError("FORBIDDEN");
  }
}

async function runBatchOrSequential(
  db: D1Database,
  stmts: ReturnType<D1Database["prepare"]>[],
): Promise<void> {
  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();
}

export type HwAssessment = { id: string; title: string };

export async function listHandwrittenAssessments(
  db: D1Database,
  caller: Caller,
): Promise<HwAssessment[]> {
  requireTeacher(caller);
  const { results } = await db
    .prepare("SELECT id, title FROM assessments WHERE teacher_id = ? " + "ORDER BY created_at DESC")
    .bind(caller.id)
    .all<HwAssessment>();
  return results ?? [];
}

export type HwQuestion = {
  id: string;
  prompt: string;
  type: string;
  marks: number;
  position: number;
  question_keys: {
    correct_answer: string;
    accepted_alternatives: string[];
    rubric: string;
    explanation: string;
  } | null;
};

type HwQuestionRow = {
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

/** One question with its keys, for the server-side save re-grade. */
type HwQuestionKeyRow = {
  prompt: string;
  marks: number;
  correct_answer: string | null;
  accepted_alternatives: string | null;
  rubric: string | null;
  explanation: string | null;
};

function parseAlternatives(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Questions for one assessment, WITH their keys — teacher-only, and
 * only after the assessment-owner check. Never call this from a
 * student path.
 */
export async function listHandwrittenQuestions(
  db: D1Database,
  caller: Caller,
  assessmentId: string,
): Promise<HwQuestion[]> {
  requireTeacher(caller);
  const owner = await db
    .prepare("SELECT teacher_id FROM assessments WHERE id = ?")
    .bind(assessmentId)
    .first<{ teacher_id: string }>();
  if (!owner) throw new HandwrittenError("NOT_FOUND");
  if (owner.teacher_id !== caller.id) {
    throw new HandwrittenError("FORBIDDEN");
  }
  const { results } = await db
    .prepare(
      "SELECT q.id, q.prompt, q.type, q.marks, q.position, " +
        "k.correct_answer, k.accepted_alternatives, k.rubric, k.explanation " +
        "FROM questions q LEFT JOIN question_keys k ON k.question_id = q.id " +
        "WHERE q.assessment_id = ? ORDER BY q.position",
    )
    .bind(assessmentId)
    .all<HwQuestionRow>();
  return (results ?? []).map((r) => ({
    id: r.id,
    prompt: r.prompt,
    type: r.type,
    marks: r.marks,
    position: r.position,
    question_keys:
      r.correct_answer === null && r.rubric === null && r.explanation === null
        ? null
        : {
            correct_answer: r.correct_answer ?? "",
            accepted_alternatives: parseAlternatives(r.accepted_alternatives),
            rubric: r.rubric ?? "",
            explanation: r.explanation ?? "",
          },
  }));
}

export type HwApprovedStudent = { id: string; full_name: string };

/**
 * The teacher's APPROVED students (teacher_students status =
 * 'approved'), for the paper form's enrolled-student selector.
 * Pending/rejected students are never offered: a paper must not be
 * linked to a student the teacher has not approved.
 */
export async function listApprovedHwStudents(
  db: D1Database,
  caller: Caller,
): Promise<HwApprovedStudent[]> {
  requireTeacher(caller);
  const { results } = await db
    .prepare(
      "SELECT p.id, p.full_name FROM teacher_students ts JOIN profiles p ON p.id = ts.student_id " +
        "WHERE ts.teacher_id = ? AND ts.status = 'approved' ORDER BY p.full_name",
    )
    .bind(caller.id)
    .all<HwApprovedStudent>();
  return results ?? [];
}

export type StudentHwGrade = {
  id: string;
  assessment_id: string | null;
  assessment_title: string | null;
  teacher_name: string;
  final_score: number;
  max_marks: number;
  // No ai_feedback here on purpose: AI feedback is teacher-only, so
  // it is never selected for — and never reaches — a student.
  teacher_feedback: string;
  created_at: string;
};

/**
 * Handwritten grades linked to one student — the student surface for
 * final-on-save grades. Scoped strictly by student_id = caller; a
 * student can never see another student's linked grades, and unlinked
 * (student_id NULL) grades are never returned here. Selects no keys,
 * and never selects ai_feedback: AI feedback is teacher-only.
 */
export async function listStudentHandwrittenGrades(
  db: D1Database,
  studentId: string,
): Promise<StudentHwGrade[]> {
  const { results } = await db
    .prepare(
      "SELECT hg.id, hg.assessment_id, a.title AS assessment_title, " +
        "COALESCE(p.full_name, '') AS teacher_name, hg.final_score, hg.max_marks, " +
        "hg.teacher_feedback, hg.created_at " +
        "FROM handwritten_grades hg LEFT JOIN assessments a ON a.id = hg.assessment_id " +
        "LEFT JOIN profiles p ON p.id = hg.teacher_id " +
        "WHERE hg.student_id = ? ORDER BY hg.created_at DESC LIMIT 50",
    )
    .bind(studentId)
    .all<StudentHwGrade>();
  return results ?? [];
}

export type HwHistoryRow = {
  id: string;
  question_id: string | null;
  assessment_id: string | null;
  student_name: string;
  image_path: string | null;
  extracted_text: string;
  corrected_text: string;
  ai_suggested_score: number | null;
  ai_feedback: string | null;
  ai_model: string | null;
  final_score: number;
  max_marks: number;
  teacher_feedback: string;
  created_at: string;
};

export async function listHandwrittenHistory(
  db: D1Database,
  caller: Caller,
): Promise<HwHistoryRow[]> {
  requireTeacher(caller);
  const { results } = await db
    .prepare(
      "SELECT id, question_id, assessment_id, student_name, image_path, " +
        "extracted_text, corrected_text, ai_suggested_score, ai_feedback, " +
        "ai_model, final_score, max_marks, teacher_feedback, created_at " +
        "FROM handwritten_grades WHERE teacher_id = ? " +
        "ORDER BY created_at DESC LIMIT 50",
    )
    .bind(caller.id)
    .all<HwHistoryRow>();
  return results ?? [];
}

const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PAPER_DATA_URL_CHARS = 8_000_000;

export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) throw new HandwrittenError("INVALID_INPUT");
  const mime = `image/${match[1]}`;
  const b64 = dataUrl.split(",", 2)[1] ?? "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

/**
 * Persist a paper to the private papers bucket FIRST (mediated R2
 * put). Returns the R2 key. Throws on an invalid upload — the caller
 * must not proceed to save a grade without this key.
 */
export async function uploadHandwrittenPaper(
  db: D1Database,
  caller: Caller,
  bucket: R2BucketLike,
  input: { dataUrl: string; fileName: string },
): Promise<string> {
  requireTeacher(caller);
  void db;
  if (!input.dataUrl || input.dataUrl.length > MAX_PAPER_DATA_URL_CHARS) {
    throw new HandwrittenError("INVALID_INPUT");
  }
  const { bytes } = decodeDataUrl(input.dataUrl);
  const safeName = (input.fileName || "paper.jpg").replace(/[\\/]/g, "_");
  const key = buildR2Key(caller.id, crypto.randomUUID(), safeName);
  await r2Put(bucket, caller.id, key, bytes);
  return key;
}

export type SaveHandwrittenGradeInput = {
  assessmentId: string | null;
  questionId: string | null;
  /** Enrolled-student account link, or null/omitted for a paper with no account. */
  studentId?: string | null;
  studentName: string;
  imagePath: string | null;
  extractedText: string;
  correctedText: string;
  /**
   * Client-supplied suggestion, accepted for compatibility only.
   * IGNORED for grading: the server re-grades the submitted
   * corrected text against the linked question's keys and saves
   * its own fresh suggestion instead, so a stale or tampered
   * client value can never become a final grade.
   */
  aiSuggestedScore: number | null;
  /** Accepted for compatibility only — ignored for grading (see above). */
  aiFeedback: string | null;
  /** Accepted for compatibility only — ignored for grading (see above). */
  aiModel: string | null;
  /**
   * Ad-hoc grading criteria, used ONLY when questionId is null
   * (a paper with no linked question). The teacher-supplied prompt
   * / rubric / alternatives the Suggest preview was graded against.
   * Validated server-side like suggestGrade's own bounds; ignored
   * when a question is linked (the DB keys win). The score is still
   * produced server-side by the model — these criteria can never
   * smuggle a client-chosen score in.
   */
  questionPrompt?: string;
  rubric?: string;
  acceptedAlternatives?: string[];
  maxMarks: number;
  teacherFeedback: string;
};

/**
 * Save a handwritten grade. The final score is the SERVER's fresh
 * re-grade of the submitted corrected text against the linked
 * question's keys — never the client-sent suggestion, which is
 * accepted in the input type only and ignored. A save without a
 * linked question (or a question without keys) is refused, and an
 * AI/quota failure refuses the save with nothing stored.
 * The image key, when present, must validate against the teacher id.
 */
export async function saveHandwrittenGrade(
  db: D1Database,
  caller: Caller,
  input: SaveHandwrittenGradeInput,
): Promise<{ id: string }> {
  requireTeacher(caller);
  if (!input.correctedText.trim()) {
    throw new HandwrittenError("INVALID_INPUT");
  }
  if (!Number.isFinite(input.maxMarks) || input.maxMarks <= 0 || input.maxMarks > 1000) {
    throw new HandwrittenError("INVALID_INPUT");
  }
  if (input.imagePath) {
    try {
      validateR2Key(caller.id, input.imagePath);
    } catch (e) {
      if (e instanceof R2Error) throw new HandwrittenError("INVALID_KEY");
      throw e;
    }
  }
  if (input.assessmentId) {
    const owner = await db
      .prepare("SELECT teacher_id FROM assessments WHERE id = ?")
      .bind(input.assessmentId)
      .first<{ teacher_id: string }>();
    if (!owner) throw new HandwrittenError("NOT_FOUND");
    if (owner.teacher_id !== caller.id) {
      throw new HandwrittenError("FORBIDDEN");
    }
  }
  if (input.questionId) {
    const q = await db
      .prepare("SELECT assessment_id FROM questions WHERE id = ?")
      .bind(input.questionId)
      .first<{ assessment_id: string }>();
    if (!q) throw new HandwrittenError("NOT_FOUND");
    if (input.assessmentId && q.assessment_id !== input.assessmentId) {
      throw new HandwrittenError("INVALID_INPUT");
    }
    if (!input.assessmentId) {
      const owner = await db
        .prepare("SELECT teacher_id FROM assessments WHERE id = ?")
        .bind(q.assessment_id)
        .first<{ teacher_id: string }>();
      if (!owner || owner.teacher_id !== caller.id) {
        throw new HandwrittenError("FORBIDDEN");
      }
    }
  }
  // Student link: only an APPROVED student of this teacher. A pending,
  // rejected, unknown, or another teacher's student is refused — a
  // paper must never surface to the wrong account.
  const studentId = input.studentId ?? null;
  let studentName = input.studentName.trim();
  if (studentId) {
    const link = await db
      .prepare(
        "SELECT 1 AS ok FROM teacher_students " +
          "WHERE teacher_id = ? AND student_id = ? AND status = 'approved'",
      )
      .bind(caller.id, studentId)
      .first<{ ok: number }>();
    if (!link) {
      throw new HandwrittenError(
        "INVALID_INPUT",
        "Student is not an approved student of this teacher.",
      );
    }
    if (!studentName) {
      const profile = await db
        .prepare("SELECT full_name FROM profiles WHERE id = ?")
        .bind(studentId)
        .first<{ full_name: string | null }>();
      studentName = (profile?.full_name ?? "").trim();
    }
  }
  // Server-verified grading (AI-F2): a handwritten grade is never
  // saved on a client-supplied score. The server re-grades the
  // submitted corrected text and stores its own fresh suggestion.
  // Criteria come from the linked question's keys when a question
  // is linked (the marks ceiling is the question's own marks, never
  // the client's). Without a linked question the paper is ad-hoc:
  // the teacher-supplied prompt/rubric travel with the request and
  // are validated here with the same bounds suggestGrade uses
  // (ai-grade.ts validateRequest). Either way the SCORE is produced
  // server-side by the model from the submitted text — a client can
  // never dictate it, and a stale suggestion can never land. The
  // ad-hoc criteria are recorded (truncated) in the audit row so
  // the grade stays traceable; question-linked criteria live in
  // question_keys. Any AI/quota failure refuses the save.
  let questionPrompt: string;
  let rubric: string;
  let acceptedAlternatives: string[];
  let effectiveMaxMarks: number;
  let adHoc = false;
  if (input.questionId) {
    const keyRow = await db
      .prepare(
        "SELECT q.prompt, q.marks, k.correct_answer, k.accepted_alternatives, k.rubric, " +
          "k.explanation FROM questions q LEFT JOIN question_keys k ON k.question_id = q.id " +
          "WHERE q.id = ?",
      )
      .bind(input.questionId)
      .first<HwQuestionKeyRow>();
    if (
      !keyRow ||
      (keyRow.correct_answer === null && keyRow.rubric === null && keyRow.explanation === null)
    ) {
      throw new HandwrittenError(
        "INVALID_INPUT",
        "This question has no answer key, so the paper cannot be graded.",
      );
    }
    if (!Number.isFinite(keyRow.marks) || keyRow.marks <= 0 || keyRow.marks > 1000) {
      throw new HandwrittenError("INVALID_INPUT", "This question has no usable marks.");
    }
    questionPrompt = keyRow.prompt;
    rubric = keyRow.rubric ?? "";
    acceptedAlternatives = parseAlternatives(keyRow.accepted_alternatives);
    effectiveMaxMarks = keyRow.marks;
  } else {
    questionPrompt = (input.questionPrompt ?? "").trim();
    rubric = (input.rubric ?? "").trim();
    const rawAlternatives: unknown[] = Array.isArray(input.acceptedAlternatives)
      ? input.acceptedAlternatives
      : [];
    if (!questionPrompt) {
      throw new HandwrittenError(
        "INVALID_INPUT",
        "An ad-hoc paper needs a question prompt to grade against.",
      );
    }
    if (questionPrompt.length > 20000 || rubric.length > 20000) {
      throw new HandwrittenError("INVALID_INPUT", "Input exceeds the maximum allowed size.");
    }
    if (rawAlternatives.length > 50) {
      throw new HandwrittenError("INVALID_INPUT", "Input exceeds the maximum allowed size.");
    }
    if (
      rawAlternatives.some(
        (alternative) => typeof alternative !== "string" || alternative.length > 2000,
      )
    ) {
      throw new HandwrittenError(
        "INVALID_INPUT",
        "Each accepted alternative must be a string of at most 2000 characters.",
      );
    }
    const alternativesChars = (rawAlternatives as string[]).reduce(
      (total, alternative) => total + alternative.length,
      0,
    );
    if (alternativesChars > 20000) {
      throw new HandwrittenError("INVALID_INPUT", "Input exceeds the maximum allowed size.");
    }
    acceptedAlternatives = rawAlternatives as string[];
    effectiveMaxMarks = input.maxMarks;
    adHoc = true;
  }
  // Quota first, fail-closed: 1 unit for the server re-grade. The
  // client's earlier Suggest call already consumed 1 unit, so one
  // Suggest + Save paper costs 2 units in total.
  if (!(await consumeAiQuota(db, caller.id, 1))) {
    throw new HandwrittenError("AI_RATE_LIMIT", "AI usage limit reached. Try again later.");
  }
  let verifiedModel: string | null = null;
  const regrade = await suggestGradeWithAi(
    {
      questionPrompt,
      rubric,
      acceptedAlternatives,
      studentAnswer: input.correctedText.trim(),
      // The question's own marks are the ceiling — a tampered
      // client maxMarks can never raise it. (Ad-hoc: the validated
      // per-request maxMarks, already bounded 1..1000 above.)
      maxMarks: effectiveMaxMarks,
    },
    undefined,
    async (event) => {
      verifiedModel = event.model;
      await logAiUsageEvent(db, caller.id, {
        kind: "grade",
        provider: event.provider,
        model: event.model,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
      });
    },
  );
  if (!regrade.ok) {
    // The re-grade consumed 1 unit and the AI call failed: refund it
    // (AI-F5). Best-effort — refundAiQuota never throws.
    await refundAiQuota(db, caller.id, 1);
    throw new HandwrittenError(
      regrade.error.code === "AI_NOT_CONFIGURED" ? "AI_NOT_CONFIGURED" : "AI_ERROR",
      regrade.error.message,
    );
  }
  const verifiedScore = regrade.suggestion.suggestedScore;
  const verifiedFeedback = regrade.suggestion.feedback;
  const id = crypto.randomUUID();
  const grade = db
    .prepare(
      "INSERT INTO handwritten_grades " +
        "(id, teacher_id, assessment_id, question_id, student_id, student_name, image_path, " +
        "extracted_text, corrected_text, ai_suggested_score, ai_feedback, ai_model, " +
        "final_score, max_marks, teacher_feedback) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      caller.id,
      input.assessmentId,
      input.questionId,
      studentId,
      studentName,
      input.imagePath,
      input.extractedText,
      input.correctedText.trim(),
      verifiedScore,
      verifiedFeedback,
      verifiedModel,
      verifiedScore,
      effectiveMaxMarks,
      input.teacherFeedback.trim(),
    );
  // Activity-feed label: linked student name, or "unlinked" for a
  // free-text paper. Never answer text, never the image path. An
  // ad-hoc grade also records its (truncated) criteria, since no
  // question_keys row exists to trace it back to.
  const audit = db
    .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
    .bind(
      caller.id,
      "handwritten_grade",
      id,
      JSON.stringify({
        final_score: verifiedScore,
        max_marks: effectiveMaxMarks,
        assessment_id: input.assessmentId,
        question_id: input.questionId,
        student_id: studentId,
        target_label: studentName || "Unlinked paper",
        ...(adHoc
          ? {
              ad_hoc: true,
              question_prompt: questionPrompt.slice(0, 500),
              rubric: rubric.slice(0, 500),
            }
          : {}),
      }),
    );
  await runBatchOrSequential(db, [grade, audit]);
  return { id };
}

/**
 * Delete a history row (teacher-owned only). The stored paper is
 * removed best-effort through mediated R2; the row delete itself
 * never fails because a paper delete failed. An audit row is kept
 * (no student name in audit details, mirroring the old trigger).
 */
export async function deleteHandwrittenGrade(
  db: D1Database,
  caller: Caller,
  bucket: R2BucketLike | null,
  gradeId: string,
): Promise<void> {
  requireTeacher(caller);
  const row = await db
    .prepare("SELECT teacher_id, image_path FROM handwritten_grades WHERE id = ?")
    .bind(gradeId)
    .first<{ teacher_id: string; image_path: string | null }>();
  if (!row) throw new HandwrittenError("NOT_FOUND");
  if (row.teacher_id !== caller.id) {
    throw new HandwrittenError("FORBIDDEN");
  }
  const del = db.prepare("DELETE FROM handwritten_grades WHERE id = ?").bind(gradeId);
  const audit = db
    .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
    .bind(caller.id, "handwritten_grade_deleted", gradeId, JSON.stringify({}));
  await runBatchOrSequential(db, [del, audit]);
  if (bucket && row.image_path) {
    try {
      await r2Delete(bucket, caller.id, row.image_path);
    } catch {
      // Best-effort: the grade row is already deleted.
    }
  }
}

/**
 * Session-checked paper download for the owning teacher: returns a
 * data URL the history UI can render. No public or signed URL is
 * ever produced. Students cannot reach this — the wrapper rejects
 * non-teachers, and the grade row's teacher_id must match.
 */
export async function getHandwrittenPaper(
  db: D1Database,
  caller: Caller,
  bucket: R2BucketLike,
  gradeId: string,
): Promise<string> {
  requireTeacher(caller);
  const row = await db
    .prepare("SELECT teacher_id, image_path FROM handwritten_grades WHERE id = ?")
    .bind(gradeId)
    .first<{ teacher_id: string; image_path: string | null }>();
  if (!row || !row.image_path) throw new HandwrittenError("NOT_FOUND");
  if (row.teacher_id !== caller.id) {
    throw new HandwrittenError("FORBIDDEN");
  }
  const bytes = await r2Get(bucket, caller.id, row.image_path);
  if (!bytes) throw new HandwrittenError("NOT_FOUND");
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

/**
 * Delete a queued (not yet graded) paper by R2 key — the match
 * queue's remove path. The key must validate against the caller
 * (first segment == teacher id); no grade row is involved.
 */
export async function deleteHandwrittenPaper(
  db: D1Database,
  caller: Caller,
  bucket: R2BucketLike,
  key: string,
): Promise<void> {
  requireTeacher(caller);
  void db;
  await r2Delete(bucket, caller.id, key);
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

export const listHwAssessmentsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listHandwrittenAssessments(ctxDb(context), ctxCaller(context)));

export const listHwQuestionsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { assessmentId: string })
  .handler(async ({ data, context }) =>
    listHandwrittenQuestions(ctxDb(context), ctxCaller(context), data.assessmentId),
  );

export const listHwStudentsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listApprovedHwStudents(ctxDb(context), ctxCaller(context)));

export const listHwHistoryD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listHandwrittenHistory(ctxDb(context), ctxCaller(context)));

export const uploadHwPaperD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { dataUrl: string; fileName: string })
  .handler(async ({ data, context }) =>
    uploadHandwrittenPaper(ctxDb(context), ctxCaller(context), await papersBucket(), data),
  );

export const saveHwGradeD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as SaveHandwrittenGradeInput)
  .handler(async ({ data, context }) =>
    saveHandwrittenGrade(ctxDb(context), ctxCaller(context), data),
  );

export const deleteHwGradeD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { gradeId: string })
  .handler(async ({ data, context }) =>
    deleteHandwrittenGrade(ctxDb(context), ctxCaller(context), await papersBucket(), data.gradeId),
  );

export const deleteHwPaperD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { key: string })
  .handler(async ({ data, context }) =>
    deleteHandwrittenPaper(ctxDb(context), ctxCaller(context), await papersBucket(), data.key),
  );

export const getHwPaperD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { gradeId: string })
  .handler(async ({ data, context }) =>
    getHandwrittenPaper(ctxDb(context), ctxCaller(context), await papersBucket(), data.gradeId),
  );
