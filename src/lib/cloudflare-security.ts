/**
 * Phase 2 security hardening for the Cloudflare-only auth core.
 *
 * Storage-agnostic, like src/lib/cloudflare-auth.ts: all rules live
 * here, the D1 implementation lives in src/server/d1-security-store.ts.
 * Unit tests use an in-memory SecurityStore; production uses D1.
 *
 * Rules (do not weaken without a security review):
 * - Rate limiting: failures are counted per lowercased email AND per
 *   IP in a 15-minute window. Exceeding either limit returns the
 *   generic RATE_LIMITED error — it must never reveal whether the
 *   email exists. Successful sign-ins are recorded too, so a
 *   successful login does not erase the failure history of an
 *   attacker guessing the same account (only time passing does).
 * - Session rotation: a successful sign-in revokes the session that
 *   presented the request (if any), so a stolen cookie cannot stay
 *   valid alongside the new one. Rotation happens AFTER the new
 *   session is created, so a failure to revoke never blocks login
 *   with a valid new session — but the revocation failure must be
 *   logged by the caller.
 * - Password reset / set-password invitation: tokens are 32-byte
 *   random values; only SHA-256(token) is stored, with a 1-hour
 *   expiry and single use. Unknown, used, and expired tokens all
 *   produce the same generic RESET_TOKEN_INVALID error. Consuming a
 *   token sets the new password AND revokes every session of that
 *   user, so a stolen session cannot survive a reset.
 * - Admin creation: only an existing admin session may create an
 *   admin, via createAdmin(). There is deliberately NO bootstrap
 *   code path: the first admin is created by the operator directly
 *   in D1 (documented in MIGRATION-DESIGN.md), never by an endpoint.
 * - Email delivery is NOT in this module: issuePasswordResetToken
 *   returns the raw token to the SERVER caller only, for delivery
 *   through the email provider in src/server/d1-email.ts. A server
 *   function must never return that token to the browser, and must
 *   never log it. When no provider is configured the server function
 *   throws EMAIL_NOT_CONFIGURED before issuing a token — it never
 *   falls back to returning or printing the token.
 */

import {
  AuthError,
  checkSession,
  hashPassword,
  hashSessionToken,
  newId,
  newSessionToken,
  signIn,
  type AuthSession,
  type AuthStore,
  type Role,
} from "@/lib/cloudflare-auth";

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_ACCOUNT_MAX_FAILURES = 10;
export const RATE_LIMIT_IP_MAX_FAILURES = 50;
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export type SecurityStore = AuthStore & {
  countRecentFailures(input: {
    email: string;
    ip: string;
    sinceIso: string;
  }): Promise<{ byEmail: number; byIp: number }>;
  recordLoginAttempt(input: {
    email: string;
    ip: string;
    succeeded: boolean;
    atIso: string;
  }): Promise<void>;
  revokeAllSessions(userId: string, atIso: string): Promise<void>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  createAdminUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    fullName: string;
  }): Promise<void>;
  createPasswordResetToken(input: {
    id: string;
    userId: string;
    tokenHash: string;
    purpose: "reset" | "set-password";
    expiresAt: string;
  }): Promise<void>;
  findPasswordResetTokenByHash(tokenHash: string): Promise<{
    id: string;
    userId: string;
    purpose: "reset" | "set-password";
    expiresAt: string;
    usedAt: string | null;
  } | null>;
  markPasswordResetTokenUsed(id: string, atIso: string): Promise<void>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Throws RATE_LIMITED when either the account or IP window is exhausted. */
export async function checkLoginAllowed(
  store: SecurityStore,
  input: { email: string; ip: string },
): Promise<void> {
  const sinceIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { byEmail, byIp } = await store.countRecentFailures({
    email: normalizeEmail(input.email),
    ip: input.ip || "unknown",
    sinceIso,
  });
  if (byEmail >= RATE_LIMIT_ACCOUNT_MAX_FAILURES || byIp >= RATE_LIMIT_IP_MAX_FAILURES) {
    throw new AuthError("RATE_LIMITED", "Too many login attempts. Try again later.");
  }
}

/** Records one attempt. Callers must record failures even when the email is unknown. */
export async function recordAttempt(
  store: SecurityStore,
  input: { email: string; ip: string; succeeded: boolean },
): Promise<void> {
  await store.recordLoginAttempt({
    email: normalizeEmail(input.email),
    ip: input.ip || "unknown",
    succeeded: input.succeeded,
    atIso: nowIso(),
  });
}

/**
 * Sign in with rate limiting + rotation. The rate check runs before
 * password verification and uses the same generic error for blocked
 * and bad-credential cases only in that it never reveals account
 * existence: RATE_LIMITED is returned for blocked attempts, and
 * INVALID_CREDENTIALS for bad passwords — the caller must not
 * distinguish "unknown email" from "wrong password" (signIn already
 * does not). On success, a presented previous session is revoked.
 */
