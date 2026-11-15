// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { auditDb } from "./audit-sqlite-helper";
import { saveHandwrittenGrade, type SaveHandwrittenGradeInput } from "@/server/d1-handwritten";
const caller = { id: "t", role: "school_teacher" };
const input: SaveHandwrittenGradeInput = {
  assessmentId: "e",
  questionId: "q",
  studentId: null,
  studentName: "Synthetic paper",
  imagePath: null,
  extractedText: "answer",
  correctedText: "answer",
  aiSuggestedScore: 99,
  aiFeedback: "forged",
  aiModel: "forged",
  maxMarks: 10,
  teacherFeedback: "",
};
beforeEach(() => {
  process.env["GRADE_PREVIEW_SIGNING_KEY"] = "synthetic-test-key-only-000000000000000000000000";
  process.env["AI_BASE_URL"] = "http://localhost:11434/v1";
  process.env["AI_MODEL"] = "test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                suggested_score: 8,
                feedback: "Reviewed",
                confidence: "high",
              }),
            },
          },
        ],
      }),
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["GRADE_PREVIEW_SIGNING_KEY"];
  delete process.env["AI_BASE_URL"];
  delete process.env["AI_MODEL"];
});
describe("Signed paper preview persistence against actual schema", () => {
  it("uses one AIcall, idempotent retries and refuses replay after deletion", async () => {
    const { db, sql } = auditDb();
    const p = await saveHandwrittenGrade(db, caller, input, { preview: true });
    const saved = await saveHandwrittenGrade(db, caller, { ...input, previewId: p.id });
    expect(await saveHandwrittenGrade(db, caller, { ...input, previewId: p.id })).toEqual(saved);
    expect(sql.prepare("SELECT count(*) AS n FROM handwritten_grades").get()?.["n"]).toBe(1);
    expect(sql.prepare("SELECT final_score FROM handwritten_grades").get()?.["final_score"]).toBe(
      8,
    );
    expect(
      sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action='handwritten_grade'").get()?.[
        "n"
      ],
    ).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    sql.prepare("DELETE FROM handwritten_grades WHERE id=?").run(saved.id);
    await expect(
      saveHandwrittenGrade(db, caller, { ...input, previewId: p.id }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("refuses changed canonical criteria and cross-teacher token use", async () => {
    const { db, sql } = auditDb();
    const p = await saveHandwrittenGrade(db, caller, input, { preview: true });
    sql.exec("UPDATE question_keys SET rubric='changed' WHERE question_id='q'");
    await expect(
      saveHandwrittenGrade(db, caller, { ...input, previewId: p.id }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      saveHandwrittenGrade(db, { id: "s", role: "school_teacher" }, { ...input, previewId: p.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rolls back grade if audit fails and supports retry after failure", async () => {
    const { db, sql } = auditDb();
    const p = await saveHandwrittenGrade(db, caller, input, { preview: true });
    sql.exec(
      "CREATE TRIGGER fail_grade_audit BEFORE INSERT ON audit_log WHEN NEW.action='handwritten_grade' BEGIN SELECT RAISE(ABORT,'audit failed'); END;",
    );
    await expect(saveHandwrittenGrade(db, caller, { ...input, previewId: p.id })).rejects.toThrow(
      "audit failed",
    );
    expect(sql.prepare("SELECT count(*) AS n FROM handwritten_grades").get()?.["n"]).toBe(0);
    sql.exec("DROP TRIGGER fail_grade_audit");
    await saveHandwrittenGrade(db, caller, { ...input, previewId: p.id });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
