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
 * - Lockout ladder: on top of the 15-minute window, a second tier
 *   counts failures in a 60-minute window (20/account, 100/IP).
 *   Tripping it blocks the account/IP until the 60-minute window
 *   drains below the threshold — up to ~60 minutes for a clustered
 *   burst, ~15-45 minutes in a sustained attack (about 10 guesses
 *   per 30 minutes). Blocked attempts are never recorded, so the
 *   lockout always expires by time and cannot be extended by
 *   continued guessing. There is NO early unlock: a password reset
 *   does not clear recorded failures (the store has no delete
 *   operation), so a locked-out user who resets still waits for the
 *   window to drain. Early unlock needs a store method
 *   (d1-security-store.ts) or a schema change — not done here.
 * - Generic rate limiting: sign-up and password-reset requests are
 *   limited through the same login_attempts table via namespaced
 *   email keys (`rate:<kind>:<key>`). The per-account login budget
 *   is never affected (a real email never equals a `rate:` key);
 *   generic rows carry the real IP, so they count toward the login
 *   per-IP budget — bounded at ~10 rows/hour/IP by the generic
 *   limits themselves, and only ever tightening it.
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

/** Lockout tier: a second, longer window on top of the 15-minute one. */
export const LOCKOUT_WINDOW_MS = 60 * 60 * 1000;
export const LOCKOUT_ACCOUNT_MAX_FAILURES = 20;
export const LOCKOUT_IP_MAX_FAILURES = 100;

/** Generic endpoint limits (1-hour windows, same attempts table). */
export const SIGNUP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const SIGNUP_MAX_PER_IP_PER_HOUR = 5;
export const RESET_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const RESET_MAX_PER_EMAIL_PER_HOUR = 5;
export const RESET_MAX_PER_IP_PER_HOUR = 5;

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

/**
 * Throws RATE_LIMITED when either the account or IP window is exhausted.
 * Two tiers share the same error (a lockout must not reveal more than a
 * rate limit does):
 * - Tier 1 (burst): 10 failures/account or 50/IP in the last 15 minutes.
 * - Tier 2 (lockout): 20 failures/account or 100/IP in the last
 *   60 minutes. The block lasts until the 60-minute window drains below
 *   the threshold — up to ~60 minutes after a clustered burst. Blocked
 *   attempts are never recorded (the check throws before any password
 *   verification), so continued guessing cannot extend the lockout;
 *   only time passing clears it.
 */
