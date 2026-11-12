/**
 * Regression tests for BIZ-F1 (deep audit 2026-11-12): a D1 submission
 * in status `approved` (teacher finished grading, result not yet
 * released) must stay non-editable inside the DO. Before the fix,
 * `toDoStatus` coerced any status other than `awaiting_review` /
 * `released` to `in_progress`, so loading the take page turned the
 * graded submission back into an editable draft and autosave could
 * overwrite the graded answers.
 *
 * Map-backed stores + compact D1 dispatch fake follow the same
 * pattern as src/test/take-session-logic.test.ts (only the SQL these
 * tests exercise). No Worker binding, no live D1.
 */
import { describe, expect, it } from "vitest";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
import {
  applyDraft,
  applySubmit,
  getSessionStatus,
  hydrateFromD1,
  loadTakeData,
  TAKE_SESSION_SCORE_REFRESH_TTL_MS,
  type DoAnswerState,
  type DoSubmissionState,
  type ExamConfig,
  type ExamConfigStore,
  type ExamQuestion,
  type SessionStore,
} from "@/server/take-session-logic";

const NOW = "2026-11-10T17:00:00.000Z";
const STUDENT = "student-1";
const EXAM = "exam-1";
const Q1 = "q-1";
const Q2 = "q-2";
const MARKS = { [Q1]: 5, [Q2]: 10 };
const GRADED_ANSWER = "graded-answer";

/* ------------------------------------------------ Map-backed store */

class MapStore implements SessionStore {
  subs = new Map<string, DoSubmissionState>();
  answers = new Map<string, Map<string, DoAnswerState>>();
  hydrated = new Set<string>();

  async getSubmission(id: string) {
    return this.subs.get(id) ?? null;
  }
  async putSubmission(sub: DoSubmissionState) {
    this.subs.set(sub.id, { ...sub });
  }
  async getAnswers(submissionId: string) {
    return [...(this.answers.get(submissionId)?.values() ?? [])];
  }
  async upsertAnswers(submissionId: string, answers: DoAnswerState[]) {
    let byQ = this.answers.get(submissionId);
    if (!byQ) {
      byQ = new Map();
      this.answers.set(submissionId, byQ);
    }
    for (const a of answers) byQ.set(a.questionId, { ...a });
  }
  async listDirty(limit: number) {
    return [...this.subs.values()]
      .filter((s) => s.dirty)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }
  async markClean(id: string) {
    const sub = this.subs.get(id);
    if (sub) this.subs.set(id, { ...sub, dirty: false });
  }
  async bumpFlushAttempt(id: string, error: string) {
    const sub = this.subs.get(id);
    if (!sub) return 0;
    const next = sub.flushAttempts + 1;
    this.subs.set(id, { ...sub, flushAttempts: next, flushError: error });
    return next;
  }
  async transaction<T>(fn: () => Promise<T>) {
    return fn();
  }
  async getInProgressSubmission(studentId: string, assessmentId: string) {
    const found = [...this.subs.values()]
      .filter(
        (s) =>
          s.studentId === studentId &&
          s.assessmentId === assessmentId &&
          s.status === "in_progress",
      )
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    return found ? { ...found } : null;
  }
  async countSubmissions(studentId: string, assessmentId: string) {
    return [...this.subs.values()].filter(
      (s) => s.studentId === studentId && s.assessmentId === assessmentId,
    ).length;
  }
  async listStudentSubmissions(studentId: string, assessmentId: string) {
    return [...this.subs.values()]
      .filter((s) => s.studentId === studentId && s.assessmentId === assessmentId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber)
      .map((s) => ({ ...s }));
  }
  async areAnswersHydrated(submissionId: string) {
    return this.hydrated.has(submissionId);
  }
  async setAnswersHydrated(submissionId: string) {
    this.hydrated.add(submissionId);
  }
}

class MapConfigStore implements ExamConfigStore {
  config: ExamConfig | null = null;
  questions: ExamQuestion[] = [];
  enrolled = new Map<string, number>();
  seeded = new Set<string>();
  scoreRefresh = new Map<string, number>();

