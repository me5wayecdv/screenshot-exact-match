/**
 * Parent phone check for the take flow (2026-11-15).
 *
 * The exam report is sent to the student's parent by WhatsApp, so a
 * student without a parent number on file cannot start an assessment:
 * the exam would run and the result could never be reported. The
 * Supabase-era `start_attempt` enforced exactly this; the D1 port
 * dropped it, and this module brings it back for both start paths
 * (the Durable Object start and the D1 reference start).
 *
 * Two rules make this safe to enforce on the hot path:
 * 1. It runs ONLY for a NEW attempt. Resuming an attempt that is
 *    already in progress is never blocked — the student started it
 *    and must be able to finish it.
 * 2. The result is a tri-state. "missing" is a definite answer (the
 *    profile has no parent phone) and blocks the start. "unknown" is
 *    a D1 failure — the DO start path treats it as "do not block"
 *    (a brief D1 overload must not stop every student from taking
 *    an exam), while the D1 path lets the error surface, because it
 *    needs D1 for everything else anyway.
 *
 * The number itself is never logged or returned: only its presence
 * matters here. The format is enforced at write time (sign-up, the
 * parent-contact form, and the DB CHECK constraint).
 */
import type { D1Database } from "@/server/d1-auth-store";

export type ParentPhoneState = "present" | "missing" | "unknown";

/**
 * Read the student's parent phone.
 *
 * @param failOpen when true, a D1 failure returns "unknown" instead
 *   of throwing (the DO start path). When false (the default, the D1
 *   path), the D1 error propagates.
 */
export async function parentPhoneState(
  db: D1Database,
  studentId: string,
  options: { failOpen?: boolean } = {},
): Promise<ParentPhoneState> {
  try {
    const row = await db
      .prepare("SELECT parent_phone FROM profiles WHERE id = ?")
      .bind(studentId)
      .first<{ parent_phone: string | null }>();
    // A student with no profile row cannot have a parent phone (the
    // assignment FK points at profiles.id), so a missing row means
    // "no phone on file".
    return row?.parent_phone ? "present" : "missing";
  } catch (error) {
    if (!options.failOpen) throw error;
    // D1 is unavailable: the caller decides what to do with "unknown".
    return "unknown";
  }
}
