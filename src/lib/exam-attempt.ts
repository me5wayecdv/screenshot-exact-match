/**
 * Pure helpers for the §6 exam experience (server timer, availability
 * windows, multiple attempts). These mirror — never replace — the
 * server-side enforcement in start_attempt / save_draft / submit_attempt:
 * the database functions are the authority, these helpers only drive the
 * take-page UI (countdown display, window states, attempt buttons).
 */

/** The effective client deadline: the earlier of the server timer expiry
 * and the assessment due date, or null for an untimed, open-ended exam. */
export function effectiveDeadlineMs(
  expiresAt: string | null | undefined,
  dueAt: string | null | undefined,
): number | null {
  const candidates = [expiresAt, dueAt]
    .filter((v): v is string => !!v)
    .map((v) => new Date(v).getTime())
    .filter((n) => Number.isFinite(n));
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/** Whole seconds left until the deadline, clamped at 0. Null when untimed. */
export function remainingSeconds(deadlineMs: number | null, nowMs: number): number | null {
  if (deadlineMs === null) return null;
  return Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
}

/** "MM:SS", or "H:MM:SS" once an hour or more remains. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type WindowState = "not_started" | "open" | "past_due";

/** Client-side mirror of the window rules enforced by start_attempt. */
export function windowState(
  nowMs: number,
  startsAt: string | null | undefined,
  dueAt: string | null | undefined,
): WindowState {
  if (startsAt && nowMs < new Date(startsAt).getTime()) return "not_started";
  if (dueAt && nowMs > new Date(dueAt).getTime()) return "past_due";
  return "open";
}

/** Whether the student may start another attempt. */
export function canStartAttempt(attemptsUsed: number, maxAttempts: number): boolean {
  return attemptsUsed < Math.max(1, maxAttempts);
}

/**
 * Random start jitter (V3.4): spreads a synchronized exam start over a
 * few seconds so 500 students do not hit startAttempt in the same
 * instant. Whole milliseconds in [0, maxMs]. The server computes the
 * attempt expiry from the actual start, so the delay costs the student
 * nothing. `random` is injectable so tests can pin the value.
 */
export function randomStartDelayMs(maxMs = 10_000, random: () => number = Math.random): number {
  return Math.floor(random() * (Math.max(0, maxMs) + 1));
}

/** Latest non-draft attempt per student, by attempt_number. Drafts never
 * count in report stats: a student mid-attempt hasn't submitted, and an
 * older released attempt must not double-count once a newer one exists. */
export function latestSubmittedPerStudent<
  T extends { student_id: string; attempt_number: number; status: string },
>(rows: T[]): T[] {
  const byStudent = new Map<string, T>();
  for (const row of rows) {
    if (row.status === "in_progress") continue;
    const cur = byStudent.get(row.student_id);
    if (!cur || row.attempt_number > cur.attempt_number) byStudent.set(row.student_id, row);
  }
  return [...byStudent.values()];
}