  async getConfig() {
    return this.config;
  }
  async touchConfig(loadedAt: number) {
    if (this.config) this.config.loadedAt = loadedAt;
  }
  async setConfig(config: ExamConfig, questions: ExamQuestion[], enrolledStudentIds: string[]) {
    this.config = { ...config };
    this.questions = questions.map((q) => ({ ...q }));
    this.enrolled = new Map(enrolledStudentIds.map((id) => [id, config.loadedAt]));
  }
  async getMarks() {
    const marks: Record<string, number> = {};
    for (const q of this.questions) marks[q.id] = q.marks;
    return marks;
  }
  async getQuestions() {
    return this.questions.map((q) => ({ ...q }));
  }
  async getScoreRefreshedAt(studentId: string) {
    return this.scoreRefresh.get(studentId) ?? null;
  }
  async setScoreRefreshedAt(studentId: string, refreshedAt: number) {
    this.scoreRefresh.set(studentId, refreshedAt);
  }
  async getEnrolledCheckedAt(studentId: string) {
    return this.enrolled.get(studentId) ?? null;
  }
  async setEnrolled(studentId: string, checkedAt: number) {
    this.enrolled.set(studentId, checkedAt);
  }
  async isStudentSeeded(studentId: string) {
    return this.seeded.has(studentId);
  }
  async setStudentSeeded(studentId: string) {
    this.seeded.add(studentId);
  }
}

/* --------------------------------------- compact D1 dispatch fake */

type FakeState = {
  submissions: Record<string, Record<string, unknown>>;
  answers: Record<string, { id: string; response: string; max_marks: number }>;
};

function makeFakeDb(state: FakeState): D1Database {
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const query = (sql: string, params: unknown[]): unknown => {
    const s = norm(sql);
    if (s.startsWith("SELECT * FROM submissions WHERE id = ?")) {
      return state.submissions[params[0] as string] ?? null;
    }
    if (s.startsWith("SELECT * FROM submissions WHERE assessment_id = ?")) {
      return Object.values(state.submissions).filter(
        (r) => r["assessment_id"] === params[0] && r["student_id"] === params[1],
      );
    }
    if (s.startsWith("SELECT status, starts_at, due_at, max_attempts")) {
      return {
        status: "published",
        starts_at: null,
        due_at: null,
        max_attempts: 10,
        duration_minutes: 60,
        title: "Exam 1",
        instructions: "Read carefully.",
      };
    }
    if (s.startsWith("SELECT id, prompt, type, options, marks, position FROM questions")) {
      return [
        {
          id: Q1,
          prompt: "What is 2+2?",
          type: "mcq",
          options: JSON.stringify(["3", "4", "5"]),
          marks: 5,
          position: 1,
        },
        {
          id: Q2,
          prompt: "Explain the water cycle.",
          type: "written",
          options: "[]",
          marks: 10,
          position: 2,
        },
      ];
    }
    if (s.startsWith("SELECT student_id FROM assessment_assignments")) {
      return [{ student_id: STUDENT }];
    }
    if (s.startsWith("SELECT group_id FROM group_exams")) {
      return [{ group_id: "g-1" }];
    }
    if (s.startsWith("SELECT student_id FROM group_members")) {
      return [{ student_id: STUDENT }];
    }
    if (s.startsWith("SELECT id, status, final_score FROM submissions")) {
      return Object.values(state.submissions)
        .filter(
          (r) =>
            r["assessment_id"] === params[0] &&
            r["student_id"] === params[1] &&
            r["status"] !== "in_progress",
        )
        .map((r) => ({
          id: r["id"] as string,
          status: r["status"] as string,
          final_score: (r["final_score"] as number | null) ?? null,
        }));
    }
    if (s.startsWith("SELECT question_id, response")) {
      const submissionId = params[0] as string;
      return Object.entries(state.answers)
        .filter(([key]) => key.startsWith(`${submissionId}:`))
        .map(([key, a]) => ({
          question_id: key.split(":")[1],
          response: a.response,
          max_marks: a.max_marks,
          time_spent_seconds: 0,
        }));
    }
    return null;
  };
  const statement = (sql: string): D1Statement => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        bound = p;
        return stmt as unknown as D1Statement;
      },
      async run() {
        return { meta: { changes: 0 } };
      },
      async first<T>() {
        return query(sql, bound) as T | null;
      },
      async all<T>() {
        const result = query(sql, bound);
        return { results: Array.isArray(result) ? (result as T[]) : [] };
      },
    };
    return stmt as unknown as D1Statement;
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: D1Statement[]) => {
      const out: unknown[] = [];
      for (const stmt of stmts) out.push(await stmt.run());
      return out;
    },
  } as unknown as D1Database;
}

function approvedRow(): Record<string, unknown> {
  return {
    id: "sub-appr",
    assessment_id: EXAM,
    student_id: STUDENT,
    status: "approved",
    attempt_number: 1,
    started_at: NOW,
    submitted_at: NOW,
    expires_at: "2026-11-10T18:00:00.000Z",
    question_order: JSON.stringify([Q1, Q2]),
    total_possible: 15,
    final_score: null,
    draft_seq: 3,
  };
}

