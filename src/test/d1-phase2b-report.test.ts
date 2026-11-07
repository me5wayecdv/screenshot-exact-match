/**
 * Tests for the Phase 2b D1 report module (src/server/d1-report.ts):
 * report reads, per-question breakdown, integrity summary, parent
 * contact, auto-send toggle, WhatsApp audit reads, and the integrity
 * flush path. Uses a fake D1Database (no live D1 required).
 *
 * Security assertions covered here:
 * - Non-owners get NOT_FOUND/FORBIDDEN, never another teacher's rows.
 * - No query in this module ever mentions question_keys.
 * - Parent contact: self or approved linked teacher only.
 * - Integrity flush: own submission + student role only; unknown
 *   event types are dropped, never stored.
 */
import { describe, expect, it } from "vitest";
import {
  getAssessmentReport,
  getIntegritySummary,
  getParentContact,
  listReportQuestions,
  listWhatsAppSends,
  listWhatsAppStudentNames,
  recordIntegrityEvents,
  setAutoWhatsAppSend,
  updateParentContact,
  type Caller,
} from "@/server/d1-report";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type State = {
  assessments: Map<
    string,
    { teacher_id: string; title: string; status: string; due_at: string | null }
  >;
  assignments: { assessment_id: string; student_id: string }[];
  submissions: {
    id: string;
    assessment_id: string;
    student_id: string;
    status: string;
    final_score: number | null;
    total_possible: number | null;
    attempt_number: number;
  }[];
  questions: {
    id: string;
    assessment_id: string;
    position: number;
    type: string;
    prompt: string;
    marks: number;
    objective: string;
    options: string;
    difficulty: string;
  }[];
  answers: {
    question_id: string;
    submission_id: string;
    auto_score: number | null;
    final_score: number | null;
    time_spent_seconds: number;
  }[];
  integrity: {
    submission_id: string;
    event_type: string;
    question_id: string | null;
    created_at: string;
  }[];
  profiles: Map<
    string,
    { full_name: string; parent_phone: string | null; whatsapp_consent: number }
  >;
  links: Map<string, string>; // `${teacher}:${student}` -> status
  sends: {
    id: string;
    submission_id: string;
    sent_at: string;
    status: string;
    trigger: string;
    message_id: string | null;
    error: string | null;
  }[];
};

function baseState(): State {
  const s: State = {
    assessments: new Map([
      ["a1", { teacher_id: "t1", title: "Quiz", status: "published", due_at: null }],
    ]),
    assignments: [{ assessment_id: "a1", student_id: "s1" }],
    submissions: [
      {
        id: "sub1",
        assessment_id: "a1",
        student_id: "s1",
        status: "released",
        final_score: 8,
        total_possible: 10,
        attempt_number: 1,
      },
    ],
    questions: [
      {
        id: "q1",
        assessment_id: "a1",
        position: 0,
        type: "mcq",
        prompt: "2+2?",
        marks: 10,
        objective: "add",
        options: '["3","4"]',
        difficulty: "easy",
      },
    ],
    answers: [
      {
        question_id: "q1",
        submission_id: "sub1",
        auto_score: 10,
        final_score: 8,
        time_spent_seconds: 90,
      },
    ],
    integrity: [
      {
        submission_id: "sub1",
        event_type: "tab_hidden",
        question_id: "q1",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        submission_id: "sub1",
        event_type: "tab_visible",
        question_id: "q1",
        created_at: "2026-01-01T00:01:00Z",
      },
      {
        submission_id: "sub1",
        event_type: "window_blur",
        question_id: null,
        created_at: "2026-01-01T00:02:00Z",
      },
    ],
    profiles: new Map([
      ["s1", { full_name: "Student One", parent_phone: null, whatsapp_consent: 0 }],
      ["t1", { full_name: "Teacher One", parent_phone: null, whatsapp_consent: 0 }],
    ]),
    links: new Map([["t1:s1", "approved"]]),
    sends: [
      {
        id: "w1",
        submission_id: "sub1",
        sent_at: "2026-01-02T00:00:00Z",
        status: "sent",
        trigger: "manual",
        message_id: "m1",
        error: null,
      },
    ],
  };
  return s;
}

