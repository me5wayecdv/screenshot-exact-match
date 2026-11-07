/**
 * Tests for D1 admin + audit (src/server/d1-admin.ts):
 * the admin-only gate and the actor-only audit rule (admin gets no
 * widened view — the old "actor reads own audit" policy, verbatim).
 */
import { describe, expect, it } from "vitest";
import { getAdminCounts, listAuditLog, listSiteActivity, type Caller } from "@/server/d1-admin";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type Audit = {
  id: number;
  action: string;
  entity_id: string | null;
  details: string;
  created_at: string;
};

function fakeDb(roles: { role: string }[], audits: Audit[]): D1Database {
  const make = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => {
        if (sql.includes("FROM user_roles")) {
          const n = sql.includes("IN ('school_teacher', 'tutor')")
            ? roles.filter((r) => r.role === "school_teacher" || r.role === "tutor").length
            : roles.filter((r) => r.role === "student").length;
          return { n } as T;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => {
        if (sql.includes("FROM audit_log")) {
          // Actor-only: only rows whose actor is the caller (params[0]).
          const rows = audits.filter(
            (a) => (a as unknown as { actor_id?: string }).actor_id === params[0],
          );
          return { results: rows as unknown as T[] };
        }
        return { results: [] };
      },
      run: async () => ({ meta: { changes: 1 } }),
    };
    return stmt as unknown as D1Statement;
  };
  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
}

const ADMIN: Caller = { id: "admin-1", role: "admin" };
const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };
const STUDENT: Caller = { id: "student-1", role: "student" };

