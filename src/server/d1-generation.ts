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
 * MIGRATION NOTE: the AI generation call (src/lib/generate-assessment.ts)
 * and source OCR (src/server/source-ocr.ts) were migrated to D1 as
 * well; this module is the D1 persistence they use, and the generate
 * route no longer calls Supabase directly.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import type { R2BucketLike } from "@/server/d1";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { buildR2Key, r2Put, sourcesBucket } from "@/server/d1-r2";
import {
  compact,
  invalidInput,
  optionalString,
  optionalStringArray,
  requireEnum,
  requireNumber,
  requireObject,
  requireString,
  requireStringArray,
} from "@/server/validate";

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
    throw new GenerationError("FORBIDDEN");
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
    throw new GenerationError("INVALID_INPUT");
  }
  if (!input.dataUrl || input.dataUrl.length > MAX_SOURCE_DATA_URL_CHARS) {
    throw new GenerationError("INVALID_INPUT");
  }
  const b64 = input.dataUrl.split(",", 2)[1];
  if (!b64) throw new GenerationError("INVALID_INPUT");
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
 * Validate a client-supplied draft payload at the boundary. The
 * handler re-validates the content (marks range, prompt length, …);
 * this guarantees the SHAPE, so a malformed payload fails with a
 * translated INVALID_INPUT instead of a TypeError inside the handler.
 */
function parseSaveDraftInput(data: unknown): SaveDraftInput {
  const input = requireObject(data);
  const rawQuestions = input["questions"];
  if (!Array.isArray(rawQuestions) || rawQuestions.length > 20) invalidInput();
  const questions: GeneratedQuestionInput[] = rawQuestions.map((raw) => {
    const q = requireObject(raw);
    return compact({
      type: requireEnum(q["type"], ["mcq", "true_false", "short_answer", "written"] as const),
      prompt: requireString(q["prompt"], 10_000),
      options: optionalStringArray(q["options"], 50) ?? [],
      marks: requireNumber(q["marks"], { min: 0, max: 1000 }),
      difficulty: optionalString(q["difficulty"], 50),
      objective: optionalString(q["objective"], 500),
      correctAnswer: optionalString(q["correctAnswer"], 5000) ?? "",
      acceptedAlternatives: optionalStringArray(q["acceptedAlternatives"], 50),
      rubric: optionalString(q["rubric"], 5000),
      explanation: optionalString(q["explanation"], 5000),
    });
  });
  return {
    title: requireString(input["title"], 200),
    subjectId: optionalString(input["subjectId"]) ?? null,
    gradeLevel: optionalString(input["gradeLevel"], 100) ?? "",
    questions,
  };
}

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
  const title = input.title.trim();
  // Same 200-char cap the assessment editor enforces, so a generated
  // draft cannot create a title the editor would refuse to save.
  if (!title || title.length > 200) throw new GenerationError("INVALID_INPUT");
  if (input.questions.length < 1 || input.questions.length > 20) {
    throw new GenerationError("INVALID_INPUT");
  }
  for (const q of input.questions) {
    if (!QUESTION_TYPES.has(q.type) || !q.prompt.trim() || !(q.marks > 0)) {
      throw new GenerationError("INVALID_INPUT");
    }
  }
  if (input.subjectId) {
    const subj = await db
      .prepare("SELECT id FROM subjects WHERE id = ?")
      .bind(input.subjectId)
      .first<{ id: string }>();
    if (!subj) throw new GenerationError("NOT_FOUND");
  }
  const assessmentId = crypto.randomUUID();
  const stmts = [
    db
      .prepare(
        "INSERT INTO assessments " +
          "(id, teacher_id, subject_id, title, grade_level, instructions, status) " +
          "VALUES (?, ?, ?, ?, ?, '', 'draft')",
      )
      .bind(assessmentId, caller.id, input.subjectId, title, input.gradeLevel.trim()),
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
  .validator((data: unknown) => {
    const input = requireObject(data);
    return {
      dataUrl: requireString(input["dataUrl"], 12_000_000),
      fileName: requireString(input["fileName"], 200),
    };
  })
  .handler(async ({ data, context }) =>
    uploadGenerationSource(ctxDb(context), ctxCaller(context), await sourcesBucket(), data),
  );

export const saveGeneratedDraftD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => parseSaveDraftInput(data))
  .handler(async ({ data, context }) =>
    saveGeneratedDraft(ctxDb(context), ctxCaller(context), data),
  );
