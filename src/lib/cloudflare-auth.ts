/**
 * Custom auth core for the Cloudflare-only Qemmini stack (Phase 1).
 *
 * This module is deliberately storage-agnostic: it talks to an AuthStore
 * interface, not to D1 directly, so the logic is unit-testable without a
 * Worker binding. The D1 implementation lives in
 * src/server/d1-auth-store.ts; the Worker cookie handling lives in the
 * server functions that call these functions (see MIGRATION-DESIGN.md).
 *
 * Security rules (do not weaken without a security review):
 * - Passwords: PBKDF2-HMAC-SHA256, 100,000 iterations, 16-byte
 *   per-user salt, stored as
 *   `pbkdf2-sha256$<iterations>$<saltB64url>$<hashB64url>`. Never
 *   plaintext, never a home-made hash, never MD5/SHA-1 alone.
 *   NOTE: 100,000 is the maximum Cloudflare Workers WebCrypto allows
 *   for PBKDF2 — higher counts throw ("iteration counts above 100000
 *   are not supported"), which broke staging sign-up/sign-in at
 *   600,000. The compensating layers are login rate limiting and the
 *   per-user salt; do NOT work around the cap with chained or
 *   iterated derivations — this stays a single standard PBKDF2 call
 *   within the platform limit. Verification always reads the
 *   iteration count from the stored hash string, so hashes created
 *   at an older count still verify.
 * - Sessions: opaque 32-byte random tokens. Only SHA-256(token) is
 *   stored; the raw token is returned once to the caller, which must
 *   put it in an HttpOnly, Secure, SameSite=Lax cookie and never in
 *   page JS, localStorage, URLs, or logs.
 * - A session is valid only if it exists, is not revoked, and has not
 *   expired. All three are checked on every lookup.
 * - Sign-in failures are generic ("Invalid email or password") whether
 *   the email is unknown, the hash is missing (OAuth account), or the
 *   password is wrong — the caller must not distinguish them.
 * - Sign-up role allowlist excludes 'admin'. Admins are created only by
 *   an existing admin (Phase 2). Any code path that lets sign-up create
 *   an admin is a privilege-escalation bug.
 * - Admin approval (2026-11-04): every NEW account is created
 *   'pending' and cannot sign in or use anything until an admin
 *   approves it. The gate is enforced in signIn AND in checkSession,
 *   so every server function behind the auth middleware inherits it —
 *   hiding UI alone is never the protection. Existing accounts are
 *   backfilled to 'approved' by migration. A rejected account can
 *   never sign in again (until an admin re-approves it).
 * - Timestamps are UTC ISO strings; expiry comparisons are string
 *   comparisons on that format, which is safe only because the format
 *   is fixed (see schema/d1-schema.sql).
 *
 * Explicitly NOT in Phase 1 (see MIGRATION-DESIGN.md for the plan):
 * password reset emails, email verification, login-attempt rate
 * limiting, and Google OAuth. The session store has the fields these
 * need (revoked_at, provider), but the flows are not implemented here.
 */

import { isValidEgyptianMobile, normalizePhoneInput } from "@/lib/whatsapp";

export type Role = "school_teacher" | "tutor" | "student" | "admin";
export type SignUpRole = Exclude<Role, "admin">;

/** Admin-approval state. New signups are 'pending'; see the header note. */
export type AccountStatus = "pending" | "approved" | "rejected";

export type AuthUser = {
  id: string;
  email: string;
  passwordHash: string | null;
  provider: "password" | "google";
  createdAt: string;
  lastSignInAt: string | null;
  status: AccountStatus;
};

export type AuthSession = {
  id: string;
  userId: string;
  role: Role;
  expiresAt: string;
};

