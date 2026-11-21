import { confirmPaperReference, getPaperReference, listPaperReferences } from "./paper-reference";
import {
  assertGradePreviewSigning,
  signGradePreview,
  verifyGradePreview,
} from "./grade-preview-token";
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
 * - Save records the reviewed server-signed preview, never a client score.
 *   Preview binds teacher, grading criteria, answer and image for30minutes.
 *   Preview consumes one quota unit. Save makes no provider call or preview
 *   storage write. Existing grade id and audit history prevent replay after
 *   save/deletion; concurrent saves are bounded by the grade primary key.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import type { R2BucketLike } from "@/server/d1";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { suggestGradeWithAi, type AiGradeSuggestion } from "./ai-client";
import { consumeAiQuota, logAiUsageEvent, refundAiQuota } from "@/server/d1-quota";
import {
  compact,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireNumber,
  requireObject,
  requireString,
} from "@/server/validate";
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

/**
 * True only for a handwritten_grades primary-key collision.
 *
 * D1 reports every write failure through the same thrown Error, so the
 * save path must distinguish "another request already saved this
 * preview" (idempotent retry, return the id) from a real failure (must
 * surface).
 */
function isHandwrittenIdClash(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /UNIQUE constraint failed:\s*handwritten_grades\.id/i.test(message);
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

/** One question with its keys, for the server-side preview. */
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
  reference_title?: string | null;
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
        "ai_model, final_score, max_marks, teacher_feedback, created_at, " +
        "(SELECT json_extract(a.details, '$.reference_title') FROM audit_log a WHERE a.entity_id = handwritten_grades.id AND a.actor_id = handwritten_grades.teacher_id AND a.action = 'handwritten_grade' LIMIT 1) AS reference_title " +
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
  /** Signed server-owned preview token. Client scores are never authoritative. */
  previewId?: string;
  referenceId?: string;
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
   * Ignored: Save verifies the signed preview against canonical criteria.
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
 * Validate a client-supplied handwritten-grade payload at the
 * boundary. The handler used to trust the shape: a missing
 * `maxMarks` reached the score comparison as undefined (NaN, so the
 * grade silently failed later) and a non-string `correctedText`
 * reached `.trim()` as a TypeError. Both are client mistakes, so both
 * must be a translated INVALID_INPUT, not a 500.
 */
function parseSaveHandwrittenGradeInput(data: unknown): SaveHandwrittenGradeInput {
  const input = requireObject(data);
  return {
    ...compact({
      previewId: optionalString(input["previewId"], 500),
      referenceId: optionalString(input["referenceId"], 100),
      studentId: optionalString(input["studentId"]),
      questionPrompt: optionalString(input["questionPrompt"], 10_000),
      rubric: optionalString(input["rubric"], 5000),
      acceptedAlternatives: optionalStringArray(input["acceptedAlternatives"], 50),
    }),
    assessmentId: optionalString(input["assessmentId"]) ?? null,
    questionId: optionalString(input["questionId"]) ?? null,
    studentName: requireString(input["studentName"], 200),
    imagePath: optionalString(input["imagePath"], 500) ?? null,
    extractedText: requireString(input["extractedText"], 100_000),
    correctedText: requireString(input["correctedText"], 100_000),
    aiSuggestedScore: optionalNumber(input["aiSuggestedScore"]) ?? null,
    aiFeedback: optionalString(input["aiFeedback"], 5000) ?? null,
    aiModel: optionalString(input["aiModel"], 200) ?? null,
    maxMarks: requireNumber(input["maxMarks"], { min: 0, max: 1000 }),
    teacherFeedback: requireString(input["teacherFeedback"], 5000),
  };
}

/** Preview uses canonical server criteria once. Save accepts only that unexpired,
 * bound preview. Client-sent scores are ignored. The image key must belong
 * to the teacher. No new inference is made during Save.
 */
export async function saveHandwrittenGrade(
  db: D1Database,
  caller: Caller,
  input: SaveHandwrittenGradeInput,
  options: { preview?: boolean } = {},
): Promise<{ id: string; suggestion?: AiGradeSuggestion }> {
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
  const reference = input.referenceId
    ? await getPaperReference(db, caller, input.referenceId)
    : null;
  const referenceImage = input.imagePath
    ? await db
        .prepare("SELECT id FROM handwritten_references WHERE teacher_id = ? AND image_path = ?")
        .bind(caller.id, input.imagePath)
        .first()
    : null;
  if (referenceImage)
    throw new HandwrittenError(
      "INVALID_INPUT",
      "The reference cannot be submitted as a student paper.",
    );
  let effectiveAssessmentId = input.assessmentId ?? null;
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
    effectiveAssessmentId = q.assessment_id;
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
  // Preview grades canonical criteria once. Save verifies the signed preview
  // against those current criteria. Neither client score nor client keys can
  // replace a linked question's server-owned marks or answer key.
  let questionPrompt: string;
  let correctAnswer = "";
  let explanation = "";
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
      (!reference &&
        !keyRow.correct_answer?.trim() &&
        !keyRow.rubric?.trim() &&
        parseAlternatives(keyRow.accepted_alternatives).length === 0)
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
    correctAnswer = keyRow.correct_answer ?? "";
    explanation = keyRow.explanation ?? "";
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
  // The signed preview travels only to its authenticated teacher. It
  // binds the exact canonical grading criteria and answer, not client scores.
  const fingerprintData = JSON.stringify([
    caller.id,
    reference
      ? [reference.id, reference.kind, reference.image_path, reference.confirmed_text]
      : null,
    effectiveAssessmentId,
    input.questionId,
    input.studentId ?? null,
    studentName,
    input.imagePath,
    questionPrompt,
    correctAnswer,
    explanation,
    rubric,
    acceptedAlternatives,
    input.correctedText.trim(),
    effectiveMaxMarks,
  ]);
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintData)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let id: string;
  let verifiedModel: string | null;
  let suggestion: AiGradeSuggestion;
  if (options.preview) {
    await assertGradePreviewSigning();
    const quotaRefundKey = crypto.randomUUID();
    const quotaConsumedAt = new Date().toISOString();
    if (!(await consumeAiQuota(db, caller.id, 1, quotaConsumedAt))) {
      throw new HandwrittenError("AI_RATE_LIMIT", "AI usage limit reached. Try again later.");
    }
    verifiedModel = null;
    const regrade = await suggestGradeWithAi(
      {
        questionPrompt,
        correctAnswer,
        explanation,
        rubric,
        acceptedAlternatives,
        studentAnswer: input.correctedText.trim(),
        ...(reference
          ? { paperReference: { kind: reference.kind, answers: reference.confirmed_text } }
          : {}),
        // The question's own marks are the ceiling — a tampered
        // client maxMarks can never raise it. (Ad-hoc: the validated
        // per-request maxMarks, already bounded 1..1000 above.)
        maxMarks: effectiveMaxMarks,
      },
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
      // The preview consumed 1 unit and the AI call failed: refund it
      // (AI-F5). Best-effort — refundAiQuota never throws.
      await refundAiQuota(db, caller.id, 1, quotaConsumedAt, quotaRefundKey);
      throw new HandwrittenError(
        regrade.error.code === "AI_NOT_CONFIGURED" ? "AI_NOT_CONFIGURED" : "AI_ERROR",
        regrade.error.message,
      );
    }

    id = crypto.randomUUID();
    suggestion = regrade.suggestion;
    const token = await signGradePreview({
      v: 1,
      purpose: "qemmini.handwritten.preview",
      id,
      fingerprint,
      suggestion,
      model: verifiedModel,
      expiresAt: Date.now() + 30 * 60_000,
    });
    return { id: token, suggestion };
  }
  if (!input.previewId)
    throw new HandwrittenError("INVALID_INPUT", "Request a fresh grade preview before saving.");
  let preview: Awaited<ReturnType<typeof verifyGradePreview>>;
  try {
    preview = await verifyGradePreview(input.previewId);
  } catch {
    throw new HandwrittenError(
      "INVALID_INPUT",
      "Grade preview expired or invalid. Request a fresh preview.",
    );
  }
  id = preview.id;
  if (preview.fingerprint !== fingerprint)
    throw new HandwrittenError(
      "INVALID_INPUT",
      "The answer or grading criteria changed. Request a fresh preview.",
    );
  const existing = await db
    .prepare("SELECT id FROM handwritten_grades WHERE id = ? AND teacher_id = ?")
    .bind(id, caller.id)
    .first<{ id: string }>();
  if (existing) return { id };
  const used = await db
    .prepare(
      "SELECT id FROM audit_log WHERE entity_id = ? AND actor_id = ? AND action = 'handwritten_grade' LIMIT 1",
    )
    .bind(id, caller.id)
    .first();
  if (used) throw new HandwrittenError("INVALID_INPUT", "This preview has already been saved.");
  suggestion = preview.suggestion;
  if (
    typeof suggestion?.suggestedScore !== "number" ||
    !Number.isFinite(suggestion.suggestedScore) ||
    suggestion.suggestedScore < 0 ||
    suggestion.suggestedScore > effectiveMaxMarks
  ) {
    throw new HandwrittenError("AI_ERROR");
  }
  verifiedModel = preview.model;
  const verifiedScore = suggestion.suggestedScore;
  const verifiedFeedback = suggestion.feedback;
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
      effectiveAssessmentId,
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
        reference_id: reference?.id ?? null,
        reference_title: reference?.title ?? null,
        reference_kind: reference?.kind ?? null,
        final_score: verifiedScore,
        max_marks: effectiveMaxMarks,
        assessment_id: effectiveAssessmentId,
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
  if (!db.batch) throw new HandwrittenError("INVALID_INPUT", "Atomic save unavailable.");
  try {
    await db.batch([grade, audit]);
  } catch (error) {
    if (!isHandwrittenIdClash(error)) throw error;
    // A concurrent save of the SAME preview won the insert. The payload
    // is identical — the fingerprint check above ties this request to the
    // same answer and grading criteria — so this is a retry, not a
    // conflict: report success instead of a raw 500.
    const raced = await db
      .prepare("SELECT id FROM handwritten_grades WHERE id = ? AND teacher_id = ?")
      .bind(id, caller.id)
      .first<{ id: string }>();
    if (!raced) throw error;
  }
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
  // The key keeps the uploaded file name, so the browser is told the
  // real type. Hardcoding image/jpeg mislabelled every PNG/WebP paper.
  return `data:${paperMimeType(row.image_path)};base64,${btoa(bin)}`;
}

