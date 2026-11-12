/**
 * D1 lessons (Phase 2 port of /lessons).
 *
 * Rules:
 * - Tutor-only for create/list: a tutor owns their lessons
 *   (lessons.tutor_id = caller). The list query filters by tutor_id
 *   in SQL; a tutor never sees another tutor's lessons or counts.
 * - Enrollment counts are the old `tutor_lesson_enrollment_counts`
 *   RPC, ported: counts per lesson id, capped at 50 lessons, only
 *   for lessons the caller owns (the join re-checks tutor_id).
 * - Join codes: D1 has no generated default (see schema/d1-schema.sql
 *   header), so application code generates the 6-character lesson
 *   code from crypto randomness and retries on UNIQUE violation,
 *   mirroring the teacher-code retry pattern in d1-auth-store.
 * - Subjects are looked up by id only (names, not student data), and are
 *   owner-scoped: a tutor only ever sees or attaches their own subjects
 *   (subjects.teacher_id = caller), mirroring the assessment flow.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export class LessonError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "LessonError";
  }
}

function requireTutor(caller: Caller): void {
  if (normalizeRole(caller.role) !== "tutor") {
    throw new LessonError("FORBIDDEN");
  }
}

function newLessonJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export type LessonRow = {
  id: string;
  title: string;
  description: string;
  subject_id: string | null;
  join_code: string;
  created_at: string;
};

export type SubjectRow = { id: string; name: string };

export type LessonList = {
  lessons: LessonRow[];
  subjects: SubjectRow[];
  enrollments: { lesson_id: string; student_count: number }[];
  hasNext: boolean;
};

export async function listTutorLessons(
  db: D1Database,
  caller: Caller,
  page: number,
  pageSize: number = 20,
): Promise<LessonList> {
  requireTutor(caller);
  const safePage = Math.max(0, Math.floor(page) || 0);
  const { results: lessonRows } = await db
    .prepare(
      "SELECT id, title, description, subject_id, join_code, created_at " +
        "FROM lessons WHERE tutor_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(caller.id, pageSize + 1, safePage * pageSize)
    .all<LessonRow>();
  const rows = lessonRows ?? [];
  const lessons = rows.slice(0, pageSize);
  const { results: subjects } = await db
    .prepare("SELECT id, name FROM subjects WHERE teacher_id = ? ORDER BY name LIMIT 200")
    .bind(caller.id)
    .all<SubjectRow>();
  let enrollments: LessonList["enrollments"] = [];
  if (lessons.length > 0) {
    const ids = lessons.slice(0, 50).map((l) => l.id);
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        "SELECT l.id AS lesson_id, COUNT(e.student_id) AS student_count " +
          "FROM lessons l LEFT JOIN lesson_enrollments e ON e.lesson_id = l.id " +
          `WHERE l.tutor_id = ? AND l.id IN (${placeholders}) GROUP BY l.id LIMIT 50`,
      )
      .bind(caller.id, ...ids)
      .all<{ lesson_id: string; student_count: number }>();
    enrollments = results ?? [];
  }
  return {
    lessons,
    subjects: subjects ?? [],
    enrollments,
    hasNext: rows.length > pageSize,
  };
}

export type CreateLessonInput = {
  title: string;
  description: string;
  subjectId: string | null;
};

export async function createLesson(
  db: D1Database,
  caller: Caller,
  input: CreateLessonInput,
): Promise<{ id: string; joinCode: string }> {
  requireTutor(caller);
  if (!input.title.trim()) throw new LessonError("INVALID_INPUT");
  if (input.subjectId) {
    const subj = await db
      .prepare("SELECT id FROM subjects WHERE id = ? AND teacher_id = ?")
      .bind(input.subjectId, caller.id)
      .first<{ id: string }>();
    if (!subj) throw new LessonError("NOT_FOUND");
  }
  const id = crypto.randomUUID();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const joinCode = newLessonJoinCode();
    try {
      await db
        .prepare(
          "INSERT INTO lessons (id, tutor_id, subject_id, title, description, join_code) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          caller.id,
          input.subjectId,
          input.title.trim(),
          input.description.trim(),
          joinCode,
        )
        .run();
      return { id, joinCode };
    } catch (e) {
      // Only a join-code collision is worth retrying with a fresh code;
      // any other failure (bad input, DB down) must surface at once
      // instead of being retried four more times and then rethrown.
      const collision =
        e instanceof Error && /UNIQUE constraint failed: lessons\.join_code/i.test(e.message);
      if (!collision) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new LessonError("INVALID_INPUT");
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

export const listTutorLessonsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { page: number })
  .handler(async ({ data, context }) =>
    listTutorLessons(ctxDb(context), ctxCaller(context), data.page),
  );

export const createLessonD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as CreateLessonInput)
  .handler(async ({ data, context }) => createLesson(ctxDb(context), ctxCaller(context), data));
