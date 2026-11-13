// @vitest-environment node
/**
 * Tests for AI-F4: AI grading suggestions must be persisted so grading
 * accuracy is measurable from data.
 *
 * - persistAiSuggestion (src/server/ai-grade.ts) writes the suggestion
 *   JSON into answers.ai_suggestion, best-effort, only for rows the
 *   calling teacher owns (admins exempt), and never throws.
 * - logAiUsageEvent (src/server/d1-quota.ts) carries the optional
 *   assessment_id / question_id / suggested_score linkage.
 * - schema/migrations/20261112_ai_suggestion_tracking.sql adds those
 *   three columns to ai_usage_events on an existing (pre-migration)
 *   database, and its PRECHECK file catches a double-apply.
 *
 * The persistence + usage tests run against a real in-memory SQLite
 * database (node:sqlite) behind a minimal D1Database adapter, so the
 * exact SQL the server code issues is what gets exercised.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { persistAiSuggestion, type AiGradeSuggestion } from "@/server/ai-grade";
import { logAiUsageEvent } from "@/server/d1-quota";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const readRepo = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

const MIGRATION = readRepo("schema/migrations/20261112_ai_suggestion_tracking.sql");
const PRECHECK = readRepo("schema/migrations/20261112_ai_suggestion_tracking.PRECHECK.sql");
const BASE_SCHEMA = readRepo("schema/d1-schema.sql");
const AUTH_SCHEMA = readRepo("schema/d1-auth.sql");

const SUGGESTION: AiGradeSuggestion = {
  suggestedScore: 7.5,
  feedback: "إجابة جيدة مع خطأ بسيط.",
  confidence: "high",
};

/** Minimal D1Database adapter over an in-memory SQLite database. */
function sqliteD1(db: DatabaseSync): D1Database {
  const prepare = (sql: string): D1Statement => {
    const stmt = db.prepare(sql);
    let params: SQLInputValue[] = [];
    const s: D1Statement = {
      bind(...p: unknown[]) {
        params = p as SQLInputValue[];
        return s;
      },
      async first<T>() {
        const row = stmt.get(...params) as T | undefined;
        return row ?? null;
      },
      async all<T>() {
        return { results: stmt.all(...params) as T[] };
      },
      async run() {
        const info = stmt.run(...params);
        return { meta: { changes: info.changes } };
      },
    };
    return s;
  };
  return {
    prepare,
    async batch(statements: D1Statement[]) {
      const out: unknown[] = [];
      for (const st of statements) out.push(await st.run());
      return out;
    },
  };
}

