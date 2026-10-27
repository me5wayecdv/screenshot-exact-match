/**
 * Similar-answer grouping for handwritten history (Phase 3).
 *
 * Pure text similarity over ALREADY-SAVED corrected answers — no AI
 * call, no new data. Groups are a review aid only: similar wording is
 * NEVER presented as proof of copying. The UI labels it neutrally and
 * shows the scores side by side so the teacher can spot inconsistent
 * grading of near-identical answers.
 *
 * Method: Arabic-aware normalization (strip diacritics and tatweel,
 * unify alef forms, ى→ي, ة→ه), tokenization, stopword removal, then
 * Jaccard similarity on token sets with a 0.55 threshold and greedy
 * clustering (a row joins the first group with any member above the
 * threshold). Callers must cluster WITHIN one question — this module
 * does not know about questions, it only compares text.
 */

export type SimilarRow = {
  id: string;
  student_name: string;
  corrected_text: string;
  final_score: number;
  max_marks: number;
};

export type SimilarGroup = { members: SimilarRow[] };

/** Stopwords are matched AFTER normalization (see normalizeAnswerText). */
const STOPWORDS = new Set([
  // Arabic (post-normalization forms: أإآ→ا, ى→ي, ة→ه)
  "من",
  "الي",
  "في",
  "علي",
  "ان",
  "ما",
  "لا",
  "لم",
  "لن",
  "هو",
  "هي",
  "كان",
  "كانت",
  "هذا",
  "هذه",
  "ذلك",
  "التي",
  "الذي",
  "و",
  "ف",
  "ب",
  "ل",
  "ك",
  "ثم",
  "بعد",
  "قبل",
  "عند",
  "مع",
  "عن",
  "بين",
  "غير",
  "كل",
  "قد",
  "لقد",
  "انه",
  "انها",
  "هم",
  "نحن",
  "انت",
  // English
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "is",
  "are",
  "was",
  "were",
  "it",
  "this",
  "that",
  "with",
  "for",
  "on",
  "by",
]);

export function normalizeAnswerText(text: string): string[] {
  const cleaned = text
    .replace(/[ً-ْ]/g, "") // Arabic diacritics (U+064B–U+0652)
    .replace(/ـ/g, "") // tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
  return cleaned.split(/[^a-z0-9؀-ۿ]+/).filter((tok) => tok && !STOPWORDS.has(tok));
}

export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const tok of setA) if (setB.has(tok)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/**
 * Greedy clustering. Rows are processed in input order; a row joins
 * the first group with any member at or above `threshold`, otherwise
 * it starts a new group. Only groups of 2+ are returned.
 */
export function groupSimilarAnswers(rows: SimilarRow[], threshold = 0.55): SimilarGroup[] {
  const tokens = new Map(rows.map((r) => [r.id, normalizeAnswerText(r.corrected_text)]));
  const groups: SimilarRow[][] = [];
  for (const row of rows) {
    const toks = tokens.get(row.id) ?? [];
    let placed = false;
    for (const group of groups) {
      if (group.some((m) => jaccard(toks, tokens.get(m.id) ?? []) >= threshold)) {
        group.push(row);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([row]);
  }
  return groups.filter((g) => g.length >= 2).map((members) => ({ members }));
}
