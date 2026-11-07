/**
 * Tests for the D1 take server functions (src/server/d1-take.ts) and
 * their use of the frozen take gate (src/server/d1-take-gate.ts).
 * Uses a dispatch fake for D1Database (same pattern as
 * src/test/d1-take-gate.test.ts): in-memory rows, every SQL string
 * recorded, so the tests prove gate-first loading and student-only
 * access without a Worker binding or a live D1.
 */
import { describe, expect, it } from "vitest";
import {
  getTakeData,
  recordIntegrityEvent,
  saveDraft,
  startAttempt,
  submitAttempt,
} from "@/server/d1-take";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

const NOW = "2026-11-03T20:00:00.000Z";

type State = {
  assessments: Record<
    string,
    {
      status: string;
      starts_at: string | null;
      due_at: string | null;
      max_attempts: number;
      duration_minutes: number | null;
      title: string;
    }
  >;
  assignments: Set<string>; // `${assessmentId}:${studentId}`
  groupLinks: Record<string, string[]>;
  approvedMembers: Set<string>; // `${groupId}:${studentId}`
  questions: Record<string, { id: string; prompt: string; type: string; marks: number }[]>;
  submissions: {
    id: string;
    assessment_id: string;
    student_id: string;
    status: string;
    attempt_number: number;
    expires_at: string | null;
    question_order: string | null;
  }[];
  answers: { submission_id: string; question_id: string; response: string }[];
  seen: string[];
  runs: { sql: string; params: unknown[] }[];
};

