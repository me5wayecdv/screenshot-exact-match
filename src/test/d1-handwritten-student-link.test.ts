/**
 * Tests for the handwritten student link (2026-11-04 gap fix):
 * a paper-graded form can link a grade to an enrolled student account,
 * and the linked grade is visible to that student immediately on save
 * (handwritten grades are FINAL on save — no release step).
 *
 * Uses dispatch fakes for D1Database. No live D1 or R2 is required.
 */
import { describe, expect, it } from "vitest";
import {
  listApprovedHwStudents,
  listStudentHandwrittenGrades,
  saveHandwrittenGrade,
  type Caller,
} from "@/server/d1-handwritten";
import { getStudentHome } from "@/server/d1-assessments";
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

type HwLinkState = {
  assessments: Map<string, string>; // assessmentId -> teacherId
  questions: Map<string, { assessment_id: string }>;
  links: Map<string, string>; // `${teacherId}:${studentId}` -> status
  profiles: Map<string, string>; // id -> full_name
  grades: Map<string, Grade>;
};

function fakeDb(state: HwLinkState): D1Database {
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
        if (sql.includes("SELECT 1 AS ok FROM teacher_students")) {
          const status = state.links.get(`${params[0]}:${params[1]}`);
          return (status === "approved" ? { ok: 1 } : null) as T | null;
        }
        if (sql.includes("COUNT(*) AS n FROM teacher_students")) {
          const n = [...state.links.entries()].filter(
            ([k, v]) => k.endsWith(`:${params[0]}`) && v === "approved",
          ).length;
          return { n } as T | null;
        }
        if (sql.startsWith("SELECT full_name FROM profiles WHERE id")) {
          const name = state.profiles.get(params[0] as string);
          return (name !== undefined ? { full_name: name } : null) as T | null;
        }
        if (sql.includes("FROM profiles WHERE id")) {
          const name = state.profiles.get(params[0] as string);
          return (
            name !== undefined ? { full_name: name, parent_phone: null, whatsapp_consent: 0 } : null
          ) as T | null;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => {
        if (sql.includes("FROM handwritten_grades hg")) {
          const studentId = params[0] as string;
          const rows = [...state.grades.values()]
            .filter((g) => g.student_id === studentId)
            .map((g) => ({
              id: g.id,
              assessment_id: g.assessment_id,
              assessment_title: g.assessment_id ? `Assessment ${g.assessment_id}` : null,
              teacher_name: state.profiles.get(g.teacher_id) ?? "",
              final_score: g.final_score,
              max_marks: g.max_marks,
              // Mirrors the real SELECT: ai_feedback is never selected
              // for students (teacher-only), so it is absent here too.
              teacher_feedback: g.teacher_feedback,
              created_at: g.created_at,
            }));
          return { results: rows as unknown as T[] };
        }
        if (sql.includes("FROM teacher_students ts JOIN profiles")) {
          const teacherId = params[0] as string;
          const rows = [...state.links.entries()]
            .filter(([k, v]) => k.startsWith(`${teacherId}:`) && v === "approved")
            .map(([k]) => {
              const studentId = k.split(":")[1]!;
              return { id: studentId, full_name: state.profiles.get(studentId) ?? "" };
            })
            .sort((a, b) => a.full_name.localeCompare(b.full_name));
          return { results: rows as unknown as T[] };
        }
        if (sql.includes("FROM assessment_assignments aa JOIN assessments")) {
          return { results: [] };
        }
        if (sql.includes("FROM lesson_enrollments")) {
          return { results: [] };
        }
        if (sql.includes("FROM teacher_students ts LEFT JOIN profiles")) {
          return { results: [] };
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
            created_at: "2026-11-04T10:00:00.000Z",
          });
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

const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };
const OTHER_TEACHER: Caller = { id: "teacher-2", role: "school_teacher" };

function baseState(): HwLinkState {
  return {
    assessments: new Map([["assess-1", "teacher-1"]]),
    questions: new Map([["q-1", { assessment_id: "assess-1" }]]),
    links: new Map([
      ["teacher-1:student-1", "approved"],
      ["teacher-1:student-2", "pending"],
      ["teacher-2:student-3", "approved"],
    ]),
    profiles: new Map([
      ["teacher-1", "Mrs Ahmed"],
      ["teacher-2", "Mr Ali"],
      ["student-1", "Sara"],
      ["student-2", "Omar"],
      ["student-3", "Laila"],
    ]),
    grades: new Map(),
  };
}

function gradeInput(overrides: Record<string, unknown> = {}) {
  return {
    assessmentId: "assess-1",
    questionId: "q-1",
    studentId: null,
    studentName: "",
    imagePath: null,
    extractedText: "x",
    correctedText: "x",
    aiSuggestedScore: 8,
    aiFeedback: "good",
    aiModel: "gemini",
    maxMarks: 10,
    teacherFeedback: "",
    ...overrides,
  };
}

describe("handwritten student link", () => {
  it("saves a linked grade and makes it visible to that student", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const { id } = await saveHandwrittenGrade(
      db,
      TEACHER,
      gradeInput({ studentId: "student-1", studentName: "Sara" }),
    );
    const stored = state.grades.get(id);
    expect(stored?.student_id).toBe("student-1");
    expect(stored?.final_score).toBe(8);
    const visible = await listStudentHandwrittenGrades(db, "student-1");
    expect(visible.map((g) => g.id)).toEqual([id]);
    expect(visible[0]?.final_score).toBe(8);
    expect(visible[0]?.max_marks).toBe(10);
    // The saved grade HAS ai_feedback ("good"), but the student
    // surface must never return it.
    expect("ai_feedback" in (visible[0] ?? {})).toBe(false);
  });

  it("student handwritten grades never carry ai_feedback (teacher-only)", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const { id } = await saveHandwrittenGrade(
      db,
      TEACHER,
      gradeInput({ studentId: "student-1", studentName: "Sara" }),
    );
    // The stored row keeps the AI feedback for the teacher's history…
    expect(state.grades.get(id)?.ai_feedback).toBe("good");
    // …but neither student surface returns it.
    const visible = await listStudentHandwrittenGrades(db, "student-1");
    expect(visible.map((g) => g.id)).toEqual([id]);
    expect("ai_feedback" in (visible[0] ?? {})).toBe(false);
    expect(visible[0]?.final_score).toBe(8);
    const home = await getStudentHome(db, "student-1", 0, 0);
    expect(home.handwrittenGrades.map((g) => g.id)).toEqual([id]);
    expect("ai_feedback" in (home.handwrittenGrades[0] ?? {})).toBe(false);
  });

  it("a grade with no student stays unlinked and invisible to students", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const { id } = await saveHandwrittenGrade(db, TEACHER, gradeInput());
    expect(state.grades.get(id)?.student_id).toBeNull();
    expect(await listStudentHandwrittenGrades(db, "student-1")).toEqual([]);
    expect(await listStudentHandwrittenGrades(db, "student-2")).toEqual([]);
  });

  it("refuses a pending student and stores nothing", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await expect(
      saveHandwrittenGrade(db, TEACHER, gradeInput({ studentId: "student-2" })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(state.grades.size).toBe(0);
  });

  it("refuses another teacher's approved student", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await expect(
      saveHandwrittenGrade(db, TEACHER, gradeInput({ studentId: "student-3" })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(state.grades.size).toBe(0);
    // The other teacher CAN link their own approved student (ad-hoc
    // paper, so no assessment-ownership check is involved).
    const { id } = await saveHandwrittenGrade(
      db,
      OTHER_TEACHER,
      gradeInput({ assessmentId: null, questionId: null, studentId: "student-3" }),
    );
    expect(state.grades.get(id)?.student_id).toBe("student-3");
  });

  it("another student cannot see a linked grade", async () => {
    const state = baseState();
    const db = fakeDb(state);
    await saveHandwrittenGrade(
      db,
      TEACHER,
      gradeInput({ studentId: "student-1", studentName: "Sara" }),
    );
    expect(await listStudentHandwrittenGrades(db, "student-2")).toEqual([]);
    expect(await listStudentHandwrittenGrades(db, "student-3")).toEqual([]);
  });

  it("fills a blank paper name from the linked student's profile", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const { id } = await saveHandwrittenGrade(
      db,
      TEACHER,
      gradeInput({ studentId: "student-1", studentName: "" }),
    );
    expect(state.grades.get(id)?.student_name).toBe("Sara");
  });

  it("the selector lists approved students of this teacher only", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const mine = await listApprovedHwStudents(db, TEACHER);
    expect(mine.map((s) => s.id)).toEqual(["student-1"]);
    const theirs = await listApprovedHwStudents(db, OTHER_TEACHER);
    expect(theirs.map((s) => s.id)).toEqual(["student-3"]);
  });

  it("getStudentHome surfaces linked grades and never unlinked ones", async () => {
    const state = baseState();
    state.grades.set("grade-linked", {
      id: "grade-linked",
      teacher_id: "teacher-1",
      assessment_id: "assess-1",
      question_id: "q-1",
      student_id: "student-1",
      student_name: "Sara",
      image_path: null,
      extracted_text: "x",
      corrected_text: "x",
      ai_suggested_score: 9,
      ai_feedback: "great",
      ai_model: "gemini",
      final_score: 9,
      max_marks: 10,
      teacher_feedback: "",
      created_at: "2026-11-04T10:00:00.000Z",
    });
    state.grades.set("grade-unlinked", {
      id: "grade-unlinked",
      teacher_id: "teacher-1",
      assessment_id: "assess-1",
      question_id: "q-1",
      student_id: null,
      student_name: "Unknown",
      image_path: null,
      extracted_text: "x",
      corrected_text: "x",
      ai_suggested_score: 5,
      ai_feedback: null,
      ai_model: "gemini",
      final_score: 5,
      max_marks: 10,
      teacher_feedback: "",
      created_at: "2026-11-04T09:00:00.000Z",
    });
    const db = fakeDb(state);
    const home = await getStudentHome(db, "student-1", 0, 0);
    expect(home.handwrittenGrades.map((g) => g.id)).toEqual(["grade-linked"]);
    expect(home.handwrittenGrades[0]?.final_score).toBe(9);
    // The linked grade's stored ai_feedback ("great") must not leak
    // through the student home response.
    expect("ai_feedback" in (home.handwrittenGrades[0] ?? {})).toBe(false);
  });
});
