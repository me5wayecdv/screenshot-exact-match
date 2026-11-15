// @vitest-environment node
import { describe, expect, it } from "vitest";
import { auditDb } from "./audit-sqlite-helper";
import { consumePasswordResetAtomic } from "@/server/d1-security-store";
import {
  addQuestion,
  deleteQuestion,
  updateQuestion,
  copyBankQuestion,
  moveQuestion,
} from "@/server/d1-assessments";
import { consumeAiQuota, refundAiQuota, getAiQuotaUsage } from "@/server/d1-quota";
import { getAssessmentReport, listReportQuestions } from "@/server/d1-report";
import { getAnalyticsOverview } from "@/server/d1-analytics";
import { listTutorAssessments } from "@/server/d1-tutor";

const at = "2026-11-15T10:00:00.000Z";
function resetDb() {
  const data = auditDb();
  data.sql.exec(
    `INSERT INTO password_reset_tokens(id,user_id,token_hash,purpose,expires_at) VALUES('r','t','hash','reset','2099-01-01T00:00:00.000Z'); INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES('sess','t','sessionhash','2099-01-01T00:00:00.000Z')`,
  );
  return data;
}
const reset = { tokenId: "r", userId: "t", passwordHash: "synthetic-hash-only", atIso: at };
describe("Atomic one-use password reset", () => {
  it("updates password, consumes token and revokes sessions together", async () => {
    const { db, sql } = resetDb();
    expect(await consumePasswordResetAtomic(db, reset)).toBe(true);
    expect(await consumePasswordResetAtomic(db, { ...reset, passwordHash: "second-hash" })).toBe(
      false,
    );
    expect(
      sql.prepare("SELECT password_hash FROM auth_users WHERE id='t'").get()?.["password_hash"],
    ).toBe(reset.passwordHash);
    expect(
      sql.prepare("SELECT revoked_at FROM auth_sessions WHERE id='sess'").get()?.["revoked_at"],
    ).toBe(at);
  });
  it("rolls all changes back if session revocation fails", async () => {
    const { db, sql } = resetDb();
    sql.exec(
      "CREATE TRIGGER fail_revoke BEFORE UPDATE ON auth_sessions BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
    );
    await expect(consumePasswordResetAtomic(db, reset)).rejects.toThrow("injected failure");
    expect(
      sql.prepare("SELECT password_hash FROM auth_users WHERE id='t'").get()?.["password_hash"],
    ).toBeNull();
    expect(
      sql.prepare("SELECT used_at FROM password_reset_tokens WHERE id='r'").get()?.["used_at"],
    ).toBeNull();
  });
  it("fails closed when transactions unavailable or token expired", async () => {
    const { db, sql } = resetDb();
    await expect(consumePasswordResetAtomic({ prepare: db.prepare }, reset)).rejects.toThrow(
      "ATOMIC_RESET_UNAVAILABLE",
    );
    sql.exec("UPDATE password_reset_tokens SET expires_at='2000-01-01'");
    expect(await consumePasswordResetAtomic(db, reset)).toBe(false);
  });
});
describe("Server-side exam history lock", () => {
  it.each(["in_progress", "awaiting_review", "released"])(
    "refuses every question mutation after %s",
    async (status) => {
      const { db, sql } = auditDb();
      sql
        .prepare(
          "INSERT INTO submissions(id,assessment_id,student_id,status,final_score,total_possible) VALUES('sub','e','s',?,8,10)",
        )
        .run(status);
      sql.exec(
        "INSERT INTO answers(id,submission_id,question_id,response,max_marks,final_score) VALUES('a','sub','q','original answer',10,8)",
      );
      const operations = [
        () => addQuestion(db, "t", "e", "written"),
        () => deleteQuestion(db, "t", "q"),
        () => moveQuestion(db, "t", "q", 1),
        () => copyBankQuestion(db, "t", "e", "q", 1),
        () =>
          updateQuestion(db, "t", "q", {
            prompt: "changed",
            marks: 20,
            type: "written",
            objective: "",
            options: [],
            difficulty: "easy",
            correctAnswer: "",
            acceptedAlternatives: [],
            rubric: "changed",
            explanation: "",
          }),
      ];
      for (const op of operations) await expect(op()).rejects.toThrow("HAS_SUBMISSIONS");
      expect(sql.prepare("SELECT response FROM answers").get()?.["response"]).toBe(
        "original answer",
      );
      expect(sql.prepare("SELECT marks FROM questions").get()?.["marks"]).toBe(10);
    },
  );
  it("allows editing an exam with no submissions", async () => {
    const { db, sql } = auditDb();
    await addQuestion(db, "t", "e", "short_answer");
    expect(sql.prepare("SELECT COUNT(*) AS n FROM questions").get()?.["n"]).toBe(2);
  });
});
describe("Question edit transaction boundaries", () => {
  const update = {
    prompt: "changed",
    marks: 20,
    type: "written" as const,
    objective: "",
    options: [],
    difficulty: "easy",
    correctAnswer: "",
    acceptedAlternatives: [],
    rubric: "changed",
    explanation: "",
  };
  it("rolls back a question update if its key update fails", async () => {
    const { db, sql } = auditDb();
    sql.exec(
      "CREATE TRIGGER fail_key BEFORE UPDATE ON question_keys BEGIN SELECT RAISE(ABORT,'key failed'); END;",
    );
    await expect(updateQuestion(db, "t", "q", update)).rejects.toThrow("key failed");
    expect(sql.prepare("SELECT prompt FROM questions WHERE id='q'").get()?.["prompt"]).toBe(
      "original",
    );
  });
  it.each(["update", "delete", "add", "copy", "move"])(
    "refuses %s when a submission lands after precheck",
    async (op) => {
      const { db, sql } = auditDb();
      sql.exec(
        "INSERT INTO questions(id,assessment_id,prompt,type,marks,position) VALUES('q2','e','second','written',5,1)",
      );
      const guarded = {
        ...db,
        batch: async (statements: Parameters<NonNullable<typeof db.batch>>[0]) => {
          sql.exec(
            "INSERT INTO submissions(id,assessment_id,student_id,status) VALUES('race','e','s','in_progress')",
          );
          return db.batch!(statements);
        },
      };
      const work =
        op === "update"
          ? updateQuestion(guarded, "t", "q", update)
          : op === "delete"
            ? deleteQuestion(guarded, "t", "q")
            : op === "add"
              ? addQuestion(guarded, "t", "e", "written")
              : op === "copy"
                ? copyBankQuestion(guarded, "t", "e", "q", 2)
                : moveQuestion(guarded, "t", "q", 1);
      await expect(work).rejects.toThrow("HAS_SUBMISSIONS");
      expect(sql.prepare("SELECT COUNT(*) AS n FROM questions").get()?.["n"]).toBe(2);
      expect(sql.prepare("SELECT prompt,position FROM questions WHERE id='q'").get()).toMatchObject(
        { prompt: "original", position: 0 },
      );
    },
  );
});
describe("Quota original-window refunds", () => {
  it("does not debit newer minute or day usage", async () => {
    const { db } = auditDb();
    const old = "2026-11-14T23:59:00.000Z",
      next = "2026-11-15T00:00:00.000Z";
    await consumeAiQuota(db, "t", 5, old);
    await consumeAiQuota(db, "t", 2, next);
    await refundAiQuota(db, "t", 5, old, "old-request");
    expect(await getAiQuotaUsage(db, "t")).toEqual({ minuteUnits: 2, dayUnits: 2 });
  });
  it("refunds same-day usage but preserves newer minute", async () => {
    const { db } = auditDb();
    await consumeAiQuota(db, "t", 5, at);
    await consumeAiQuota(db, "t", 2, "2026-11-15T10:01:00.000Z");
    await refundAiQuota(db, "t", 5, at, "old-request");
    expect(await getAiQuotaUsage(db, "t")).toEqual({ minuteUnits: 2, dayUnits: 2 });
  });
});
describe("Larger-class D1 query caps", () => {
  it("reads complete reports for500students and attempts without exceeding100binds", async () => {
    const { db, sql } = auditDb();
    for (let i = 0; i < 500; i++) {
      sql
        .prepare("INSERT INTO auth_users(id,email,status) VALUES(?,?,'approved')")
        .run("s" + i, `s${i}@example.invalid`);
      sql.prepare("INSERT INTO profiles(id,full_name) VALUES(?,?)").run("s" + i, "Student " + i);
      sql
        .prepare(
          "INSERT INTO submissions(id,assessment_id,student_id,status) VALUES(?,'e',?,'released')",
        )
        .run("sub" + i, "s" + i);
      sql
        .prepare(
          "INSERT INTO answers(id,submission_id,question_id,response,max_marks) VALUES(?,?,'q','answer',10)",
        )
        .run("a" + i, "sub" + i);
    }
    const caller = { id: "t", role: "school_teacher" };
    const report = await getAssessmentReport(db, caller, "e");
    expect(Object.keys(report.names)).toHaveLength(500);
    expect((await listReportQuestions(db, caller, "e")).answers).toHaveLength(500);
  });
  it("handles100overview ids and150tutor assessment ids", async () => {
    const { db, sql } = auditDb();
    const ids = [];
    for (let i = 0; i < 150; i++) {
      ids.push("e" + i);
      sql
        .prepare(
          "INSERT INTO assessments(id,teacher_id,title,status) VALUES(?,'t','test','published')",
        )
        .run("e" + i);
      sql
        .prepare(
          "INSERT INTO submissions(id,assessment_id,student_id,status) VALUES(?,?,'s','released')",
        )
        .run("sub" + i, "e" + i);
    }
    expect(
      await getAnalyticsOverview(db, { id: "t", role: "school_teacher" }, ids.slice(0, 100)),
    ).toHaveLength(100);
    expect(await listTutorAssessments(db, { id: "s", role: "student" }, ids)).toHaveLength(150);
  });
});