function fakeDb(state: State, seenSql: string[]): D1Database {
  const runOne = (sql: string, params: unknown[]): { meta: { changes: number } } => {
    seenSql.push(sql);
    if (sql.startsWith("UPDATE profiles SET parent_phone")) {
      const id = params[2] as string;
      const p = state.profiles.get(id);
      if (!p) return { meta: { changes: 0 } };
      p.parent_phone = params[0] as string;
      p.whatsapp_consent = params[1] as number;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE assessments SET auto_whatsapp_send")) {
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO integrity_events")) {
      const [, submission_id, event_type, question_id, created_at] = params as [
        string,
        string,
        string,
        string | null,
        string,
      ];
      state.integrity.push({ submission_id, event_type, question_id, created_at });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  };

  const first = async (sql: string, params: unknown[]): Promise<unknown> => {
    seenSql.push(sql);
    if (sql.includes("FROM assessments WHERE id = ?")) {
      const a = state.assessments.get(params[0] as string);
      return a ? { id: params[0], ...a } : null;
    }
    if (sql.includes("FROM submissions s JOIN assessments a") && sql.includes("WHERE s.id = ?")) {
      const sub = state.submissions.find((x) => x.id === params[0]);
      if (!sub) return null;
      const a = state.assessments.get(sub.assessment_id);
      return { assessment_id: sub.assessment_id, teacher_id: a?.teacher_id };
    }
    if (sql.includes("FROM submissions WHERE id = ?")) {
      const sub = state.submissions.find((x) => x.id === params[0]);
      return sub ? { student_id: sub.student_id } : null;
    }
    if (sql.includes("FROM teacher_students WHERE teacher_id = ?")) {
      const status = state.links.get(`${params[0]}:${params[1]}`);
      return status ? { status } : null;
    }
    if (sql.includes("FROM profiles WHERE id = ?") && sql.includes("parent_phone")) {
      const p = state.profiles.get(params[0] as string);
      return p ? { parent_phone: p.parent_phone, whatsapp_consent: p.whatsapp_consent } : null;
    }
    return null;
  };

  const all = async (sql: string, params: unknown[]): Promise<{ results: unknown[] }> => {
    seenSql.push(sql);
    if (sql.includes("FROM assessment_assignments")) {
      return {
        results: state.assignments
          .filter((x) => x.assessment_id === params[0])
          .map((x) => ({ student_id: x.student_id })),
      };
    }
    if (sql.includes("FROM submissions WHERE assessment_id = ?") && sql.includes("final_score")) {
      return { results: state.submissions.filter((x) => x.assessment_id === params[0]) };
    }
    if (sql.includes("FROM submissions WHERE assessment_id = ?")) {
      return {
        results: state.submissions
          .filter((x) => x.assessment_id === params[0])
          .map((x) => ({ id: x.id })),
      };
    }
    if (sql.includes("FROM profiles WHERE id IN")) {
      const ids = params as string[];
      return {
        results: ids
          .map((id) => state.profiles.get(id))
          .filter(Boolean)
          .map((p, i) => ({ id: ids[i], full_name: p!.full_name })),
      };
    }
    if (sql.includes("FROM questions WHERE assessment_id = ? ORDER BY position")) {
      return { results: state.questions.filter((x) => x.assessment_id === params[0]) };
    }
    if (sql.includes("FROM questions WHERE assessment_id = ?")) {
      return {
        results: state.questions
          .filter((x) => x.assessment_id === params[0])
          .map((x) => ({ id: x.id })),
      };
    }
    if (sql.includes("FROM answers WHERE submission_id IN")) {
      const ids = new Set(params as string[]);
      return {
        results: state.answers
          .filter((x) => ids.has(x.submission_id))
          .map((x) => ({
            question_id: x.question_id,
            auto_score: x.auto_score,
            final_score: x.final_score,
          })),
      };
    }
    if (sql.includes("FROM answers WHERE submission_id = ?")) {
      return {
        results: state.answers
          .filter((x) => x.submission_id === params[0])
          .map((x) => ({ question_id: x.question_id, time_spent_seconds: x.time_spent_seconds })),
      };
    }
    if (sql.includes("FROM integrity_events")) {
      return { results: state.integrity.filter((x) => x.submission_id === params[0]) };
    }
    if (sql.includes("FROM teacher_students WHERE teacher_id = ? AND status")) {
      const teacherId = params[0] as string;
      const ids = (params.slice(1) as string[]).filter(
        (id) => state.links.get(`${teacherId}:${id}`) === "approved",
      );
      return { results: ids.map((student_id) => ({ student_id })) };
    }
    if (sql.includes("FROM whatsapp_sends")) {
      return { results: state.sends.filter((x) => x.submission_id === params[0]) };
    }
    return { results: [] };
  };

  const make = (sql: string): D1Statement => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      async first<T>() {
        return (await first(sql, params)) as T | null;
      },
      async all<T>() {
        return (await all(sql, params)) as { results: T[] };
      },
      async run() {
        return runOne(sql, params);
      },
    };
    return stmt as unknown as D1Statement;
  };

  return {
    prepare: (sql: string) => make(sql),
    batch: async (stmts: D1Statement[]) => {
      const out: unknown[] = [];
      for (const st of stmts) out.push(await (st as unknown as { run(): unknown }).run());
      return out as never;
    },
  } as unknown as D1Database;
}

const teacher: Caller = { id: "t1", role: "school_teacher" };
const otherTeacher: Caller = { id: "t2", role: "tutor" };
const admin: Caller = { id: "admin1", role: "admin" };
const student: Caller = { id: "s1", role: "student" };

