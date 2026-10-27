/**
 * Per-student shuffled question order.
 *
 * The take page renders ALL questions in one scrollable list (position
 * order from the query). Shuffling only changes display order; every
 * answer, score, and key lookup in the app is by question_id, never by
 * position — so grading cannot break (verified against grading.tsx and
 * assessment-report-questions.tsx; see NOTES.md).
 *
 * Persistence (two layers, both keyed by student+assessment):
 *  1. localStorage — set on first render of an attempt, so a reload or
 *     resume BEFORE submit shows the same order.
 *  2. public.submissions.question_order — written in the same insert that
 *     creates the submission at submit time, so the locked (post-submit)
 *     view and any future view use the same order even on another device.
 * The submission column wins when present; localStorage is the fallback.
 */

export function shuffleIds(ids: string[]): string[] {
  const arr = [...ids];
  const rand = (): number => {
    try {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return buf[0] / 2 ** 32;
    } catch {
      return Math.random();
    }
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Stored order filtered to ids that still exist, with new ids appended in input order. */
export function resolveOrderIds(allIds: string[], order: string[] | null | undefined): string[] {
  if (!order || order.length === 0) return [...allIds];
  const known = new Set(allIds);
  const kept = order.filter((id) => known.has(id));
  const seen = new Set(kept);
  return [...kept, ...allIds.filter((id) => !seen.has(id))];
}

/** Reorder question objects by a stored id order (same rules as resolveOrderIds). */
export function resolveQuestionOrder<T extends { id: string }>(
  questions: T[],
  order: string[] | null | undefined,
): T[] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return resolveOrderIds(
    questions.map((q) => q.id),
    order,
  )
    .map((id) => byId.get(id)!)
    .filter(Boolean);
}

export function orderStorageKey(assessmentId: string, studentId: string): string {
  return `qemmini:question-order:${assessmentId}:${studentId}`;
}

/** Stored order from localStorage only (null when absent or malformed). */
export function loadQuestionOrder(assessmentId: string, studentId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(orderStorageKey(assessmentId, studentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string" && v.length > 0))
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveQuestionOrder(assessmentId: string, studentId: string, order: string[]): void {
  try {
    window.localStorage.setItem(orderStorageKey(assessmentId, studentId), JSON.stringify(order));
  } catch {
    // Private mode / quota: the submission-column copy still persists at submit.
  }
}
