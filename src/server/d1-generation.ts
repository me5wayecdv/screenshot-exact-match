/**
 * D1 generation (Phase 2 port of /assessments/generate's persistence).
 *
 * What this module does:
 * - listSubjects: the subject list the generate form offers. Subjects
 *   are names only; the old route read them without a teacher filter
 *   and this port keeps that read (no student data, no keys).
 * - uploadGenerationSource: the platform rule, mediated through R2 —
 *   a pasted-text source file / photo is persisted to the private
 *   generation-sources bucket FIRST, under
 *   {teacher_id}/{uuid}/{name} validated by src/server/d1-r2.ts,
 *   before any generation runs from it. A failed upload blocks the
 *   flow (the route aborts extraction, exactly as before). The
 *   server never trusts a client-supplied teacher id: the key's
 *   first segment is always the session teacher's id.
 * - saveGeneratedDraft: the D1 persistence for a generated draft.
 *   Generation NEVER publishes directly and NEVER writes final
 *   grades: the assessment is inserted with status = 'draft' only,
 *   questions are inserted without scores, and question_keys rows
 *   are teacher-only data written alongside them. The draft goes to
 *   teacher review (the existing /assessments/$id flow) before
 *   anything is published or graded.
 *
 * NOT migrated here (owned by another workstream, left on its old
 * path): the AI generation call itself (src/lib/generate-assessment.ts)
 * and source OCR (src/server/source-ocr.ts) still run against
 * Supabase. This module is the D1 persistence those calls must use
 * once they migrate; the generate route's AI submit still goes
 * through the legacy call today, and that gap is reported, not
 * hidden. The route's direct Supabase calls (subjects query and
 * source upload) are migrated to the wrappers below.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import type { R2BucketLike } from "@/server/d1";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { buildR2Key, r2Put, sourcesBucket } from "@/server/d1-r2";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export function isTeacherCaller(caller: Caller): boolean {
  const role = normalizeRole(caller.role);
  return role === "school_teacher" || role === "tutor" || role === "admin";
}

export class GenerationError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "GenerationError";
  }
}

function requireTeacher(caller: Caller): void {
  if (!isTeacherCaller(caller)) {
    throw new GenerationError("FORBIDDEN", "Generation is teacher-only.");
  }
}

export type SubjectRow = { id: string; name: string };

export async function listSubjects(db: D1Database, caller: Caller): Promise<SubjectRow[]> {
  requireTeacher(caller);
  const { results } = await db
    .prepare("SELECT id, name FROM subjects ORDER BY name LIMIT 200")
    .all<SubjectRow>();
  return results ?? [];
}

const SOURCE_EXTS = new Set(["pdf", "docx", "jpg", "jpeg", "png", "webp"]);
const MAX_SOURCE_DATA_URL_CHARS = 14_000_000;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Persist one generation source file to the private sources bucket
 * via mediated R2. `dataUrl` is the browser FileReader data URL for
 * the file; the extension is validated against the allowlist and
 * the key is built server-side from the session teacher id.
 */
export async function uploadGenerationSource(
  db: D1Database,
  caller: Caller,
  bucket: R2BucketLike,
  input: { dataUrl: string; fileName: string },
): Promise<string> {
  requireTeacher(caller);
  void db;
  const ext = (input.fileName.split(".").pop() ?? "").toLowerCase();
  if (!SOURCE_EXTS.has(ext)) {
    throw new GenerationError("INVALID_INPUT", "Unsupported source file type.");
  }
  if (!input.dataUrl || input.dataUrl.length > MAX_SOURCE_DATA_URL_CHARS) {
    throw new GenerationError("INVALID_INPUT", "Source file is missing or too large.");
  }
  const b64 = input.dataUrl.split(",", 2)[1];
  if (!b64) throw new GenerationError("INVALID_INPUT", "Source file is not a data URL.");
  const safeName = input.fileName.replace(/[\\/]/g, "_");
  const key = buildR2Key(caller.id, crypto.randomUUID(), safeName);
  await r2Put(bucket, caller.id, key, decodeBase64(b64));
  return key;
}

