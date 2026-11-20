// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoGradeObjectiveOnSubmit, getTakeData } from "@/server/d1-take";
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
describe("teacher-only grading before complete publication", () => {
  it("hides legacy partial totals from the direct student API", async () => {
    const { db, sql } = fixture();
    sql.exec(
      "UPDATE submissions SET final_score=5, total_possible=10, released_at='2026-11-20T18:00:00Z'",
    );
    const data = await getTakeData(db, "student", "exam");
    expect(data.allowed).toBe(true);
    if (data.allowed) {
      expect(data.submissions[0]).toMatchObject({ status: "awaiting_review", final_score: null });
      expect(data.answersBySubmission["sub"]?.[0]).not.toHaveProperty("final_score");
    }
  });
  it("saves objective grades for the teacher, then publishes once after the essay is graded", async () => {
    const { db, sql, sub } = fixture();
    expect(await autoGradeObjectiveOnSubmit(db, "sub")).toBe("graded");
    expect(sub()).toMatchObject({
      status: "awaiting_review",
      final_score: null,
      total_possible: 20,
      released_at: null,
    });
    expect(sql.prepare("SELECT final_score FROM answers WHERE id='a1'").get()).toMatchObject({
      final_score: 5,
    });
    const open = await listGradingPage(db, "teacher", "awaiting_review", 0, 30);
    expect(open.submissions[0]).toMatchObject({ status: "awaiting_review", unscoredCount: 1 });
    await expect(releaseSubmission(db, "teacher", "sub", "")).rejects.toThrow();
    await reviewAnswer(db, "teacher", "a1", 3, "Correction", "approve");
    await setAutoScores(db, "teacher", "sub", [{ answerId: "a1", score: 5 }]);
    expect(sql.prepare("SELECT final_score FROM answers WHERE id='a1'").get()).toMatchObject({
      final_score: 3,
    });
    await reviewAnswer(db, "teacher", "a3", 8, "Good", "approve");
    expect(sub()).toMatchObject({ status: "approved", final_score: null, released_at: null });
    const full = await releaseSubmission(db, "teacher", "sub", "");
    expect(full).toMatchObject({ finalScore: 11, totalPossible: 20 });
    expect(sub()).toMatchObject({ status: "released", final_score: 11, total_possible: 20 });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM submissions").get()).toMatchObject({ n: 1 });
  });
  it("never auto-publishes an objective-only exam", async () => {
    const { db, sql, sub } = fixture();
    sql.exec("DELETE FROM answers WHERE id='a3'; DELETE FROM questions WHERE id='q3'");
    await autoGradeObjectiveOnSubmit(db, "sub");
    expect(sub()).toMatchObject({
      status: "approved",
      final_score: null,
      total_possible: 10,
      released_at: null,
    });
    expect((await releaseSubmission(db, "teacher", "sub", "")).finalScore).toBe(5);
  });
  it("materializes blank essays without inventing a score", async () => {
    const { db, sql } = fixture();
    sql.exec("DELETE FROM answers WHERE id='a3'");
    await autoGradeObjectiveOnSubmit(db, "sub");
    expect(
      sql
        .prepare("SELECT response, final_score, auto_score FROM answers WHERE question_id='q3'")
        .get(),
    ).toMatchObject({ response: "", final_score: null, auto_score: null });
    await expect(reviewAnswer(db, "stranger", "a1", 5, "", "approve")).rejects.toThrow("NOT_FOUND");
  });
});