function fakeDb(state: State): D1Database {
  const stmt = (kind: string, params: unknown[]): D1Statement => {
    const first = async <T>(): Promise<T | null> => {
      if (kind === "assessment") {
        const row = state.assessments[params[0] as string];
        if (!row) return null;
        return {
          id: params[0],
          title: row.title,
          instructions: "",
          status: row.status,
          starts_at: row.starts_at,
          due_at: row.due_at,
          max_attempts: row.max_attempts,
          duration_minutes: row.duration_minutes,
        } as unknown as T;
      }
      if (kind === "assignment") {
        return state.assignments.has(`${params[0]}:${params[1]}`)
          ? ({ one: 1 } as unknown as T)
          : null;
      }
      if (kind === "member") {
        return state.approvedMembers.has(`${params[0]}:${params[1]}`)
          ? ({ one: 1 } as unknown as T)
          : null;
      }
      if (kind === "submission-by-id") {
        const row = state.submissions.find((s) => s.id === params[0]);
        return (row ?? null) as unknown as T | null;
      }
      if (kind === "draft") {
        const row = state.submissions.find(
          (s) =>
            s.assessment_id === params[0] &&
            s.student_id === params[1] &&
            s.status === "in_progress",
        );
        return (row ? { id: row.id } : null) as unknown as T | null;
      }
      if (kind === "count-submissions") {
        const n = state.submissions.filter(
          (s) => s.assessment_id === params[0] && s.student_id === params[1],
        ).length;
        return { n } as unknown as T;
      }
      if (kind === "sum-marks") {
        const rows = state.questions[params[0] as string] ?? [];
        return { total: rows.reduce((sum, q) => sum + q.marks, 0) } as unknown as T;
      }
      if (kind === "due") {
        const row = state.assessments[params[0] as string];
        return (row ? { due_at: row.due_at } : null) as unknown as T | null;
      }
      if (kind === "question-marks") {
        const rows = Object.values(state.questions).flat();
        const q = rows.find((r) => r.id === params[0]);
        return (q ? { marks: q.marks } : null) as unknown as T | null;
      }
      if (kind === "answer-existing") {
        const row = state.answers.find(
          (a) => a.submission_id === params[0] && a.question_id === params[1],
        );
        return (row
          ? { id: `${row.submission_id}:${row.question_id}` }
          : null) as unknown as T | null;
      }
      if (kind === "submission-owner") {
        const row = state.submissions.find((s) => s.id === params[0]);
        return (row
          ? { assessment_id: row.assessment_id, student_id: row.student_id }
          : null) as unknown as T | null;
      }
      if (kind === "question-owner") {
        const rows = Object.values(state.questions).flat();
        const q = rows.find((r) => r.id === params[0]);
        return (q ? { id: q.id } : null) as unknown as T | null;
      }
      return null;
    };
    const all = async <T>(): Promise<{ results?: T[] }> => {
      if (kind === "links") {
        const ids = state.groupLinks[params[0] as string] ?? [];
        return { results: ids.map((group_id) => ({ group_id })) as unknown as T[] };
      }
      if (kind === "questions") {
        const rows = state.questions[params[0] as string] ?? [];
        return {
          results: rows.map((q) => ({ ...q, options: "[]", position: 0 })) as unknown as T[],
        };
      }
      if (kind === "submissions") {
        const rows = state.submissions.filter(
          (s) => s.assessment_id === params[0] && s.student_id === params[1],
        );
        return {
          results: rows.map((s) => ({
            ...s,
            started_at: null,
            submitted_at: null,
            final_score: null,
            total_possible: 10,
          })) as unknown as T[],
        };
      }
      if (kind === "answers") {
        const ids = params as string[];
        const rows = state.answers.filter((a) => ids.includes(a.submission_id));
        return { results: rows as unknown as T[] };
      }
      if (kind === "draft-answer-lookup") {
        const submissionId = params[0] as string;
        const assessmentId = params[1] as string;
        const ids = params.slice(2) as string[];
        const questions = (state.questions[assessmentId] ?? []).filter((q) => ids.includes(q.id));
        return {
          results: questions.map((q) => ({
            question_id: q.id,
            marks: q.marks,
            answer_id: state.answers.some(
              (a) => a.submission_id === submissionId && a.question_id === q.id,
            )
              ? `${submissionId}:${q.id}`
              : null,
          })) as unknown as T[],
        };
      }
      return { results: [] };
    };
    return {
      bind: () => stmt(kind, params),
      first,
      all,
      run: async () => undefined,
    } as unknown as D1Statement;
  };
  return {
    prepare(sql: string): D1Statement {
      state.seen.push(sql);
      let kind = "unknown";
      if (sql.includes("FROM assessments") && sql.includes("WHERE id = ?")) kind = "assessment";
      else if (sql.includes("FROM assessment_assignments")) kind = "assignment";
      else if (sql.includes("FROM group_exams")) kind = "links";
      else if (sql.includes("FROM group_members")) kind = "member";
      else if (sql.includes("FROM questions") && sql.includes("ORDER BY position"))
        kind = "questions";
      else if (
        sql.includes(
          "FROM submissions WHERE assessment_id = ? AND student_id = ? AND status = 'in_progress'",
        )
      )
        kind = "draft";
      else if (
        sql.includes(
          "FROM submissions WHERE assessment_id = ? AND student_id = ? ORDER BY attempt_number",
        )
      )
        kind = "submissions";
      else if (sql.startsWith("SELECT COUNT(*) AS n FROM submissions")) kind = "count-submissions";
      else if (sql.includes("SUM(marks)")) kind = "sum-marks";
      else if (sql.startsWith("SELECT * FROM submissions WHERE id = ?")) kind = "submission-by-id";
      else if (sql.startsWith("SELECT due_at FROM assessments")) kind = "due";
      else if (sql.includes("SELECT marks FROM questions")) kind = "question-marks";
      else if (sql.includes("LEFT JOIN answers a ON a.question_id = q.id"))
        kind = "draft-answer-lookup";
      else if (sql.startsWith("SELECT id FROM answers")) kind = "answer-existing";
      else if (sql.startsWith("SELECT assessment_id, student_id FROM submissions"))
        kind = "submission-owner";
      else if (sql.startsWith("SELECT id FROM questions WHERE id = ?")) kind = "question-owner";
      else if (sql.startsWith("SELECT submission_id, question_id, response FROM answers"))
        kind = "answers";
      let params: unknown[] = [];
      const base = stmt(kind, params);
      return {
        bind: (...p: unknown[]) => {
          params = p;
          if (sql.startsWith("INSERT INTO submissions")) {
            state.submissions.push({
              id: p[0] as string,
              assessment_id: p[1] as string,
              student_id: p[2] as string,
              status: "in_progress",
              attempt_number: p[3] as number,
              expires_at: p[6] as string | null,
              question_order: p[7] as string,
            });
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("INSERT INTO answers")) {
            state.answers.push({
              submission_id: p[1] as string,
              question_id: p[2] as string,
              response: p[3] as string,
            });
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("UPDATE submissions SET status")) {
            const row = state.submissions.find((s) => s.id === p[1]);
            if (row) row.status = "awaiting_review";
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("UPDATE answers SET")) {
            state.runs.push({ sql, params: p });
          } else if (sql.startsWith("INSERT INTO integrity_events")) {
            state.runs.push({ sql, params: p });
          }
          return stmt(kind, params);
        },
        first: base.first,
        all: base.all,
        run: base.run,
      } as unknown as D1Statement;
    },
  };
}