function fakeState(): FakeState {
  return {
    submissions: { "sub-appr": approvedRow() },
    answers: { "sub-appr:q-1": { id: "a-1", response: GRADED_ANSWER, max_marks: 5 } },
  };
}

async function loadPage(store: MapStore, cfg: MapConfigStore, db: D1Database) {
  return loadTakeData(store, cfg, db, {
    studentId: STUDENT,
    assessmentId: EXAM,
    nowIso: NOW,
  });
}

/* ------------------------------------------------------------------ */

describe("approved submission state (BIZ-F1)", () => {
  it("seed keeps `approved`: the take page shows it as submitted, never as an editable draft", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();
    const cfg = new MapConfigStore();

    const page = await loadPage(store, cfg, db);
    expect(page.allowed).toBe(true);
    if (page.allowed) {
      expect(page.submissions).toHaveLength(1);
      expect(page.submissions[0]).toMatchObject({ id: "sub-appr", status: "approved" });
      // No in-progress submission exists, so the page has no draft to edit.
      expect(page.submissions.some((s) => s.status === "in_progress")).toBe(false);
      expect(page.answersBySubmission["sub-appr"]).toEqual([
        { question_id: Q1, response: GRADED_ANSWER },
      ]);
    }

    const stored = await store.getSubmission("sub-appr");
    expect(stored?.status).toBe("approved");
    expect(await store.getInProgressSubmission(STUDENT, EXAM)).toBeNull();

    // The status poll reports it as submitted, not started.
    const status = await getSessionStatus(store, {
      submissionId: "sub-appr",
      studentId: STUDENT,
      assessmentId: EXAM,
    });
    expect(status).toMatchObject({ status: "submitted", submissionId: "sub-appr" });
  });

  it("autosave cannot overwrite the graded answers of an `approved` submission", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();
    const cfg = new MapConfigStore();
    await loadPage(store, cfg, db);

    const draft = await applyDraft(store, {
      submissionId: "sub-appr",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "overwritten", time_spent_seconds: 5 }],
      seq: 4,
      marks: MARKS,
      nowIso: NOW,
    });
    expect(draft.applied).toBe("not_editable");
    expect((await store.getAnswers("sub-appr")).at(0)?.response).toBe(GRADED_ANSWER);
    expect((await store.getSubmission("sub-appr"))?.dirty).toBe(false);

    // A re-submit against it is also a no-op (it is already submitted).
    const submit = await applySubmit(store, {
      submissionId: "sub-appr",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "overwritten", time_spent_seconds: 5 }],
      seq: 4,
      marks: MARKS,
      nowIso: NOW,
    });
    expect(submit.submitted).toBe(false);
  });

  it("hydrateFromD1 preserves `approved` and the hydrated row is not editable", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();

    const sub = await hydrateFromD1(db, store, "sub-appr");
    expect(sub?.status).toBe("approved");
    expect(sub?.dirty).toBe(false);

    const draft = await applyDraft(store, {
      submissionId: "sub-appr",
      studentId: STUDENT,
      answers: [{ question_id: Q1, response: "overwritten", time_spent_seconds: 5 }],
      seq: 4,
      marks: MARKS,
      nowIso: NOW,
    });
    expect(draft.applied).toBe("not_editable");
    expect((await store.getAnswers("sub-appr")).at(0)?.response).toBe(GRADED_ANSWER);
  });

  it("score refresh keeps `approved`, then picks up the release with its final score", async () => {
    const state = fakeState();
    const db = makeFakeDb(state);
    const store = new MapStore();
    const cfg = new MapConfigStore();

    const first = await loadPage(store, cfg, db);
    expect(first.allowed).toBe(true);
    if (first.allowed) {
      expect(first.submissions[0]).toMatchObject({ status: "approved", final_score: null });
    }

    // The teacher releases it in D1 (approved -> released, score set).
    const row = state.submissions["sub-appr"]!;
    row["status"] = "released";
    row["final_score"] = 12;
    // Age the score refresh past the TTL (V3.3: 5 min) so the next
    // load re-reads.
    cfg.scoreRefresh.set(STUDENT, Date.parse(NOW) - TAKE_SESSION_SCORE_REFRESH_TTL_MS - 1);
    const second = await loadPage(store, cfg, db);
    expect(second.allowed).toBe(true);
    if (second.allowed) {
      expect(second.submissions[0]).toMatchObject({ status: "released", final_score: 12 });
    }
  });
});
