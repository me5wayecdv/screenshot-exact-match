/**
 * TakeSession — the Durable Object for one exam's live take path
 * (Phase 4). One instance per assessment
 * (`TAKE_SESSIONS.idFromName(assessmentId)`); the Worker routes
 * start / draft / submit / status here, and this object holds the
 * live session in its own SQLite storage, flushing to D1 in the
 * background (alarm every 10s + an immediate flush attempt on
 * submit).
 *
 * This file is the thin runtime wrapper around the pure logic in
 * take-session-logic.ts: fetch routing, the SQLite store adapter,
 * the alarm, and lazy hydration from D1. It references the
 * `DurableObject` runtime global, so it is NOT unit-tested directly
 * (the global does not exist in vitest's node env) — it is verified
 * live (smoke + ladder), as the Phase 3 worker-entry wrapper was.
 *
 * The DO processes requests sequentially, so the getAlarm-then-
 * setAlarm check and the store operations never race each other.
 */

import type { D1Database } from "@/server/d1-auth-store";
import type { CloudflareEnv } from "@/server/d1";
import type {
  DurableObjectLike,
  DurableObjectStateLike,
  DurableObjectStorageLike,
  SqlStorageLike,
} from "@/server/durable-object-types";
import {
  applyDraft,
  applyStart,
  applySubmit,
  flushDirty,
  flushOne,
  getCachedMarks,
  getSessionStatus,
  hydrateFromD1,
  validateStart,
  TAKE_SESSION_FLUSH_BATCH,
  type DoAnswerState,
  type DoSubmissionState,
  type DraftInput,
  type ExamConfig,
  type ExamConfigStore,
  type SessionStore,
  type StartInput,
  type SubmitInput,
} from "@/server/take-session-logic";

