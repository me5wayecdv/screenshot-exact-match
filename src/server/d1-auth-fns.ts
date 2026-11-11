/**
 * D1 auth server functions (Phase 2, migrated auth routes).
 *
 * Cookie rules: the session token is set ONLY via HttpOnly, Secure,
 * SameSite=Lax cookies (setCookie from @tanstack/react-start/server).
 * It is never returned in a JSON body, never stored in localStorage,
 * and never logged. Sign-out deletes the cookie AND revokes the
 * session server-side. Rate limiting uses getRequestIP() with an
 * "unknown" fallback — an unavailable IP must not disable the limit
 * for the account key (the email key still applies).
 *
 * EMAIL DELIVERY (cutover gap #1, now wired): requestPasswordReset
 * sends the token by email through src/server/d1-email.ts (Resend or
 * MailChannels). The provider check runs BEFORE a token is issued, so
 * EMAIL_NOT_CONFIGURED is identical for known and unknown emails
 * (no account-enumeration signal) and no orphan token is created.
 * The token itself is never returned, logged, or printed — the email
 * body is its only destination. See docs/cutover-readiness.md for
 * the operator setup (RESEND_API_KEY secret, EMAIL_FROM var).
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest, getRequestIP, setCookie, deleteCookie } from "@tanstack/react-start/server";
import { getD1Async } from "@/server/d1";
import { createD1AuthStore, newTeacherJoinCode, setTeacherJoinCode } from "@/server/d1-auth-store";
import { appendAuditLog } from "@/server/d1-admin";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  checkSession,
  clearSessionCookieHeader,
  isTeacherRole,
  requireRole,
  sessionCookieHeader,
  signOut,
  signUp,
  type AuthSession,
} from "@/lib/cloudflare-auth";
import {
  checkPasswordResetAllowed,
  checkSignupAllowed,
  consumePasswordResetToken,
  createAdmin,
  issuePasswordResetToken,
  recordPasswordResetAttempt,
  recordSignupAttempt,
  signInWithRotation,
  type SecurityStore,
} from "@/lib/cloudflare-security";
import { createD1SecurityStore } from "@/server/d1-security-store";
import { getMeData, parseSessionCookie, requireCloudflareAuth } from "@/server/d1-session";
import { assertEmailConfigured, sendAuthEmail, EmailError } from "@/server/d1-email";
import type { D1Database } from "@/server/d1-auth-store";

// NOTE: this module is imported by client routes, so it must export
// ONLY server functions (plus types). Plain exported helpers that use
// server-only imports get pulled into the client bundle and trip the
// TanStack import-protection plugin — that is why the origin helper
// below is deliberately NOT exported, and why createD1SecurityStore
// lives in d1-security-store.ts instead of here.
function securityStore(db: D1Database): SecurityStore {
  return createD1SecurityStore(db);
}

/**
 * Origin for auth-email links: the request origin in production,
 * APP_URL as an explicit fallback. Throws EMAIL_SEND_FAILED when
 * neither exists, because a link without an origin cannot be built
 * — and the token must not be delivered any other way.
 */
function requestOrigin(): string {
  try {
    const url = getRequest()?.url;
    if (url) return new URL(url).origin;
  } catch {
    // Fall through to the env fallback.
  }
  const fallback = typeof process !== "undefined" ? (process.env["APP_URL"] ?? "").trim() : "";
  if (fallback) return fallback.replace(/\/+$/, "");
  throw new EmailError("EMAIL_SEND_FAILED", "Email send failed (no origin).");
}

function requestIp(): string {
  try {
    return getRequestIP() ?? "unknown";
  } catch {
    return "unknown";
  }
}

function previousToken(): string | null {
  try {
    const request = getRequest();
    return parseSessionCookie(request?.headers.get("cookie") ?? "");
  } catch {
    return null;
  }
}

function setSessionCookie(token: string, expiresAt: string): void {
  setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    expires: new Date(expiresAt),
  });
}

async function assignTeacherJoinCode(db: D1Database, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newTeacherJoinCode();
    await setTeacherJoinCode(db, userId, code);
    const row = await db
      .prepare("SELECT join_code FROM profiles WHERE id = ?")
      .bind(userId)
      .first<{ join_code: string | null }>();
    if (row?.join_code) return;
  }
  // Non-fatal: the teacher can still sign in; the join code can be
  // generated later. Failing sign-up over a code collision would be
  // worse than a missing code that is visible and fixable.
}

