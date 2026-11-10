/**
 * Tests for the admin approval layer (2026-11-04):
 * - New signups are PENDING and get no session (src/lib/cloudflare-auth.ts).
 * - Pending/rejected accounts cannot sign in, and a live session dies
 *   the moment the account is rejected — this is the gate every
 *   requireCloudflareAuth server function inherits, including the
 *   AI and grading paths (they all sit behind that middleware).
 * - Teacher signup requires a valid Egyptian mobile; subjects/school
 *   are stored for the admin queue.
 * - Admin list/decide/reset (src/server/d1-admin.ts): full identity,
 *   pending first, admin-only, and the reset stores ONLY a PBKDF2
 *   hash — the temporary password is returned once and never logged
 *   or stored anywhere (the audit row must not contain it).
 */
import { describe, expect, it } from "vitest";
import {
  checkSession,
  hashPassword,
  hashSessionToken,
  signIn,
  signUp,
  verifyPassword,
  type AccountStatus,
  type AuthStore,
  type Role,
} from "@/lib/cloudflare-auth";
import { decideAccount, listAccounts, resetUserPassword, type Caller } from "@/server/d1-admin";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

// ---------------------------------------------------------------- auth core

type MemUser = {
  id: string;
  email: string;
  passwordHash: string | null;
  provider: "password" | "google";
  createdAt: string;
  lastSignInAt: string | null;
  status: AccountStatus;
};

type MemSession = {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
};

function createApprovalStore(): AuthStore & {
  users: Map<string, MemUser>;
  sessions: Map<string, MemSession>;
  setStatus(userId: string, status: AccountStatus): void;
} {
  const users = new Map<string, MemUser>();
  const roles = new Map<string, Role>();
  const sessions = new Map<string, MemSession>();
  const byTokenHash = new Map<string, MemSession>();
  return {
    users,
    sessions,
    setStatus(userId: string, status: AccountStatus) {
      for (const u of users.values()) {
        if (u.id === userId) u.status = status;
      }
    },
    async findUserByEmail(email: string) {
      return users.get(email) ?? null;
    },
    async findRoleByUserId(userId: string) {
      return roles.get(userId) ?? null;
    },
    async findUserStatusById(userId: string) {
      for (const u of users.values()) {
        if (u.id === userId) return u.status;
      }
      return null;
    },
    async createUser(input) {
      users.set(input.email, {
        id: input.id,
        email: input.email,
        passwordHash: input.passwordHash,
        provider: "password",
        createdAt: new Date().toISOString(),
        lastSignInAt: null,
        status: "pending",
      });
      roles.set(input.id, input.role);
    },
    async findSessionByTokenHash(tokenHash: string) {
      const s = byTokenHash.get(tokenHash);
      return s
        ? { id: s.id, userId: s.userId, expiresAt: s.expiresAt, revokedAt: s.revokedAt }
        : null;
    },
    async createSession(input) {
      const s: MemSession = {
        id: input.id,
        userId: input.userId,
        expiresAt: input.expiresAt,
        revokedAt: null,
      };
      sessions.set(input.id, s);
      byTokenHash.set(input.tokenHash, s);
    },
    async revokeSession(sessionId: string, revokedAt: string) {
      const s = sessions.get(sessionId);
      if (s) s.revokedAt = revokedAt;
    },
    async touchLastSignIn() {},
  };
}

async function pendingTeacher(store: AuthStore, email = "teacher@example.com") {
  return signUp(store, {
    email,
    password: "correct-horse-battery",
    fullName: "Test Teacher",
    role: "school_teacher",
    teacherPhone: "01012345678",
    subjects: "Math",
    school: "Cairo Center",
    iterations: 1000,
  });
}