/** MIME type for a stored paper, from the extension kept in its R2 key. */
function paperMimeType(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "avif":
      return "image/avif";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
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
  const reference = await db
    .prepare("SELECT id FROM handwritten_references WHERE teacher_id = ? AND image_path = ?")
    .bind(caller.id, key)
    .first();
  if (reference)
    throw new HandwrittenError(
      "INVALID_INPUT",
      "Confirmed reference images cannot be deleted as student papers.",
    );
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
  .validator((data: unknown) => {
    const input = requireObject(data);
    return { assessmentId: requireString(input["assessmentId"]) };
  })
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
  .validator((data: unknown) => {
    const input = requireObject(data);
    return {
      dataUrl: requireString(input["dataUrl"], 12_000_000),
      fileName: requireString(input["fileName"], 200),
    };
  })
  .handler(async ({ data, context }) =>
    uploadHandwrittenPaper(ctxDb(context), ctxCaller(context), await papersBucket(), data),
  );

export const previewHwGradeD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => parseSaveHandwrittenGradeInput(data))
  .handler(async ({ data, context }) => {
    const preview = await saveHandwrittenGrade(ctxDb(context), ctxCaller(context), data, {
      preview: true,
    });
    if (!preview.suggestion) throw new HandwrittenError("AI_ERROR");
    return { previewId: preview.id, suggestion: preview.suggestion };
  });

