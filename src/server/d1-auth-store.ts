/**
 * D1 implementation of the AuthStore interface (Phase 1).
 *
 * Thin SQL translation layer only: no security decisions live here.
 * All password/session/role rules are in src/lib/cloudflare-auth.ts.
 * Every query below is a prepared statement with bound parameters —
 * never interpolate user input into SQL strings.
 *
 * D1 interface shape (matches Cloudflare's D1Database API):
 *   db.prepare(sql).bind(...params).first<T>() / .all<T>() / .run()
 * The createUser write uses db.batch() so auth_users + profiles +
 * user_roles are created atomically; a failure in any of them rolls
 * the whole sign-up back instead of leaving a half-created account.
 */

import type { AccountStatus, AuthStore, AuthUser, Role } from "@/lib/cloudflare-auth";

export type D1Result<T = Record<string, unknown>> = {
  results?: T[];
};

export type D1Statement = {
  bind(...params: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
};

export type D1Database = {
  prepare(sql: string): D1Statement;
  batch?(statements: D1Statement[]): Promise<unknown>;
};

type UserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  provider: string;
  created_at: string;
  last_sign_in_at: string | null;
  status: string | null;
};

/** Unknown/missing status fails closed: treated as pending, never approved. */
function toStatus(raw: string | null): AccountStatus {
  return raw === "approved" || raw === "rejected" ? raw : "pending";
}

type SessionRow = {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
};

function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    provider: row.provider === "google" ? "google" : "password",
    createdAt: row.created_at,
    lastSignInAt: row.last_sign_in_at,
    status: toStatus(row.status),
  };
}

export function createD1AuthStore(db: D1Database): AuthStore {
  return {
    async findUserByEmail(email: string): Promise<AuthUser | null> {
      const row = await db
        .prepare(
          "SELECT id, email, password_hash, provider, created_at, last_sign_in_at, status " +
            "FROM auth_users WHERE email = ?",
        )
        .bind(email)
        .first<UserRow>();
      return row ? toUser(row) : null;
    },

    async findUserStatusById(userId: string): Promise<AccountStatus | null> {
      const row = await db
        .prepare("SELECT status FROM auth_users WHERE id = ?")
        .bind(userId)
        .first<{ status: string | null }>();
      return row ? toStatus(row.status) : null;
    },

    async findRoleByUserId(userId: string): Promise<Role | null> {
      const row = await db
        .prepare("SELECT role FROM user_roles WHERE user_id = ?")
        .bind(userId)
        .first<{ role: string }>();
      const role = row?.role;
      return role === "school_teacher" ||
        role === "tutor" ||
        role === "student" ||
        role === "admin" ||
        role === "teacher"
        ? (role as Role)
        : null;
    },

    async createUser(input: {
      id: string;
      email: string;
      passwordHash: string;
      fullName: string;
      role: "school_teacher" | "tutor" | "student";
      parentPhone: string | null;
      teacherPhone?: string | null;
      subjects?: string | null;
      school?: string | null;
    }): Promise<void> {
      const now = new Date().toISOString();
      const stmts = [
        db
          .prepare(
            "INSERT INTO auth_users (id, email, password_hash, provider, created_at, status) " +
              "VALUES (?, ?, ?, 'password', ?, 'pending')",
          )
          .bind(input.id, input.email, input.passwordHash, now),
        db
          .prepare(
            "INSERT INTO profiles (id, full_name, parent_phone, whatsapp_consent, created_at) " +
              "VALUES (?, ?, ?, 0, ?)",
          )
          .bind(input.id, input.fullName, input.parentPhone, now),
        db
          .prepare("INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, ?)")
          .bind(crypto.randomUUID(), input.id, input.role),
      ];
      // Teachers get their profile row at signup so the admin can see
      // phone/subjects/school in the approval queue immediately. The
      // profile page's subject upsert keeps working via ON CONFLICT.
      if (input.role === "school_teacher" || input.role === "tutor") {
        stmts.push(
          db
            .prepare(
              "INSERT INTO teacher_profiles (user_id, bio, subjects_text, type, phone, school) " +
                "VALUES (?, '', ?, ?, ?, ?)",
            )
            .bind(
              input.id,
              input.subjects ?? "",
              input.role,
              input.teacherPhone ?? null,
              input.school ?? null,
            ),
        );
      }
      if (db.batch) {
        await db.batch(stmts);
      } else {
        // Fallback for adapters without batch(): sequential writes. The
        // caller must treat a mid-sequence failure as a partial account
        // and surface it; D1 itself always provides batch().
        for (const s of stmts) await s.run();
      }
    },

    async findSessionByTokenHash(tokenHash: string) {
      const row = await db
        .prepare(
          "SELECT id, user_id, expires_at, revoked_at FROM auth_sessions " + "WHERE token_hash = ?",
        )
        .bind(tokenHash)
        .first<SessionRow>();
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      };
    },

    async createSession(input: {
      id: string;
      tokenHash: string;
      userId: string;
      expiresAt: string;
    }): Promise<void> {
      await db
        .prepare(
          "INSERT INTO auth_sessions (id, token_hash, user_id, created_at, expires_at) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .bind(input.id, input.tokenHash, input.userId, new Date().toISOString(), input.expiresAt)
        .run();
    },

    async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
      await db
        .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?")
        .bind(revokedAt, sessionId)
        .run();
    },

    async touchLastSignIn(userId: string, at: string): Promise<void> {
      await db
        .prepare("UPDATE auth_users SET last_sign_in_at = ? WHERE id = ?")
        .bind(at, userId)
        .run();
    },
  };
}

/**
 * Phase 2: teacher join codes (Supabase trigger parity). The profiles
 * join_code is a 12-character uppercase hex string, UNIQUE. Callers
 * must retry on UNIQUE violation with a fresh code (up to 5 tries);
 * a code is never assigned to a student, and never overwritten once
 * set — overwriting would invalidate codes teachers already shared.
 */
export async function setTeacherJoinCode(
  db: D1Database,
  userId: string,
  joinCode: string,
): Promise<boolean> {
  try {
    await db
      .prepare("UPDATE profiles SET join_code = ? WHERE id = ? AND join_code IS NULL")
      .bind(joinCode, userId)
      .run();
    return true;
  } catch {
    return false;
  }
}

export function newTeacherJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