describe("admin approval: auth core", () => {
  it("signup creates a PENDING account and NO session", async () => {
    const store = createApprovalStore();
    const created = await pendingTeacher(store);
    expect(created.status).toBe("pending");
    expect(store.sessions.size).toBe(0);
  });

  it("pending sign-in with the right password says waiting, wrong password stays generic", async () => {
    const store = createApprovalStore();
    await pendingTeacher(store);
    await expect(
      signIn(store, { email: "teacher@example.com", password: "correct-horse-battery" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_PENDING" });
    // No status leak to password guessers.
    await expect(
      signIn(store, { email: "teacher@example.com", password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("approved sign-in works; rejected sign-in is blocked with a clear error", async () => {
    const store = createApprovalStore();
    const created = await pendingTeacher(store);
    store.setStatus(created.userId, "approved");
    const signed = await signIn(store, {
      email: "teacher@example.com",
      password: "correct-horse-battery",
    });
    expect(signed.userId).toBe(created.userId);
    store.setStatus(created.userId, "rejected");
    await expect(
      signIn(store, { email: "teacher@example.com", password: "correct-horse-battery" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_REJECTED" });
  });

  it("a live session dies when the account is rejected, and a pending session never validates", async () => {
    const store = createApprovalStore();
    const created = await pendingTeacher(store);
    store.setStatus(created.userId, "approved");
    const signed = await signIn(store, {
      email: "teacher@example.com",
      password: "correct-horse-battery",
    });
    expect((await checkSession(store, signed.sessionToken)).userId).toBe(created.userId);
    // Admin rejects: every protected server function behind the auth
    // middleware now rejects this session (AI/grading paths included).
    store.setStatus(created.userId, "rejected");
    await expect(checkSession(store, signed.sessionToken)).rejects.toMatchObject({
      code: "ACCOUNT_REJECTED",
    });
    // A session forged for a pending account never validates either.
    const pending = await pendingTeacher(store, "pending2@example.com");
    await store.createSession({
      id: "forged-session",
      tokenHash: await hashSessionToken("forged-raw-token"),
      userId: pending.userId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await expect(checkSession(store, "forged-raw-token")).rejects.toMatchObject({
      code: "ACCOUNT_PENDING",
    });
  });

  it("teacher signup requires a valid Egyptian mobile; students do not need one", async () => {
    const store = createApprovalStore();
    await expect(
      signUp(store, {
        email: "t1@example.com",
        password: "correct-horse-battery",
        fullName: "No Phone",
        role: "school_teacher",
        iterations: 1000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHONE" });
    await expect(
      signUp(store, {
        email: "t2@example.com",
        password: "correct-horse-battery",
        fullName: "Bad Phone",
        role: "tutor",
        teacherPhone: "+1 555 123 4567",
        iterations: 1000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PHONE" });
    const ok = await signUp(store, {
      email: "t3@example.com",
      password: "correct-horse-battery",
      fullName: "Good Phone",
      role: "tutor",
      teacherPhone: "01123456789",
      iterations: 1000,
    });
    expect(ok.status).toBe("pending");
    const student = await signUp(store, {
      email: "s@example.com",
      password: "correct-horse-battery",
      fullName: "Student",
      role: "student",
      parentPhone: "+201012345678",
      iterations: 1000,
    });
    expect(student.status).toBe("pending");
  });
});

// ---------------------------------------------------------------- admin fns

type AccountRow = {
  id: string;
  email: string;
  status: AccountStatus;
  role: string;
  fullName: string;
  parentPhone: string | null;
  teacherPhone: string | null;
  subjects: string | null;
  school: string | null;
  createdAt: string;
  passwordHash: string | null;
  sessionsRevoked: boolean;
};

function fakeAdminDb(seed: AccountRow[]): D1Database & {
  rows: AccountRow[];
  seenSql: string[];
  audit: { actor_id: string; action: string; entity_id: string | null; details: string }[];
} {
  const rows = seed.map((r) => ({ ...r }));
  const seenSql: string[] = [];
  const audit: {
    actor_id: string;
    action: string;
    entity_id: string | null;
    details: string;
  }[] = [];
  const make = (sql: string) => {
    seenSql.push(sql);
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => {
        if (sql.includes("FROM auth_users a JOIN user_roles")) {
          const row = rows.find((r) => r.id === params[0]);
          return (row ? { role: row.role, email: row.email, full_name: row.fullName } : null) as T;
        }
        if (sql.includes("FROM auth_users a") && sql.includes("WHERE a.id = ?")) {
          const row = rows.find((r) => r.id === params[0]);
          return (row ? { id: row.id, email: row.email, full_name: row.fullName } : null) as T;
        }
        if (sql.includes("FROM auth_users WHERE id")) {
          const row = rows.find((r) => r.id === params[0]);
          return (row ? { id: row.id } : null) as T;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => {
        if (sql.includes("LEFT JOIN teacher_profiles")) {
          const ordered = [...rows].sort((a, b) => {
            const rank = (s: AccountStatus) => (s === "pending" ? 0 : s === "approved" ? 1 : 2);
            return rank(a.status) - rank(b.status) || (a.createdAt < b.createdAt ? 1 : -1);
          });
          return {
            results: ordered.map((r) => ({
              id: r.id,
              email: r.email,
              created_at: r.createdAt,
              status: r.status,
              full_name: r.fullName,
              parent_phone: r.parentPhone,
              teacher_phone: r.teacherPhone,
              subjects_text: r.subjects,
              school: r.school,
              role: r.role,
            })) as unknown as T[],
          };
        }
        return { results: [] };
      },
      run: async () => {
        if (sql.startsWith("UPDATE auth_users SET status")) {
          const row = rows.find((r) => r.id === params[1]);
          if (row) row.status = params[0] as AccountStatus;
        } else if (sql.startsWith("UPDATE auth_users SET password_hash")) {
          const row = rows.find((r) => r.id === params[1]);
          if (row) row.passwordHash = params[0] as string;
        } else if (sql.startsWith("UPDATE auth_sessions SET revoked_at")) {
          for (const r of rows) {
            if (r.id === params[1]) r.sessionsRevoked = true;
          }
        } else if (sql.startsWith("INSERT INTO audit_log")) {
          audit.push({
            actor_id: params[0] as string,
            action: params[1] as string,
            entity_id: params[2] as string | null,
            details: params[3] as string,
          });
        }
        return { meta: { changes: 1 } };
      },
    };
    return stmt as unknown as D1Statement;
  };
  return {
    rows,
    seenSql,
    audit,
    prepare: (sql: string) => make(sql),
  } as unknown as D1Database & {
    rows: AccountRow[];
    seenSql: string[];
    audit: { actor_id: string; action: string; entity_id: string | null; details: string }[];
  };
}

const ADMIN: Caller = { id: "admin-1", role: "admin" };
const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };

function seedRows(): AccountRow[] {
  return [
    {
      id: "u-pending-teacher",
      email: "pending-teacher@example.com",
      status: "pending",
      role: "school_teacher",
      fullName: "Pending Teacher",
      parentPhone: null,
      teacherPhone: "+201012345678",
      subjects: "Physics",
      school: "Cairo Center",
      createdAt: "2026-11-04T10:00:00.000Z",
      passwordHash: "pbkdf2-sha256$1000$abc$def",
      sessionsRevoked: false,
    },
    {
      id: "u-approved-student",
      email: "student@example.com",
      status: "approved",
      role: "student",
      fullName: "Approved Student",
      parentPhone: "+201112345678",
      teacherPhone: null,
      subjects: null,
      school: null,
      createdAt: "2026-11-04T09:00:00.000Z",
      passwordHash: "pbkdf2-sha256$1000$abc$def",
      sessionsRevoked: false,
    },
    {
      id: "u-admin",
      email: "admin@example.com",
      status: "approved",
      role: "admin",
      fullName: "Admin",
      parentPhone: null,
      teacherPhone: null,
      subjects: null,
      school: null,
      createdAt: "2026-11-04T08:00:00.000Z",
      passwordHash: "pbkdf2-sha256$1000$abc$def",
      sessionsRevoked: false,
    },
  ];
}

describe("admin approval: admin functions", () => {
  it("list shows full identity with pending first, and never selects password hashes", async () => {
    const db = fakeAdminDb(seedRows());
    const { rows: accounts } = await listAccounts(db, ADMIN);
    expect(accounts.map((a) => a.id)).toEqual([
      "u-pending-teacher",
      "u-approved-student",
      "u-admin",
    ]);
    const teacher = accounts[0]!;
    expect(teacher.email).toBe("pending-teacher@example.com");
    expect(teacher.fullName).toBe("Pending Teacher");
    expect(teacher.phone).toBe("+201012345678");
    expect(teacher.subjects).toBe("Physics");
    expect(teacher.school).toBe("Cairo Center");
    expect(teacher.role).toBe("school_teacher");
    expect(teacher.status).toBe("pending");
    // A student shows the parent phone, not a teacher phone.
    expect(accounts[1]!.phone).toBe("+201112345678");
    expect(accounts[1]!.subjects).toBeNull();
    // The list query must never touch password hashes.
    expect(db.seenSql.some((s) => s.includes("password_hash"))).toBe(false);
    // No returned object carries a hash field at all.
    for (const a of accounts) {
      expect(a).not.toHaveProperty("passwordHash");
      expect(a).not.toHaveProperty("password_hash");
    }
    await expect(listAccounts(db, TEACHER)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("approve unlocks and reject revokes sessions; admin rows are untouchable", async () => {
    const db = fakeAdminDb(seedRows());
    const approved = await decideAccount(db, ADMIN, {
      userId: "u-pending-teacher",
      decision: "approved",
    });
    expect(approved.status).toBe("approved");
    expect(db.rows.find((r) => r.id === "u-pending-teacher")!.status).toBe("approved");
    const rejected = await decideAccount(db, ADMIN, {
      userId: "u-approved-student",
      decision: "rejected",
    });
    expect(rejected.status).toBe("rejected");
    expect(db.rows.find((r) => r.id === "u-approved-student")!.sessionsRevoked).toBe(true);
    expect(db.audit.map((a) => a.action)).toEqual(["account_approved", "account_rejected"]);
    // Activity-feed labels: each decision row names its target account.
    for (const a of db.audit) {
      const details = JSON.parse(a.details) as { target_label?: unknown };
      expect(typeof details.target_label).toBe("string");
      expect((details.target_label as string).length).toBeGreaterThan(0);
      expect(a.details).not.toContain("password_hash");
    }
    await expect(
      decideAccount(db, ADMIN, { userId: "u-admin", decision: "rejected" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      decideAccount(db, TEACHER, { userId: "u-pending-teacher", decision: "approved" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      decideAccount(db, ADMIN, {
        userId: "u-pending-teacher",
        decision: "maybe" as "approved",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reset stores only a PBKDF2 hash: temp verifies, old password dies, audit has no temp", async () => {
    const db = fakeAdminDb(seedRows());
    const oldHash = await hashPassword("old-password-here", 1000);
    const row = db.rows.find((r) => r.id === "u-approved-student")!;
    row.passwordHash = oldHash;
    const result = await resetUserPassword(db, ADMIN, { userId: "u-approved-student" });
    expect(result.temporaryPassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{14}$/);
    const stored = db.rows.find((r) => r.id === "u-approved-student")!.passwordHash!;
    // Stored value is a hash, never the plaintext.
    expect(stored).toMatch(/^pbkdf2-sha256\$\d+\$/);
    expect(stored).not.toContain(result.temporaryPassword);
    expect(await verifyPassword(result.temporaryPassword, stored)).toBe(true);
    expect(await verifyPassword("old-password-here", stored)).toBe(false);
    expect(row.sessionsRevoked).toBe(true);
    // The audit row records the reset but must not contain the temp value.
    const auditRow = db.audit.find((a) => a.action === "password_reset")!;
    expect(auditRow).toBeDefined();
    expect(auditRow.details).not.toContain(result.temporaryPassword);
    // ...but it does carry the feed label (target account name/email).
    const resetDetails = JSON.parse(auditRow.details) as { target_label?: unknown };
    expect(typeof resetDetails.target_label).toBe("string");
    expect((resetDetails.target_label as string).length).toBeGreaterThan(0);
    await expect(
      resetUserPassword(db, TEACHER, { userId: "u-approved-student" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(resetUserPassword(db, ADMIN, { userId: "no-such-user" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
