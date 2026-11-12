/**
 * Tests for the AI-F2 server-verified handwritten save
 * (src/server/d1-handwritten.ts): the saved final score must come
 * from a fresh SERVER re-grade of the submitted corrected text
 * against the linked question's own keys — never from the
 * client-supplied suggestion, which is ignored for grading.
 *
 * Uses dispatch fakes for D1Database plus a stubbed global fetch
 * for the OpenAI-compatible grading endpoint (same vi.stubGlobal
 * pattern as src/test/gemini-vision.test.ts). No live D1, R2, or
 * AI provider is required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveHandwrittenGrade,
  type Caller,
  type SaveHandwrittenGradeInput,
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
      prompt: string;
      marks: number;
      key: {
        correct_answer: string;
        accepted_alternatives: string;
        rubric: string;
        explanation: string;
      } | null;
    }
  >;
  links: Map<string, string>; // "teacherId:studentId" -> status
  profiles: Map<string, string>;
  grades: Map<string, Grade>;
  audits: string[];
  auditDetails: string[];
  quotaUnits: number;
  quotaExhausted: boolean;
  usageEvents: Array<{ kind: string; model: string }>;
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
        if (sql.includes("LEFT JOIN question_keys")) {
          const q = state.questions.get(params[0] as string);
          if (!q) return null as T | null;
          return {
            prompt: q.prompt,
            marks: q.marks,
            correct_answer: q.key?.correct_answer ?? null,
            accepted_alternatives: q.key?.accepted_alternatives ?? null,
            rubric: q.key?.rubric ?? null,
            explanation: q.key?.explanation ?? null,
          } as T | null;
        }
        if (sql.includes("FROM questions WHERE id")) {
          const q = state.questions.get(params[0] as string);
          return (q ? { assessment_id: q.assessment_id } : null) as T | null;
        }
        if (sql.includes("FROM teacher_students")) {
          const status = state.links.get(`${params[0]}:${params[1]}`);
          return (status === "approved" ? { ok: 1 } : null) as T | null;
        }
        if (sql.includes("SELECT full_name FROM profiles")) {
          const name = state.profiles.get(params[0] as string);
          return (name ? { full_name: name } : null) as T | null;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => {
        return { results: [] as T[] };
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
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO audit_log")) {
          state.audits.push(params[1] as string);
          state.auditDetails.push(params[3] as string);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO ai_rate_limits")) {
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE ai_rate_limits")) {
          // consumeAiQuota's conditional UPDATE: 1 row when the
          // increment lands, 0 when the cap blocks it.
          if (state.quotaExhausted) return { meta: { changes: 0 } };
          state.quotaUnits += 1;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO ai_usage_events")) {
          state.usageEvents.push({ kind: params[2] as string, model: params[4] as string });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
    };
    return stmt as unknown as D1Statement;
  };
  return {
    prepare: (sql: string) => make(sql),
    batch: async (stmts: D1Statement[]) => {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out as never;
    },
  } as unknown as D1Database;
}

const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };

function baseState(): HwState {
  return {
    assessments: new Map([["assess-1", "teacher-1"]]),
    questions: new Map([
      [
        "q-1",
        {
          assessment_id: "assess-1",
          prompt: "What is 6 times 7?",
          marks: 10,
          key: {
            correct_answer: "42",
            accepted_alternatives: '["forty-two"]',
            rubric: "Correct product (10)",
            explanation: "6 x 7 = 42",
          },
        },
      ],
      [
        "q-nokey",
        {
          assessment_id: "assess-1",
          prompt: "Explain photosynthesis.",
          marks: 5,
          key: null,
        },
      ],
    ]),
    links: new Map(),
    profiles: new Map(),
    grades: new Map(),
    audits: [],
    auditDetails: [],
    quotaUnits: 0,
    quotaExhausted: false,
    usageEvents: [],
  };
}

function gradeInput(overrides: Partial<SaveHandwrittenGradeInput> = {}): SaveHandwrittenGradeInput {
  return {
    assessmentId: "assess-1",
    questionId: "q-1",
    studentName: "Ali",
    imagePath: null,
    extractedText: "ocr text",
    correctedText: "42",
    aiSuggestedScore: 8,
    aiFeedback: "client feedback",
    aiModel: "client-model",
    maxMarks: 10,
    teacherFeedback: "",
    ...overrides,
  };
}

/** OpenAI-compatible chat/completions payload returning one suggestion. */
function mockGradeFetch(score: number, feedback = "server feedback") {
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              suggested_score: score,
              feedback,
              confidence: "high",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    text: async () => "",
    headers: new Headers(),
    body: null,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as {
    mock: { calls: Array<[unknown, { body?: string }]> };
  };
}

function mockFailingFetch(status = 500) {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({ error: "boom" }),
    text: async () => "boom",
    headers: new Headers(),
    body: null,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The request body the grading call was sent, parsed as JSON. */
function gradeRequestBody(fetchMock: ReturnType<typeof mockGradeFetch>): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];
  expect(call).toBeDefined();
  return JSON.parse(call![1].body as string) as Record<string, unknown>;
}