export type AuthStore = {
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findRoleByUserId(userId: string): Promise<Role | null>;
  /** Approval status of an account id (null = no such account). */
  findUserStatusById(userId: string): Promise<AccountStatus | null>;
  /** Creates auth_users + profiles + user_roles atomically. */
  createUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    fullName: string;
    role: SignUpRole;
    parentPhone: string | null;
    /** Teacher-only: required Egyptian mobile, stored on teacher_profiles. */
    teacherPhone?: string | null;
    /** Teacher-only: subjects taught, stored on teacher_profiles. */
    subjects?: string | null;
    /** Teacher-only: school/center name, stored on teacher_profiles. */
    school?: string | null;
  }): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<{
    id: string;
    userId: string;
    expiresAt: string;
    revokedAt: string | null;
  } | null>;
  createSession(input: {
    id: string;
    tokenHash: string;
    userId: string;
    expiresAt: string;
  }): Promise<void>;
  revokeSession(sessionId: string, revokedAt: string): Promise<void>;
  touchLastSignIn(userId: string, at: string): Promise<void>;
};

export const SESSION_COOKIE = "qemmini_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Production PBKDF2 iteration count. MUST stay <= 100,000: that is the
// Cloudflare Workers WebCrypto cap, and anything above it throws at
// sign-up/sign-in time. See the regression test in
// src/test/pbkdf2-iterations.test.ts.
export const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 8;

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CREDENTIALS"
      | "EMAIL_TAKEN"
      | "INVALID_EMAIL"
      | "WEAK_PASSWORD"
      | "INVALID_ROLE"
      | "SESSION_EXPIRED"
      | "SESSION_REVOKED"
      | "SESSION_NOT_FOUND"
      | "FORBIDDEN"
      | "RATE_LIMITED"
      | "RESET_TOKEN_INVALID"
      | "ACCOUNT_NOT_FOUND"
      | "ACCOUNT_PENDING"
      | "ACCOUNT_REJECTED"
      | "INVALID_PHONE"
      | "NOT_PASSWORDLESS",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AuthError";
  }
}

function toIso(date: Date): string {
  return date.toISOString();
}

function nowIso(): string {
  return toIso(new Date());
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison for equal-length strings; false otherwise. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const [, iterPart, saltPart, expected] = parts;
  if (!iterPart || !saltPart || !expected) return false;
  const iterations = Number(iterPart);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = b64urlToBytes(saltPart);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return timingSafeEqual(b64url(new Uint8Array(bits)), expected);
}

export function hashSessionToken(rawToken: string): Promise<string> {
  return sha256Hex(rawToken);
}

export function newSessionToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function newId(): string {
  return crypto.randomUUID();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const SIGNUP_ROLES: SignUpRole[] = ["school_teacher", "tutor", "student"];

function isTeacherSignUpRole(role: string): boolean {
  return role === "school_teacher" || role === "tutor";
}

/**
 * Sign-up creates a PENDING account and deliberately creates NO
 * session: a new account cannot use anything until an admin approves
 * it (see the header note). The caller must surface the pending
 * state to the user instead of navigating to the dashboard.
 */
export async function signUp(
  store: AuthStore,
  input: {
    email: string;
    password: string;
    fullName: string;
    role: string;
    parentPhone?: string | null;
    teacherPhone?: string | null;
    subjects?: string | null;
    school?: string | null;
    iterations?: number;
  },
): Promise<{ userId: string; status: AccountStatus }> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new AuthError("INVALID_EMAIL");
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new AuthError("WEAK_PASSWORD");
  if (!SIGNUP_ROLES.includes(input.role as SignUpRole)) throw new AuthError("INVALID_ROLE");
  if (await store.findUserByEmail(email)) throw new AuthError("EMAIL_TAKEN");

  // Teachers must be identifiable and contactable so the admin can
  // verify they are really a teacher: phone is required and must be
  // an Egyptian mobile (same rule as the student parent phone).
  // Validation is server-side — the client check alone is not trusted.
  let teacherPhone: string | null = null;
  if (isTeacherSignUpRole(input.role)) {
    teacherPhone = normalizePhoneInput(input.teacherPhone ?? "");
    if (!isValidEgyptianMobile(teacherPhone)) {
      throw new AuthError("INVALID_PHONE", "A valid Egyptian mobile is required for teachers.");
    }
  }

  const userId = newId();
  const passwordHash = await hashPassword(input.password, input.iterations);
  await store.createUser({
    id: userId,
    email,
    passwordHash,
    fullName: input.fullName.trim(),
    role: input.role as SignUpRole,
    parentPhone: input.parentPhone ?? null,
    teacherPhone,
    subjects: (input.subjects ?? "").trim().slice(0, 200) || null,
    school: (input.school ?? "").trim().slice(0, 200) || null,
  });
  return { userId, status: "pending" };
}

