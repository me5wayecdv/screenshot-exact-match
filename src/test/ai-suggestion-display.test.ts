// @vitest-environment node
/**
 * Tests for the AI-F4 display fix: a suggestion the teacher generated on
 * /grading must survive a reload. The WRITE path (persistAiSuggestion)
 * already lands the suggestion JSON in answers.ai_suggestion — live-verified
 * 2026-11-14 (1 row on qemmini-live-db) — but getGradingDetail never
 * returned it, so after a reload the suggestion box was gone entirely.
 *
 * - getGradingDetail (src/server/d1-grading.ts) returns each answer's
 *   persisted suggestion as a parsed, validated `aiSuggestion` object
 *   (or null): the client renders it without a fresh AI call.
 * - The parse is defensive: corrupt JSON, a non-finite score, or a score
 *   outside the question's marks all resolve to null, never a throw.
 * - Ownership is unchanged: a non-owner teacher still gets NOT_FOUND and
 *   never sees another teacher's suggestion.
 *
 * Runs against a real in-memory SQLite database (node:sqlite) behind a
 * minimal D1Database adapter, so the exact SQL the server code issues is
 * what gets exercised.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getGradingDetail } from "@/server/d1-grading";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

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

/**
 * Seed: teacher-1 owns ex1 -> sub-1. Four written questions (10 marks
 * each); a1 carries a valid persisted suggestion, a2 has none, a3 has
 * corrupt JSON, a4 has a score above the question's marks.
 */
function seed(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE assessments (id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL);
    CREATE TABLE submissions (id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE questions (id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL, prompt TEXT NOT NULL, type TEXT NOT NULL, marks REAL NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE question_keys (question_id TEXT PRIMARY KEY, correct_answer TEXT, accepted_alternatives TEXT, rubric TEXT, explanation TEXT);
    CREATE TABLE answers (id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, question_id TEXT NOT NULL, response TEXT, max_marks REAL, auto_score REAL, final_score REAL, feedback TEXT, review_status TEXT, ai_suggestion TEXT);
    INSERT INTO assessments (id, teacher_id) VALUES ('ex1', 'teacher-1');
    INSERT INTO submissions (id, assessment_id, status) VALUES ('sub-1', 'ex1', 'awaiting_review');
    INSERT INTO questions (id, assessment_id, prompt, type, marks, position) VALUES
      ('q1', 'ex1', 'ما هي عاصمة المملكة العربية السعودية؟', 'written', 10, 1),
      ('q2', 'ex1', 'اشرح دورة الماء.', 'written', 10, 2),
      ('q3', 'ex1', 'ما الفرق بين الحمض والقاعدة؟', 'written', 10, 3),
      ('q4', 'ex1', 'اذكر ثلاثة كواكب.', 'written', 10, 4);
    INSERT INTO question_keys (question_id, correct_answer, accepted_alternatives, rubric, explanation)
      VALUES ('q1', NULL, '[]', 'العاصمة + أكبر مدينة', NULL);
    INSERT INTO answers (id, submission_id, question_id, response, max_marks, auto_score, final_score, feedback, review_status, ai_suggestion) VALUES
      ('a1', 'sub-1', 'q1', 'عاصمة المملكة العربية السعودية هي الرياض.', 10, NULL, NULL, '', 'not_graded',
       '{"suggested_score":10,"feedback":"الإجابة صحيحة ووافية.","confidence":"high","model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"}'),
      ('a2', 'sub-1', 'q2', 'الماء يتبخر ثم يتكاثف.', 10, NULL, NULL, '', 'not_graded', NULL),
      ('a3', 'sub-1', 'q3', 'الحمض حامض.', 10, NULL, NULL, '', 'not_graded', '{not json'),
      ('a4', 'sub-1', 'q4', 'الأرض والمريخ.', 10, NULL, NULL, '', 'not_graded',
       '{"suggested_score":99,"feedback":"مبالغ فيها.","confidence":"low","model":"m"}');
  `);
}

function freshDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  seed(db);
  return sqliteD1(db);
}

describe("AI-F4 display fix: getGradingDetail returns the persisted suggestion", () => {
  it("returns the persisted suggestion for an answer that has one", async () => {
    const detail = await getGradingDetail(freshDb(), "teacher-1", "sub-1");
    const a1 = detail.answers.find((a) => a.id === "a1");
    expect(a1?.aiSuggestion).toEqual({
      suggestedScore: 10,
      feedback: "الإجابة صحيحة ووافية.",
      confidence: "high",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
  });

  it("returns null when no suggestion was persisted for the answer", async () => {
    const detail = await getGradingDetail(freshDb(), "teacher-1", "sub-1");
    const a2 = detail.answers.find((a) => a.id === "a2");
    expect(a2?.aiSuggestion).toBeNull();
  });

  it("ignores corrupt persisted JSON instead of throwing", async () => {
    const detail = await getGradingDetail(freshDb(), "teacher-1", "sub-1");
    const a3 = detail.answers.find((a) => a.id === "a3");
    expect(a3?.aiSuggestion).toBeNull();
  });

  it("ignores a persisted score outside the question's marks", async () => {
    const detail = await getGradingDetail(freshDb(), "teacher-1", "sub-1");
    const a4 = detail.answers.find((a) => a.id === "a4");
    expect(a4?.aiSuggestion).toBeNull();
  });

  it("a non-owner teacher never sees the suggestion (NOT_FOUND)", async () => {
    await expect(getGradingDetail(freshDb(), "teacher-2", "sub-1")).rejects.toThrow("NOT_FOUND");
  });
});