describe("saveHandwrittenGrade server verification (AI-F2)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["AI_BASE_URL", "AI_MODEL", "AI_API_KEY"]) {
      savedEnv[key] = process.env[key];
    }
    // Local endpoint: configured without an API key.
    process.env["AI_BASE_URL"] = "http://localhost:11434/v1";
    process.env["AI_MODEL"] = "test-model";
    delete process.env["AI_API_KEY"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("a tampered client score is NOT saved — the server re-grade result lands", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const fetchMock = mockGradeFetch(7, "server feedback");
    const { id } = await saveHandwrittenGrade(
      db,
      TEACHER,
      gradeInput({ aiSuggestedScore: 100, aiFeedback: "tampered", aiModel: "tampered" }),
    );
    const stored = state.grades.get(id);
    expect(stored?.final_score).toBe(7);
    expect(stored?.ai_suggested_score).toBe(7);
    expect(stored?.ai_feedback).toBe("server feedback");
    expect(stored?.ai_model).toBe("test-model");
    expect(stored?.max_marks).toBe(10);
    // The re-grade consumed exactly 1 quota unit.
    expect(state.quotaUnits).toBe(1);
    expect(state.usageEvents).toEqual([{ kind: "grade", model: "test-model" }]);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("corrected text edited after Suggest is graded as the NEW text", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const fetchMock = mockGradeFetch(9);
    const { id } = await saveHandwrittenGrade(
      db,
      TEACHER,
      gradeInput({
        correctedText: "the edited answer is 42",
        aiSuggestedScore: 3,
        aiFeedback: "stale suggestion for the old text",
      }),
    );
    const body = gradeRequestBody(fetchMock);
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    const userContent = messages.find((m) => m.role === "user")?.content ?? "";
    expect(userContent).toContain("the edited answer is 42");
    expect(userContent).not.toContain("stale suggestion");
    const stored = state.grades.get(id);
    expect(stored?.corrected_text).toBe("the edited answer is 42");
    expect(stored?.final_score).toBe(9);
  });

  it("a server re-grade failure refuses the save and stores nothing", async () => {
    const state = baseState();
    const db = fakeDb(state);
    mockFailingFetch(500);
    await expect(saveHandwrittenGrade(db, TEACHER, gradeInput())).rejects.toMatchObject({
      code: "AI_ERROR",
    });
    expect(state.grades.size).toBe(0);
    expect(state.audits).toEqual([]);
  });

  it("an unconfigured AI provider refuses the save and stores nothing", async () => {
    const state = baseState();
    const db = fakeDb(state);
    delete process.env["AI_BASE_URL"];
    delete process.env["AI_MODEL"];
    const fetchMock = mockGradeFetch(7);
    await expect(saveHandwrittenGrade(db, TEACHER, gradeInput())).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });
    expect(state.grades.size).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("a spent quota refuses the save before any AI call", async () => {
    const state = baseState();
    state.quotaExhausted = true;
    const db = fakeDb(state);
    const fetchMock = mockGradeFetch(7);
    await expect(saveHandwrittenGrade(db, TEACHER, gradeInput())).rejects.toMatchObject({
      code: "AI_RATE_LIMIT",
    });
    expect(state.grades.size).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("a save without a linked question AND without ad-hoc criteria is refused", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const fetchMock = mockGradeFetch(7);
    await expect(
      saveHandwrittenGrade(db, TEACHER, gradeInput({ questionId: null, assessmentId: null })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(state.grades.size).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("an ad-hoc paper (no linked question) is re-graded against the teacher-supplied prompt", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const fetchMock = mockGradeFetch(6, "ad-hoc server feedback");
    const { id } = await saveHandwrittenGrade(
      db,
      TEACHER,
      gradeInput({
        questionId: null,
        assessmentId: null,
        questionPrompt: "What is 6 times 7?",
        rubric: "Correct product (10)",
        acceptedAlternatives: ["forty-two"],
        aiSuggestedScore: 100,
        maxMarks: 10,
      }),
    );
    const stored = state.grades.get(id);
    // Server score wins over the tampered client score, as always.
    expect(stored?.final_score).toBe(6);
    expect(stored?.ai_feedback).toBe("ad-hoc server feedback");
    expect(stored?.question_id).toBeNull();
    expect(stored?.max_marks).toBe(10);
    // The grading call received the teacher-supplied ad-hoc criteria.
    const body = gradeRequestBody(fetchMock);
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    const userContent = messages.find((m) => m.role === "user")?.content ?? "";
    expect(userContent).toContain("What is 6 times 7?");
    expect(userContent).toContain("Correct product");
    // The ad-hoc criteria are recorded in the audit row for traceability.
    const details = JSON.parse(state.auditDetails[0] ?? "{}") as Record<string, unknown>;
    expect(details["ad_hoc"]).toBe(true);
    expect(details["question_prompt"]).toBe("What is 6 times 7?");
    expect(state.quotaUnits).toBe(1);
  });

  it("an ad-hoc paper with an empty prompt is refused", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const fetchMock = mockGradeFetch(7);
    await expect(
      saveHandwrittenGrade(
        db,
        TEACHER,
        gradeInput({ questionId: null, assessmentId: null, questionPrompt: "   ", rubric: "" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(state.grades.size).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("a save for a question with no keys is refused", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const fetchMock = mockGradeFetch(7);
    await expect(
      saveHandwrittenGrade(db, TEACHER, gradeInput({ questionId: "q-nokey" })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(state.grades.size).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("a tampered maxMarks cannot raise the ceiling — the question's marks win", async () => {
    const state = baseState();
    const db = fakeDb(state);
    mockGradeFetch(7);
    const { id } = await saveHandwrittenGrade(
      db,
      TEACHER,
      gradeInput({ maxMarks: 1000, aiSuggestedScore: 999 }),
    );
    const stored = state.grades.get(id);
    expect(stored?.max_marks).toBe(10);
    expect(stored?.final_score).toBe(7);
  });
});