export type GeneratedQuestionInput = {
  type: "mcq" | "true_false" | "short_answer" | "written";
  prompt: string;
  options: string[];
  marks: number;
  difficulty?: string;
  /** Learning objective, preserved from generated drafts (Phase 2b). */
  objective?: string;
  correctAnswer: string;
  acceptedAlternatives?: string[];
  rubric?: string;
  explanation?: string;
};

export type SaveDraftInput = {
  title: string;
  subjectId: string | null;
  gradeLevel: string;
  questions: GeneratedQuestionInput[];
};

const QUESTION_TYPES = new Set(["mcq", "true_false", "short_answer", "written"]);

/**
 * Persist a generated assessment as a DRAFT for teacher review.
 * Never publishes, never writes final grades. The subject, when
 * given, must exist (any teacher's subject, mirroring the old
 * generate call, which looked the subject up by id without an
 * ownership filter — subjects are names, not student data).
 */
export async function saveGeneratedDraft(
  db: D1Database,
  caller: Caller,
  input: SaveDraftInput,
): Promise<{ assessmentId: string; questionCount: number }> {
  requireTeacher(caller);
  if (!input.title.trim()) throw new GenerationError("INVALID_INPUT", "Title is required.");
  if (input.questions.length < 1 || input.questions.length > 20) {
    throw new GenerationError("INVALID_INPUT", "Question count must be 1..20.");
  }
  for (const q of input.questions) {
    if (!QUESTION_TYPES.has(q.type) || !q.prompt.trim() || !(q.marks > 0)) {
      throw new GenerationError("INVALID_INPUT", "Invalid generated question.");
    }
  }
  if (input.subjectId) {
    const subj = await db
      .prepare("SELECT id FROM subjects WHERE id = ?")
      .bind(input.subjectId)
      .first<{ id: string }>();
    if (!subj) throw new GenerationError("NOT_FOUND", "Subject not found.");
  }
  const assessmentId = crypto.randomUUID();
  const stmts = [
    db
      .prepare(
        "INSERT INTO assessments " +
          "(id, teacher_id, subject_id, title, grade_level, instructions, status) " +
          "VALUES (?, ?, ?, ?, ?, '', 'draft')",
      )
      .bind(assessmentId, caller.id, input.subjectId, input.title.trim(), input.gradeLevel.trim()),
  ];
  input.questions.forEach((q, i) => {
    const questionId = crypto.randomUUID();
    stmts.push(
      db
        .prepare(
          "INSERT INTO questions " +
            "(id, assessment_id, prompt, type, options, difficulty, marks, position, objective) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          questionId,
          assessmentId,
          q.prompt.trim(),
          q.type,
          JSON.stringify(q.options ?? []),
          q.difficulty ?? "mixed",
          q.marks,
          i,
          q.objective ?? "",
        ),
      db
        .prepare(
          "INSERT INTO question_keys " +
            "(question_id, correct_answer, accepted_alternatives, rubric, explanation) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          questionId,
          q.correctAnswer,
          JSON.stringify(q.acceptedAlternatives ?? []),
          q.rubric ?? "",
          q.explanation ?? "",
        ),
    );
  });
  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();
  return { assessmentId, questionCount: input.questions.length };
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

export const listSubjectsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listSubjects(ctxDb(context), ctxCaller(context)));

export const uploadGenerationSourceD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { dataUrl: string; fileName: string })
  .handler(async ({ data, context }) =>
    uploadGenerationSource(ctxDb(context), ctxCaller(context), await sourcesBucket(), data),
  );

export const saveGeneratedDraftD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as SaveDraftInput)
  .handler(async ({ data, context }) =>
    saveGeneratedDraft(ctxDb(context), ctxCaller(context), data),
  );
