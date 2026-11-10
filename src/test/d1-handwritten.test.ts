/**
 * Tests for D1 handwritten grading (src/server/d1-handwritten.ts),
 * using dispatch fakes for D1Database and a fake R2 bucket object.
 * No live D1 or R2 is required.
 */
import { describe, expect, it } from "vitest";
import {
  deleteHandwrittenGrade,
  deleteHandwrittenPaper,
  getHandwrittenPaper,
  listHandwrittenHistory,
  listHandwrittenQuestions,
  saveHandwrittenGrade,
  uploadHandwrittenPaper,
  type Caller,
} from "@/server/d1-handwritten";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type Grade = {
  id: string;
  teacher_id: string;
  assessment_id: string | null;
  question_id: string | null;
  student_id: string | null;
  student_name: string;
  image_path: string | null;
  extracted_text: string;
  corrected_text: string;
  ai_suggested_score: number | null;
  ai_feedback: string | null;
  ai_model: string | null;
  final_score: number;
  max_marks: number;
  teacher_feedback: string;
  created_at: string;
};

type HwState = {
  assessments: Map<string, string>; // assessmentId -> teacherId
  questions: Map<
    string,
    {
      assessment_id: string;
      key: {
        correct_answer: string;
        accepted_alternatives: string;
        rubric: string;
        explanation: string;
      } | null;
    }
  >;
  grades: Map<string, Grade>;
  audits: string[];
};

function fakeDb(state: HwState): D1Database {
  const make = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => {
        if (sql.includes("FROM assessments WHERE id")) {
          const t = state.assessments.get(params[0] as string);
          return (t ? { teacher_id: t } : null) as T | null;
        }
        if (sql.includes("FROM questions WHERE id")) {
          const q = state.questions.get(params[0] as string);
          return (q ? { assessment_id: q.assessment_id } : null) as T | null;
        }
        if (sql.includes("FROM handwritten_grades WHERE id")) {
          const g = state.grades.get(params[0] as string);
          return (g ? { teacher_id: g.teacher_id, image_path: g.image_path } : null) as T | null;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => {
        if (sql.includes("FROM questions q LEFT JOIN question_keys")) {
          const assessmentId = params[0] as string;
          const rows = [...state.questions.entries()]
            .filter(([, q]) => q.assessment_id === assessmentId)
            .map(([id, q]) => ({
              id,
              prompt: "Q?",
              type: "written",
              marks: 10,
              position: 0,
              correct_answer: q.key?.correct_answer ?? null,
              accepted_alternatives: q.key?.accepted_alternatives ?? null,
              rubric: q.key?.rubric ?? null,
              explanation: q.key?.explanation ?? null,
            }));
          return { results: rows as unknown as T[] };
        }
        if (sql.includes("FROM handwritten_grades WHERE teacher_id")) {
          const rows = [...state.grades.values()].filter((g) => g.teacher_id === params[0]);
          return { results: rows as unknown as T[] };
        }
        return { results: [] };
      },
      run: async () => {
        if (sql.includes("INSERT INTO handwritten_grades")) {
          const [
            id,
            teacher_id,
            assessment_id,
            question_id,
            student_id,
            student_name,
            image_path,
            extracted_text,
            corrected_text,
            ai_suggested_score,
            ai_feedback,
            ai_model,
            final_score,
            max_marks,
            teacher_feedback,
          ] = params as [
            string,
            string,
            string | null,
            string | null,
            string | null,
            string,
            string | null,
            string,
            string,
            number,
            string | null,
            string | null,
            number,
            number,
            string,
          ];
          state.grades.set(id, {
            id,
            teacher_id,
            assessment_id,
            question_id,
            student_id,
            student_name,
            image_path,
            extracted_text,
            corrected_text,
            ai_suggested_score,
            ai_feedback,
            ai_model,
            final_score,
            max_marks,
            teacher_feedback,
            created_at: "2026-11-03T20:00:00.000Z",
          });
        } else if (sql.includes("DELETE FROM handwritten_grades")) {
          state.grades.delete(params[0] as string);
        } else if (sql.includes("INSERT INTO audit_log")) {
          state.audits.push(params[1] as string);
        }
        return { meta: { changes: 1 } };
      },
    };
    return stmt as unknown as D1Statement;
  };
  return {
    prepare: (sql: string) => make(sql),
    batch: async (stmts: D1Statement[]) => {
      for (const s of stmts) await s.run();
      return stmts.map(() => ({}));
    },
  } as unknown as D1Database;
}

function fakeBucket() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    put: async (key: string, value: unknown) => {
      files.set(key, value as Uint8Array);
    },
    get: async (key: string) => {
      const v = files.get(key);
      if (!v) return null;
      return { size: v.length, arrayBuffer: async () => v.buffer as ArrayBuffer };
    },
    delete: async (key: string) => {
      files.delete(key);
    },
  };
}

const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };
const OTHER_TEACHER: Caller = { id: "teacher-2", role: "school_teacher" };
const STUDENT: Caller = { id: "student-1", role: "student" };

function baseState(): HwState {
  const state: HwState = {
    assessments: new Map([["assess-1", "teacher-1"]]),
    questions: new Map([
      [
        "q-1",
        {
          assessment_id: "assess-1",
          key: { correct_answer: "42", accepted_alternatives: "[]", rubric: "r", explanation: "e" },
        },
      ],
    ]),
    grades: new Map([
      [
        "grade-1",
        {
          id: "grade-1",
          teacher_id: "teacher-1",
          assessment_id: "assess-1",
          question_id: "q-1",
          student_id: null,
          student_name: "Sara",
          image_path: "teacher-1/11111111-1111-1111-1111-111111111111/paper.jpg",
          extracted_text: "x",
          corrected_text: "x",
          ai_suggested_score: 8,
          ai_feedback: "good",
          ai_model: "gemini",
          final_score: 8,
          max_marks: 10,
          teacher_feedback: "",
          created_at: "2026-11-03T20:00:00.000Z",
        },
      ],
    ]),
    audits: [],
  };
  return state;
}

