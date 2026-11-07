/**
 * Tests for the custom auth core (src/lib/cloudflare-auth.ts).
 * Storage is an in-memory AuthStore, so these tests prove the logic
 * (hashing, session validity, role gates) without a D1 binding. The
 * D1 SQL itself is proven separately by scripts/d1-smoke.ts, which
 * runs the same logic against real SQLite via bun:sqlite.
 *
 * Note on iterations: tests pass iterations: 1000 to signUp so the
 * suite stays fast. The stored format carries the iteration count, so
 * verification always follows the stored value; production sign-ups
 * use the 100,000 default in cloudflare-auth.ts (the Workers
 * WebCrypto PBKDF2 cap — see pbkdf2-iterations.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  AuthError,
  checkSession,
  hashSessionToken,
  requireRole,
  signIn,
  signOut,
  signUp,
  type AuthSession,
  type AuthStore,
  type Role,
} from "@/lib/cloudflare-auth";

type StoredSession = {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
};

function createMemoryStore(): AuthStore & {
  sessions: Map<string, StoredSession>;
  setSessionExpiry(tokenHash: string, expiresAt: string): void;
  /** Test-only approval: mirrors the admin approve action. */
  approveUser(userId: string): void;
} {
  const users = new Map<
    string,
    {
      id: string;
      email: string;
      passwordHash: string | null;
      provider: "password" | "google";
      createdAt: string;
      lastSignInAt: string | null;
      status: "pending" | "approved" | "rejected";
    }
  >();
  const roles = new Map<string, Role>();
  const sessions = new Map<string, StoredSession>();
  const byTokenHash = new Map<string, StoredSession>();
  return {
    sessions,
    setSessionExpiry(tokenHash: string, expiresAt: string) {
      const s = byTokenHash.get(tokenHash);
      if (s) s.expiresAt = expiresAt;
    },
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
        ? {
            id: s.id,
            userId: s.userId,
            expiresAt: s.expiresAt,
            revokedAt: s.revokedAt,
          }
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
  };
}

// Sign-up creates a PENDING account with no session, so the helper
// approves and signs in to give tests a usable session (mirroring the
// admin approval step). Tests for the pending gate itself live in
// d1-account-approval.test.ts.
async function signedUpTeacher(store: ReturnType<typeof createMemoryStore>) {
  const created = await signUp(store, {
    email: "Teacher@Example.com",
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

describe("custom auth core", () => {
  it("sign-up lowercases the email and the session checks out with its role", async () => {
    const store = createMemoryStore();
    const created = await signedUpTeacher(store);
    const session: AuthSession = await checkSession(store, created.sessionToken);
    expect(session.userId).toBe(created.userId);
    expect(session.role).toBe("school_teacher");
    // The stored token hash is not the raw token.
    const hash = await hashSessionToken(created.sessionToken);
    expect(hash).not.toBe(created.sessionToken);
    expect(store.sessions.size).toBe(1);
  });

  it("rejects a wrong password and an unknown email with the same generic error", async () => {
    const store = createMemoryStore();
    await signedUpTeacher(store);
    await expect(
      signIn(store, { email: "teacher@example.com", password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(
      signIn(store, { email: "nobody@example.com", password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("accepts the correct password after a failed attempt", async () => {
    const store = createMemoryStore();
    await signedUpTeacher(store);
    await expect(
      signIn(store, { email: "teacher@example.com", password: "nope-nope-no" }),
    ).rejects.toBeInstanceOf(AuthError);
    const signed = await signIn(store, {
      email: "teacher@example.com",
      password: "correct-horse-battery",
    });
    expect((await checkSession(store, signed.sessionToken)).role).toBe("school_teacher");
  });

  it("rejects expired sessions", async () => {
    const store = createMemoryStore();
    const created = await signedUpTeacher(store);
    store.setSessionExpiry(
      await hashSessionToken(created.sessionToken),
      new Date(Date.now() - 1000).toISOString(),
    );
    await expect(checkSession(store, created.sessionToken)).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
  });

  it("rejects revoked sessions after sign-out", async () => {
    const store = createMemoryStore();
    const created = await signedUpTeacher(store);
    await signOut(store, created.sessionToken);
    await expect(checkSession(store, created.sessionToken)).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });
    // Signing out again with a dead token is a no-op, never an error.
    await expect(signOut(store, created.sessionToken)).resolves.toBeUndefined();
  });

  it("rejects unknown session tokens", async () => {
    const store = createMemoryStore();
    await expect(checkSession(store, "no-such-token")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("enforces roles: a student cannot pass a teacher gate", async () => {
    const store = createMemoryStore();
    const created = await signUp(store, {
      email: "student@example.com",
      password: "correct-horse-battery",
      fullName: "Test Student",
      role: "student",
      iterations: 1000,
    });
    store.approveUser(created.userId);
    const signed = await signIn(store, {
      email: "student@example.com",
      password: "correct-horse-battery",
    });
    const session = await checkSession(store, signed.sessionToken);
    expect(() => requireRole(session, ["school_teacher", "tutor"])).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(requireRole(session, ["student"]).role).toBe("student");
  });

  it("never lets sign-up create an admin", async () => {
    const store = createMemoryStore();
    await expect(
      signUp(store, {
        email: "admin@example.com",
        password: "correct-horse-battery",
        fullName: "Sneaky",
        role: "admin",
        iterations: 1000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROLE" });
  });

  it("rejects duplicate emails, weak passwords, and bad emails", async () => {
    const store = createMemoryStore();
    await signedUpTeacher(store);
    await expect(
      signUp(store, {
        email: "TEACHER@example.com",
        password: "another-good-password",
        fullName: "Duplicate",
        role: "tutor",
        iterations: 1000,
      }),
    ).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
    await expect(
      signUp(store, {
        email: "new@example.com",
        password: "short",
        fullName: "Weak",
        role: "student",
        iterations: 1000,
      }),
    ).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    await expect(
      signUp(store, {
        email: "not-an-email",
        password: "correct-horse-battery",
        fullName: "Bad",
        role: "student",
        iterations: 1000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_EMAIL" });
  });

  it("an OAuth account with no password hash can never password-sign-in", async () => {
    const store = createMemoryStore();
    const oauthStore: AuthStore = {
      ...store,
      async findUserByEmail() {
        return {
          id: "oauth-user",
          email: "oauth@example.com",
          passwordHash: null,
          provider: "google",
          createdAt: new Date().toISOString(),
          lastSignInAt: null,
          status: "approved",
        };
      },
    };
    await expect(
      signIn(oauthStore, { email: "oauth@example.com", password: "anything" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
});
