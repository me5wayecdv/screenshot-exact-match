// Pure prompt + validation module for assessment generation (slice 2).
//
// This file has NO server-only imports and reads NO environment variables,
// so it is safe to import from anywhere. The server function
// (src/lib/generate-assessment.ts) calls buildGeneratePrompt(),
// sends it to the AI API, and validates the reply with
// parseGeneratedDraft(). The coordinator may unify this module with the
// sibling AI-grading slice's AI module: the shared surface is
// buildGeneratePrompt / parseGeneratedDraft / distributeCounts, and the
// GeneratedDraft shape below. See NOTES.md for the unification notes.
//
// Teacher-final-word: everything this module produces is a DRAFT. The
// server function saves it as an UNPUBLISHED assessment and the teacher
// reviews/edits it in the existing builder route before publishing.
// Nothing here ever publishes.

export type GenerateQuestionType = "mcq" | "true_false" | "short_answer" | "written";

export const GENERATE_QUESTION_TYPES: GenerateQuestionType[] = [
  "mcq",
  "true_false",
  "short_answer",
  "written",
];

export function isGenerateQuestionType(v: unknown): v is GenerateQuestionType {
  return typeof v === "string" && (GENERATE_QUESTION_TYPES as string[]).includes(v);
}

/** Per-question difficulty stored on questions.difficulty. */
export type QuestionDifficulty = "easy" | "medium" | "hard";

/** Generation preference: one level, or "mixed" (the model varies levels). */
export type GenerateDifficulty = QuestionDifficulty | "mixed";

export function isQuestionDifficulty(v: unknown): v is QuestionDifficulty {
  return v === "easy" || v === "medium" || v === "hard";
}

export function isGenerateDifficulty(v: unknown): v is GenerateDifficulty {
  return v === "mixed" || isQuestionDifficulty(v);
}

/** Unknown/invalid difficulty from a model reply falls back to medium. */
function cleanDifficulty(v: unknown): QuestionDifficulty {
  return isQuestionDifficulty(v) ? v : "medium";
}

/** One validated, ready-to-save generated question. */
export type GeneratedQuestion = {
  type: GenerateQuestionType;
  prompt: string;
  /** MCQ options only. [] for true_false / short_answer / written, matching
   *  the builder's addQuestion() default (non-MCQ questions store []). */
  options: string[];
  /** MCQ: must be one of options. true_false: exactly "true" | "false".
   *  short_answer: the expected answer. written: "" (rubric carries it). */
  correct_answer: string;
  accepted_alternatives: string[];
  /** Written questions only; "" otherwise. */
  rubric: string;
  explanation: string;
  marks: number;
  objective: string;
  difficulty: QuestionDifficulty;
};

export type GeneratedDraft = {
  title: string;
  questions: GeneratedQuestion[];
};

export type GeneratePromptInput = {
  sourceText: string;
  subjectName: string | null;
  gradeLevel: string;
  /** Requested question count per type, e.g. { mcq: 3, true_false: 2 }. */
  counts: Partial<Record<GenerateQuestionType, number>>;
  /** Difficulty preference: one level, or "mixed" (vary across questions). */
  difficulty: GenerateDifficulty;
};

/**
 * Split `total` questions across `types` as evenly as possible, in the
 * order the teacher ticked the types (earlier types get the remainder).
 * E.g. distributeCounts(5, ["mcq", "true_false"]) => { mcq: 3, true_false: 2 }.
 */
export function distributeCounts(
  total: number,
  types: GenerateQuestionType[],
): Partial<Record<GenerateQuestionType, number>> {
  const out: Partial<Record<GenerateQuestionType, number>> = {};
  if (types.length === 0) return out;
  const base = Math.floor(total / types.length);
  const remainder = total % types.length;
  types.forEach((t, i) => {
    out[t] = base + (i < remainder ? 1 : 0);
  });
  return out;
}

const TYPE_LABEL: Record<GenerateQuestionType, string> = {
  mcq: "اختيار من متعدد (MCQ)",
  true_false: "صح أم خطأ (true/false)",
  short_answer: "إجابة قصيرة (short answer)",
  written: "إجابة مقالية (written)",
};

/**
 * Build the model prompt. The model is told to answer ONLY with JSON in
 * the schema below, in the same language as the source text, and to draw
 * questions ONLY from the source text (no invented facts from outside it).
 */
