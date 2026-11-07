/**
 * Tests for Phase 2 security hardening (src/lib/cloudflare-security.ts).
 * Storage is an in-memory SecurityStore, so these prove the rules
 * (rate limiting, rotation, reset tokens, admin gating) without a D1
 * binding. The D1 SQL for the underlying tables is in
 * schema/d1-security.sql; the D1 store functions are thin translations
 * of the same operations tested here.
 *
 * Note: signUp uses iterations: 1000 for speed. consumePasswordReset
 * hashes with the production default (100,000) exactly once per test
 * that uses it, proving the stored format round-trips.
 */
import { describe, expect, it } from "vitest";
import {
  checkSession,
  hashSessionToken,
  signIn,
  signUp,
  type AuthStore,
  type Role,
} from "@/lib/cloudflare-auth";
import {
  checkLoginAllowed,
  consumePasswordResetToken,
  createAdmin,
  issuePasswordResetToken,
  signInWithRotation,
  type SecurityStore,
} from "@/lib/cloudflare-security";

type StoredUser = {
  id: string;
  email: string;
  passwordHash: string | null;
  provider: "password" | "google";
  createdAt: string;
  lastSignInAt: string | null;
  status: "pending" | "approved" | "rejected";
};
type StoredSession = {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
};
type StoredReset = {
  id: string;
  userId: string;
  purpose: "reset" | "set-password";
  expiresAt: string;
  usedAt: string | null;
};

