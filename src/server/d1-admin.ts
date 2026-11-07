/**
 * D1 admin + audit (Phase 2 port of /admin and /audit).
 *
 * Admin counts: the /admin page shows two counts only — teachers
 * (school_teacher + tutor roles) and students. The wrapper requires
 * the admin role, and the pure function re-checks it; a teacher
 * session is rejected server-side, never given a count. Counts are
 * aggregates, never user rows. Legacy 'teacher' rows are NOT counted
 * as teachers here, mirroring the old page's explicit
 * in(['school_teacher', 'tutor']) filter.
 *
 * Audit log: the old policy was "actor reads own audit" — a teacher
 * sees their own handwritten-grade history on /audit, and students
 * see nothing (the route shows auditTeacherOnly for students).
 * That rule is preserved VERBATIM in code: listAuditLog filters
 * actor_id = caller for every role, including admin. The SEPARATE
 * listSiteActivity feed below is the explicit product decision
 * (user, 2026-11-05: "the admin sees everything happening on the
 * site") that widens the admin view site-wide: it is admin-only,
 * display-only, and never touches password_hash. The two reads
 * must not be merged: /audit stays actor-only, /admin gets the
 * site-wide feed. Audit rows are append-only from server code:
 * this module exposes an insert helper for other server modules,
 * and no update/delete path exists here.
 * Audit details are stored as JSON text in D1 and parsed back on
 * read (malformed JSON falls back to the raw string, never throws
 * the whole list away).
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import { assertEmailConfigured, sendAuthEmail } from "@/server/d1-email";
import {
  createD1SecurityStore,
  revokeAllSessions,
  setPasswordHash,
} from "@/server/d1-security-store";
import { getRequest } from "@tanstack/react-start/server";
import { EmailError } from "@/server/d1-email";
import { issueSetPasswordInvitation } from "@/lib/cloudflare-security";
import { hashPassword, type AccountStatus, type AuthSession } from "@/lib/cloudflare-auth";

export type Caller = { id: string; role: string };

export function normalizeRole(role: string): string {
  return role === "teacher" ? "school_teacher" : role;
}

export class AdminError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "INVALID_INPUT",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AdminError";
  }
}

function requireAdmin(caller: Caller): void {
  if (normalizeRole(caller.role) !== "admin") {
    throw new AdminError("FORBIDDEN", "Admin only.");
  }
}

export async function getAdminCounts(
  db: D1Database,
  caller: Caller,
): Promise<{ teachers: number; students: number }> {
  requireAdmin(caller);
  const [teachers, students] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role IN ('school_teacher', 'tutor')")
      .first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM user_roles WHERE role = 'student'")
      .first<{ n: number }>(),
  ]);
  return { teachers: teachers?.n ?? 0, students: students?.n ?? 0 };
}

export type AuditDetailValue = string | number | boolean | null;

export type AuditRow = {
  id: number;
  action: string;
  entity_id: string | null;
  details: Record<string, AuditDetailValue> | string;
  created_at: string;
};

// Audit details are flat scalars in practice (scores, ids, decisions).
// Non-scalar values are stringified so the server-function return type
// stays serializable (TanStack Start rejects `unknown` values).
function parseDetails(raw: string): Record<string, AuditDetailValue> | string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, AuditDetailValue> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] =
          typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
            ? v
            : JSON.stringify(v);
      }
      return out;
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * Actor-only audit read: actor_id = caller, always, for every role.
 * Students are rejected by the route UI, but this function also
 * refuses them server-side so a direct call cannot list rows.
 */
export async function listAuditLog(db: D1Database, caller: Caller): Promise<AuditRow[]> {
  const role = normalizeRole(caller.role);
  if (role === "student") {
    throw new AdminError("FORBIDDEN", "Audit history is not available to students.");
  }
  const { results } = await db
    .prepare(
      "SELECT id, action, entity_id, details, created_at FROM audit_log " +
        "WHERE actor_id = ? ORDER BY created_at DESC LIMIT 100",
    )
    .bind(caller.id)
    .all<{
      id: number;
      action: string;
      entity_id: string | null;
      details: string;
      created_at: string;
    }>();
  return (results ?? []).map((r) => ({
    id: r.id,
    action: r.action,
    entity_id: r.entity_id,
    details: parseDetails(r.details),
    created_at: r.created_at,
  }));
}