export function buildGeneratePrompt(input: GeneratePromptInput): string {
  const countLines = (Object.keys(input.counts) as GenerateQuestionType[])
    .map((t) => `- ${TYPE_LABEL[t]}: ${input.counts[t]} سؤال`)
    .join("\n");
  const subjectLine = input.subjectName ? `المادة: ${input.subjectName}\n` : "";
  const gradeLine = input.gradeLevel ? `الصف الدراسي: ${input.gradeLevel}\n` : "";
  const difficultyLine =
    input.difficulty === "mixed"
      ? "مستويات الصعوبة: وزّع الأسئلة على مستويات مختلفة (سهل ومتوسط وصعب) واذكر مستوى كل سؤال في حقل difficulty."
      : `مستوى صعوبة كل الأسئلة: ${input.difficulty === "easy" ? "سهل" : input.difficulty === "hard" ? "صعب" : "متوسط"} (اذكر القيمة نفسها في حقل difficulty لكل سؤال).`;
  return [
    "أنت معلم خبير يصيغ اختبارات من نصوص المناهج. أجب بصيغة JSON فقط، بدون أي نص خارج JSON وبدون أسوار كود (code fences).",
    "اكتب الأسئلة بنفس لغة النص المصدر. استخدم النص المصدر فقط: لا تخترع حقائق أو أسئلة عن معلومات غير موجودة فيه.",
    `${subjectLine}${gradeLine}أنشئ اختباراً بالمواصفات التالية:`,
    countLines,
    difficultyLine,
    "صيغة JSON المطلوبة بالضبط:",
    JSON.stringify(
      {
        title: "عنوان قصير للاختبار",
        questions: [
          {
            type: "mcq",
            prompt: "نص السؤال",
            options: ["الخيار الأول", "الخيار الثاني", "الخيار الثالث", "الخيار الرابع"],
            correct_answer: "الخيار الصحيح كما ورد حرفياً في options",
            accepted_alternatives: [],
            rubric: "",
            explanation: "شرح قصير (اختياري)",
            marks: 1,
            objective: "هدف التعلم (اختياري)",
            difficulty: "medium",
          },
        ],
      },
      null,
      2,
    ),
    "قواعد كل نوع:",
    "- mcq: 4 خيارات مختلفة، وcorrect_answer يجب أن يساوي أحدها حرفياً.",
    '- true_false: options فارغة، وcorrect_answer يساوي "true" أو "false" فقط.',
    "- short_answer: correct_answer إجابة مختصرة متوقعة، وaccepted_alternatives بدائل مقبولة إن وجدت.",
    "- written: correct_answer فارغة، وrubric إلزامية: معايير تصحيح كل معيار في سطر مع درجته.",
    "- marks: رقم بين 0.5 و 10، والافتراضي 1 عند عدم التحديد.",
    "- difficulty: مستوى صعوبة السؤال: easy أو medium أو hard فقط.",
    "نص المصدر:",
    input.sourceText,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Defensive validation of model output. Anything that does not fit the
// existing questions/question_keys schema is DROPPED (never repaired by
// guessing an answer). If nothing valid survives, parsing fails and the
// server function returns a clear error instead of saving a broken draft.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanStrArray(v: unknown, maxItem: number, maxCount: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (s && !out.includes(s)) out.push(s.slice(0, maxItem));
    if (out.length >= maxCount) break;
  }
  return out;
}

function cleanMarks(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(0.5, n));
}

/** Parse + validate raw model JSON. Throws Error("AI_PARSE_FAILED") on bad shape. */
export function parseGeneratedDraft(raw: unknown, maxQuestions: number): GeneratedDraft {
  if (!isRecord(raw)) throw new Error("AI_PARSE_FAILED");
  const title = cleanStr(raw.title, 200);
  if (!title) throw new Error("AI_PARSE_FAILED");
  if (!Array.isArray(raw.questions)) throw new Error("AI_PARSE_FAILED");

  const questions: GeneratedQuestion[] = [];
  for (const item of raw.questions) {
    if (questions.length >= maxQuestions) break;
    if (!isRecord(item)) continue;
    if (!isGenerateQuestionType(item.type)) continue;
    const prompt = cleanStr(item.prompt, 4000);
    if (!prompt) continue;
    const marks = cleanMarks(item.marks);
    const objective = cleanStr(item.objective, 300);
    const explanation = cleanStr(item.explanation, 1000);
    const type = item.type;

    if (type === "mcq") {
      const options = cleanStrArray(item.options, 500, 6);
      const correct = cleanStr(item.correct_answer, 500);
      if (options.length < 2 || !correct || !options.includes(correct)) continue;
      questions.push({
        type,
        prompt,
        options,
        correct_answer: correct,
        accepted_alternatives: [],
        rubric: "",
        explanation,
        marks,
        objective,
        difficulty: cleanDifficulty(item.difficulty),
      });
    } else if (type === "true_false") {
      const correct = cleanStr(item.correct_answer, 10);
      if (correct !== "true" && correct !== "false") continue;
      questions.push({
        type,
        prompt,
        options: [],
        correct_answer: correct,
        accepted_alternatives: [],
        rubric: "",
        explanation,
        marks,
        objective,
        difficulty: cleanDifficulty(item.difficulty),
      });
    } else if (type === "short_answer") {
      const correct = cleanStr(item.correct_answer, 500);
      if (!correct) continue;
      questions.push({
        type,
        prompt,
        options: [],
        correct_answer: correct,
        accepted_alternatives: cleanStrArray(item.accepted_alternatives, 500, 10),
        rubric: "",
        explanation,
        marks,
        objective,
        difficulty: cleanDifficulty(item.difficulty),
      });
    } else {
      // written: the rubric is the key; a written question without one is
      // unusable for grading, so drop it rather than saving a blank rubric.
      const rubric = cleanStr(item.rubric, 4000);
      if (!rubric) continue;
      questions.push({
        type,
        prompt,
        options: [],
        correct_answer: "",
        accepted_alternatives: [],
        rubric,
        explanation,
        marks,
        objective,
        difficulty: cleanDifficulty(item.difficulty),
      });
    }
  }

  if (questions.length === 0) throw new Error("AI_PARSE_FAILED");
  return { title, questions };
}

/** Extract the JSON object from a model reply (tolerates ```json fences). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("AI_PARSE_FAILED");
  return JSON.parse(text.slice(start, end + 1));
}
