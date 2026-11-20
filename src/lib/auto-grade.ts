/** Deterministic objective auto-grade (the old score_objective rule),
 *  shared by the grading page (teacher review, PR: auto-apply) and
 *  the submit-time auto-release for fully objective exams. Pure:
 *  no imports, no database, safe to call from any context. */

export type ObjectiveKey = {
  correct_answer: string;
  accepted_alternatives: string[];
  rubric: string;
  explanation: string;
} | null;

/** Full marks on a match, zero on a mismatch or an unanswered keyed
 *  question, null when the question is not auto-gradable at all
 *  (written, or the teacher set no key). */
export function autoScoreFor(
  question: { type: string; marks: number },
  key: ObjectiveKey,
  answerText: string,
): number | null {
  if (!key) return null;
  const marks = Number(question.marks);
  if (question.type === "mcq" || question.type === "true_false") {
    const expected = (key.correct_answer ?? "").trim();
    // A missing teacher key is not a zero: no key, no auto-grade.
    if (!expected) return null;
    const ans = (answerText ?? "").trim();
    // A keyed question left unanswered scores zero.
    if (!ans) return 0;
    return ans === expected ? marks : 0;
  }
  if (question.type === "short_answer") {
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    // No teacher key and no accepted alternative: no auto-grade.
    if (
      !normalize(key.correct_answer ?? "") &&
      !key.accepted_alternatives.some((a) => normalize(a))
    )
      return null;
    const norm = normalize(answerText ?? "");
    if (!norm) return 0;
    if (norm === normalize(key.correct_answer ?? "")) return marks;
    if (key.accepted_alternatives.some((a) => normalize(a) === norm)) return marks;
    return 0;
  }
  return null;
}

/** Whether a question can be auto-graded at all, independent of the
 *  student's answer: an objective type with a usable teacher key.
 *  Written questions and unkeyed objective questions always need the
 *  teacher. */
export function isAutoGradable(question: { type: string }, key: ObjectiveKey): boolean {
  if (!key) return false;
  if (question.type === "mcq" || question.type === "true_false") {
    return !!(key.correct_answer ?? "").trim();
  }
  if (question.type === "short_answer") {
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    return (
      !!normalize(key.correct_answer ?? "") || key.accepted_alternatives.some((a) => !!normalize(a))
    );
  }
  return false;
}