export type SiteActivityRow = {
  id: number;
  action: string;
  entityId: string | null;
  details: Record<string, AuditDetailValue> | string;
  createdAt: string;
  actorName: string;
  actorEmail: string;
  actorRole: string;
  targetName: string | null;
  targetEmail: string | null;
};

type SiteActivityRowRaw = {
  id: number;
  action: string;
  entity_id: string | null;
  details: string;
  created_at: string;
  actor_email: string | null;
  actor_name: string | null;
  actor_role: string | null;
  target_email: string | null;
  target_name: string | null;
};

/**
 * Admin-only site-wide activity feed (display only). Unlike
 * listAuditLog, this deliberately returns EVERY actor's rows,
 * newest first — the admin sees everything happening on the site.
 * Actor and target display info comes from joins only; the query
 * selects no password column (never password_hash) and the feed
 * renders only time / actor / event type / target label — never
 * answer content, never scores, never free-form details. Admin
 * rows cannot be acted on through this feed: there is no decision
 * or mutation path here, only the read.
 *
 * Pagination: first page is the latest 100; callers pass a larger
 * offset to load more. Limit is clamped to 1..100, offset to >= 0.
 */
export async function listSiteActivity(
  db: D1Database,
  caller: Caller,
  input: { limit?: number; offset?: number } = {},
): Promise<SiteActivityRow[]> {
  requireAdmin(caller);
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 100)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const { results } = await db
    .prepare(
      "SELECT a.id, a.action, a.entity_id, a.details, a.created_at, " +
        "au.email AS actor_email, COALESCE(p.full_name, '') AS actor_name, " +
        "r.role AS actor_role, tu.email AS target_email, " +
        "COALESCE(tp.full_name, '') AS target_name " +
        "FROM audit_log a " +
        "LEFT JOIN auth_users au ON au.id = a.actor_id " +
        "LEFT JOIN profiles p ON p.id = a.actor_id " +
        "LEFT JOIN user_roles r ON r.user_id = a.actor_id " +
        "LEFT JOIN auth_users tu ON tu.id = a.entity_id " +
        "LEFT JOIN profiles tp ON tp.id = a.entity_id " +
        "ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?",
    )
    .bind(limit, offset)
    .all<SiteActivityRowRaw>();
  return (results ?? []).map((row) => ({
    id: row.id,
    action: row.action,
    entityId: row.entity_id,
    details: parseDetails(row.details),
    createdAt: row.created_at,
    actorName: row.actor_name ?? "",
    actorEmail: row.actor_email ?? "",
    actorRole: normalizeRole(row.actor_role ?? ""),
    targetName: row.target_name ? row.target_name : null,
    targetEmail: row.target_email,
  }));
}

/** Append-only audit insert for server code. Actor is always the session user. */
export async function appendAuditLog(
  db: D1Database,
  actorId: string,
  action: string,
  entityId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
    .bind(actorId, action, entityId, JSON.stringify(details))
    .run();
}

export type PasswordlessAccount = {
  id: string;
  email: string;
  createdAt: string;
};

/**
 * Cutover gap #2 — passwordless accounts report (admin-only).
 * Returns id + email + created date ONLY: no password hash (there is
 * none), no roles, no session data, no other columns. The query
 * selects exactly those three columns, so a wider row can never leak
 * through this function. Passwordless means password_hash IS NULL —
 * the migrated Google-linked accounts that need a set-password
 * invitation, not "provider = google" (provider alone is not proof
 * that no password exists).
 */