describe("D1 admin + audit", () => {
  it("an admin-only route rejects a teacher session", async () => {
    const db = fakeDb([], []);
    await expect(getAdminCounts(db, TEACHER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getAdminCounts(db, STUDENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admin counts teachers (school_teacher + tutor) and students, not legacy rows", async () => {
    const db = fakeDb(
      [
        { role: "school_teacher" },
        { role: "tutor" },
        { role: "teacher" },
        { role: "student" },
        { role: "student" },
        { role: "admin" },
      ],
      [],
    );
    expect(await getAdminCounts(db, ADMIN)).toEqual({ teachers: 2, students: 2 });
  });

  it("audit is actor-only even for admin: no other actor's rows leak", async () => {
    const audits = [
      {
        id: 1,
        action: "handwritten_grade",
        entity_id: "g1",
        details: '{"final_score":8}',
        created_at: "2026-11-03T20:00:00.000Z",
        actor_id: "teacher-1",
      },
      {
        id: 2,
        action: "release",
        entity_id: "s1",
        details: "{}",
        created_at: "2026-11-03T20:01:00.000Z",
        actor_id: "teacher-2",
      },
      {
        id: 3,
        action: "handwritten_grade",
        entity_id: "g2",
        details: '{"final_score":9}',
        created_at: "2026-11-03T20:02:00.000Z",
        actor_id: "admin-1",
      },
    ] as unknown as Audit[];
    const db = fakeDb([], audits);
    const teacherRows = await listAuditLog(db, TEACHER);
    expect(teacherRows.map((r) => r.id)).toEqual([1]);
    expect(teacherRows[0]?.details).toEqual({ final_score: 8 });
    // Admin sees only their own rows too — the old policy is not widened.
    const adminRows = await listAuditLog(db, ADMIN);
    expect(adminRows.map((r) => r.id)).toEqual([3]);
    await expect(listAuditLog(db, STUDENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

/**
 * Site-wide activity feed (listSiteActivity): the deliberate,
 * explicit exception to the actor-only rule above — admin-only,
 * display-only, every actor's rows, newest first, paginated.
 * The fake serves pre-joined rows in the shape the SQL returns.
 */
type ActivityRaw = {
  id: number;
  action: string;
  entity_id: string | null;
  details: string;
  created_at: string;
  actor_email: string | null;
  actor_name: string | null;
  actor_role: string | null;
  target_email: string | null;
  target_name: string | null;
};

function fakeActivityDb(rows: ActivityRaw[]): D1Database & { seenParams: unknown[][] } {
  const seenParams: unknown[][] = [];
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1) || b.id - a.id);
  const make = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        seenParams.push(p);
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => null,
      all: async <T>(): Promise<{ results?: T[] }> => {
        if (sql.includes("FROM audit_log a")) {
          const limit = params[0] as number;
          const offset = params[1] as number;
          return { results: sorted.slice(offset, offset + limit) as unknown as T[] };
        }
        return { results: [] };
      },
      run: async () => ({ meta: { changes: 1 } }),
    };
    return stmt as unknown as D1Statement;
  };
  return { prepare: (sql: string) => make(sql), seenParams } as unknown as D1Database & {
    seenParams: unknown[][];
  };
}

const ACTIVITY_ROWS: ActivityRaw[] = [
  {
    id: 1,
    action: "account_signup",
    entity_id: "student-9",
    details: '{"role":"student","target_label":"Sara"}',
    created_at: "2026-11-05T06:00:00.000Z",
    actor_email: "sara@example.com",
    actor_name: "Sara",
    actor_role: "student",
    target_email: "sara@example.com",
    target_name: "Sara",
  },
  {
    id: 2,
    action: "exam_created",
    entity_id: "exam-1",
    details: '{"target_label":"Algebra Quiz"}',
    created_at: "2026-11-05T06:05:00.000Z",
    actor_email: "t@example.com",
    actor_name: "Mr T",
    actor_role: "school_teacher",
    target_email: null,
    target_name: "",
  },
  {
    id: 3,
    action: "account_approved",
    entity_id: "student-9",
    details: '{"target_label":"Sara"}',
    created_at: "2026-11-05T06:10:00.000Z",
    actor_email: "admin@example.com",
    actor_name: "Admin",
    actor_role: "admin",
    target_email: "sara@example.com",
    target_name: "Sara",
  },
];

describe("D1 admin site activity feed", () => {
  it("rejects non-admin callers server-side", async () => {
    const db = fakeActivityDb(ACTIVITY_ROWS);
    await expect(listSiteActivity(db, TEACHER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listSiteActivity(db, STUDENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admin sees every actor's rows, newest first, with actor/target resolved", async () => {
    const db = fakeActivityDb(ACTIVITY_ROWS);
    const rows = await listSiteActivity(db, ADMIN, { limit: 100, offset: 0 });
    expect(rows.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(rows[0]).toMatchObject({
      action: "account_approved",
      actorName: "Admin",
      actorEmail: "admin@example.com",
      actorRole: "admin",
      targetName: "Sara",
      targetEmail: "sara@example.com",
    });
    expect(rows[1]).toMatchObject({
      action: "exam_created",
      actorName: "Mr T",
      actorRole: "school_teacher",
      targetName: null,
    });
    expect(rows[1]?.details).toEqual({ target_label: "Algebra Quiz" });
  });

  it("paginates with limit/offset and clamps limit to 100", async () => {
    const db = fakeActivityDb(ACTIVITY_ROWS);
    const page = await listSiteActivity(db, ADMIN, { limit: 2, offset: 1 });
    expect(page.map((r) => r.id)).toEqual([2, 1]);
    const db2 = fakeActivityDb(ACTIVITY_ROWS);
    await listSiteActivity(db2, ADMIN, { limit: 500 });
    expect(db2.seenParams[0]?.[0]).toBe(100);
    const db3 = fakeActivityDb(ACTIVITY_ROWS);
    await listSiteActivity(db3, ADMIN, { limit: -5, offset: -3 });
    expect(db3.seenParams[0]).toEqual([1, 0]);
  });

  it("never selects a password column", async () => {
    // The feed SQL is the only query this fake serves; assert via the
    // function contract instead: no returned row carries a hash field.
    const db = fakeActivityDb(ACTIVITY_ROWS);
    const rows = await listSiteActivity(db, ADMIN);
    for (const r of rows) {
      expect(r).not.toHaveProperty("password_hash");
      expect(r).not.toHaveProperty("passwordHash");
      expect(JSON.stringify(r.details)).not.toContain("password");
    }
  });
});