/** Alarm cadence for the background D1 flush (DESIGN.md §5). */
const FLUSH_ALARM_DELAY_MS = 10_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS do_submissions (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    submitted_at TEXT,
    expires_at TEXT,
    question_order TEXT NOT NULL,
    total_possible INTEGER NOT NULL,
    draft_seq INTEGER NOT NULL DEFAULT 0,
    dirty INTEGER NOT NULL DEFAULT 1,
    flush_attempts INTEGER NOT NULL DEFAULT 0,
    flush_error TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS do_answers (
    submission_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    response TEXT NOT NULL DEFAULT '',
    max_marks INTEGER NOT NULL,
    time_spent_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (submission_id, question_id)
  )`,
  `CREATE INDEX IF NOT EXISTS do_submissions_dirty_idx
    ON do_submissions (dirty, updated_at)`,
  // V2 (DESIGN-V2.md): the per-exam config cache. One config row
  // (this DO is one exam), question marks, positive-only enrollment
  // (a missing row means "check D1", never "denied"), and the
  // per-student seed marker (pre-DO submissions imported once).
  `CREATE TABLE IF NOT EXISTS do_config (
    assessment_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    starts_at TEXT,
    due_at TEXT,
    max_attempts INTEGER NOT NULL,
    duration_minutes INTEGER,
    total_possible INTEGER NOT NULL,
    loaded_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS do_question_marks (
    question_id TEXT PRIMARY KEY,
    marks INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS do_enrolled (
    student_id TEXT PRIMARY KEY,
    checked_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS do_seeded_students (
    student_id TEXT PRIMARY KEY,
    seeded_at INTEGER NOT NULL
  )`,
];

/** SessionStore over the DO's SQLite storage (synchronous exec, so
 *  the async methods resolve immediately). Row types are declared
 *  (not Record<string, unknown>) so property access typechecks. */
type DoSubmissionRow = {
  id: string;
  assessment_id: string;
  student_id: string;
  status: string;
  attempt_number: number;
  started_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  question_order: string;
  total_possible: number;
  draft_seq: number;
  dirty: number;
  flush_attempts: number;
  flush_error: string | null;
  updated_at: string;
};

type DoAnswerRow = {
  question_id: string;
  response: string;
  max_marks: number;
  time_spent_seconds: number;
};

class SqliteSessionStore implements SessionStore, ExamConfigStore {
  private readonly sql: SqlStorageLike;
  private readonly storage: DurableObjectStorageLike;

  constructor(storage: DurableObjectStorageLike) {
    this.storage = storage;
    this.sql = storage.sql;
  }

  private rows<T>(sqlText: string, ...params: unknown[]): T[] {
    return this.sql.exec<T>(sqlText, ...params).toArray();
  }

  private toState(row: DoSubmissionRow): DoSubmissionState {
    return {
      id: row.id,
      assessmentId: row.assessment_id,
      studentId: row.student_id,
      status: row.status === "awaiting_review" ? "awaiting_review" : "in_progress",
      attemptNumber: row.attempt_number ?? 1,
      startedAt: row.started_at,
      submittedAt: row.submitted_at ?? null,
      expiresAt: row.expires_at ?? null,
      questionOrder: JSON.parse(row.question_order || "[]") as string[],
      totalPossible: row.total_possible ?? 0,
      draftSeq: row.draft_seq ?? 0,
      dirty: row.dirty === 1,
      flushAttempts: row.flush_attempts ?? 0,
      flushError: row.flush_error ?? null,
      updatedAt: row.updated_at,
    };
  }

  async getSubmission(id: string): Promise<DoSubmissionState | null> {
    const rows = this.rows<DoSubmissionRow>(
      "SELECT * FROM do_submissions WHERE id = ?",
      id,
    );
    const row = rows[0];
    if (!row) return null;
    return this.toState(row);
  }

  async getInProgressSubmission(
    studentId: string,
    assessmentId: string,
  ): Promise<DoSubmissionState | null> {
    const rows = this.rows<DoSubmissionRow>(
      "SELECT * FROM do_submissions WHERE student_id = ? AND assessment_id = ? " +
        "AND status = 'in_progress' ORDER BY attempt_number DESC LIMIT 1",
      studentId,
      assessmentId,
    );
    const row = rows[0];
    if (!row) return null;
    return this.toState(row);
  }

  async countSubmissions(studentId: string, assessmentId: string): Promise<number> {
    const rows = this.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM do_submissions WHERE student_id = ? AND assessment_id = ?",
      studentId,
      assessmentId,
    );
    return rows[0]?.n ?? 0;
  }

  async putSubmission(sub: DoSubmissionState): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO do_submissions " +
        "(id, assessment_id, student_id, status, attempt_number, started_at, submitted_at, " +
        "expires_at, question_order, total_possible, draft_seq, dirty, flush_attempts, " +
        "flush_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      sub.id,
      sub.assessmentId,
      sub.studentId,
      sub.status,
      sub.attemptNumber,
      sub.startedAt,
      sub.submittedAt,
      sub.expiresAt,
      JSON.stringify(sub.questionOrder),
      sub.totalPossible,
      sub.draftSeq,
      sub.dirty ? 1 : 0,
      sub.flushAttempts,
      sub.flushError,
      sub.updatedAt,
    );
  }

  async getAnswers(submissionId: string): Promise<DoAnswerState[]> {
    return this.rows<DoAnswerRow>(
      "SELECT question_id, response, max_marks, time_spent_seconds FROM do_answers " +
        "WHERE submission_id = ?",
      submissionId,
    ).map((row) => ({
      questionId: row.question_id,
      response: row.response ?? "",
      maxMarks: row.max_marks ?? 0,
      timeSpentSeconds: row.time_spent_seconds ?? 0,
    }));
  }

  async upsertAnswers(submissionId: string, answers: DoAnswerState[]): Promise<void> {
    for (const a of answers) {
      this.sql.exec(
        "INSERT INTO do_answers (submission_id, question_id, response, max_marks, " +
          "time_spent_seconds) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(submission_id, question_id) DO UPDATE SET " +
          "response = excluded.response, max_marks = excluded.max_marks, " +
          "time_spent_seconds = excluded.time_spent_seconds",
        submissionId,
        a.questionId,
        a.response,
        a.maxMarks,
        a.timeSpentSeconds,
      );
    }
  }

  async listDirty(limit: number): Promise<DoSubmissionState[]> {
    const rows = this.rows<DoSubmissionRow>(
      "SELECT * FROM do_submissions WHERE dirty = 1 ORDER BY updated_at ASC LIMIT ?",
      limit,
    );
    const out: DoSubmissionState[] = [];
    for (const row of rows) {
      const sub = await this.getSubmission(row.id);
      if (sub) out.push(sub);
    }
    return out;
  }

  async markClean(id: string): Promise<void> {
    this.sql.exec("UPDATE do_submissions SET dirty = 0 WHERE id = ?", id);
  }

  async bumpFlushAttempt(id: string, error: string): Promise<number> {
    this.sql.exec(
      "UPDATE do_submissions SET flush_attempts = flush_attempts + 1, flush_error = ? " +
        "WHERE id = ?",
      error,
      id,
    );
    const rows = this.rows<{ flush_attempts: number }>(
      "SELECT flush_attempts FROM do_submissions WHERE id = ?",
      id,
    );
    return rows[0]?.flush_attempts ?? 0;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // DO SQLite storage forbids raw BEGIN/COMMIT/SAVEPOINT SQL —
    // the storage transaction API is the only way to get a
    // transaction. (Raw BEGIN IMMEDIATE here 500'd every /start on
    // the first live deploy, 2026-11-10.)
    return this.storage.transaction(fn);
  }

  /* --------------------------------------- V2 config cache (DESIGN-V2.md) */

  async getConfig(): Promise<ExamConfig | null> {
    const rows = this.rows<{
      assessment_id: string;
      status: string;
      starts_at: string | null;
      due_at: string | null;
      max_attempts: number;
      duration_minutes: number | null;
      total_possible: number;
      loaded_at: number;
    }>("SELECT * FROM do_config LIMIT 1");
    const row = rows[0];
    if (!row) return null;
    return {
      assessmentId: row.assessment_id,
      status: row.status,
      startsAt: row.starts_at,
      dueAt: row.due_at,
      maxAttempts: row.max_attempts,
      durationMinutes: row.duration_minutes,
      totalPossible: row.total_possible,
      loadedAt: row.loaded_at,
    };
  }

  async setConfig(
    config: ExamConfig,
    marks: Record<string, number>,
    enrolledStudentIds: string[],
  ): Promise<void> {
    // One storage transaction so a crash cannot leave a fresh
    // config with a half-written enrolled set.
    await this.transaction(async () => {
      this.sql.exec("DELETE FROM do_config");
      this.sql.exec(
        "INSERT INTO do_config (assessment_id, status, starts_at, due_at, max_attempts, " +
          "duration_minutes, total_possible, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        config.assessmentId,
        config.status,
        config.startsAt,
        config.dueAt,
        config.maxAttempts,
        config.durationMinutes,
        config.totalPossible,
        config.loadedAt,
      );
      this.sql.exec("DELETE FROM do_question_marks");
      for (const [questionId, mark] of Object.entries(marks)) {
        this.sql.exec(
          "INSERT INTO do_question_marks (question_id, marks) VALUES (?, ?)",
          questionId,
          mark,
        );
      }
      this.sql.exec("DELETE FROM do_enrolled");
      for (const studentId of enrolledStudentIds) {
        this.sql.exec(
          "INSERT INTO do_enrolled (student_id, checked_at) VALUES (?, ?)",
          studentId,
          config.loadedAt,
        );
      }
    });
  }

  async getMarks(): Promise<Record<string, number>> {
    const marks: Record<string, number> = {};
    for (const row of this.rows<{ question_id: string; marks: number }>(
      "SELECT question_id, marks FROM do_question_marks",
    )) {
      marks[row.question_id] = row.marks;
    }
    return marks;
  }

  async getEnrolledCheckedAt(studentId: string): Promise<number | null> {
    const rows = this.rows<{ checked_at: number }>(
      "SELECT checked_at FROM do_enrolled WHERE student_id = ?",
      studentId,
    );
    return rows[0]?.checked_at ?? null;
  }

  async setEnrolled(studentId: string, checkedAt: number): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO do_enrolled (student_id, checked_at) VALUES (?, ?)",
      studentId,
      checkedAt,
    );
  }

  async isStudentSeeded(studentId: string): Promise<boolean> {
    const rows = this.rows<{ student_id: string }>(
      "SELECT student_id FROM do_seeded_students WHERE student_id = ?",
      studentId,
    );
    return rows.length > 0;
  }

  async setStudentSeeded(studentId: string, seededAt: number): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO do_seeded_students (student_id, seeded_at) VALUES (?, ?)",
      studentId,
      seededAt,
    );
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isTakeError(error: unknown): boolean {
  return error instanceof Error && /^TAKE_/.test(error.message);
}

/**
 * The DurableObject base class is a Worker runtime global — but
 * Cloudflare validates a deploy by executing the script in a context
 * where that global is not yet defined, so a bare `extends
 * DurableObject` fails the upload with "DurableObject is not
 * defined" (code 10021). Resolve the base lazily from globalThis
 * instead: at runtime the global is present and the class extends
 * the real base; anywhere else (deploy validation, node) the
 * fallback keeps module evaluation from throwing.
 */
type DurableObjectConstructor = new (
  state: DurableObjectStateLike,
  env: unknown,
) => DurableObjectLike;

const DurableObjectBase: DurableObjectConstructor =
  (
    globalThis as {
      DurableObject?: DurableObjectConstructor;
    }
  ).DurableObject ??
  (class {
    constructor(
      _state: DurableObjectStateLike,
      _env: unknown,
    ) {}
  } as DurableObjectConstructor);

export class TakeSession extends DurableObjectBase {
  private readonly state: DurableObjectStateLike;
  private readonly env: CloudflareEnv;
  private readonly store: SqliteSessionStore;

  constructor(state: DurableObjectStateLike, env: unknown) {
    super(state, env);
    this.state = state;
    this.env = (env ?? {}) as CloudflareEnv;
    // Diagnostic (Phase 4, 2026-11-10): the first live deploy 500'd
    // every /start at 0ms CPU with no stack in the dashboard. Log the
    // two facts that decide the cause before touching storage: whether
    // the runtime DurableObject global resolved, and whether this
    // class has SQLite storage (undefined = the v1 migration did not
    // enable it for this class).
    const globalKind = typeof (
      globalThis as { DurableObject?: unknown }
    ).DurableObject;
    const sqlKind = typeof state?.storage?.sql;
    console.error(
      `[TakeSession] construct: DurableObject global=${globalKind}, storage.sql=${sqlKind}`,
    );
    if (!state?.storage?.sql) {
      throw new Error(
        "TakeSession: SQLite storage unavailable — state.storage.sql is undefined (the DO migration did not enable SQLite storage for this class)",
      );
    }
    try {
      this.store = new SqliteSessionStore(state.storage);
      // SQLite storage is synchronous: the schema is ready before the
      // first request is served.
      for (const statement of SCHEMA) state.storage.sql.exec(statement);
    } catch (error) {
      console.error(
        "[TakeSession] construct failed:",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      throw error;
    }
  }

  private get db(): D1Database | null {
    return (this.env.DB as D1Database | undefined) ?? null;
  }

  /** Set the flush alarm when none is scheduled (called after every
   *  mutation that leaves dirty rows). */
  private async ensureFlushAlarm(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + FLUSH_ALARM_DELAY_MS);
    }
  }

  /** Hydrate an unknown submission from D1 (pre-DO rows, resumes
   *  after the cutover). Returns null when D1 has no such row. */
  private async hydrate(submissionId: string): Promise<DoSubmissionState | null> {
    const db = this.db;
    if (!db) return null;
    return hydrateFromD1(db, this.store, submissionId);
  }

  private async ensureKnown(submissionId: string): Promise<DoSubmissionState | null> {
    return (await this.store.getSubmission(submissionId)) ?? (await this.hydrate(submissionId));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      const body = (await request.json()) as Record<string, unknown>;
      switch (url.pathname) {
        case "/start": {
          // V2 (DESIGN-V2.md): validation runs HERE, against the
          // DO-side config cache — the Worker no longer pays ~8 D1
          // reads per start. The client sends no attempt values
          // anymore; validateStart computes them (or resumes).
          const input = body as unknown as {
            submissionId: string;
            studentId: string;
            assessmentId: string;
            questionOrder: string[];
            nowIso: string;
          };
          const db = this.db;
          if (!db) {
            throw new Error("TakeSession: D1 binding unavailable for start validation");
          }
          const validated = await validateStart(this.store, this.store, db, {
            studentId: input.studentId,
            assessmentId: input.assessmentId,
            nowIso: input.nowIso,
          });
          if ("existingId" in validated) {
            return jsonResponse({ queued: false, submissionId: validated.existingId });
          }
          const result = await applyStart(this.store, {
            submissionId: input.submissionId,
            studentId: input.studentId,
            assessmentId: input.assessmentId,
            questionOrder: input.questionOrder,
            attemptNumber: validated.attemptNumber,
            totalPossible: validated.totalPossible,
            expiresAt: validated.expiresAt,
            nowIso: input.nowIso,
          } satisfies StartInput);
          await this.ensureFlushAlarm();
          return jsonResponse({ queued: true, submissionId: result.submissionId });
        }
        case "/draft": {
          const input = body as unknown as DraftInput;
          await this.ensureKnown(input.submissionId);
          // V2: marks come from the DO-side cache, not the Worker's
          // per-draft D1 read. Unknown submissions throw TAKE_NOT_FOUND
          // in applyDraft before the marks are used, so {} is safe.
          const sub = await this.store.getSubmission(input.submissionId);
          const marks = sub
            ? await getCachedMarks(this.store, this.db, sub.assessmentId, Date.now())
            : {};
          const result = await applyDraft(this.store, { ...input, marks });
          await this.ensureFlushAlarm();
          return jsonResponse(result);
        }
        case "/submit": {
          const input = body as unknown as SubmitInput;
          await this.ensureKnown(input.submissionId);
          const sub = await this.store.getSubmission(input.submissionId);
          const marks = sub
            ? await getCachedMarks(this.store, this.db, sub.assessmentId, Date.now())
            : {};
          const result = await applySubmit(this.store, { ...input, marks });
          if (result.submitted) {
            // Immediate flush attempt (submits are spread over the
            // exam, not synchronized). On failure the row stays dirty
            // for the alarm flush — the submit is already acked.
            const db = this.db;
            const fresh = await this.store.getSubmission(input.submissionId);
            if (db && fresh) await flushOne(db, this.store, fresh);
          }
          await this.ensureFlushAlarm();
          return jsonResponse(result);
        }
        case "/status": {
          const input = body as unknown as {
            submissionId: string;
            studentId: string;
            assessmentId: string;
          };
          await this.ensureKnown(input.submissionId);
          const status = await getSessionStatus(this.store, input);
          // null = not in this DO and not in D1: the serverFn falls
          // back to the D1 getTakeStatus (redirect / failure lookup).
          return jsonResponse(status ?? { status: "pending" });
        }
        default:
          return jsonResponse({ error: "NOT_FOUND" }, 404);
      }
    } catch (error) {
      if (isTakeError(error)) {
        return jsonResponse({ error: (error as Error).message }, 400);
      }
      // Diagnostic (Phase 4, 2026-11-10): log the real error — the
      // dashboard shows only the 500 request line, no stack. Return
      // the message (not a bare "INTERNAL") so the caller surfaces it.
      console.error(
        "[TakeSession] fetch failed:",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return jsonResponse(
        { error: error instanceof Error ? error.message : "INTERNAL" },
        500,
      );
    }
  }

  /** Background flush: drain dirty rows to D1, re-arm while any
   *  remain. */
  override async alarm(): Promise<void> {
    const db = this.db;
    if (!db) return;
    const result = await flushDirty(db, this.store, TAKE_SESSION_FLUSH_BATCH);
    if (result.remaining) {
      await this.state.storage.setAlarm(Date.now() + FLUSH_ALARM_DELAY_MS);
    }
  }
}