export async function listPasswordlessAccounts(
  db: D1Database,
  caller: Caller,
): Promise<PasswordlessAccount[]> {
  requireAdmin(caller);
  const { results } = await db
    .prepare(
      "SELECT id, email, created_at FROM auth_users " +
        "WHERE password_hash IS NULL ORDER BY created_at ASC",
    )
    .all<{ id: string; email: string; created_at: string }>();
  return (results ?? []).map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at }));
}

/**
 * Origin for invitation-email links (same rule as d1-auth-fns.ts).
 * Non-exported on purpose: this module is imported by client routes,
 * and an exported helper using getRequest trips the TanStack
 * import-protection plugin in the client bundle.
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

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

function ctxCaller(context: unknown): Caller {
  const s = ctxSession(context);
  return { id: s.userId, role: s.role };
}

/**
 * Admin approval queue (2026-11-04): every new account is pending
 * until an admin approves it. The list selects EXACT columns —
 * never password_hash — so a wider row can never leak through this
 * function. Phone is the teacher's own phone for teachers
 * (teacher_profiles.phone) and the parent phone for students
 * (profiles.parent_phone); subjects/school exist only for teachers.
 * Pending accounts sort first so the queue is reviewed top-down.
 */
export type AdminAccount = {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  subjects: string | null;
  school: string | null;
  role: string;
  createdAt: string;
  status: AccountStatus;
};

type AdminAccountRow = {
  id: string;
  email: string;
  created_at: string;
  status: string;
  full_name: string | null;
  parent_phone: string | null;
  teacher_phone: string | null;
  subjects_text: string | null;
  school: string | null;
  role: string;
};

export async function listAccounts(db: D1Database, caller: Caller): Promise<AdminAccount[]> {
  requireAdmin(caller);
  const { results } = await db
    .prepare(
      "SELECT a.id, a.email, a.created_at, a.status, p.full_name, p.parent_phone, " +
        "tp.phone AS teacher_phone, tp.subjects_text, tp.school, r.role " +
        "FROM auth_users a JOIN profiles p ON p.id = a.id " +
        "JOIN user_roles r ON r.user_id = a.id " +
        "LEFT JOIN teacher_profiles tp ON tp.user_id = a.id " +
        "ORDER BY CASE WHEN a.status = 'pending' THEN 0 " +
        "WHEN a.status = 'approved' THEN 1 ELSE 2 END, a.created_at DESC",
    )
    .all<AdminAccountRow>();
  return (results ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.full_name ?? r.email,
    phone: r.teacher_phone ?? r.parent_phone,
    subjects: r.subjects_text,
    school: r.school,
    role: normalizeRole(r.role),
    createdAt: r.created_at,
    status:
      r.status === "approved" || r.status === "rejected" ? r.status : ("pending" as AccountStatus),
  }));
}

export type AccountDecision = "approved" | "rejected";

/**
 * Approve or reject one account. Rejection revokes all live sessions
 * immediately (the session gate in checkSession would block them
 * anyway); approval needs no session work because pending accounts
 * never hold a session. Admin accounts are excluded: an admin cannot
 * lock another admin (or themselves) out through this queue.
 * Every decision is audit-logged (actor + target id only).
 */
export async function decideAccount(
  db: D1Database,
  caller: Caller,
  input: { userId: string; decision: AccountDecision },
): Promise<{ ok: true; status: AccountStatus }> {
  requireAdmin(caller);
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw new AdminError("INVALID_INPUT", "Decision must be approved or rejected.");
  }
  const target = await db
    .prepare(
      "SELECT r.role, a.email, p.full_name FROM auth_users a " +
        "JOIN user_roles r ON r.user_id = a.id LEFT JOIN profiles p ON p.id = a.id WHERE a.id = ?",
    )
    .bind(input.userId)
    .first<{ role: string; email: string; full_name: string | null }>();
  if (!target) throw new AdminError("INVALID_INPUT", "No such account.");
  if (normalizeRole(target.role) === "admin") {
    throw new AdminError("INVALID_INPUT", "Admin accounts cannot be approved or rejected here.");
  }
  await db
    .prepare("UPDATE auth_users SET status = ? WHERE id = ?")
    .bind(input.decision, input.userId)
    .run();
  if (input.decision === "rejected") {
    await revokeAllSessions(db, input.userId, new Date().toISOString());
  }
  // Activity-feed label only: name/email of the decided account.
  // Never a password or hash — the query above selects neither.
  await appendAuditLog(
    db,
    caller.id,
    input.decision === "approved" ? "account_approved" : "account_rejected",
    input.userId,
    { target_label: (target.full_name ?? "").trim() || target.email },
  );
  return { ok: true, status: input.decision };
}