export async function checkLoginAllowed(
  store: SecurityStore,
  input: { email: string; ip: string },
): Promise<void> {
  const email = normalizeEmail(input.email);
  const ip = input.ip || "unknown";
  const now = Date.now();
  const windowCounts = await store.countRecentFailures({
    email,
    ip,
    sinceIso: new Date(now - RATE_LIMIT_WINDOW_MS).toISOString(),
  });
  if (
    windowCounts.byEmail >= RATE_LIMIT_ACCOUNT_MAX_FAILURES ||
    windowCounts.byIp >= RATE_LIMIT_IP_MAX_FAILURES
  ) {
    throw new AuthError("RATE_LIMITED");
  }
  const lockoutCounts = await store.countRecentFailures({
    email,
    ip,
    sinceIso: new Date(now - LOCKOUT_WINDOW_MS).toISOString(),
  });
  if (
    lockoutCounts.byEmail >= LOCKOUT_ACCOUNT_MAX_FAILURES ||
    lockoutCounts.byIp >= LOCKOUT_IP_MAX_FAILURES
  ) {
    throw new AuthError("RATE_LIMITED");
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
 * Generic per-endpoint rate limiting, reusing the login_attempts table
 * with NO schema change. Events are recorded under a namespaced email
 * key (`rate:<kind>:<key>`), so the per-account login budget is never
 * affected: a login check counts rows for the real email, which can
 * never equal a `rate:` key. The row carries the real IP and
 * succeeded=0, so it DOES count toward the login per-IP budget —
 * bounded at ~10 rows/hour/IP by the generic limits themselves, and
 * only ever tightening login blocking for an IP already abusing other
 * endpoints. The check counts only the namespaced bucket (byEmail);
 * the byIp count from the same query is ignored.
 *
 * Callers must record the event BEFORE doing the work (and before any
 * existence check), so the limit trips identically for known and
 * unknown emails — otherwise the limit itself becomes an
 * account-enumeration signal.
 */
function rateLimitKey(key: string): string {
  return `rate:${key}`;
}

export async function checkRateLimit(
  store: SecurityStore,
  input: { key: string; ip: string; windowMs: number; max: number },
): Promise<void> {
  const { byEmail } = await store.countRecentFailures({
    email: rateLimitKey(input.key),
    ip: input.ip || "unknown",
    sinceIso: new Date(Date.now() - input.windowMs).toISOString(),
  });
  if (byEmail >= input.max) {
    throw new AuthError("RATE_LIMITED");
  }
}

export async function recordRateLimitEvent(
  store: SecurityStore,
  input: { key: string; ip: string },
): Promise<void> {
  await store.recordLoginAttempt({
    email: rateLimitKey(input.key),
    ip: input.ip || "unknown",
    succeeded: false,
    atIso: nowIso(),
  });
}

/** Sign-up: 5 attempts/hour per IP. */
export async function checkSignupAllowed(store: SecurityStore, ip: string): Promise<void> {
  await checkRateLimit(store, {
    key: `signup:ip:${ip || "unknown"}`,
    ip,
    windowMs: SIGNUP_RATE_LIMIT_WINDOW_MS,
    max: SIGNUP_MAX_PER_IP_PER_HOUR,
  });
}

export async function recordSignupAttempt(store: SecurityStore, ip: string): Promise<void> {
  await recordRateLimitEvent(store, { key: `signup:ip:${ip || "unknown"}`, ip });
}

/**
 * Password-reset requests: 5/hour per target email AND 5/hour per IP.
 * Both buckets are checked (two cheap indexed counts; reset requests
 * are rare). The event is recorded under both keys before any
 * existence check, so unknown emails consume budget identically —
 * the limit never reveals whether the email exists.
 */
export async function checkPasswordResetAllowed(
  store: SecurityStore,
  email: string,
  ip: string,
): Promise<void> {
  await checkRateLimit(store, {
    key: `reset:email:${normalizeEmail(email)}`,
    ip,
    windowMs: RESET_RATE_LIMIT_WINDOW_MS,
    max: RESET_MAX_PER_EMAIL_PER_HOUR,
  });
  await checkRateLimit(store, {
    key: `reset:ip:${ip || "unknown"}`,
    ip,
    windowMs: RESET_RATE_LIMIT_WINDOW_MS,
    max: RESET_MAX_PER_IP_PER_HOUR,
  });
}

export async function recordPasswordResetAttempt(
  store: SecurityStore,
  email: string,
  ip: string,
): Promise<void> {
  await recordRateLimitEvent(store, { key: `reset:email:${normalizeEmail(email)}`, ip });
  await recordRateLimitEvent(store, { key: `reset:ip:${ip || "unknown"}`, ip });
}

/**
 * Sign in with rate limiting (burst window + 60-minute lockout ladder)
 * + rotation. The rate check runs before password verification and
 * uses the same generic error for blocked and bad-credential cases
 * only in that it never reveals account existence: RATE_LIMITED is
 * returned for blocked attempts, and INVALID_CREDENTIALS for bad
 * passwords — the caller must not distinguish "unknown email" from
 * "wrong password" (signIn already does not). On success, a presented
 * previous session is revoked.
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
    throw new AuthError("RESET_TOKEN_INVALID");
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
  if (!user) throw new AuthError("ACCOUNT_NOT_FOUND");
  if (user.passwordHash !== null) throw new AuthError("NOT_PASSWORDLESS");
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