export const signInD1 = createServerFn({ method: "POST" })
  .validator((data: unknown) => data as { email: string; password: string })
  .handler(async ({ data }) => {
    const db = await getD1Async();
    const result = await signInWithRotation(securityStore(db), {
      email: data.email,
      password: data.password,
      ip: requestIp(),
      previousRawToken: previousToken(),
    });
    setSessionCookie(result.sessionToken, result.expiresAt);
    return { ok: true, userId: result.userId };
  });

export const signUpD1 = createServerFn({ method: "POST" })
  .validator(
    (data: unknown) =>
      data as {
        email: string;
        password: string;
        fullName: string;
        role: string;
        parentPhone?: string | null;
        teacherPhone?: string | null;
        subjects?: string | null;
        school?: string | null;
      },
  )
  .handler(async ({ data }) => {
    const db = await getD1Async();
    // Sign-up abuse cap (5/hour per IP): check and record before any
    // account work, so failed/duplicate sign-ups consume budget too.
    const store = securityStore(db);
    await checkSignupAllowed(store, requestIp());
    await recordSignupAttempt(store, requestIp());
    const result = await signUp(createD1AuthStore(db), {
      email: data.email,
      password: data.password,
      fullName: data.fullName,
      role: data.role,
      parentPhone: data.parentPhone ?? null,
      teacherPhone: data.teacherPhone ?? null,
      subjects: data.subjects ?? null,
      school: data.school ?? null,
    });
    if (isTeacherRole(data.role as "school_teacher" | "tutor")) {
      await assignTeacherJoinCode(db, result.userId);
    }
    // Activity feed: account signup (actor = the new account itself —
    // there is no session yet). Best-effort on purpose: a failed
    // audit write must not fail a signup that already created the
    // account (the user cannot retry cleanly past the email clash).
    try {
      await appendAuditLog(db, result.userId, "account_signup", result.userId, {
        role: data.role,
        target_label: data.fullName.trim(),
      });
    } catch {
      // Feed row lost; the account itself is unaffected.
    }
    // Pending accounts get NO session cookie: the client must show the
    // waiting-for-approval state instead of navigating to the dashboard.
    // (Today every signup is pending, so no cookie is ever set here.)
    return { ok: true, userId: result.userId, status: result.status };
  });

export const signOutD1 = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async () => {
    const db = await getD1Async();
    const token = previousToken();
    if (token) await signOut(createD1AuthStore(db), token);
    deleteCookie(SESSION_COOKIE);
    return { ok: true };
  });

export const getMeD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => {
    const { session, db } = context as { session: AuthSession; db: D1Database };
    return getMeData(db, session);
  });

/**
 * Password reset request. Provider check FIRST (identical error for
 * known/unknown emails, no orphan token), then issue, then email.
 * Generic success when the email is unknown (no token, no send).
 * The token is deliberately NOT returned — see the header note.
 */
export const requestPasswordResetD1 = createServerFn({ method: "POST" })
  .validator((data: unknown) => data as { email: string })
  .handler(async ({ data }) => {
    await assertEmailConfigured();
    const db = await getD1Async();
    const store = securityStore(db);
    // Rate limit BEFORE issuing: the record happens for unknown emails
    // too, so the limit never reveals whether the email exists.
    await checkPasswordResetAllowed(store, data.email, requestIp());
    await recordPasswordResetAttempt(store, data.email, requestIp());
    const issued = await issuePasswordResetToken(store, data.email);
    if (issued.token) {
      await sendAuthEmail({
        to: data.email.trim().toLowerCase(),
        origin: requestOrigin(),
        token: issued.token,
        purpose: issued.purpose ?? "reset",
      });
    }
    return { ok: true };
  });

export const consumePasswordResetD1 = createServerFn({ method: "POST" })
  .validator((data: unknown) => data as { token: string; newPassword: string })
  .handler(async ({ data }) => {
    const db = await getD1Async();
    await consumePasswordResetToken(securityStore(db), {
      token: data.token,
      newPassword: data.newPassword,
    });
    return { ok: true };
  });

export const createAdminD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { email: string; password: string; fullName: string })
  .handler(async ({ context, data }) => {
    const { session, db } = context as { session: AuthSession; db: D1Database };
    requireRole(session, ["admin"]);
    const created = await createAdmin(securityStore(db), session, data);
    return { ok: true, userId: created.userId };
  });

// Re-exported for server functions that need cookie headers outside
// setCookie (e.g. tests and future API routes). Not for browser use.
export { clearSessionCookieHeader, sessionCookieHeader };
export { checkSession };
