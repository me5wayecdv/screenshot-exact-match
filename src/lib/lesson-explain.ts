export type LessonExplainLanguage = "ar" | "en";

/** Same guardrail as assessment generation (src/lib/generate-assessment.ts). */
export const LESSON_EXPLAIN_MAX_CHARS = 30_000;
/** Mirrors the generation source minimum: shorter text is not a lesson. */
export const LESSON_EXPLAIN_MIN_CHARS = 50;

export type CappedLessonSource = {
  text: string;
  truncated: boolean;
  originalChars: number;
};

/**
 * Trim, then cap at LESSON_EXPLAIN_MAX_CHARS. A large file must never
 * silently produce a shallow explanation: callers must surface `truncated`
 * with `originalChars` whenever it is true.
 */
export function capLessonSourceText(text: string): CappedLessonSource {
  const trimmed = text.trim();
  if (trimmed.length <= LESSON_EXPLAIN_MAX_CHARS) {
    return { text: trimmed, truncated: false, originalChars: trimmed.length };
  }
  return {
    text: trimmed.slice(0, LESSON_EXPLAIN_MAX_CHARS),
    truncated: true,
    originalChars: trimmed.length,
  };
}

export type LessonExplainInput = {
  language: LessonExplainLanguage;
  sourceText: string;
  truncated: boolean;
  originalChars: number;
};

/** Validate the untrusted explain payload before it reaches an AI provider. */
export function validateLessonExplainInput(raw: unknown): LessonExplainInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const language = data["language"];
  if (language !== "ar" && language !== "en") return null;
  if (typeof data["sourceText"] !== "string") return null;
  const capped = capLessonSourceText(data["sourceText"]);
  if (capped.text.length < LESSON_EXPLAIN_MIN_CHARS) return null;
  return {
    language,
    sourceText: capped.text,
    truncated: capped.truncated,
    originalChars: capped.originalChars,
  };
}

/**
 * System prompt for the explanation. The reply must be in the language of
 * the lesson text itself (falling back to the teacher's UI language when
 * the lesson language is unclear), structured in the five fixed sections,
 * and grounded in the provided text only — no invented facts.
 */
export function buildLessonExplainSystemPrompt(language: LessonExplainLanguage): string {
  if (language === "ar") {
    return [
      "أنت مساعد تربوي عملي داخل منصة قَيّمني، مخصص لمعلمي المدارس والمدرسين الخصوصيين.",
      "اشرح الدرس التالي بلغة نص الدرس نفسه (درس عربي يُشرح بالعربية، ودرس إنجليزي يُشرح بالإنجليزية)؛ وإذا لم تتضح لغة الدرس، اشرح بالعربية.",
      "اعتمد على نص الدرس المقدم فقط. لا تخترع حقائق أو تفاصيل من خارج النص؛ وإذا كان النص ناقصاً أو غامضاً في نقطة ما، قل ذلك صراحة بدل ملء الفراغ.",
      "اكتب الشرح بالترتيب التالي، مع عنوان واضح لكل قسم:",
      "1. ملخص: فقرة قصيرة تلخص فكرة الدرس.",
      "2. مفاهيم أساسية: أهم المصطلحات والأفكار مع تعريف موجز لكل منها.",
      "3. شرح خطوة بخطوة: تسلسل منطقي يبني الفهم تدريجياً.",
      "4. أمثلة: مثالان أو ثلاثة من واقع الدرس أو من الحياة اليومية.",
      "5. أخطاء شائعة عند الطلاب: أكثر الفهوم الخاطئة شيوعاً وكيف يصححها المعلم.",
      "الشرح مسودة للمراجعة فقط: أنت لا تنشئ اختباراً ولا تعتمد درجات ولا تنشر نتائج، ولا تتعامل مع أسماء طلاب أو إجابات فردية.",
    ].join("\n\n");
  }

  return [
    "You are a practical teaching assistant inside Qayyimni, for school teachers and tutors.",
    "Explain the following lesson in the language of the lesson text itself (an Arabic lesson is explained in Arabic, an English lesson in English); if the lesson language is unclear, explain in English.",
    "Ground the explanation in the provided lesson text only. Do not invent facts or details beyond the text; if the text is incomplete or vague on a point, say so explicitly instead of filling the gap.",
    "Write the explanation in this order, with a clear heading for each section:",
    "1. Summary: a short paragraph capturing the lesson's main idea.",
    "2. Key concepts: the most important terms and ideas, each with a brief definition.",
    "3. Step-by-step explanation: a logical sequence that builds understanding gradually.",
    "4. Examples: two or three examples from the lesson or from everyday life.",
    "5. Common student mistakes: the most frequent misconceptions and how the teacher can correct them.",
    "This explanation is a draft for teacher review only: you create no assessments, approve no marks, and release no results, and you never touch student names or individual answers.",
  ].join("\n\n");
}

/** User message: the lesson text itself, with a short instruction line. */
export function buildLessonExplainUserPrompt(
  language: LessonExplainLanguage,
  sourceText: string,
): string {
  const instruction = language === "ar" ? "اشرح الدرس التالي:" : "Explain the following lesson:";
  return `${instruction}\n\n${sourceText}`;
}
