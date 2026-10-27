/**
 * Server-only prompt module for AI grading suggestions (slice 1).
 *
 * Teacher-final-word: the model only ever produces a *suggestion*. It never
 * assigns a final score, never saves anything, and never releases a
 * submission. The teacher accepts, edits, or rejects the suggestion on the
 * /grading page, and only the teacher's own score (final_score) can release.
 *
 * This module is pure: it builds prompt strings and holds no API key, no
 * fetch call, and no browser-only code. Import it only from server code
 * (src/server/ai-grade.ts). Never import it from a client component.
 */

export type AiGradingPromptInput = {
  /** The question text as written by the teacher. */
  questionPrompt: string;
  /** Rubric text (one criterion per line, e.g. "يذكر السبب الرئيسي (2)"). May be empty. */
  rubric: string;
  /** Accepted alternative answers. May be empty. */
  acceptedAlternatives: string[];
  /** The student's written answer. May be empty (handled by the caller). */
  studentAnswer: string;
  /** Maximum marks for this question. */
  maxMarks: number;
};

/** Bound input length so a single answer cannot blow up the prompt. */
const MAX_CHARS = 8000;

function truncate(value: string): string {
  const text = (value ?? "").trim();
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "…" : text;
}

/**
 * Build the system + user messages for one grading suggestion.
 * The student answer and the requested feedback are Arabic; the model is
 * told explicitly to grade against the rubric and the accepted alternatives
 * — not against exact wording — and to award partial credit per rubric
 * criterion.
 */
export function buildAiGradingPrompt(input: AiGradingPromptInput): {
  system: string;
  user: string;
} {
  const alternatives =
    input.acceptedAlternatives
      .map((a) => a.trim())
      .filter(Boolean)
      .join("\n- ") || "لا توجد إجابات بديلة محددة.";

  const system = [
    "أنت مساعد تصحيح للمعلم في منصة تقييم عربية. مهمتك اقتراح درجة فقط،",
    "والقرار النهائي دائماً للمعلم.",
    "صحّح إجابة الطالب وفق معايير التصحيح (rubric) والإجابات البديلة المقبولة،",
    "وليس بالمطابقة الحرفية للنص. امنح درجات جزئية بحسب تحقق كل معيار.",
    "إذا لم توجد معايير تصحيح، صحّح وفق صحة المحتوى واكتماله بشكل عام.",
    "لا تتجاوز الدرجة القصوى أبداً، ولا تعطِ درجة سالبة.",
    "اكتب الملاحظات بالعربية فقط، في جملة إلى ثلاث جمل، وبأسلوب بنّاء يذكر",
    "ما تحقق وما ينقص أو ما أخطأ فيه الطالب.",
    "أعد النتيجة بصيغة JSON فقط، دون أي نص آخر، بهذا الشكل بالضبط:",
    '{"suggested_score": <number>, "feedback": "<string>", "confidence": "high" | "medium" | "low"}',
    'حيث confidence هو تقديرك لثقتك في الاقتراح: "high" عندما تكون الإجابة',
    'واضحة ومعايير التصحيح حاسمة، و"low" عندما تكون الإجابة غامضة أو قصيرة',
    "جداً أو لا تغطيها المعايير.",
  ].join(" ");

  const user = [
    `السؤال:\n${truncate(input.questionPrompt)}`,
    `معايير التصحيح:\n${truncate(input.rubric) || "لا توجد معايير تصحيح محددة."}`,
    `إجابات بديلة مقبولة:\n- ${truncate(alternatives)}`,
    `إجابة الطالب:\n${truncate(input.studentAnswer)}`,
    `الدرجة القصوى: ${input.maxMarks}`,
  ].join("\n\n");

  return { system, user };
}