/** Seed the ownership chain: teacher-1 owns ex1 -> sub-1 -> ans-1 (q-1). */
function seedOwnership(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE assessments (id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL);
    CREATE TABLE submissions (id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL);
    CREATE TABLE answers (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      ai_suggestion TEXT
    );
    CREATE TABLE ai_usage_events (
      id TEXT PRIMARY KEY,
      teacher_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      assessment_id TEXT,
      question_id TEXT,
      suggested_score REAL,
      created_at TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare("INSERT INTO assessments (id, teacher_id) VALUES ('ex1', 'teacher-1')").run();
  db.prepare("INSERT INTO assessments (id, teacher_id) VALUES ('ex2', 'teacher-2')").run();
  db.prepare("INSERT INTO submissions (id, assessment_id) VALUES ('sub-1', 'ex1')").run();
  db.prepare("INSERT INTO submissions (id, assessment_id) VALUES ('sub-2', 'ex2')").run();
  db.prepare(
    "INSERT INTO answers (id, submission_id, question_id, ai_suggestion) VALUES ('ans-1', 'sub-1', 'q-1', NULL)",
  ).run();
  db.prepare(
    "INSERT INTO answers (id, submission_id, question_id, ai_suggestion) VALUES ('ans-2', 'sub-2', 'q-2', NULL)",
  ).run();
}

function readSuggestion(db: DatabaseSync, answerId: string): unknown {
  const row = db.prepare("SELECT ai_suggestion FROM answers WHERE id = ?").get(answerId) as
    { ai_suggestion: string | null } | undefined;
  return row?.ai_suggestion ? JSON.parse(row.ai_suggestion) : null;
}

/** Split a multi-statement SQL file into individual statements. */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

/** The base schema as it was BEFORE this finding: new columns stripped. */
function preMigrationSchema(): string {
  const start = BASE_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS ai_usage_events");
  const end = BASE_SCHEMA.indexOf(");", start);
  const block = BASE_SCHEMA.slice(start, end);
  const stripped = block
    .replace(/^\s*assessment_id TEXT,\n/m, "")
    .replace(/^\s*question_id TEXT,\n/m, "")
    .replace(/^\s*suggested_score REAL,\n/m, "");
  expect(stripped).not.toBe(block);
  return BASE_SCHEMA.slice(0, start) + stripped + BASE_SCHEMA.slice(end);
}

describe("persistAiSuggestion", () => {
  it("(a) persists the JSON suggestion on the owned answer row", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    const persisted = await persistAiSuggestion(
      db,
      { teacherId: "teacher-1", isAdmin: false },
      { answerId: "ans-1", submissionId: "sub-1", questionId: "q-1", assessmentId: "ex1" },
      SUGGESTION,
      "llama-3.3-70b",
    );

    expect(persisted).toBe(true);
    expect(readSuggestion(raw, "ans-1")).toEqual({
      suggested_score: 7.5,
      feedback: "إجابة جيدة مع خطأ بسيط.",
      confidence: "high",
      model: "llama-3.3-70b",
    });
    // No other row touched.
    expect(readSuggestion(raw, "ans-2")).toBeNull();
  });

  it("(a) persists via submissionId+questionId when no answerId is given", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    const persisted = await persistAiSuggestion(
      db,
      { teacherId: "teacher-1", isAdmin: false },
      { submissionId: "sub-1", questionId: "q-1", assessmentId: "ex1" },
      SUGGESTION,
      "llama-3.3-70b",
    );

    expect(persisted).toBe(true);
    expect(readSuggestion(raw, "ans-1")).toEqual({
      suggested_score: 7.5,
      feedback: "إجابة جيدة مع خطأ بسيط.",
      confidence: "high",
      model: "llama-3.3-70b",
    });
  });

  it("(b) without any ids it succeeds (returns false) and persists nothing", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    const persisted = await persistAiSuggestion(
      db,
      { teacherId: "teacher-1", isAdmin: false },
      {},
      SUGGESTION,
      "llama-3.3-70b",
    );

    expect(persisted).toBe(false);
    expect(readSuggestion(raw, "ans-1")).toBeNull();
    expect(readSuggestion(raw, "ans-2")).toBeNull();
  });

  it("(c) a forged answerId from another teacher does NOT persist", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    const persisted = await persistAiSuggestion(
      db,
      { teacherId: "teacher-2", isAdmin: false },
      { answerId: "ans-1", submissionId: "sub-1", questionId: "q-1", assessmentId: "ex1" },
      SUGGESTION,
      "llama-3.3-70b",
    );

    expect(persisted).toBe(false);
    expect(readSuggestion(raw, "ans-1")).toBeNull();
  });

  it("(c) a forged submissionId+questionId from another teacher does NOT persist", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    const persisted = await persistAiSuggestion(
      db,
      { teacherId: "teacher-2", isAdmin: false },
      { submissionId: "sub-1", questionId: "q-1" },
      SUGGESTION,
      "llama-3.3-70b",
    );

    expect(persisted).toBe(false);
    expect(readSuggestion(raw, "ans-1")).toBeNull();
  });

  it("(c) mismatched ids (answer from another submission) do NOT persist", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    const persisted = await persistAiSuggestion(
      db,
      { teacherId: "teacher-1", isAdmin: false },
      { answerId: "ans-1", submissionId: "sub-2", questionId: "q-1" },
      SUGGESTION,
      "llama-3.3-70b",
    );

    expect(persisted).toBe(false);
    expect(readSuggestion(raw, "ans-1")).toBeNull();
  });

  it("an admin may persist a suggestion for any teacher's answer", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    const persisted = await persistAiSuggestion(
      db,
      { teacherId: "admin-1", isAdmin: true },
      { answerId: "ans-1" },
      SUGGESTION,
      "llama-3.3-70b",
    );

    expect(persisted).toBe(true);
    expect(readSuggestion(raw, "ans-1")).not.toBeNull();
  });

  it("a nonexistent answerId resolves to false and never throws", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    await expect(
      persistAiSuggestion(
        db,
        { teacherId: "teacher-1", isAdmin: false },
        { answerId: "no-such-answer" },
        SUGGESTION,
        "llama-3.3-70b",
      ),
    ).resolves.toBe(false);
  });
});

