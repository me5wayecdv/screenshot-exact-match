/**
 * D1 implementation of the Phase 2 security store (rate limiting,
 * password-reset tokens, revoke-all, admin creation).
 *
 * Thin SQL translation only — all rules live in
 * src/lib/cloudflare-security.ts. Every query is a prepared statement
 * with bound parameters; never interpolate user input into SQL.
 * Multi-write operations use db.batch() where available so a
 * reset cannot half-apply (password changed but sessions alive).
 */

import { createD1AuthStore, type D1Database } from "@/server/d1-auth-store";
import type { SecurityStore } from "@/lib/cloudflare-security";

/**
 * Shared D1 SecurityStore adapter (used by d1-auth-fns.ts and
 * d1-admin.ts). Lives here — not in a server-fn module — because
 * server-fn modules are imported by client routes, and only server
 * functions (plus types) may be exported from those modules without
 * dragging server-only imports into the client bundle.
 */
export function createD1SecurityStore(db: D1Database): SecurityStore {
  const auth = createD1AuthStore(db);
  return {
    ...auth,
    countRecentFailures: (input) => countRecentFailures(db, input),
    recordLoginAttempt: (input) => recordLoginAttempt(db, input),
    revokeAllSessions: (userId, atIso) => revokeAllSessions(db, userId, atIso),
    setPasswordHash: (userId, hash) => setPasswordHash(db, userId, hash),
    createAdminUser: (input) => createAdminUser(db, input),
    createPasswordResetToken: (input) => createPasswordResetToken(db, input),
    findPasswordResetTokenByHash: (hash) => findPasswordResetTokenByHash(db, hash),
    markPasswordResetTokenUsed: (id, atIso) => markPasswordResetTokenUsed(db, id, atIso),
  };
}

export async function countRecentFailures(
  db: D1Database,
  input: { email: string; ip: string; sinceIso: string },
): Promise<{ byEmail: number; byIp: number }> {
  const byEmailRow = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM login_attempts " +
        "WHERE email = ? AND succeeded = 0 AND attempted_at > ?",
    )
    .bind(input.email, input.sinceIso)
    .first<{ n: number }>();
  const byIpRow = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM login_attempts " +
        "WHERE ip = ? AND succeeded = 0 AND attempted_at > ?",
    )
    .bind(input.ip, input.sinceIso)
    .first<{ n: number }>();
  return { byEmail: byEmailRow?.n ?? 0, byIp: byIpRow?.n ?? 0 };
}

export async function recordLoginAttempt(
  db: D1Database,
  input: { email: string; ip: string; succeeded: boolean; atIso: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO login_attempts (id, email, ip, attempted_at, succeeded) " +
        "VALUES (?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), input.email, input.ip, input.atIso, input.succeeded ? 1 : 0)
    .run();
}

export async function revokeAllSessions(
  db: D1Database,
  userId: string,
  atIso: string,
): Promise<void> {
  await db
    .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .bind(atIso, userId)
    .run();
}

export async function setPasswordHash(
  db: D1Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare("UPDATE auth_users SET password_hash = ? WHERE id = ?")
    .bind(passwordHash, userId)
    .run();
}

export async function createAdminUser(
  db: D1Database,
  input: { id: string; email: string; passwordHash: string; fullName: string },
): Promise<void> {
  const now = new Date().toISOString();
  const stmts = [
    db
      .prepare(
        // Admins are approved by construction: an existing admin created
        // this account, so it must not land in the approval queue.
        "INSERT INTO auth_users (id, email, password_hash, provider, created_at, status) " +
          "VALUES (?, ?, ?, 'password', ?, 'approved')",
      )
      .bind(input.id, input.email, input.passwordHash, now),
    db
      .prepare("INSERT INTO profiles (id, full_name, created_at) VALUES (?, ?, ?)")
      .bind(input.id, input.fullName, now),
    db
      .prepare("INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, 'admin')")
      .bind(crypto.randomUUID(), input.id),
  ];
  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();
}

export async function createPasswordResetToken(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    tokenHash: string;
    purpose: "reset" | "set-password";
    expiresAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO password_reset_tokens (id, user_id, token_hash, purpose, expires_at) " +
        "VALUES (?, ?, ?, ?, ?)",
    )
    .bind(input.id, input.userId, input.tokenHash, input.purpose, input.expiresAt)
    .run();
}

export async function findPasswordResetTokenByHash(
  db: D1Database,
  tokenHash: string,
): Promise<{
  id: string;
  userId: string;
  purpose: "reset" | "set-password";
  expiresAt: string;
  usedAt: string | null;
} | null> {
  const row = await db
    .prepare(
      "SELECT id, user_id, purpose, expires_at, used_at " +
        "FROM password_reset_tokens WHERE token_hash = ?",
    )
    .bind(tokenHash)
    .first<{
      id: string;
      user_id: string;
      purpose: string;
      expires_at: string;
      used_at: string | null;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose === "set-password" ? "set-password" : "reset",
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

export async function markPasswordResetTokenUsed(
  db: D1Database,
  id: string,
  atIso: string,
): Promise<void> {
  await db
    .prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?")
    .bind(atIso, id)
    .run();
}

/** Atomic reset consumption: set hash + mark used + revoke all sessions. */
export async function consumePasswordResetAtomic(
  db: D1Database,
  input: { tokenId: string; userId: string; passwordHash: string; atIso: string },
): Promise<void> {
  const stmts = [
    db
      .prepare("UPDATE auth_users SET password_hash = ? WHERE id = ?")
      .bind(input.passwordHash, input.userId),
    db
      .prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?")
      .bind(input.atIso, input.tokenId),
    db
      .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(input.atIso, input.userId),
  ];
  if (db.batch) await db.batch(stmts);
  else for (const s of stmts) await s.run();
}