const TINY_JPEG = `data:image/jpeg;base64,${btoa("fake-jpeg-bytes")}`;

describe("D1 handwritten grading", () => {
  it("rejects students from every handwritten function", async () => {
    const db = fakeDb(baseState());
    await expect(listHandwrittenHistory(db, STUDENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listHandwrittenQuestions(db, STUDENT, "assess-1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      saveHandwrittenGrade(db, STUDENT, {
        assessmentId: null,
        questionId: null,
        studentName: "x",
        imagePath: null,
        extractedText: "x",
        correctedText: "x",
        aiSuggestedScore: 5,
        aiFeedback: null,
        aiModel: null,
        maxMarks: 10,
        teacherFeedback: "",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("teacher history still carries ai_feedback (teacher-only)", async () => {
    const db = fakeDb(baseState());
    const rows = await listHandwrittenHistory(db, TEACHER);
    expect(rows.map((r) => r.id)).toEqual(["grade-1"]);
    expect(rows[0]?.ai_feedback).toBe("good");
  });

  it("a teacher cannot read another teacher's questions (keys included)", async () => {
    const db = fakeDb(baseState());
    await expect(listHandwrittenQuestions(db, OTHER_TEACHER, "assess-1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const qs = await listHandwrittenQuestions(db, TEACHER, "assess-1");
    expect(qs[0]?.question_keys?.correct_answer).toBe("42");
  });

  it("a student cannot fetch another student's paper: only the owning teacher can", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const bucket = fakeBucket();
    bucket.files.set(
      "teacher-1/11111111-1111-1111-1111-111111111111/paper.jpg",
      new Uint8Array([1, 2, 3]),
    );
    await expect(getHandwrittenPaper(db, OTHER_TEACHER, bucket, "grade-1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(getHandwrittenPaper(db, STUDENT, bucket, "grade-1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const url = await getHandwrittenPaper(db, TEACHER, bucket, "grade-1");
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("upload builds a teacher-owned 3-segment R2 key via mediation", async () => {
    const db = fakeDb(baseState());
    const bucket = fakeBucket();
    const key = await uploadHandwrittenPaper(db, TEACHER, bucket, {
      dataUrl: TINY_JPEG,
      fileName: "paper.jpg",
    });
    expect(key.split("/")[0]).toBe("teacher-1");
    expect(key.split("/").length).toBe(3);
    expect(bucket.files.has(key)).toBe(true);
    await expect(
      uploadHandwrittenPaper(db, STUDENT, bucket, { dataUrl: TINY_JPEG, fileName: "paper.jpg" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("save forces the AI score as final and blocks a foreign-folder key", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await expect(
      saveHandwrittenGrade(db, TEACHER, {
        assessmentId: "assess-1",
        questionId: "q-1",
        studentName: "Ali",
        imagePath: null,
        extractedText: "x",
        correctedText: "x",
        aiSuggestedScore: null,
        aiFeedback: null,
        aiModel: null,
        maxMarks: 10,
        teacherFeedback: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      saveHandwrittenGrade(db, TEACHER, {
        assessmentId: "assess-1",
        questionId: "q-1",
        studentName: "Ali",
        imagePath: "teacher-2/11111111-1111-1111-1111-111111111111/paper.jpg",
        extractedText: "x",
        correctedText: "x",
        aiSuggestedScore: 7,
        aiFeedback: null,
        aiModel: null,
        maxMarks: 10,
        teacherFeedback: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_KEY" });
    const { id } = await saveHandwrittenGrade(db, TEACHER, {
      assessmentId: "assess-1",
      questionId: "q-1",
      studentName: "Ali",
      imagePath: null,
      extractedText: "x",
      correctedText: "x",
      aiSuggestedScore: 7,
      aiFeedback: "f",
      aiModel: "gemini",
      maxMarks: 10,
      teacherFeedback: "",
    });
    expect(state.grades.get(id)?.final_score).toBe(7);
    expect(state.audits).toContain("handwritten_grade");
  });

  it("queued-paper delete refuses a foreign-folder key", async () => {
    const db = fakeDb(baseState());
    const bucket = fakeBucket();
    const ownKey = "teacher-1/11111111-1111-1111-1111-111111111111/paper.jpg";
    bucket.files.set(ownKey, new Uint8Array([1]));
    await expect(
      deleteHandwrittenPaper(
        db,
        TEACHER,
        bucket,
        "teacher-2/11111111-1111-1111-1111-111111111111/paper.jpg",
      ),
    ).rejects.toThrow();
    expect(bucket.files.has(ownKey)).toBe(true);
    await deleteHandwrittenPaper(db, TEACHER, bucket, ownKey);
    expect(bucket.files.has(ownKey)).toBe(false);
  });

  it("delete refuses another teacher's grade and removes the owning paper", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const bucket = fakeBucket();
    bucket.files.set(
      "teacher-1/11111111-1111-1111-1111-111111111111/paper.jpg",
      new Uint8Array([9]),
    );
    await expect(
      deleteHandwrittenGrade(db, OTHER_TEACHER, bucket, "grade-1"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.grades.has("grade-1")).toBe(true);
    await deleteHandwrittenGrade(db, TEACHER, bucket, "grade-1");
    expect(state.grades.has("grade-1")).toBe(false);
    expect(bucket.files.has("teacher-1/11111111-1111-1111-1111-111111111111/paper.jpg")).toBe(
      false,
    );
    expect(state.audits).toContain("handwritten_grade_deleted");
  });
});
