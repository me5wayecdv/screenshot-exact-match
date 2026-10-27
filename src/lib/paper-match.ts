/**
 * Pure helpers for Phase 3 paper matching (shared by the server
 * function and the tests). No server-only imports here.
 *
 * Question numbers in photos arrive in several shapes: a JSON number
 * (3), a digit string ("3"), Arabic-Indic digits ("٣"), or a string
 * with surrounding words ("السؤال ٣"). Ordinal words (الثالث، third)
 * are NOT parsed — those pages fall through to the AI content match.
 */

/** Arabic-Indic digits ٠-٩ mapped to Western digits. */
const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
};

function toWesternDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d] ?? d);
}

/** Parse a question number from model output, or null if unusable. */
export function parseQuestionNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string") {
    const digits = toWesternDigits(v).replace(/[^0-9]/g, "");
    if (!digits) return null;
    const n = Number.parseInt(digits, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Map a 1-based question number to a 0-based index into the
 * position-sorted question list, or null when out of range.
 */
export function matchByNumber(questionNumber: number, questionCount: number): number | null {
  if (!Number.isInteger(questionNumber) || questionNumber < 1) return null;
  if (questionNumber > questionCount) return null;
  return questionNumber - 1;
}

/**
 * Phase 6 — batch completion helpers (pure, tested).
 *
 * The match panel is a queue: pages arrive unmatched, get matched, then
 * get graded one by one through the single-grade form. These helpers
 * keep that queue honest without any server state.
 */

/** Pages that still need a match run (text empty). Re-running a match
 *  only sends these, so a partial failure costs one retry, not a full
 *  re-match of already-matched pages. */
export function pendingMatchItems<T extends { text: string }>(items: T[]): T[] {
  return items.filter((it) => !it.text);
}

/**
 * The next ungraded page after `currentId`, wrapping to the start of
 * the list when the current page was the last ungraded one. Null when
 * every other page is graded (or the list is empty).
 */
export function nextUngradedMatch<T extends { id: string; graded: boolean }>(
  items: T[],
  currentId: string,
): T | null {
  const rest = items.filter((it) => it.id !== currentId && !it.graded);
  if (rest.length === 0) return null;
  const currentIdx = items.findIndex((it) => it.id === currentId);
  const after = rest.find((it) => items.indexOf(it) > currentIdx);
  return after ?? rest[0]!;
}

export function matchProgress<T extends { graded: boolean }>(
  items: T[],
): { done: number; total: number } {
  return { done: items.filter((it) => it.graded).length, total: items.length };
}