describe("logAiUsageEvent linkage fields", () => {
  it("(d) carries assessment_id / question_id / suggested_score when supplied", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    await logAiUsageEvent(db, "teacher-1", {
      kind: "grade",
      provider: "cloudflare-openai",
      model: "llama-3.3-70b",
      inputTokens: 120,
      outputTokens: 45,
      assessmentId: "ex1",
      questionId: "q-1",
      suggestedScore: 7.5,
    });

    const row = raw.prepare("SELECT * FROM ai_usage_events").get() as Record<string, unknown>;
    expect(row["assessment_id"]).toBe("ex1");
    expect(row["question_id"]).toBe("q-1");
    expect(row["suggested_score"]).toBe(7.5);
    expect(row["kind"]).toBe("grade");
    expect(row["input_tokens"]).toBe(120);
  });

  it("(d) stores NULL linkage when the fields are not supplied", async () => {
    const raw = new DatabaseSync(":memory:");
    seedOwnership(raw);
    const db = sqliteD1(raw);

    await logAiUsageEvent(db, "teacher-1", {
      kind: "ocr",
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputTokens: 300,
      outputTokens: 80,
    });

    const row = raw.prepare("SELECT * FROM ai_usage_events").get() as Record<string, unknown>;
    expect(row["assessment_id"]).toBeNull();
    expect(row["question_id"]).toBeNull();
    expect(row["suggested_score"]).toBeNull();
  });
});

describe("20261112_ai_suggestion_tracking migration", () => {
  it("(e) applies cleanly to a DB built from the pre-migration schema", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(AUTH_SCHEMA);
    raw.exec(preMigrationSchema());
    expect(tableColumns(raw, "ai_usage_events")).not.toContain("assessment_id");

    raw.exec(MIGRATION);

    const cols = tableColumns(raw, "ai_usage_events");
    expect(cols).toContain("assessment_id");
    expect(cols).toContain("question_id");
    expect(cols).toContain("suggested_score");
  });

  it("(e) the base schema already carries the new columns (fresh DBs need no migration)", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(AUTH_SCHEMA);
    raw.exec(BASE_SCHEMA);
    const cols = tableColumns(raw, "ai_usage_events");
    expect(cols).toContain("assessment_id");
    expect(cols).toContain("question_id");
    expect(cols).toContain("suggested_score");
  });

  it("(f) applying the migration twice fails safely on the duplicate column", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(AUTH_SCHEMA);
    raw.exec(preMigrationSchema());
    raw.exec(MIGRATION);

    expect(() => raw.exec(MIGRATION)).toThrow(/duplicate column/i);
  });

  it("(f) the PRECHECK returns no rows before the migration and catches it after", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(AUTH_SCHEMA);
    raw.exec(preMigrationSchema());
    const checks = splitStatements(PRECHECK);
    expect(checks.length).toBeGreaterThanOrEqual(4);

    // The column-existence checks (all but the row-count sanity query).
    const columnChecks = checks.slice(0, -1);
    const runChecks = () => columnChecks.flatMap((sql) => raw.prepare(sql).all() as unknown[]);
    expect(runChecks()).toHaveLength(0);

    raw.exec(MIGRATION);
    const hits = runChecks();
    expect(hits.length).toBe(3);
    expect(hits.map((h) => (h as { check_name: string }).check_name).sort()).toEqual([
      "assessment_id_exists",
      "question_id_exists",
      "suggested_score_exists",
    ]);

    // Row-count sanity query still runs and returns one row.
    const sanitySql = checks[checks.length - 1];
    if (!sanitySql) throw new Error("PRECHECK has no row-count query");
    const sanity = raw.prepare(sanitySql).all() as unknown[];
    expect(sanity).toHaveLength(1);
  });

  it("the migration is additive only", () => {
    expect(MIGRATION).toMatch(/ALTER TABLE ai_usage_events ADD COLUMN assessment_id TEXT/i);
    expect(MIGRATION).toMatch(/ALTER TABLE ai_usage_events ADD COLUMN question_id TEXT/i);
    expect(MIGRATION).toMatch(/ALTER TABLE ai_usage_events ADD COLUMN suggested_score REAL/i);
    expect(MIGRATION).not.toMatch(/DROP TABLE|DELETE FROM|UPDATE ai_usage_events/i);
  });
});