export async function signIn(
  store: AuthStore,
  input: { email: string; password: string },
): Promise<{ userId: string; sessionToken: string; expiresAt: string }> {
  const user = await store.findUserByEmail(normalizeEmail(input.email));
  // Generic failure for unknown email, OAuth account (null hash), and
  // wrong password alike — do not leak which one it was.
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password");
  }
  // Status is checked ONLY after the password verifies, so the
  // pending/rejected messages never leak account state to someone
  // guessing passwords. A legitimate owner with the right password
  // gets a clear, actionable message instead of a generic failure.
  if (user.status === "pending") {
    throw new AuthError("ACCOUNT_PENDING", "Your account is waiting for admin approval.");
  }
  if (user.status === "rejected") {
    throw new AuthError("ACCOUNT_REJECTED", "Your account was rejected by an admin.");
  }
  await store.touchLastSignIn(user.id, nowIso());
  return createSessionFor(store, user.id);
}

async function createSessionFor(
  store: AuthStore,
  userId: string,
): Promise<{ userId: string; sessionToken: string; expiresAt: string }> {
  const rawToken = newSessionToken();
  const expiresAt = toIso(new Date(Date.now() + SESSION_TTL_MS));
  await store.createSession({
    id: newId(),
    tokenHash: await hashSessionToken(rawToken),
    userId,
    expiresAt,
  });
  return { userId, sessionToken: rawToken, expiresAt };
}

export async function checkSession(
  store: AuthStore,
  rawToken: string | null | undefined,
): Promise<AuthSession> {
  if (!rawToken) throw new AuthError("SESSION_NOT_FOUND");
  const row = await store.findSessionByTokenHash(await hashSessionToken(rawToken));
  if (!row) throw new AuthError("SESSION_NOT_FOUND");
  if (row.revokedAt) throw new AuthError("SESSION_REVOKED");
  if (row.expiresAt <= nowIso()) throw new AuthError("SESSION_EXPIRED");
  const role = await store.findRoleByUserId(row.userId);
  if (!role) throw new AuthError("SESSION_NOT_FOUND");
  // Approval gate for live sessions: rejecting an account revokes its
  // usefulness immediately, even if a session cookie is still valid.
  // Every server function behind the auth middleware inherits this.
  const status = await store.findUserStatusById(row.userId);
  if (!status) throw new AuthError("SESSION_NOT_FOUND");
  if (status === "pending") {
    throw new AuthError("ACCOUNT_PENDING", "Your account is waiting for admin approval.");
  }
  if (status === "rejected") {
    throw new AuthError("ACCOUNT_REJECTED", "Your account was rejected by an admin.");
  }
  return { id: row.id, userId: row.userId, role, expiresAt: row.expiresAt };
}

export async function signOut(store: AuthStore, rawToken: string): Promise<void> {
  // Revoking by session id requires resolving the token first; an
  // unknown token is a no-op (logout must never error on stale cookies).
  try {
    const session = await checkSession(store, rawToken);
    await store.revokeSession(session.id, nowIso());
  } catch {
    // Unknown/expired/revoked tokens are already effectively logged out.
  }
}

/** Role gate: throws FORBIDDEN unless the session role is allowed. */
export function requireRole(session: AuthSession, allowed: Role[]): AuthSession {
  if (!allowed.includes(session.role)) throw new AuthError("FORBIDDEN");
  return session;
}

export function isTeacherRole(role: Role): boolean {
  return role === "school_teacher" || role === "tutor";
}

/** Cookie header value for a freshly created session. */
export function sessionCookieHeader(rawToken: string, expiresAt: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return (
    `${SESSION_COOKIE}=${rawToken}; Path=/; HttpOnly; Secure; ` +
    `SameSite=Lax; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}`
  );
}

/** Cookie header value that clears the session cookie. */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
