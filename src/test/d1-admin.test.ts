/**
 * Tests for D1 admin + audit (src/server/d1-admin.ts):
 * the admin-only gate and the actor-only audit rule (admin gets no
 * widened view — the old "actor reads own audit" policy, verbatim).
 * Plus the Stage 11A port coverage: the five-key activity-feed
 * whitelist, keyset cursor paging, 50-row account/passwordless
 * paging, idempotent decideAccount, and rejection-sampled temp
 * passwords.
 */
import { describe, expect, it, vi } from "vitest";
import {
  decideAccount,
  getAdminCounts,
  listAccounts,
  listAuditLog,
  listPasswordlessAccounts,
  listSiteActivity,
  newTemporaryPassword,
  type Caller,
} from "@/server/d1-admin";
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
 * display-only, every actor's rows, newest first, cursor-paged.
 * The fake serves pre-joined rows in the shape the SQL returns and
 * emulates the keyset filter: with a cursor it keeps only rows
 * strictly older than (created_at, id) and applies the LIMIT.
 * It reads the live `rows` array on every call, so tests can insert
 * rows between pages to prove stability.
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
          const sorted = [...rows].sort(
            (a, b) =>
              (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0) ||
              b.id - a.id,
          );
          let pool = sorted;
          let limit: number;
          if (params.length === 4) {
            // Cursor page: (created_at, created_at, id, limit + 1).
            const cAt = params[0] as string;
            const cId = params[2] as number;
            pool = sorted.filter(
              (r) => r.created_at < cAt || (r.created_at === cAt && r.id < cId),
            );
            limit = params[3] as number;
          } else {
            limit = params[0] as number;
          }
          return { results: pool.slice(0, limit) as unknown as T[] };
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
    const page = await listSiteActivity(db, ADMIN);
    expect(page.rows.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(page.nextCursor).toBeNull();
    expect(page.rows[0]).toMatchObject({
      action: "account_approved",
      actorName: "Admin",
      actorEmail: "admin@example.com",
      actorRole: "admin",
      targetName: "Sara",
      targetEmail: "sara@example.com",
    });
    expect(page.rows[0]?.details).toEqual({ target_label: "Sara" });
    expect(page.rows[1]).toMatchObject({
      action: "exam_created",
      actorName: "Mr T",
      actorRole: "school_teacher",
      targetName: null,
    });
    expect(page.rows[1]?.details).toEqual({ target_label: "Algebra Quiz" });
  });

  it("pages by cursor and clamps the page size to 50", async () => {
    const db = fakeActivityDb(ACTIVITY_ROWS);
    const first = await listSiteActivity(db, ADMIN, { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([3, 2]);
    expect(typeof first.nextCursor).toBe("string");
    const second = await listSiteActivity(db, ADMIN, { cursor: first.nextCursor, limit: 2 });
    expect(second.rows.map((r) => r.id)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
    const db2 = fakeActivityDb(ACTIVITY_ROWS);
    await listSiteActivity(db2, ADMIN, { limit: 500 });
    expect(db2.seenParams[0]).toEqual([51]);
    const db3 = fakeActivityDb(ACTIVITY_ROWS);
    await listSiteActivity(db3, ADMIN, { limit: -5 });
    expect(db3.seenParams[0]).toEqual([2]);
  });

  it("never selects a password column", async () => {
    // The feed SQL is the only query this fake serves; assert via the
    // function contract instead: no returned row carries a hash field.
    const db = fakeActivityDb(ACTIVITY_ROWS);
    const page = await listSiteActivity(db, ADMIN);
    for (const r of page.rows) {
      expect(r).not.toHaveProperty("password_hash");
      expect(r).not.toHaveProperty("passwordHash");
      expect(JSON.stringify(r.details)).not.toContain("password");
    }
  });
});

describe("D1 admin activity-feed details whitelist", () => {
  it("strips non-whitelisted keys: scores and answer content never reach the browser", async () => {
    const rows: ActivityRaw[] = [
      {
        id: 1,
        action: "handwritten_grade",
        entity_id: "g1",
        details:
          '{"target_label":"Sara","final_score":8,"answer_text":"my answer","score":9,' +
          '"decision":"approved","to":"published","nested":{"a":1},"count":3}',
        created_at: "2026-11-05T06:00:00.000Z",
        actor_email: "t@example.com",
        actor_name: "Mr T",
        actor_role: "school_teacher",
        target_email: null,
        target_name: "Sara",
      },
    ];
    const db = fakeActivityDb(rows);
    const page = await listSiteActivity(db, ADMIN);
    expect(page.rows[0]?.details).toEqual({
      target_label: "Sara",
      decision: "approved",
      to: "published",
    });
  });

  it("survives malformed JSON and non-object payloads with an empty object", async () => {
    const mk = (details: string): ActivityRaw => ({
      id: 1,
      action: "exam_created",
      entity_id: "exam-1",
      details,
      created_at: "2026-11-05T06:00:00.000Z",
      actor_email: "t@example.com",
      actor_name: "Mr T",
      actor_role: "school_teacher",
      target_email: null,
      target_name: "",
    });
    for (const bad of ['{"broken":', "[]", '"just a string"', "42", "null"]) {
      const db = fakeActivityDb([mk(bad)]);
      const page = await listSiteActivity(db, ADMIN);
      expect(page.rows[0]?.details).toEqual({});
    }
  });

  it("drops non-string and empty whitelisted values and truncates long labels", async () => {
    const rows: ActivityRaw[] = [
      {
        id: 1,
        action: "group_membership_decision",
        entity_id: "g1",
        details: JSON.stringify({
          target_label: "x".repeat(250),
          decision: 5,
          exam_label: "",
          group_label: "Group A",
        }),
        created_at: "2026-11-05T06:00:00.000Z",
        actor_email: "t@example.com",
        actor_name: "Mr T",
        actor_role: "school_teacher",
        target_email: null,
        target_name: "Sara",
      },
    ];
    const db = fakeActivityDb(rows);
    const page = await listSiteActivity(db, ADMIN);
    expect(page.rows[0]?.details).toEqual({
      target_label: "x".repeat(200),
      group_label: "Group A",
    });
  });
});

describe("D1 admin activity-feed cursor paging", () => {
  function fiveRows(): ActivityRaw[] {
    return [1, 2, 3, 4, 5].map((id) => ({
      id,
      action: "exam_created",
      entity_id: `exam-${id}`,
      details: '{"target_label":"Quiz"}',
      created_at: `2026-11-05T06:0${id}:00.000Z`,
      actor_email: "t@example.com",
      actor_name: "Mr T",
      actor_role: "school_teacher",
      target_email: null,
      target_name: "",
    }));
  }

  it("returns stable pages with no overlap and ends with a null cursor", async () => {
    const db = fakeActivityDb(fiveRows());
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listSiteActivity(db, ADMIN, { cursor, limit: 2 });
      expect(page.rows).toHaveLength(page.nextCursor === null ? 1 : 2);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);
    expect(seen).toEqual([5, 4, 3, 2, 1]);
    expect(pages).toBe(3);
  });

  it("is stable across concurrent inserts: a new row never shifts a page in flight", async () => {
    const rows = fiveRows();
    const db = fakeActivityDb(rows);
    const first = await listSiteActivity(db, ADMIN, { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([5, 4]);
    // A new event arrives at the top between pages.
    rows.push({
      id: 6,
      action: "account_signup",
      entity_id: "student-10",
      details: '{"target_label":"New"}',
      created_at: "2026-11-05T06:06:00.000Z",
      actor_email: "n@example.com",
      actor_name: "New",
      actor_role: "student",
      target_email: "n@example.com",
      target_name: "New",
    });
    const second = await listSiteActivity(db, ADMIN, { cursor: first.nextCursor, limit: 2 });
    expect(second.rows.map((r) => r.id)).toEqual([3, 2]);
    // The new row only appears on a fresh first page.
    const fresh = await listSiteActivity(db, ADMIN, { limit: 2 });
    expect(fresh.rows.map((r) => r.id)).toEqual([6, 5]);
  });

  it("treats a malformed cursor as the first page", async () => {
    const db = fakeActivityDb(fiveRows());
    const page = await listSiteActivity(db, ADMIN, { cursor: "not-a-cursor", limit: 2 });
    expect(page.rows.map((r) => r.id)).toEqual([5, 4]);
  });
});

/**
 * Account + passwordless paging: both lists are bounded at 50 rows
 * with hasNext. The fake emulates LIMIT ? OFFSET ? by slicing a
 * pre-sorted copy of the store, the way D1 would.
 */
type AccountRaw = {
  id: string;
  email: string;
  created_at: string;
  status: string;
  full_name: string | null;
  parent_phone: string | null;
  teacher_phone: string | null;
  subjects_text: string | null;
  school: string | null;
  role: string;
};

function fakeAccountListsDb(
  accounts: AccountRaw[],
  passwordless: { id: string; email: string; created_at: string }[],
): D1Database {
  const make = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => null,
      all: async <T>(): Promise<{ results?: T[] }> => {
        const limit = params[0] as number;
        const offset = params[1] as number;
        if (sql.includes("FROM auth_users a JOIN profiles p")) {
          const rank = (s: string) => (s === "pending" ? 0 : s === "approved" ? 1 : 2);
          const sorted = [...accounts].sort(
            (a, b) =>
              rank(a.status) - rank(b.status) ||
              (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0) ||
              (a.id < b.id ? 1 : -1),
          );
          return { results: sorted.slice(offset, offset + limit) as unknown as T[] };
        }
        if (sql.includes("WHERE password_hash IS NULL")) {
          const sorted = [...passwordless].sort(
            (a, b) =>
              (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
              (a.id < b.id ? -1 : 1),
          );
          return { results: sorted.slice(offset, offset + limit) as unknown as T[] };
        }
        return { results: [] };
      },
      run: async () => ({ meta: { changes: 1 } }),
    };
    return stmt as unknown as D1Statement;
  };
  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
}

function manyAccounts(n: number): AccountRaw[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `u-${String(i).padStart(3, "0")}`,
    email: `user${i}@example.com`,
    created_at: `2026-11-0${1 + (i % 5)}T06:${String(i % 60).padStart(2, "0")}:00.000Z`,
    status: i < 10 ? "pending" : "approved",
    full_name: `User ${i}`,
    parent_phone: null,
    teacher_phone: null,
    subjects_text: null,
    school: null,
    role: i % 2 === 0 ? "student" : "school_teacher",
  }));
}