function baseState(): State {
  return {
    assessments: {
      ex1: {
        status: "published",
        starts_at: null,
        due_at: null,
        max_attempts: 2,
        duration_minutes: 30,
        title: "Exam 1",
      },
    },
    assignments: new Set(["ex1:student-a", "ex1:student-b"]),
    groupLinks: { ex1: ["group-1"] },
    approvedMembers: new Set(["group-1:student-a"]),
    questions: {
      ex1: [
        { id: "q1", prompt: "2 + 2?", type: "mcq", marks: 5 },
        { id: "q2", prompt: "Explain.", type: "written", marks: 5 },
      ],
    },
    submissions: [],
    answers: [],
    seen: [],
    runs: [],
  };
}

describe("d1-take: gate first", () => {
  it("blocks a non-member with a stale assignment row and loads nothing else", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const result = await getTakeData(db, "student-b", "ex1", NOW);
    expect(result).toEqual({ allowed: false, reason: "NOT_GROUP_MEMBER" });
    // No question, answer, or submission query was ever issued.
    expect(state.seen.some((sql) => sql.includes("FROM questions"))).toBe(false);
    expect(state.seen.some((sql) => sql.includes("FROM answers"))).toBe(false);
    expect(state.seen.some((sql) => sql.includes("FROM submissions"))).toBe(false);
  });

  it("blocks a student with no assignment row", async () => {
    const db = fakeDb(baseState());
    expect(await getTakeData(db, "student-c", "ex1", NOW)).toEqual({
      allowed: false,
      reason: "NOT_ASSIGNED",
    });
  });

  it("an approved group member loads questions — never question_keys", async () => {
    const state = baseState();
    const db = fakeDb(state);
    const result = await getTakeData(db, "student-a", "ex1", NOW);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
      // The take payload has no key fields at all.
      expect(result.questions.every((q) => !("key" in q) && !("correct_answer" in q))).toBe(true);
    }
    expect(state.seen.some((sql) => sql.includes("question_keys"))).toBe(false);
  });

  it("an existing draft still loads after the window closes (draft wins)", async () => {
    const state = baseState();
    state.assessments["ex1"]!.due_at = "2026-11-01T00:00:00.000Z";
    state.submissions.push({
      id: "sub-1",
      assessment_id: "ex1",
      student_id: "student-a",
      status: "in_progress",
      attempt_number: 1,
      expires_at: null,
      question_order: null,
    });
    const db = fakeDb(state);
    const result = await getTakeData(db, "student-a", "ex1", NOW);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.submissions.some((s) => s.id === "sub-1")).toBe(true);
    }
  });
});

describe("d1-take: student-only access", () => {
  it("a student cannot save, submit, or record events on another student's submission", async () => {
    const state = baseState();
    state.submissions.push({
      id: "sub-1",
      assessment_id: "ex1",
      student_id: "student-a",
      status: "in_progress",
      attempt_number: 1,
      expires_at: null,
      question_order: null,
    });
    const db = fakeDb(state);
    expect(
      await saveDraft(
        db,
        "student-b",
        "sub-1",
        [{ question_id: "q1", response: "x", time_spent_seconds: 5 }],
        NOW,
      ),
    ).toBe(false);
    expect(await submitAttempt(db, "student-b", "sub-1", NOW)).toBe(false);
    await expect(
      recordIntegrityEvent(db, "student-b", "sub-1", "tab_hidden", "q1"),
    ).rejects.toThrow("NOT_FOUND");
    expect(state.runs.length).toBe(0);
  });

  it("a student sees only their own submissions and answers", async () => {
    const state = baseState();
    state.groupLinks = {};
    state.submissions.push(
      {
        id: "sub-a",
        assessment_id: "ex1",
        student_id: "student-a",
        status: "awaiting_review",
        attempt_number: 1,
        expires_at: null,
        question_order: null,
      },
      {
        id: "sub-b",
        assessment_id: "ex1",
        student_id: "student-b",
        status: "awaiting_review",
        attempt_number: 1,
        expires_at: null,
        question_order: null,
      },
    );
    state.answers.push(
      { submission_id: "sub-a", question_id: "q1", response: "mine" },
      { submission_id: "sub-b", question_id: "q1", response: "theirs" },
    );
    const db = fakeDb(state);
    const result = await getTakeData(db, "student-a", "ex1", NOW);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.submissions.map((s) => s.id)).toEqual(["sub-a"]);
      expect(result.answersBySubmission["sub-a"]?.[0]?.response).toBe("mine");
      expect(result.answersBySubmission["sub-b"]).toBeUndefined();
    }
  });
});