function createMemorySecurityStore(): SecurityStore & {
  sessions: Map<string, StoredSession>;
  /** Test-only approval: mirrors the admin approve action. */
  approveUser(userId: string): void;
} {
  const users = new Map<string, StoredUser>();
  const roles = new Map<string, Role>();
  const sessions = new Map<string, StoredSession>();
  const byTokenHash = new Map<string, StoredSession>();
  const attempts: { email: string; ip: string; succeeded: boolean; atIso: string }[] = [];
  const resets = new Map<string, StoredReset>();
  return {
    sessions,
    approveUser(userId: string) {
      for (const u of users.values()) {
        if (u.id === userId) u.status = "approved";
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
      const s: StoredSession = {
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
    async countRecentFailures(input) {
      const byEmail = attempts.filter(
        (a) => a.email === input.email && !a.succeeded && a.atIso > input.sinceIso,
      ).length;
      const byIp = attempts.filter(
        (a) => a.ip === input.ip && !a.succeeded && a.atIso > input.sinceIso,
      ).length;
      return { byEmail, byIp };
    },
    async recordLoginAttempt(input) {
      attempts.push(input);
    },
    async revokeAllSessions(userId: string, atIso: string) {
      for (const s of sessions.values()) {
        if (s.userId === userId && !s.revokedAt) s.revokedAt = atIso;
      }
    },
    async setPasswordHash(userId: string, passwordHash: string) {
      for (const u of users.values()) {
        if (u.id === userId) u.passwordHash = passwordHash;
      }
    },
    async createAdminUser(input) {
      users.set(input.email, {
        id: input.id,
        email: input.email,
        passwordHash: input.passwordHash,
        provider: "password",
        createdAt: new Date().toISOString(),
        lastSignInAt: null,
        status: "approved",
      });
      roles.set(input.id, "admin");
    },
    async createPasswordResetToken(input) {
      resets.set(input.tokenHash, {
        id: input.id,
        userId: input.userId,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        usedAt: null,
      });
    },
    async findPasswordResetTokenByHash(tokenHash: string) {
      return resets.get(tokenHash) ?? null;
    },
    async markPasswordResetTokenUsed(id: string, atIso: string) {
      for (const r of resets.values()) {
        if (r.id === id) r.usedAt = atIso;
      }
    },
  };
}

// Sign-up creates a PENDING account with no session, so the helper
// approves and signs in to give tests a usable session (mirroring the
// admin approval step).
async function signedUpTeacher(store: ReturnType<typeof createMemorySecurityStore>) {
  const created = await signUp(store, {
    email: "teacher@example.com",
    password: "correct-horse-battery",
    fullName: "Test Teacher",
    role: "school_teacher",
    teacherPhone: "01012345678",
    iterations: 1000,
  });
  store.approveUser(created.userId);
  return signIn(store, {
    email: "teacher@example.com",
    password: "correct-horse-battery",
  });
}

describe("rate limiting", () => {
  it("blocks the account after 10 failures in the window, and success does not clear it", async () => {
    const store = createMemorySecurityStore();
    await signedUpTeacher(store);
    for (let i = 0; i < 10; i++) {
      await expect(
        signInWithRotation(store, {
          email: "teacher@example.com",
          password: "wrong-password",
          ip: "1.2.3.4",
        }),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }
    await expect(
      signInWithRotation(store, {
        email: "teacher@example.com",
        password: "correct-horse-battery",
        ip: "1.2.3.4",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // A different account from the same IP is still under the IP cap.
    await expect(
      checkLoginAllowed(store, { email: "other@example.com", ip: "1.2.3.4" }),
    ).resolves.toBeUndefined();
  });

  it("blocks an IP after 50 failures across accounts", async () => {
    const store = createMemorySecurityStore();
    for (let i = 0; i < 50; i++) {
      await store.recordLoginAttempt({
        email: `victim${i}@example.com`,
        ip: "9.9.9.9",
        succeeded: false,
        atIso: new Date().toISOString(),
      });
    }
    await expect(
      checkLoginAllowed(store, { email: "fresh@example.com", ip: "9.9.9.9" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("session rotation", () => {
  it("revokes the presented session on a new sign-in", async () => {
    const store = createMemorySecurityStore();
    const first = await signedUpTeacher(store);
    const second = await signInWithRotation(store, {
      email: "teacher@example.com",
      password: "correct-horse-battery",
      ip: "1.2.3.4",
      previousRawToken: first.sessionToken,
    });
    await expect(checkSession(store, first.sessionToken)).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });
    expect((await checkSession(store, second.sessionToken)).userId).toBe(first.userId);
  });
});

describe("password reset tokens", () => {
  it("issues, consumes, revokes all sessions, and rejects reuse", async () => {
    const store = createMemorySecurityStore();
    const created = await signedUpTeacher(store);
    const issued = await issuePasswordResetToken(store, "teacher@example.com");
    expect(issued.token).toBeTruthy();
    const consumed = await consumePasswordResetToken(store, {
      token: issued.token!,
      newPassword: "brand-new-password",
    });
    expect(consumed.userId).toBe(created.userId);
    // Old session is dead after reset.
    await expect(checkSession(store, created.sessionToken)).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });
    // New password works; reuse of the token fails generically.
    const signed = await signIn(store, {
      email: "teacher@example.com",
      password: "brand-new-password",
    });
    expect(signed.userId).toBe(created.userId);
    await expect(
      consumePasswordResetToken(store, { token: issued.token!, newPassword: "another-one" }),
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });
  });

  it("returns no token for unknown emails and rejects unknown tokens generically", async () => {
    const store = createMemorySecurityStore();
    await expect(issuePasswordResetToken(store, "nobody@example.com")).resolves.toMatchObject({
      ok: true,
      token: null,
    });
    await expect(
      consumePasswordResetToken(store, { token: "no-such-token", newPassword: "x".repeat(12) }),
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });
  });

  it("rejects an expired token with the same generic error", async () => {
    const store = createMemorySecurityStore();
    await signedUpTeacher(store);
    const issued = await issuePasswordResetToken(store, "teacher@example.com");
    const expiredStore: SecurityStore = {
      ...store,
      async findPasswordResetTokenByHash(tokenHash: string) {
        const row = await store.findPasswordResetTokenByHash(tokenHash);
        return row ? { ...row, expiresAt: new Date(Date.now() - 1000).toISOString() } : null;
      },
    };
    await expect(
      consumePasswordResetToken(expiredStore, {
        token: issued.token!,
        newPassword: "brand-new-password",
      }),
    ).rejects.toMatchObject({ code: "RESET_TOKEN_INVALID" });
  });

  it("a set-password token works for a Google account with no password", async () => {
    const store = createMemorySecurityStore();
    // Seed a Google-linked user directly (no password hash).
    const googleStore: AuthStore = {
      ...store,
      async findUserByEmail(email: string) {
        if (email === "google@example.com") {
          return {
            id: "google-user",
            email: "google@example.com",
            passwordHash: null,
            provider: "google",
            createdAt: new Date().toISOString(),
            lastSignInAt: null,
            status: "approved",
          };
        }
        return store.findUserByEmail(email);
      },
    };
    const issued = await issuePasswordResetToken(
      googleStore as unknown as SecurityStore,
      "google@example.com",
    );
    expect(issued.token).toBeTruthy();
    // Consumption is exercised in the main reset test; here the
    // purpose is that issuance does not fail for a NULL-hash account.
  });
});

describe("admin creation", () => {
  it("forbids non-admins and allows an existing admin", async () => {
    const store = createMemorySecurityStore();
    const teacher = await signedUpTeacher(store);
    const teacherSession = await checkSession(store, teacher.sessionToken);
    await expect(
      createAdmin(store, teacherSession, {
        email: "newadmin@example.com",
        password: "correct-horse-battery",
        fullName: "New Admin",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Seed an admin session by creating one through the store.
    await store.createAdminUser({
      id: "admin-1",
      email: "admin@example.com",
      passwordHash: "x",
      fullName: "Admin",
    });
    const adminSession = {
      id: "s",
      userId: "admin-1",
      role: "admin" as Role,
      expiresAt: "2099-01-01",
    };
    const created = await createAdmin(store, adminSession, {
      email: "newadmin@example.com",
      password: "correct-horse-battery",
      fullName: "New Admin",
    });
    expect(created.userId).toBeTruthy();
    expect(await store.findRoleByUserId(created.userId)).toBe("admin");
  });
});