describe("D1 admin account paging", () => {
  it("listAccounts pages at 50 with hasNext and pending first across pages", async () => {
    const db = fakeAccountListsDb(manyAccounts(55), []);
    const first = await listAccounts(db, ADMIN);
    expect(first.rows).toHaveLength(50);
    expect(first.hasNext).toBe(true);
    expect(first.rows.slice(0, 10).every((r) => r.status === "pending")).toBe(true);
    const second = await listAccounts(db, ADMIN, 1);
    expect(second.rows).toHaveLength(5);
    expect(second.hasNext).toBe(false);
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(ids.size).toBe(55);
    const third = await listAccounts(db, ADMIN, 2);
    expect(third.rows).toEqual([]);
    expect(third.hasNext).toBe(false);
  });

  it("listAccounts rejects non-admin callers and clamps bad pages to page 0", async () => {
    const db = fakeAccountListsDb(manyAccounts(3), []);
    await expect(listAccounts(db, TEACHER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const page = await listAccounts(db, ADMIN, -1);
    expect(page.rows).toHaveLength(3);
    expect(page.hasNext).toBe(false);
  });

  it("listPasswordlessAccounts pages at 50 with hasNext, oldest first", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({
      id: `p-${String(i).padStart(3, "0")}`,
      email: `pw${i}@example.com`,
      created_at: `2026-11-05T06:${String(i % 60).padStart(2, "0")}:00.000Z`,
    }));
    const db = fakeAccountListsDb([], rows);
    const first = await listPasswordlessAccounts(db, ADMIN);
    expect(first.rows).toHaveLength(50);
    expect(first.hasNext).toBe(true);
    const second = await listPasswordlessAccounts(db, ADMIN, 1);
    expect(second.rows).toHaveLength(5);
    expect(second.hasNext).toBe(false);
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(ids.size).toBe(55);
    await expect(listPasswordlessAccounts(db, TEACHER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

/**
 * decideAccount idempotency: an in-memory store that emulates the
 * conditional UPDATE guard (status <> decision AND no admin role).
 * "u-race" simulates a role change between the read and the write:
 * the pre-read still sees a teacher, the UPDATE matches nothing,
 * and the re-read sees the admin role.
 */
type MiniUser = { id: string; email: string; fullName: string; role: string; status: string };

function fakeDecideDb(users: MiniUser[]) {
  const state = {
    users: new Map(users.map((u) => [u.id, { ...u }])),
    revocations: 0,
    audits: [] as { actor: string; action: string; entity: string }[],
  };
  const make = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => {
        if (sql.includes("FROM auth_users a") && sql.includes("JOIN user_roles r")) {
          const u = state.users.get(params[0] as string);
          if (!u) return null;
          // u-race: the pre-read still sees the old (teacher) role.
          const role = u.id === "u-race" ? "school_teacher" : u.role;
          return { role, email: u.email, full_name: u.fullName } as T;
        }
        if (sql.includes("SELECT r.role FROM user_roles r")) {
          const u = state.users.get(params[0] as string);
          if (!u) return null;
          // u-race: by the re-read the role has become admin.
          return { role: u.id === "u-race" ? "admin" : u.role } as T;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => ({ results: [] }),
      run: async () => {
        if (sql.includes("UPDATE auth_users SET status")) {
          const [decision, userId] = params as [string, string];
          const u = state.users.get(userId);
          if (!u) return { meta: { changes: 0 } };
          // Emulate the guard: status <> decision AND no admin role.
          // u-race became admin between the read and the write.
          if (u.status === decision || u.role === "admin" || u.id === "u-race") {
            return { meta: { changes: 0 } };
          }
          u.status = decision;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE auth_sessions SET revoked_at")) {
          state.revocations += 1;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT INTO audit_log")) {
          state.audits.push({
            actor: params[0] as string,
            action: params[1] as string,
            entity: params[2] as string,
          });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
    };
    return stmt as unknown as D1Statement;
  };
  const db = { prepare: (sql: string) => make(sql) } as unknown as D1Database;
  return { db, state };
}

describe("D1 admin decideAccount is a single atomic conditional UPDATE", () => {
  const users = (): MiniUser[] => [
    { id: "u-pending", email: "p@example.com", fullName: "Pending", role: "student", status: "pending" },
    { id: "u-approved", email: "a@example.com", fullName: "Approved", role: "student", status: "approved" },
    { id: "u-admin", email: "admin2@example.com", fullName: "Admin Two", role: "admin", status: "pending" },
    { id: "u-race", email: "race@example.com", fullName: "Race", role: "school_teacher", status: "pending" },
  ];

  it("approves a pending account once: changed, one audit row, no revocation", async () => {
    const { db, state } = fakeDecideDb(users());
    const res = await decideAccount(db, ADMIN, { userId: "u-pending", decision: "approved" });
    expect(res).toEqual({ ok: true, status: "approved", changed: true });
    expect(state.users.get("u-pending")?.status).toBe("approved");
    expect(state.audits).toEqual([
      { actor: "admin-1", action: "account_approved", entity: "u-pending" },
    ]);
    expect(state.revocations).toBe(0);
  });

  it("a second identical decision is a no-op: no second audit row, no revocation", async () => {
    const { db, state } = fakeDecideDb(users());
    await decideAccount(db, ADMIN, { userId: "u-pending", decision: "approved" });
    const res = await decideAccount(db, ADMIN, { userId: "u-pending", decision: "approved" });
    expect(res).toEqual({ ok: true, status: "approved", changed: false });
    expect(state.audits).toHaveLength(1);
    expect(state.revocations).toBe(0);
  });

  it("rejection revokes sessions exactly once; a second rejection is a no-op", async () => {
    const { db, state } = fakeDecideDb(users());
    const first = await decideAccount(db, ADMIN, { userId: "u-pending", decision: "rejected" });
    expect(first).toEqual({ ok: true, status: "rejected", changed: true });
    expect(state.revocations).toBe(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]?.action).toBe("account_rejected");
    const second = await decideAccount(db, ADMIN, { userId: "u-pending", decision: "rejected" });
    expect(second.changed).toBe(false);
    expect(state.revocations).toBe(1);
    expect(state.audits).toHaveLength(1);
  });

  it("a reversal still changes a row and still runs its effects", async () => {
    const { db, state } = fakeDecideDb(users());
    await decideAccount(db, ADMIN, { userId: "u-approved", decision: "rejected" });
    expect(state.users.get("u-approved")?.status).toBe("rejected");
    expect(state.revocations).toBe(1);
    expect(state.audits).toHaveLength(1);
  });

  it("refuses admin targets and missing accounts with no side effects", async () => {
    const { db, state } = fakeDecideDb(users());
    await expect(
      decideAccount(db, ADMIN, { userId: "u-admin", decision: "approved" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      decideAccount(db, ADMIN, { userId: "u-missing", decision: "approved" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(state.audits).toEqual([]);
    expect(state.revocations).toBe(0);
    expect(state.users.get("u-admin")?.status).toBe("pending");
  });

  it("a role that became admin between read and write is refused, not decided", async () => {
    const { db, state } = fakeDecideDb(users());
    await expect(
      decideAccount(db, ADMIN, { userId: "u-race", decision: "approved" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(state.audits).toEqual([]);
    expect(state.revocations).toBe(0);
    expect(state.users.get("u-race")?.status).toBe("pending");
  });

  it("rejects non-admin callers and invalid decisions", async () => {
    const { db } = fakeDecideDb(users());
    await expect(
      decideAccount(db, TEACHER, { userId: "u-pending", decision: "approved" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      decideAccount(db, ADMIN, {
        userId: "u-pending",
        decision: "maybe" as "approved",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("D1 admin temporary passwords use rejection sampling", () => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

  it("are 14 chars from the unambiguous alphabet and unique", () => {
    const alphabet = new Set(ALPHABET);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pw = newTemporaryPassword();
      expect(pw).toHaveLength(14);
      for (const ch of pw) expect(alphabet.has(ch)).toBe(true);
      seen.add(pw);
    }
    expect(seen.size).toBe(200);
  });

  it("skips bytes at or above 228 instead of mapping them with % 57 (deterministic)", () => {
    // Interleave a rejected byte (228) before every accepted byte.
    // Accepted bytes arrive as 0, 1, 2, ... so the password must be
    // exactly the first 14 alphabet symbols — the 228s must neither
    // shift the output nor appear in it.
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = i % 2 === 0 ? 228 : Math.floor(i / 2);
        }
        return arr;
      },
    });
    try {
      expect(newTemporaryPassword()).toBe("ABCDEFGHJKLMNP");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("are near-uniform over the alphabet (no modulo bias)", () => {
    // 5,000 passwords x 14 chars = 70,000 draws; uniform expectation is
    // ~1,228 per symbol (sigma ~35). With the old `byte % 57` the first
    // 28 symbols would average ~1,367 and the last 29 ~1,094 — a gap of
    // ~273. The gap between the two group means is the sharp check:
    // under uniform sampling its sigma is ~9, so |gap| < 60 is ~6 sigma
    // and the old bias fails it by ~29 sigma. The loose per-symbol
    // bounds below only guard against gross breakage.
    const counts = new Map<string, number>();
    for (let i = 0; i < 5000; i++) {
      for (const ch of newTemporaryPassword()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(57);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(800);
      expect(n).toBeLessThan(1700);
    }
    const first28 = ALPHABET.slice(0, 28).split("");
    const last29 = ALPHABET.slice(28).split("");
    const mean = (chars: string[]) =>
      chars.reduce((sum, ch) => sum + (counts.get(ch) ?? 0), 0) / chars.length;
    expect(Math.abs(mean(first28) - mean(last29))).toBeLessThan(60);
  });
});