// Unambiguous alphabet only (no 0/O, 1/l/I) so a temp password read
// over the phone cannot be misheard into a failed sign-in.
const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function newTemporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return [...bytes].map((b) => TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length]).join("");
}

/**
 * Admin password reset — the ONLY password-related admin capability.
 * The server generates the temporary password, stores ONLY its PBKDF2
 * hash (exactly like any password), revokes all sessions, and returns
 * the plaintext value ONCE in this response so the admin can pass it
 * to the user out-of-band. It is never logged, never stored, and
 * never appears in the audit row. The admin UI must show it once and
 * discard it; there is no way to retrieve it afterwards.
 */
export async function resetUserPassword(
  db: D1Database,
  caller: Caller,
  input: { userId: string },
): Promise<{ ok: true; temporaryPassword: string }> {
  requireAdmin(caller);
  const target = await db
    .prepare(
      "SELECT a.id, a.email, p.full_name FROM auth_users a " +
        "LEFT JOIN profiles p ON p.id = a.id WHERE a.id = ?",
    )
    .bind(input.userId)
    .first<{ id: string; email: string; full_name: string | null }>();
  if (!target) throw new AdminError("INVALID_INPUT", "No such account.");
  const temporaryPassword = newTemporaryPassword();
  await setPasswordHash(db, input.userId, await hashPassword(temporaryPassword));
  await revokeAllSessions(db, input.userId, new Date().toISOString());
  // Activity-feed label only: name/email of the reset account.
  // The temporary password itself is NEVER in the audit row.
  await appendAuditLog(db, caller.id, "password_reset", input.userId, {
    target_label: (target.full_name ?? "").trim() || target.email,
  });
  return { ok: true, temporaryPassword };
}

export const getAdminCountsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => getAdminCounts(ctxDb(context), ctxCaller(context)));

export const listAccountsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listAccounts(ctxDb(context), ctxCaller(context)));

export const decideAccountD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { userId: string; decision: AccountDecision })
  .handler(async ({ context, data }) => decideAccount(ctxDb(context), ctxCaller(context), data));

export const resetUserPasswordD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { userId: string })
  .handler(async ({ context, data }) =>
    resetUserPassword(ctxDb(context), ctxCaller(context), data),
  );

export const listSiteActivityD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { limit?: number; offset?: number })
  .handler(async ({ context, data }) =>
    listSiteActivity(ctxDb(context), ctxCaller(context), data ?? {}),
  );

export const listAuditLogD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listAuditLog(ctxDb(context), ctxCaller(context)));

export const listPasswordlessAccountsD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ context }) => listPasswordlessAccounts(ctxDb(context), ctxCaller(context)));

/**
 * Admin-only set-password invitation. Provider check FIRST (no orphan
 * token when email is unconfigured), then issue, then email. Returns
 * generic { ok: true } only — the token goes to the account's email
 * and nowhere else. Google OAuth is deliberately NOT built here; the
 * invitation path is the chosen cutover solution.
 */
export const createSetPasswordInvitationD1 = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data as { email: string })
  .handler(async ({ context, data }) => {
    await assertEmailConfigured();
    const db = ctxDb(context);
    const session = ctxSession(context);
    const issued = await issueSetPasswordInvitation(createD1SecurityStore(db), session, data.email);
    await sendAuthEmail({
      to: data.email.trim().toLowerCase(),
      origin: requestOrigin(),
      token: issued.token,
      purpose: "set-password",
    });
    return { ok: true };
  });