export async function signInWithRotation(
  store: SecurityStore,
  input: { email: string; password: string; ip: string; previousRawToken?: string | null },
): Promise<{ userId: string; sessionToken: string; expiresAt: string }> {
  await checkLoginAllowed(store, { email: input.email, ip: input.ip });
  let result: { userId: string; sessionToken: string; expiresAt: string };
  try {
    result = await signIn(store, { email: input.email, password: input.password });
  } catch (err) {
    await recordAttempt(store, { email: input.email, ip: input.ip, succeeded: false });
    throw err;
  }
  await recordAttempt(store, { email: input.email, ip: input.ip, succeeded: true });
  if (input.previousRawToken) {
    try {
      const prev = await checkSession(store, input.previousRawToken);
      await store.revokeSession(prev.id, nowIso());
    } catch {
      // No valid previous session: nothing to rotate. A stolen or
      // expired token must not block a legitimate new sign-in.
    }
  }
  return result;
}

/**
 * Issues a reset/set-password token. Returns the raw token to the
 * SERVER caller only (for email delivery) plus the token purpose, so
 * the caller emails the matching page (/reset-password or
 * /set-password). When the email does not exist, no token is created
 * and the return is indistinguishable except that token is null —
 * the caller must still respond with the same generic success.
 */
export async function issuePasswordResetToken(
  store: SecurityStore,
  email: string,
): Promise<{ ok: true; token: string | null; purpose: "reset" | "set-password" | null }> {
  const user = await store.findUserByEmail(normalizeEmail(email));
  if (!user) return { ok: true, token: null, purpose: null };
  const purpose = user.passwordHash ? "reset" : "set-password";
  const rawToken = newSessionToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await store.createPasswordResetToken({
    id: newId(),
    userId: user.id,
    tokenHash: await hashSessionToken(rawToken),
    purpose,
    expiresAt,
  });
  return { ok: true, token: rawToken, purpose };
}

/**
 * Consumes a reset token: sets the new password, marks the token
 * used, and revokes ALL sessions of the user. Unknown, used, and
 * expired tokens all fail with the same generic error.
 */
export async function consumePasswordResetToken(
  store: SecurityStore,
  input: { token: string; newPassword: string },
): Promise<{ userId: string }> {
  if (input.newPassword.length < 8) throw new AuthError("WEAK_PASSWORD");
  const row = await store.findPasswordResetTokenByHash(await hashSessionToken(input.token));
  if (!row || row.usedAt || row.expiresAt <= nowIso()) {
    throw new AuthError("RESET_TOKEN_INVALID", "Invalid or expired reset link.");
  }
  const passwordHash = await hashPassword(input.newPassword);
  await store.setPasswordHash(row.userId, passwordHash);
  await store.markPasswordResetTokenUsed(row.id, nowIso());
  await store.revokeAllSessions(row.userId, nowIso());
  return { userId: row.userId };
}

/**
 * Issues a set-password invitation for a passwordless account
 * (Google-linked accounts migrated without a password hash).
 * Admin-only, and only when the account truly has no password:
 * inviting a passworded account would be a back-door reset, so it
 * fails with NOT_PASSWORDLESS instead. Returns the raw token to the
 * SERVER caller only, for email delivery — same rule as
 * issuePasswordResetToken: never return it to the browser, never log
 * it. Google OAuth is NOT implemented here; the invitation path is
 * the chosen cutover solution (see docs/cutover-readiness.md).
 */
export async function issueSetPasswordInvitation(
  store: SecurityStore,
  adminSession: AuthSession,
  email: string,
): Promise<{ ok: true; token: string }> {
  if (adminSession.role !== "admin") throw new AuthError("FORBIDDEN");
  const user = await store.findUserByEmail(normalizeEmail(email));
  if (!user) throw new AuthError("ACCOUNT_NOT_FOUND", "No account with that email.");
  if (user.passwordHash !== null)
    throw new AuthError("NOT_PASSWORDLESS", "Account already has a password.");
  const rawToken = newSessionToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await store.createPasswordResetToken({
    id: newId(),
    userId: user.id,
    tokenHash: await hashSessionToken(rawToken),
    purpose: "set-password",
    expiresAt,
  });
  return { ok: true, token: rawToken };
}

/** Creates an admin, gated on an existing admin session. No self-service path. */
export async function createAdmin(
  store: SecurityStore,
  adminSession: AuthSession,
  input: { email: string; password: string; fullName: string },
): Promise<{ userId: string }> {
  if (adminSession.role !== "admin") throw new AuthError("FORBIDDEN");
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("INVALID_EMAIL");
  if (input.password.length < 8) throw new AuthError("WEAK_PASSWORD");
  if (await store.findUserByEmail(email)) throw new AuthError("EMAIL_TAKEN");
  const userId = newId();
  await store.createAdminUser({
    id: userId,
    email,
    passwordHash: await hashPassword(input.password),
    fullName: input.fullName.trim(),
  });
  return { userId };
}

/** Revokes every session of a user (password change, admin revocation). */
export async function revokeAllUserSessions(store: SecurityStore, userId: string): Promise<void> {
  await store.revokeAllSessions(userId, nowIso());
}

export type { Role };
