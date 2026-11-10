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
  DurableObjectStateLike,
  SqlStorageLike,
} from "@/server/durable-object-types";
import {
  applyDraft,
  applyStart,
  applySubmit,
  flushDirty,
  flushOne,
  getSessionStatus,
  hydrateFromD1,
  TAKE_SESSION_FLUSH_BATCH,
  type DoAnswerState,
  type DoSubmissionState,
  type DraftInput,
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

class SqliteSessionStore implements SessionStore {
  constructor(private readonly sql: SqlStorageLike) {}

  private rows<T>(sqlText: string, ...params: unknown[]): T[] {
    return this.sql.exec<T>(sqlText, ...params).toArray();
  }

  async getSubmission(id: string): Promise<DoSubmissionState | null> {
    const rows = this.rows<DoSubmissionRow>(
      "SELECT * FROM do_submissions WHERE id = ?",
      id,
    );
    const row = rows[0];
    if (!row) return null;
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
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
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

export class TakeSession extends DurableObject {
  private readonly state: DurableObjectStateLike;
  private readonly env: CloudflareEnv;
  private readonly store: SqliteSessionStore;

  constructor(state: DurableObjectStateLike, env: unknown) {
    super(state, env);
    this.state = state;
    this.env = (env ?? {}) as CloudflareEnv;
    this.store = new SqliteSessionStore(state.storage.sql);
    // SQLite storage is synchronous: the schema is ready before the
    // first request is served.
    for (const statement of SCHEMA) state.storage.sql.exec(statement);
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
          const result = await applyStart(this.store, body as unknown as StartInput);
          await this.ensureFlushAlarm();
          return jsonResponse(result);
        }
        case "/draft": {
          const input = body as unknown as DraftInput;
          await this.ensureKnown(input.submissionId);
          const result = await applyDraft(this.store, input);
          await this.ensureFlushAlarm();
          return jsonResponse(result);
        }
        case "/submit": {
          const input = body as unknown as SubmitInput;
          await this.ensureKnown(input.submissionId);
          const result = await applySubmit(this.store, input);
          if (result.submitted) {
            // Immediate flush attempt (submits are spread over the
            // exam, not synchronized). On failure the row stays dirty
            // for the alarm flush — the submit is already acked.
            const db = this.db;
            const sub = await this.store.getSubmission(input.submissionId);
            if (db && sub) await flushOne(db, this.store, sub);
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
      return jsonResponse({ error: "INTERNAL" }, 500);
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
