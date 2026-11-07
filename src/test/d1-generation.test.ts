/**
 * Tests for D1 generation (src/server/d1-generation.ts), using
 * dispatch fakes for D1Database and a fake R2 bucket object.
 */
import { describe, expect, it } from "vitest";
import {
  listSubjects,
  saveGeneratedDraft,
  uploadGenerationSource,
  type Caller,
} from "@/server/d1-generation";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type DraftState = {
  subjects: Map<string, string>;
  assessments: { id: string; teacher_id: string; status: string }[];
  questions: { assessment_id: string }[];
  keys: { question_id: string }[];
};

function fakeDb(state: DraftState): D1Database {
  const make = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => {
        if (sql.includes("FROM subjects WHERE id")) {
          const name = state.subjects.get(params[0] as string);
          return (name ? { id: params[0] } : null) as T | null;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => {
        if (sql.includes("FROM subjects ORDER BY name")) {
          return {
            results: [...state.subjects.entries()].map(([id, name]) => ({
              id,
              name,
            })) as unknown as T[],
          };
        }
        return { results: [] };
      },
      run: async () => {
        if (sql.includes("INSERT INTO assessments")) {
          state.assessments.push({
            id: params[0] as string,
            teacher_id: params[1] as string,
            status: "draft",
          });
        } else if (sql.includes("INSERT INTO questions")) {
          state.questions.push({ assessment_id: params[1] as string });
        } else if (sql.includes("INSERT INTO question_keys")) {
          state.keys.push({ question_id: params[0] as string });
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

const TEACHER: Caller = { id: "teacher-1", role: "tutor" };
const STUDENT: Caller = { id: "student-1", role: "student" };

const DOC_DATA_URL = `data:application/pdf;base64,${btoa("pdf-bytes")}`;

describe("D1 generation", () => {
  it("rejects students from subjects, upload and draft save", async () => {
    const db = fakeDb({ subjects: new Map(), assessments: [], questions: [], keys: [] });
    await expect(listSubjects(db, STUDENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      uploadGenerationSource(db, STUDENT, fakeBucket(), {
        dataUrl: DOC_DATA_URL,
        fileName: "a.pdf",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      saveGeneratedDraft(db, STUDENT, {
        title: "T",
        subjectId: null,
        gradeLevel: "1",
        questions: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a non-teacher cannot generate for another teacher's folder: the key is always the caller's", async () => {
    const db = fakeDb({ subjects: new Map(), assessments: [], questions: [], keys: [] });
    const bucket = fakeBucket();
    const key = await uploadGenerationSource(db, TEACHER, bucket, {
      dataUrl: DOC_DATA_URL,
      fileName: "lesson.pdf",
    });
    expect(key.startsWith("teacher-1/")).toBe(true);
    expect(key.split("/").length).toBe(3);
    expect(bucket.files.has(key)).toBe(true);
    await expect(
      uploadGenerationSource(db, TEACHER, bucket, { dataUrl: DOC_DATA_URL, fileName: "evil.exe" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("a draft is saved as draft only, never published, never with final grades", async () => {
    const state: DraftState = {
      subjects: new Map([["subj-1", "Math"]]),
      assessments: [],
      questions: [],
      keys: [],
    };
    const db = fakeDb(state);
    const { assessmentId, questionCount } = await saveGeneratedDraft(db, TEACHER, {
      title: "Quiz",
      subjectId: "subj-1",
      gradeLevel: "3",
      questions: [
        {
          type: "mcq",
          prompt: "2+2?",
          options: ["3", "4"],
          marks: 5,
          correctAnswer: "4",
          acceptedAlternatives: [],
          rubric: "",
          explanation: "",
        },
        {
          type: "written",
          prompt: "Explain.",
          options: [],
          marks: 5,
          correctAnswer: "any",
          acceptedAlternatives: [],
          rubric: "r",
          explanation: "",
        },
      ],
    });
    expect(questionCount).toBe(2);
    expect(state.assessments).toHaveLength(1);
    expect(state.assessments[0]?.id).toBe(assessmentId);
    expect(state.assessments[0]?.status).toBe("draft");
    expect(state.assessments[0]?.teacher_id).toBe("teacher-1");
    expect(state.questions).toHaveLength(2);
    expect(state.keys).toHaveLength(2);
  });

  it("refuses empty, oversized, and unknown-subject drafts", async () => {
    const state: DraftState = { subjects: new Map(), assessments: [], questions: [], keys: [] };
    const db = fakeDb(state);
    const one = {
      type: "mcq" as const,
      prompt: "?",
      options: [],
      marks: 1,
      correctAnswer: "x",
      acceptedAlternatives: [],
      rubric: "",
      explanation: "",
    };
    await expect(
      saveGeneratedDraft(db, TEACHER, {
        title: "T",
        subjectId: null,
        gradeLevel: "",
        questions: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      saveGeneratedDraft(db, TEACHER, {
        title: "T",
        subjectId: null,
        gradeLevel: "",
        questions: Array(21).fill(one),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      saveGeneratedDraft(db, TEACHER, {
        title: "T",
        subjectId: "missing",
        gradeLevel: "",
        questions: [one],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.assessments).toHaveLength(0);
  });
});