export const saveHwGradeD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => parseSaveHandwrittenGradeInput(data))
  .handler(async ({ data, context }) =>
    saveHandwrittenGrade(ctxDb(context), ctxCaller(context), data),
  );

export const deleteHwGradeD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    return { gradeId: requireString(input["gradeId"]) };
  })
  .handler(async ({ data, context }) =>
    deleteHandwrittenGrade(ctxDb(context), ctxCaller(context), await papersBucket(), data.gradeId),
  );

export const deleteHwPaperD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    return { key: requireString(input["key"], 500) };
  })
  .handler(async ({ data, context }) =>
    deleteHandwrittenPaper(ctxDb(context), ctxCaller(context), await papersBucket(), data.key),
  );

export const getHwPaperD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    return { gradeId: requireString(input["gradeId"]) };
  })
  .handler(async ({ data, context }) =>
    getHandwrittenPaper(ctxDb(context), ctxCaller(context), await papersBucket(), data.gradeId),
  );

export const listHwReferencesD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listPaperReferences(ctxDb(context), ctxCaller(context)));
export const confirmHwReferenceD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => {
    const input = requireObject(data);
    const kind = requireString(input["kind"]);
    if (kind !== "written" && kind !== "bubble") throw new HandwrittenError("INVALID_INPUT");
    return {
      title: requireString(input["title"], 200),
      kind: kind as "written" | "bubble",
      dataUrl: requireString(input["dataUrl"], 4_000_000),
      confirmedText: requireString(input["confirmedText"], 8000),
    };
  })
  .handler(async ({ data, context }) =>
    confirmPaperReference(ctxDb(context), ctxCaller(context), await papersBucket(), data),
  );

export const getHwReferenceImageD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => ({
    referenceId: requireString(requireObject(data)["referenceId"], 100),
  }))
  .handler(async ({ data, context }) => {
    const caller = ctxCaller(context);
    const reference = await getPaperReference(ctxDb(context), caller, data.referenceId);
    const bytes = await r2Get(await papersBucket(), caller.id, reference.image_path);
    if (!bytes) throw new HandwrittenError("NOT_FOUND");
    let bin = "";
    for (const byte of new Uint8Array(bytes)) bin += String.fromCharCode(byte);
    const ext = reference.image_path.split(".").pop();
    return `data:image/${ext === "png" ? "png" : ext === "webp" ? "webp" : "jpeg"};base64,${btoa(bin)}`;
  });