describe("d1-take: attempts", () => {
  it("startAttempt is idempotent for an existing draft and creates attempt 2 otherwise", async () => {
    const state = baseState();
    state.groupLinks = {};
    state.submissions.push({
      id: "sub-1",
      assessment_id: "ex1",
      student_id: "student-a",
      status: "in_progress",
      attempt_number: 1,
      expires_at: null,
      question_order: null,
    });
    const db = fakeDb(state);
    expect(await startAttempt(db, "student-a", "ex1", ["q2", "q1"], NOW)).toEqual({
      submissionId: "sub-1",
    });
    expect(state.runs.filter((r) => r.sql.startsWith("INSERT INTO submissions")).length).toBe(0);

    const state2 = baseState();
    state2.groupLinks = {};
    state2.submissions.push({
      id: "sub-1",
      assessment_id: "ex1",
      student_id: "student-a",
      status: "awaiting_review",
      attempt_number: 1,
      expires_at: null,
      question_order: null,
    });
    const db2 = fakeDb(state2);
    const created = await startAttempt(db2, "student-a", "ex1", ["q2", "q1"], NOW);
    expect(typeof created.submissionId).toBe("string");
    const insert = state2.runs.find((r) => r.sql.startsWith("INSERT INTO submissions"));
    expect(insert?.params[3]).toBe(2); // attempt_number
    expect(insert?.params[7]).toBe('["q2","q1"]'); // question_order preserved
  });

  it("startAttempt refuses a non-member even with a stale assignment row", async () => {
    const db = fakeDb(baseState());
    await expect(startAttempt(db, "student-b", "ex1", ["q1"], NOW)).rejects.toThrow(
      "TAKE_NOT_GROUP_MEMBER",
    );
  });

  it("saveDraft freezes at expiry and submit stays allowed afterwards", async () => {
    const state = baseState();
    state.submissions.push({
      id: "sub-1",
      assessment_id: "ex1",
      student_id: "student-a",
      status: "in_progress",
      attempt_number: 1,
      expires_at: "2026-11-03T19:00:00.000Z",
      question_order: null,
    });
    const db = fakeDb(state);
    expect(
      await saveDraft(
        db,
        "student-a",
        "sub-1",
        [{ question_id: "q1", response: "x", time_spent_seconds: 5 }],
        NOW,
      ),
    ).toBe(false);
    expect(state.runs.filter((r) => r.sql.startsWith("INSERT INTO answers")).length).toBe(0);
    expect(await submitAttempt(db, "student-a", "sub-1", NOW)).toBe(true);
  });

  it("saveDraft takes max_marks from the question, never the client", async () => {
    const state = baseState();
    state.groupLinks = {};
    state.submissions.push({
      id: "sub-1",
      assessment_id: "ex1",
      student_id: "student-a",
      status: "in_progress",
      attempt_number: 1,
      expires_at: null,
      question_order: null,
    });
    const db = fakeDb(state);
    expect(
      await saveDraft(
        db,
        "student-a",
        "sub-1",
        [{ question_id: "q1", response: "4", time_spent_seconds: 12 }],
        NOW,
      ),
    ).toBe(true);
    const insert = state.runs.find((r) => r.sql.startsWith("INSERT INTO answers"));
    expect(insert?.params[4]).toBe(5); // q1's marks, not a client value
  });
});
