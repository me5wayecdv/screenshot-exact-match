/**
 * Tests for the D1 take gate (src/server/d1-take-gate.ts).
 * Uses a dispatch fake for D1Database: the test declares, per table,
 * which rows exist, and the fake answers the gate's four queries.
 * This proves the gate's logic (published + window + assignment +
 * group-membership defence in depth) without a Worker binding.
 */
import { describe, expect, it } from "vitest";
import { canTakeAssessment } from "@/server/d1-take-gate";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type FakeData = {
  assessments: Record<string, { status: string; starts_at: string | null; due_at: string | null }>;
  assignments: Set<string>; // `${assessmentId}:${studentId}`
  groupLinks: Record<string, string[]>; // assessmentId -> groupIds
  approvedMembers: Set<string>; // `${groupId}:${studentId}`
};

function fakeDb(data: FakeData): D1Database {
  const stmt = (kind: string, params: unknown[]): D1Statement => {
    const first = async <T>(): Promise<T | null> => {
      if (kind === "assessment") {
        const row = data.assessments[params[0] as string];
        return (row ?? null) as unknown as T | null;
      }
      if (kind === "assignment") {
        return data.assignments.has(`${params[0]}:${params[1]}`)
          ? ({ one: 1 } as unknown as T)
          : null;
      }
      if (kind === "member") {
        return data.approvedMembers.has(`${params[0]}:${params[1]}`)
          ? ({ one: 1 } as unknown as T)
          : null;
      }
      return null;
    };
    const all = async <T>(): Promise<{ results?: T[] }> => {
      if (kind === "links") {
        const ids = data.groupLinks[params[0] as string] ?? [];
        return { results: ids.map((group_id) => ({ group_id }) as unknown as T) };
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
      const kind = sql.includes("FROM assessments")
        ? "assessment"
        : sql.includes("FROM assessment_assignments")
          ? "assignment"
          : sql.includes("FROM group_exams")
            ? "links"
            : sql.includes("FROM group_members")
              ? "member"
              : "unknown";
      let params: unknown[] = [];
      const s = stmt(kind, params);
      // Re-bind through a wrapper that captures params.
      return {
        bind: (...p: unknown[]) => {
          params = p;
          return stmt(kind, params);
        },
        first: s.first,
        all: s.all,
        run: s.run,
      } as unknown as D1Statement;
    },
  };
}

const NOW = "2026-11-03T20:00:00.000Z";
const base: FakeData = {
  assessments: {
    ex1: { status: "published", starts_at: null, due_at: null },
    exDraft: { status: "draft", starts_at: null, due_at: null },
  },
  assignments: new Set(["ex1:student-a", "ex1:student-b"]),
  groupLinks: { ex1: ["group-1"] },
  approvedMembers: new Set(["group-1:student-a"]),
};

describe("take gate", () => {
  it("allows an approved group member with an assignment row", async () => {
    expect(await canTakeAssessment(fakeDb(base), "student-a", "ex1", NOW)).toEqual({
      allowed: true,
    });
  });

  it("blocks a non-member even with a stale assignment row (group defence in depth)", async () => {
    expect(await canTakeAssessment(fakeDb(base), "student-b", "ex1", NOW)).toEqual({
      allowed: false,
      reason: "NOT_GROUP_MEMBER",
    });
  });

  it("blocks a student with no assignment row", async () => {
    expect(await canTakeAssessment(fakeDb(base), "student-c", "ex1", NOW)).toEqual({
      allowed: false,
      reason: "NOT_ASSIGNED",
    });
  });

  it("blocks drafts and unknown assessments", async () => {
    expect(await canTakeAssessment(fakeDb(base), "student-a", "exDraft", NOW)).toEqual({
      allowed: false,
      reason: "NOT_PUBLISHED",
    });
    expect(await canTakeAssessment(fakeDb(base), "student-a", "nope", NOW)).toEqual({
      allowed: false,
      reason: "NOT_FOUND",
    });
  });

  it("allows when the exam has no group links at all", async () => {
    const data: FakeData = { ...base, groupLinks: {} };
    expect(await canTakeAssessment(fakeDb(data), "student-b", "ex1", NOW)).toEqual({
      allowed: true,
    });
  });

  it("blocks a window that has not started or has closed", async () => {
    const future: FakeData = {
      ...base,
      assessments: {
        ex1: { status: "published", starts_at: "2026-12-01T00:00:00.000Z", due_at: null },
      },
      groupLinks: {},
    };
    expect(await canTakeAssessment(fakeDb(future), "student-a", "ex1", NOW)).toEqual({
      allowed: false,
      reason: "NOT_STARTED",
    });
    const past: FakeData = {
      ...base,
      assessments: {
        ex1: { status: "published", starts_at: null, due_at: "2026-11-01T00:00:00.000Z" },
      },
      groupLinks: {},
    };
    expect(await canTakeAssessment(fakeDb(past), "student-a", "ex1", NOW)).toEqual({
      allowed: false,
      reason: "WINDOW_CLOSED",
    });
  });
});
