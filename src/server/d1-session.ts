/**
 * Shared D1 session middleware + "me" lookup for migrated routes.
 *
 * Rules (mirroring src/server/d1-groups.ts Phase 1 PoC, now shared):
 * - The session is resolved server-side from the HttpOnly cookie on
 *   EVERY call. The client never supplies a user id, teacher id, or
 *   actor id; server functions use ONLY session.userId.
 * - requireCloudflareAuth puts { session } in context and throws on
 *   missing/invalid/expired/revoked sessions, so unauthenticated
 *   callers never reach a query.
 * - getMeData returns only the caller's own profile: id, email, role
 *   (legacy 'teacher' mapped to 'school_teacher'), full name, and
 *   the teacher join code (profiles.join_code, null for students).
 *   It never returns another user's row.
 */

import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { D1Database } from "@/server/d1-auth-store";
import { getD1Async } from "@/server/d1";
import { SESSION_COOKIE, checkSession, type AuthSession } from "@/lib/cloudflare-auth";
import { createD1AuthStore } from "@/server/d1-auth-store";

export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader);
  return match?.[1] ?? null;
}

export async function resolveSessionFromRequest(
  db: D1Database,
  request: { headers: { get(name: string): string | null } } | null | undefined,
): Promise<AuthSession> {
  const cookie = request?.headers.get("cookie") ?? "";
  return checkSession(createD1AuthStore(db), parseSessionCookie(cookie));
}

export const requireCloudflareAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const db = await getD1Async();
    const session = await resolveSessionFromRequest(db, getRequest());
    return next({ context: { session, db } });
  },
);

export type MeData = {
  id: string;
  email: string;
  role: "school_teacher" | "tutor" | "student" | "admin";
  fullName: string;
  joinCode: string | null;
};

export async function getMeData(db: D1Database, session: AuthSession): Promise<MeData> {
  const [emailRow, profileRow, roleRow] = await Promise.all([
    db
      .prepare("SELECT email FROM auth_users WHERE id = ?")
      .bind(session.userId)
      .first<{ email: string }>(),
    db
      .prepare("SELECT full_name, join_code FROM profiles WHERE id = ?")
      .bind(session.userId)
      .first<{ full_name: string | null; join_code: string | null }>(),
    db
      .prepare("SELECT role FROM user_roles WHERE user_id = ?")
      .bind(session.userId)
      .first<{ role: string }>(),
  ]);
  const rawRole = roleRow?.role;
  const role: MeData["role"] =
    rawRole === "teacher"
      ? "school_teacher"
      : rawRole === "school_teacher" ||
          rawRole === "tutor" ||
          rawRole === "student" ||
          rawRole === "admin"
        ? rawRole
        : "student";
  return {
    id: session.userId,
    email: emailRow?.email ?? "",
    role,
    fullName: profileRow?.full_name || emailRow?.email || "",
    joinCode: profileRow?.join_code ?? null,
  };
}
