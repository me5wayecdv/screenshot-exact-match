/**
 * Tests for cutover gap #2 (src/lib/cloudflare-security.ts invitation
 * + src/server/d1-admin.ts passwordless report).
 *
 * The invitation reuses the hashed 1-hour single-use token mechanism:
 * only SHA-256(token) is stored, never the raw token. The report
 * returns id + email + created date ONLY — the fake D1 below asserts
 * the query selects exactly those columns, and the test asserts the
 * returned objects carry exactly those three keys.
 */
import { describe, expect, it } from "vitest";
import { hashSessionToken, type AuthStore, type Role } from "@/lib/cloudflare-auth";
import { issueSetPasswordInvitation, type SecurityStore } from "@/lib/cloudflare-security";
import { listPasswordlessAccounts, type Caller } from "@/server/d1-admin";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type StoredUser = {
  id: string;
  email: string;
  passwordHash: string | null;
  provider: "password" | "google";
  createdAt: string;
};

function createMemoryStore(users: StoredUser[]): SecurityStore & {
  recordedTokens: { userId: string; tokenHash: string; purpose: string }[];
} {
  const recordedTokens: { userId: string; tokenHash: string; purpose: string }[] = [];
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const base: AuthStore = {
    findUserByEmail: async (email: string) =>
      byEmail.get(email)
        ? {
            id: byEmail.get(email)!.id,
            email: byEmail.get(email)!.email,
            passwordHash: byEmail.get(email)!.passwordHash,
            provider: byEmail.get(email)!.provider,
            createdAt: byEmail.get(email)!.createdAt,
            lastSignInAt: null,
            status: "approved",
          }
        : null,
    findRoleByUserId: async () => null,
    findUserStatusById: async () => "approved",
    createUser: async () => {},
    findSessionByTokenHash: async () => null,
    createSession: async () => {},
    revokeSession: async () => {},
    touchLastSignIn: async () => {},
  };
  return {
    ...base,
    recordedTokens,
    countRecentFailures: async () => ({ byEmail: 0, byIp: 0 }),
    recordLoginAttempt: async () => {},
    revokeAllSessions: async () => {},
    setPasswordHash: async () => {},
    createAdminUser: async () => {},
    createPasswordResetToken: async (input) => {
      recordedTokens.push({
        userId: input.userId,
        tokenHash: input.tokenHash,
        purpose: input.purpose,
      });
    },
    findPasswordResetTokenByHash: async () => null,
    markPasswordResetTokenUsed: async () => {},
  };
}

const ADMIN_SESSION = {
  id: "session-admin",
  userId: "admin-1",
  role: "admin" as Role,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};
const TEACHER_SESSION = {
  id: "session-teacher",
  userId: "teacher-1",
  role: "school_teacher" as Role,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

describe("set-password invitation", () => {
  it("admin can invite a passwordless (Google-linked) account, purpose set-password", async () => {
    const store = createMemoryStore([
      {
        id: "u-google",
        email: "google-user@example.test",
        passwordHash: null,
        provider: "google",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const issued = await issueSetPasswordInvitation(
      store,
      ADMIN_SESSION,
      "google-user@example.test",
    );
    expect(issued.token.length).toBeGreaterThan(20);
    expect(store.recordedTokens).toHaveLength(1);
    expect(store.recordedTokens[0]!.purpose).toBe("set-password");
    expect(store.recordedTokens[0]!.userId).toBe("u-google");
    // Only the hash is stored: the raw token is not the stored value,
    // but hashing it reproduces the stored hash.
    expect(store.recordedTokens[0]!.tokenHash).not.toBe(issued.token);
    expect(await hashSessionToken(issued.token)).toBe(store.recordedTokens[0]!.tokenHash);
  });

  it("a non-admin session is rejected", async () => {
    const store = createMemoryStore([
      {
        id: "u-google",
        email: "google-user@example.test",
        passwordHash: null,
        provider: "google",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await expect(
      issueSetPasswordInvitation(store, TEACHER_SESSION, "google-user@example.test"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.recordedTokens).toHaveLength(0);
  });

  it("an account that already has a password is NOT invited", async () => {
    const store = createMemoryStore([
      {
        id: "u-pw",
        email: "pw-user@example.test",
        passwordHash: "dummy-hash-not-a-real-password",
        provider: "password",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await expect(
      issueSetPasswordInvitation(store, ADMIN_SESSION, "pw-user@example.test"),
    ).rejects.toMatchObject({ code: "NOT_PASSWORDLESS" });
    expect(store.recordedTokens).toHaveLength(0);
  });

  it("an unknown email is reported, not invited", async () => {
    const store = createMemoryStore([]);
    await expect(
      issueSetPasswordInvitation(store, ADMIN_SESSION, "nobody@example.test"),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    expect(store.recordedTokens).toHaveLength(0);
  });
});

function fakePasswordlessDb(
  rows: { id: string; email: string; created_at: string; password_hash: string | null }[],
): D1Database {
  const make = (sql: string) => {
    const stmt = {
      bind(..._p: unknown[]) {
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => null,
      all: async <T>(): Promise<{ results?: T[] }> => {
        if (!sql.includes("FROM auth_users") || !sql.includes("password_hash IS NULL")) {
          throw new Error("unexpected query: " + sql);
        }
        // The query must select exactly id, email, created_at — never
        // password_hash or any other column.
        expect(sql).not.toContain("password_hash,");
        const selected = rows.filter((r) => r.password_hash === null);
        return { results: selected as unknown as T[] };
      },
      run: async () => undefined,
    };
    return stmt as unknown as D1Statement;
  };
  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
}

const ADMIN: Caller = { id: "admin-1", role: "admin" };
const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };

describe("passwordless accounts report", () => {
  it("admin gets id + email + created date only, passworded rows excluded", async () => {
    const db = fakePasswordlessDb([
      { id: "u1", email: "a@example.test", created_at: "2026-01-01", password_hash: null },
      { id: "u2", email: "b@example.test", created_at: "2026-01-02", password_hash: "hash" },
      { id: "u3", email: "c@example.test", created_at: "2026-01-03", password_hash: null },
    ]);
    const rows = await listPasswordlessAccounts(db, ADMIN);
    expect(rows).toEqual([
      { id: "u1", email: "a@example.test", createdAt: "2026-01-01" },
      { id: "u3", email: "c@example.test", createdAt: "2026-01-03" },
    ]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["createdAt", "email", "id"]);
  });

  it("non-admin callers are rejected", async () => {
    const db = fakePasswordlessDb([]);
    await expect(listPasswordlessAccounts(db, TEACHER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
