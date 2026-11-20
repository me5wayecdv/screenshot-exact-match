// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoReleaseObjectiveOnSubmit } from "@/server/d1-take";
import {
  listGradingPage,
  reviewAnswer,
  releaseSubmission,
  setAutoScores,
} from "@/server/d1-grading";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync("schema/d1-auth.sql", "utf8"));
  sql.exec(readFileSync("schema/d1-schema.sql", "utf8"));
  sql.exec(`
    INSERT INTO auth_users (id,email) VALUES ('teacher','t@example.invalid'), ('student','s@example.invalid'), ('stranger','x@example.invalid');
    INSERT INTO profiles (id, full_name) VALUES ('teacher','Teacher'), ('student','Student'), ('stranger','Other');
    INSERT INTO assessments (id, teacher_id, title, status) VALUES ('exam','teacher','Mixed exam','published');
    INSERT INTO assessment_assignments VALUES ('exam','student');
    INSERT INTO questions (id, assessment_id, prompt, type, marks, position) VALUES
      ('q1','exam','MCQ','mcq',5,1), ('q2','exam','Short','short_answer',5,2), ('q3','exam','Essay','written',10,3);
    INSERT INTO question_keys (question_id, correct_answer) VALUES ('q1','B'), ('q2','Cairo');
    INSERT INTO submissions (id, assessment_id, student_id, status, total_possible) VALUES ('sub','exam','student','awaiting_review',20);
    INSERT INTO answers (id, submission_id, question_id, response, max_marks) VALUES
      ('a1','sub','q1','B',5), ('a2','sub','q2','wrong',5), ('a3','sub','q3','My essay',10);
  `);
  const db: D1Database = {
    prepare(query: string) {
      const st = sql.prepare(query);
      let params: SQLInputValue[] = [];
      const out: D1Statement = {
        bind(...values: unknown[]) {
          params = values as SQLInputValue[];
          return out;
        },
        async first<T>() {
          return (st.get(...params) as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: st.all(...params) as T[] };
        },
        async run() {
          const r = st.run(...params);
          return { meta: { changes: r.changes } };
        },
      };
      return out;
    },
    async batch(statements: D1Statement[]) {
      sql.exec("BEGIN");
      try {
        const result = [];
        for (const st of statements) result.push(await st.run());
        sql.exec("COMMIT");
        return result;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { sql, db, sub: () => sql.prepare("SELECT * FROM submissions WHERE id='sub'").get()! };
}
const FIRST = "2026-11-20T18:00:00.000Z";

describe("mixed exam partial publication against the real schema", () => {
  it("publishes the objective score without a schema change and stays in the teacher's open list", async () => {
    const { db, sub } = fixture();
    expect(await autoReleaseObjectiveOnSubmit(db, "sub", FIRST)).toBe("partial");
    expect(sub()).toMatchObject({
      status: "awaiting_review",
      final_score: 5,
      total_possible: 10,
      released_at: FIRST,
    });
    const open = await listGradingPage(db, "teacher", "awaiting_review", 0, 30);
    expect(open.submissions[0]).toMatchObject({ status: "partially_released", unscoredCount: 1 });
    expect((await listGradingPage(db, "teacher", "released", 0, 30)).submissions).toHaveLength(0);
    expect(
      (await listGradingPage(db, "stranger", "awaiting_review", 0, 30)).submissions,
    ).toHaveLength(0);
    expect(await autoReleaseObjectiveOnSubmit(db, "sub", FIRST)).toBeNull();
  });
  it("keeps pre-existing teacher overrides in every later partial-total refresh", async () => {
    const { db, sql, sub } = fixture();
    sql.exec("UPDATE answers SET final_score=3, review_status='approved' WHERE id='a1'");
    await autoReleaseObjectiveOnSubmit(db, "sub", FIRST);
    expect(sub()).toMatchObject({ final_score: 3, total_possible: 10 });
    expect(
      sql.prepare("SELECT final_score, auto_score, review_status FROM answers WHERE id='a1'").get(),
    ).toMatchObject({ final_score: 3, auto_score: 5, review_status: "approved" });
    await reviewAnswer(db, "teacher", "a3", 8, "Good", "approve");
    expect(sub()).toMatchObject({ final_score: 3, total_possible: 10 });
    await reviewAnswer(db, "teacher", "a1", 4, "Corrected", "approve");
    expect(sub()).toMatchObject({ final_score: 4, total_possible: 10 });
  });
  it("keeps essay scores unpublished until full release, then updates the same result and keeps first publication time", async () => {
    const { db, sub, sql } = fixture();
    await autoReleaseObjectiveOnSubmit(db, "sub", FIRST);
    await expect(releaseSubmission(db, "teacher", "sub", "")).rejects.toThrow("NOT_FULLY_GRADED");
    await reviewAnswer(db, "teacher", "a3", 8, "Good", "approve");
    expect(sub()).toMatchObject({ status: "awaiting_review", final_score: 5, total_possible: 10 });
    const full = await releaseSubmission(db, "teacher", "sub", "");
    expect(full).toMatchObject({ finalScore: 13, totalPossible: 20 });
    expect(sub()).toMatchObject({
      status: "released",
      final_score: 13,
      total_possible: 20,
      released_at: FIRST,
    });
    await reviewAnswer(db, "teacher", "a3", 9, "Correction", "approve");
    await releaseSubmission(db, "teacher", "sub", "");
    expect(sub()).toMatchObject({ final_score: 14, total_possible: 20, released_at: FIRST });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM submissions").get()).toMatchObject({ n: 1 });
  });
  it("teacher override wins over auto-grade, and the published objective score updates in place", async () => {
    const { db, sub, sql } = fixture();
    await autoReleaseObjectiveOnSubmit(db, "sub", FIRST);
    await reviewAnswer(db, "teacher", "a1", 3, "Correction", "approve");
    expect(sub()).toMatchObject({ final_score: 3, total_possible: 10 });
    await setAutoScores(db, "teacher", "sub", [{ answerId: "a1", score: 5 }]);
    expect(sql.prepare("SELECT final_score FROM answers WHERE id='a1'").get()).toMatchObject({
      final_score: 3,
    });
    await expect(reviewAnswer(db, "stranger", "a3", 10, "", "approve")).rejects.toThrow(
      "NOT_FOUND",
    );
  });
  it("materializes a blank essay for teacher grading without counting it as zero", async () => {
    const { db, sql, sub } = fixture();
    sql.exec("DELETE FROM answers WHERE id='a3'");
    await autoReleaseObjectiveOnSubmit(db, "sub", FIRST);
    const essay = sql.prepare("SELECT * FROM answers WHERE question_id='q3'").get()!;
    expect(essay).toMatchObject({
      response: "",
      final_score: null,
      auto_score: null,
      review_status: "not_graded",
    });
    expect(sub()).toMatchObject({ final_score: 5, total_possible: 10 });
    await reviewAnswer(db, "teacher", String(essay["id"]), 0, "Unanswered", "approve");
    expect((await releaseSubmission(db, "teacher", "sub", "")).finalScore).toBe(5);
  });
});