describe("d1-report: assessment report", () => {
  it("owner gets assessment + assignments + submissions + names", async () => {
    const db = fakeDb(baseState(), []);
    const report = await getAssessmentReport(db, teacher, "a1");
    expect(report.assessment.title).toBe("Quiz");
    expect(report.assignments).toHaveLength(1);
    expect(report.submissions).toHaveLength(1);
    expect(report.names["s1"]).toBe("Student One");
  });

  it("non-owner gets NOT_FOUND, admin passes", async () => {
    const db = fakeDb(baseState(), []);
    await expect(getAssessmentReport(db, otherTeacher, "a1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const report = await getAssessmentReport(db, admin, "a1");
    expect(report.assessment.id).toBe("a1");
  });

  it("no query in this module mentions question_keys", async () => {
    const seen: string[] = [];
    const db = fakeDb(baseState(), seen);
    await getAssessmentReport(db, teacher, "a1");
    await listReportQuestions(db, teacher, "a1");
    await getIntegritySummary(db, teacher, "sub1", "a1");
    await listWhatsAppSends(db, teacher, "sub1");
    expect(seen.join("\n")).not.toMatch(/question_keys/);
  });
});

describe("d1-report: per-question breakdown", () => {
  it("returns questions with parsed options and answers, plus submission count", async () => {
    const db = fakeDb(baseState(), []);
    const data = await listReportQuestions(db, teacher, "a1");
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0]!.options).toEqual(["3", "4"]);
    expect(data.answers).toHaveLength(1);
    expect(data.submissionCount).toBe(1);
  });

  it("non-owner gets NOT_FOUND", async () => {
    const db = fakeDb(baseState(), []);
    await expect(listReportQuestions(db, otherTeacher, "a1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("d1-report: integrity summary", () => {
  it("counts tab switches / blurs and per-question time", async () => {
    const db = fakeDb(baseState(), []);
    const data = await getIntegritySummary(db, teacher, "sub1", "a1");
    expect(data.tabSwitches).toBe(1);
    expect(data.windowBlurs).toBe(1);
    expect(data.totalTimeSeconds).toBe(90);
    expect(data.hasData).toBe(true);
  });

  it("non-owner gets FORBIDDEN", async () => {
    const db = fakeDb(baseState(), []);
    await expect(getIntegritySummary(db, otherTeacher, "sub1", "a1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("d1-report: parent contact", () => {
  it("self and approved teacher can read; stranger cannot", async () => {
    const db = fakeDb(baseState(), []);
    await expect(getParentContact(db, student, "s1")).resolves.toMatchObject({
      parent_phone: null,
    });
    await expect(getParentContact(db, teacher, "s1")).resolves.toBeDefined();
    await expect(getParentContact(db, otherTeacher, "s1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("update validates the phone server-side and writes for self", async () => {
    const state = baseState();
    const db = fakeDb(state, []);
    await expect(updateParentContact(db, student, "s1", "not-a-phone", true)).rejects.toMatchObject(
      {
        code: "INVALID_INPUT",
      },
    );
    await updateParentContact(db, student, "s1", "01012345678", true);
    expect(state.profiles.get("s1")!.parent_phone).toBe("+201012345678");
    expect(state.profiles.get("s1")!.whatsapp_consent).toBe(1);
  });

  it("pending link cannot update", async () => {
    const state = baseState();
    state.links.set("t1:s1", "pending");
    const db = fakeDb(state, []);
    await expect(updateParentContact(db, teacher, "s1", "01012345678", true)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
  });
});

describe("d1-report: auto-send toggle + whatsapp audit", () => {
  it("owner toggles, non-owner gets NOT_FOUND", async () => {
    const db = fakeDb(baseState(), []);
    await setAutoWhatsAppSend(db, teacher, "a1", true);
    await expect(setAutoWhatsAppSend(db, otherTeacher, "a1", true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("audit rows are owner-only", async () => {
    const db = fakeDb(baseState(), []);
    const rows = await listWhatsAppSends(db, teacher, "sub1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    await expect(listWhatsAppSends(db, otherTeacher, "sub1")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("whatsapp names only include approved linked students", async () => {
    const db = fakeDb(baseState(), []);
    const names = await listWhatsAppStudentNames(db, teacher, ["s1", "sX"]);
    expect(Object.keys(names)).toEqual(["s1"]);
  });
});

describe("d1-report: integrity flush", () => {
  it("own student flush inserts events; unknown types dropped", async () => {
    const state = baseState();
    const db = fakeDb(state, []);
    const before = state.integrity.length;
    await recordIntegrityEvents(db, student, "sub1", [
      { event_type: "tab_hidden", question_id: "q1", created_at: "2026-01-03T00:00:00Z" },
      { event_type: "keystroke", question_id: "q1", created_at: "2026-01-03T00:00:01Z" },
    ]);
    expect(state.integrity.length).toBe(before + 1);
    expect(state.integrity.at(-1)!.event_type).toBe("tab_hidden");
  });

  it("another student's submission and teacher callers are refused", async () => {
    const db = fakeDb(baseState(), []);
    await expect(
      recordIntegrityEvents(db, { id: "s2", role: "student" }, "sub1", [
        { event_type: "tab_hidden", question_id: null, created_at: "2026-01-03T00:00:00Z" },
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      recordIntegrityEvents(db, teacher, "sub1", [
        { event_type: "tab_hidden", question_id: null, created_at: "2026-01-03T00:00:00Z" },
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
